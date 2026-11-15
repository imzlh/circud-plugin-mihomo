import {
  atomicWriteJson,
  atomicWriteText,
  ControlError,
  MAX_CONFIG_BYTES,
  optionalPositiveInteger,
  pathExists,
  readJsonIfPresent,
  removeIfPresent,
  requiredString,
  runCommand,
  safeId,
  sha256Hex,
  syncDirectory,
  type JsonObject,
  type RuntimePaths,
} from './runtime.ts';

export interface GenerationMetadata {
  version: 1;
  generationId: string;
  transactionId: string;
  profileId: string;
  profileRevision: number;
  name: string;
  sha256: string;
  createdAt: number;
  validation: { ok: true; warnings: string[] };
  networkConfig?: JsonObject;
}

export interface ActiveGeneration {
  version: 1;
  generationId: string;
  previousGenerationId?: string;
  transactionId: string;
  profileId: string;
  profileRevision: number;
  sha256: string;
  appliedAt: number;
}

interface StageInput {
  transactionId: string;
  profileId: string;
  profileRevision: number;
  name: string;
  compiledContent: string;
  sha256?: string;
  networkConfig?: JsonObject;
}

export class GenerationManager {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly dryRun: boolean,
  ) {}

  async recoverInterruptedActivation(): Promise<{ recovered: boolean; previousGenerationId?: string }> {
    const journal = await readJsonIfPresent<JsonObject>(this.paths.activation);
    if (!journal || journal.state === 'complete') {
      if (journal?.state === 'complete') await removeIfPresent(this.paths.activation);
      return { recovered: false };
    }
    const previousPointer = journal.previousPointer && typeof journal.previousPointer === 'object'
      ? journal.previousPointer as unknown as ActiveGeneration
      : undefined;
    const previous = previousPointer?.generationId ?? (typeof journal.previousGenerationId === 'string'
      ? journal.previousGenerationId
      : undefined);
    if (previousPointer?.version === 1 && typeof previousPointer.generationId === 'string') {
      await this.get(previousPointer.generationId);
      await this.restoreActive(previousPointer);
    } else if (previous) {
      const metadata = await this.get(previous);
      await this.writeActive(metadata, safeId(journal.transactionId ?? `recovery-${Date.now()}`, 'transactionId'), undefined);
    } else {
      await removeIfPresent(this.paths.active);
    }
    await atomicWriteJson(this.paths.activation, {
      ...journal,
      state: 'recovered',
      recoveredAt: Date.now(),
    });
    await removeIfPresent(this.paths.activation);
    return { recovered: true, ...(previous ? { previousGenerationId: previous } : {}) };
  }

  async validateContent(content: string): Promise<{ ok: true; warnings: string[] }> {
    validateContentSize(content);
    const temp = `${this.paths.runtimeDir}/validate-${crypto.randomUUID()}.yaml`;
    try {
      await atomicWriteText(temp, content, 0o600);
      return await this.validateFile(temp);
    } finally {
      await removeIfPresent(temp);
    }
  }

  async stage(raw: JsonObject): Promise<JsonObject> {
    const input = normalizeStageInput(raw);
    const actualHash = await sha256Hex(input.compiledContent);
    if (input.sha256 !== undefined && input.sha256.toLowerCase() !== actualHash) {
      throw new ControlError('content_hash_mismatch', 'Compiled content does not match sha256', {
        expected: input.sha256.toLowerCase(),
        actual: actualHash,
      });
    }
    const validation = await this.validateContent(input.compiledContent);
    const generationId = `g-${actualHash.slice(0, 24)}-${input.profileRevision}`;
    const finalDirectory = this.directory(generationId);
    const previous = await this.active();
    if (await pathExists(finalDirectory)) {
      const existing = await this.get(generationId);
      if (existing.sha256 !== actualHash) throw new ControlError('generation_conflict', 'Generation id already refers to different content');
      return this.stageResult(existing, previous?.generationId);
    }

    const temporary = `${this.paths.generationDir}/.stage-${crypto.randomUUID()}`;
    const metadata: GenerationMetadata = {
      version: 1,
      generationId,
      transactionId: input.transactionId,
      profileId: input.profileId,
      profileRevision: input.profileRevision,
      name: input.name,
      sha256: actualHash,
      createdAt: Date.now(),
      validation,
      ...(input.networkConfig ? { networkConfig: input.networkConfig } : {}),
    };
    try {
      await Deno.mkdir(temporary, { mode: 0o700 });
      await atomicWriteText(`${temporary}/config.yaml`, input.compiledContent, 0o600);
      await atomicWriteJson(`${temporary}/metadata.json`, metadata, 0o600);
      await syncDirectory(temporary);
      await Deno.rename(temporary, finalDirectory);
      await syncDirectory(this.paths.generationDir);
    } catch (error) {
      await removeIfPresent(temporary, true);
      if (error instanceof Deno.errors.AlreadyExists) {
        const existing = await this.get(generationId);
        if (existing.sha256 === actualHash) return this.stageResult(existing, previous?.generationId);
      }
      throw error;
    }
    return this.stageResult(metadata, previous?.generationId);
  }

  async get(generationId: string): Promise<GenerationMetadata> {
    safeId(generationId, 'generationId');
    const metadata = await readJsonIfPresent<GenerationMetadata>(`${this.directory(generationId)}/metadata.json`);
    if (!metadata || metadata.generationId !== generationId || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
      throw new ControlError('generation_not_found', `Generation does not exist: ${generationId}`);
    }
    return metadata;
  }

  configPath(generationId: string): string {
    safeId(generationId, 'generationId');
    return `${this.directory(generationId)}/config.yaml`;
  }

  async active(): Promise<ActiveGeneration | undefined> {
    const active = await readJsonIfPresent<ActiveGeneration>(this.paths.active);
    if (!active) return undefined;
    if (active.version !== 1 || typeof active.generationId !== 'string') {
      throw new ControlError('state_corrupt', 'Active generation pointer is invalid');
    }
    await this.get(active.generationId);
    return active;
  }

  async beginActivation(transactionId: string, target: GenerationMetadata, previous?: ActiveGeneration): Promise<void> {
    await atomicWriteJson(this.paths.activation, {
      version: 1,
      state: 'activating',
      transactionId,
      generationId: target.generationId,
      ...(previous ? { previousGenerationId: previous.generationId } : {}),
      ...(previous ? { previousPointer: previous } : {}),
      startedAt: Date.now(),
    });
  }

  async writeActive(target: GenerationMetadata, transactionId: string, previous?: ActiveGeneration): Promise<ActiveGeneration> {
    const pointer: ActiveGeneration = {
      version: 1,
      generationId: target.generationId,
      ...(previous && previous.generationId !== target.generationId
        ? { previousGenerationId: previous.generationId }
        : previous?.previousGenerationId ? { previousGenerationId: previous.previousGenerationId } : {}),
      transactionId,
      profileId: target.profileId,
      profileRevision: target.profileRevision,
      sha256: target.sha256,
      appliedAt: Date.now(),
    };
    await this.writeActiveFiles(pointer);
    return pointer;
  }

  async finishActivation(extra: JsonObject = {}): Promise<void> {
    const journal = await readJsonIfPresent<JsonObject>(this.paths.activation);
    if (journal) await atomicWriteJson(this.paths.activation, { ...journal, ...extra, state: 'complete', finishedAt: Date.now() });
    await removeIfPresent(this.paths.activation);
  }

  async recordActivationFailure(error: unknown, rollback: JsonObject): Promise<void> {
    const journal = await readJsonIfPresent<JsonObject>(this.paths.activation) ?? {};
    await atomicWriteJson(this.paths.activation, {
      ...journal,
      state: 'failed',
      failedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      rollback,
    });
  }

  async restoreActive(previous?: ActiveGeneration): Promise<void> {
    if (!previous) {
      await removeIfPresent(this.paths.active);
      await removeIfPresent(this.paths.activeConfig);
    } else {
      await this.get(previous.generationId);
      await this.writeActiveFiles(previous);
    }
  }

  private async writeActiveFiles(pointer: ActiveGeneration): Promise<void> {
    const content = await Deno.readTextFile(this.configPath(pointer.generationId));
    const actual = await sha256Hex(content);
    if (actual !== pointer.sha256) throw new ControlError('generation_corrupt', 'Generation content no longer matches its metadata');
    // procd uses this stable path. Activation replaces the bytes atomically;
    // the activation journal restores both this file and the pointer on error.
    await atomicWriteText(this.paths.activeConfig, content, 0o600);
    await atomicWriteJson(this.paths.active, pointer);
  }

  private async validateFile(path: string): Promise<{ ok: true; warnings: string[] }> {
    if (this.dryRun) return { ok: true, warnings: ['Mihomo validation skipped in dry-run mode.'] };
    if (!await pathExists(this.paths.mihomo)) throw new ControlError('dependency_missing', 'mihomo executable is unavailable');
    const result = await runCommand(
      this.paths.mihomo,
      ['-t', '-d', this.paths.mihomoWorkDir, '-f', path],
      { timeoutMs: 30_000, outputLimit: 1024 * 1024 },
    );
    if (!result.success) {
      throw new ControlError('config_invalid', result.stderr.trim() || result.stdout.trim() || 'Mihomo rejected the configuration');
    }
    const warnings = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => /warn/i.test(line)).slice(0, 100);
    return { ok: true, warnings };
  }

  private stageResult(metadata: GenerationMetadata, previousGenerationId?: string): JsonObject {
    return {
      generationId: metadata.generationId,
      path: this.configPath(metadata.generationId),
      sha256: metadata.sha256,
      ...(previousGenerationId ? { previousGenerationId } : {}),
      validation: metadata.validation,
    };
  }

  private directory(generationId: string): string {
    return `${this.paths.generationDir}/${generationId}`;
  }
}

function normalizeStageInput(input: JsonObject): StageInput {
  const transactionId = safeId(input.transactionId ?? `tx-${crypto.randomUUID()}`, 'transactionId');
  const profileId = safeId(input.profileId ?? 'anonymous', 'profileId');
  const profileRevision = optionalPositiveInteger(input.profileRevision, 'profileRevision') ?? 1;
  const name = requiredString(input.name ?? profileId, 'name', 1024);
  const compiledContent = requiredString(input.compiledContent, 'compiledContent', MAX_CONFIG_BYTES);
  const sha256 = input.sha256 === undefined ? undefined : requiredString(input.sha256, 'sha256', 64).toLowerCase();
  const networkConfig = input.networkConfig === undefined
    ? undefined
    : record(input.networkConfig, 'networkConfig');
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new ControlError('invalid_request', 'sha256 must be 64 lowercase hexadecimal characters');
  return { transactionId, profileId, profileRevision, name, compiledContent, sha256, networkConfig };
}

function validateContentSize(content: string): void {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (!content.trim()) throw new ControlError('config_invalid', 'Mihomo configuration must not be empty');
  if (bytes > MAX_CONFIG_BYTES) throw new ControlError('config_too_large', 'Mihomo configuration exceeds 5 MiB');
  if (content.includes('\0')) throw new ControlError('config_invalid', 'Mihomo configuration contains NUL bytes');
}
