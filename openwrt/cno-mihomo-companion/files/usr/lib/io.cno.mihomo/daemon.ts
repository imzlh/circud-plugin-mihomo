import {
  GenerationManager,
  type ActiveGeneration,
  type GenerationMetadata,
} from "./generations.ts";
import { NetworkManager } from "./network.ts";
import { ServiceManager, type DaemonConfig } from "./service.ts";
import {
  canonicalJson,
  CONTROL_VERBS,
  ControlError,
  decoder,
  delay,
  encoder,
  ensureDirectories,
  failed,
  isControlVerb,
  MAX_COMMAND_OUTPUT,
  MAX_CONTROL_BYTES,
  MAX_SCRIPT_RUNNER_OUTPUT,
  ok,
  optionalPositiveInteger,
  pathExists,
  readJsonIfPresent,
  readTextIfPresent,
  readStreamLimited,
  record,
  removeIfPresent,
  requiredString,
  rootDirectory,
  runCommand,
  runtimePaths,
  safeId,
  sha256Hex,
  writeAll,
  type ControlVerb,
  type Envelope,
  type JsonObject,
  type RuntimePaths,
} from "./runtime.ts";

interface RequestEnvelope {
  version: 1;
  verb: ControlVerb;
  input: JsonObject;
}

interface LoadedConfig extends DaemonConfig {
  redirectPort: number;
  tproxyPort: number;
  dnsPort: number;
  routeMark: number;
  bypassMark: number;
  routeTable: number;
  ipv4RulePriority: number;
  ipv6RulePriority: number;
}

const paths = runtimePaths(rootDirectory());
let shuttingDown = false;
let server: Deno.HttpServer<Deno.UnixAddr> | undefined;
let queue: Promise<unknown> = Promise.resolve();

async function main(): Promise<void> {
  await ensureDirectories(paths);
  const config = await loadConfig(paths);
  const application = new Application(paths, config);
  await application.initialize();
  await removeIfPresent(paths.socket);
  server = Deno.serve(
    {
      path: paths.socket,
      onListen: () => undefined,
    },
    async (request) => {
      if (request.method !== "POST")
        return jsonResponse(
          failed(
            new ControlError(
              "method_not_allowed",
              "Control socket accepts POST only",
            ),
          ),
          405,
        );
      try {
        const bytes = await readStreamLimited(
          request.body ?? new ReadableStream(),
          MAX_CONTROL_BYTES,
        );
        const payload = parseRequest(decoder.decode(bytes));
        const envelope = await enqueue(() =>
          application.handle(payload.verb, payload.input),
        );
        return jsonResponse(envelope, 200);
      } catch (error) {
        return jsonResponse(failed(error), 200);
      }
    },
  );

  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server?.shutdown().catch(() => undefined);
  };
  try {
    Deno.addSignalListener("SIGTERM", stop);
  } catch {
    /* signal API unavailable */
  }
  try {
    Deno.addSignalListener("SIGINT", stop);
  } catch {
    /* signal API unavailable */
  }
  await server.finished;
  await application.shutdown();
  await removeIfPresent(paths.socket);
}

export class Application {
  private readonly generations: GenerationManager;
  private readonly network: NetworkManager;
  private readonly service: ServiceManager;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly config: LoadedConfig,
  ) {
    this.generations = new GenerationManager(paths, config.dryRun);
    this.network = new NetworkManager(paths, config.dryRun, {
      redirect: config.redirectPort,
      tproxy: config.tproxyPort,
      dns: config.dnsPort,
      routeMark: config.routeMark,
      bypassMark: config.bypassMark,
      routeTable: config.routeTable,
      ipv4RulePriority: config.ipv4RulePriority,
      ipv6RulePriority: config.ipv6RulePriority,
    });
    this.service = new ServiceManager(paths, config);
  }

  async initialize(): Promise<void> {
    await this.generations.recoverInterruptedActivation();
    await this.network.initialize();
    await this.service.initialize();
    if (this.network.publicValue().desired) {
      try {
        await this.network.reconcile();
      } catch (error) {
        console.error(
          `cno-mihomod: network recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    // ServiceManager.shutdown is intentionally non-destructive: procd owns
    // Mihomo independently from this management daemon.
    await this.service.shutdown();
  }

  async handle(verb: ControlVerb, input: JsonObject): Promise<Envelope> {
    try {
      switch (verb) {
        case "capabilities":
          return ok(this.capabilities());
        case "status":
        case "status.get":
          return ok(await this.status());
        case "profile.compile":
          return ok(await this.compile(input));
        case "profile.apply":
          return ok(await this.applyProfile(input));
        case "generation.stage":
          return ok(await this.generations.stage(input));
        case "generation.activate":
          return ok(await this.activate(input));
        case "generation.rollback":
          return ok(await this.rollback(input));
        case "service.start":
          return ok(await this.service.start());
        case "service.reload":
          return ok(await this.service.reload());
        case "service.restart":
          return ok(await this.service.restart());
        case "service.stop":
          return ok(await this.stopService());
        case "network.enable":
          return ok(await this.network.enable(input));
        case "network.disable":
          return ok(await this.network.disable(input));
        case "network.reconcile":
          return ok(await this.network.reconcile(input));
        case "script.run":
          return await this.runScript(input);
      }
    } catch (error) {
      return failed(error);
    }
  }

  private capabilities(): JsonObject {
    return {
      protocolVersion: 1,
      implementation: "io.cno.mihomo.openwrt",
      verbs: [...CONTROL_VERBS],
      atomicGenerations: true,
      generationRollback: true,
      networkOwnershipJournal: true,
      failOpen: true,
      mihomoSupervision: "procd",
      scriptIsolation: "fresh-cno-process",
      networkModes: ["redirect", "tproxy", "tun"],
      tunOwnership: "mihomo-device-companion-routes",
      dryRun: this.config.dryRun,
    };
  }

  private async status(): Promise<JsonObject> {
    const active = await this.generations.active();
    const network = this.network.managedStatus();
    return {
      service: await this.service.status(),
      controller: this.service.controllerStatus(),
      config: active
        ? {
            state: "active",
            activeProfileId: active.profileId,
            activeRevision: active.profileRevision,
            generationId: active.generationId,
            ...(active.previousGenerationId
              ? { previousGenerationId: active.previousGenerationId }
              : {}),
            sha256: active.sha256,
            appliedAt: active.appliedAt,
            lastTransactionId: active.transactionId,
          }
        : { state: "pending" },
      network,
      networkConfig: this.network.publicValue(),
    };
  }

  private async compile(input: JsonObject): Promise<JsonObject> {
    const content = profileContent(input);
    const profile =
      input.profile && typeof input.profile === "object"
        ? (input.profile as JsonObject)
        : {};
    const enhancement = input.enhancement ?? input.globalEnhancement;
    if (
      enhancement !== undefined &&
      enhancement !== null &&
      canonicalJson(enhancement) !== "{}"
    ) {
      throw new ControlError(
        "enhancement_unsupported",
        "profile.compile accepts already compiled YAML; execute enhancement stages in the package compiler or script.run first",
      );
    }
    const validation = await this.generations.validateContent(content);
    const sha256 = await sha256Hex(content);
    const signature = await sha256Hex(
      canonicalJson({
        profileId: input.profileId ?? profile.id ?? "anonymous",
        profileRevision: input.profileRevision ?? profile.revision ?? 1,
        content: sha256,
        enhancement: enhancement ?? null,
      }),
    );
    if (
      input.expectedSignature !== undefined &&
      input.expectedSignature !== signature
    ) {
      throw new ControlError(
        "enhancement_signature_mismatch",
        "Compiler inputs changed since preview",
        { expected: input.expectedSignature, actual: signature },
      );
    }
    return {
      compiledContent: content,
      sha256,
      enhancementSignature: signature,
      warnings: validation.warnings,
      logs: [],
    };
  }

  private async applyProfile(input: JsonObject): Promise<JsonObject> {
    const compiled = await this.compile(input);
    const profile =
      input.profile && typeof input.profile === "object"
        ? (input.profile as JsonObject)
        : input;
    const transactionId = safeId(
      input.transactionId ?? `tx-${crypto.randomUUID()}`,
      "transactionId",
    );
    const profileId = safeId(
      input.profileId ?? profile.id ?? "anonymous",
      "profileId",
    );
    const profileRevision =
      optionalPositiveInteger(
        input.profileRevision ?? profile.revision,
        "profileRevision",
      ) ?? 1;
    const staged = await this.generations.stage({
      transactionId,
      profileId,
      profileRevision,
      name: input.name ?? profile.name ?? profileId,
      compiledContent: compiled.compiledContent,
      sha256: compiled.sha256,
      networkConfig: input.networkConfig,
    });
    const activated = await this.activate({
      transactionId,
      generationId: staged.generationId,
      expectedActiveGenerationId: input.expectedActiveGenerationId,
      networkRevision: input.networkRevision,
      networkConfig: input.networkConfig,
    });
    return {
      transactionId,
      profileId,
      profileRevision,
      generationId: staged.generationId,
      previousGenerationId: activated.previousGenerationId,
      sha256: compiled.sha256,
      enhancementSignature: compiled.enhancementSignature,
      appliedAt: activated.appliedAt,
      service: activated.service,
      network: activated.network,
      warnings: compiled.warnings,
      logs: compiled.logs,
    };
  }

  private async activate(input: JsonObject): Promise<JsonObject> {
    const transactionId = safeId(
      input.transactionId ?? `tx-${crypto.randomUUID()}`,
      "transactionId",
    );
    const generationId = safeId(input.generationId, "generationId");
    const target = await this.generations.get(generationId);
    const previous = await this.generations.active();
    const previousNetwork = this.network.checkpoint();
    assertActiveCas(input.expectedActiveGenerationId, previous);
    const networkRevision = optionalPositiveInteger(
      input.networkRevision,
      "networkRevision",
    );
    if (
      networkRevision !== undefined &&
      networkRevision !== this.network.publicValue().revision
    ) {
      throw new ControlError(
        "network_revision_conflict",
        "Network configuration changed before activation",
        {
          expected: networkRevision,
          current: this.network.publicValue().revision,
        },
      );
    }
    await this.generations.beginActivation(transactionId, target, previous);
    let pointer: ActiveGeneration | undefined;
    try {
      pointer = await this.generations.writeActive(
        target,
        transactionId,
        previous,
      );
      const serviceResult = await this.service.restartGeneration();
      const desiredNetwork = input.networkConfig ?? target.networkConfig;
      const networkResult = await this.network.reconcile(
        desiredNetwork === undefined
          ? {}
          : { config: record(desiredNetwork, "networkConfig") },
      );
      await this.generations.finishActivation({
        service: serviceResult.service,
        network: networkResult,
      });
      return {
        generationId,
        ...(previous ? { previousGenerationId: previous.generationId } : {}),
        appliedAt: pointer.appliedAt,
        service: {
          restarted: true,
          controllerHealthy: this.service.controllerStatus().reachable === true,
          ...this.service.controllerStatus(),
        },
        network: {
          revision: this.network.publicValue().revision,
          state: this.network.publicValue().state,
        },
        rollback: { attempted: false },
      };
    } catch (error) {
      const rollback: JsonObject = { attempted: true, succeeded: false };
      try {
        await this.service.stopForRollback(false);
        await this.generations.restoreActive(previous);
        if (previous) {
          await this.service.restartGeneration();
          await this.network.restore(previousNetwork);
        } else
          await this.network.failOpen(
            "Activation failed before any generation became healthy",
          );
        rollback.succeeded = true;
      } catch (rollbackError) {
        rollback.error =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        try {
          await this.network.failOpen("Generation rollback failed");
        } catch {
          /* error is already recorded */
        }
      }
      await this.generations.recordActivationFailure(error, rollback);
      throw new ControlError(
        "activation_failed",
        error instanceof Error ? error.message : "Generation activation failed",
        {
          phase: pointer ? "service_or_network" : "pointer",
          rollback,
        },
      );
    }
  }

  private async rollback(input: JsonObject): Promise<JsonObject> {
    const active = await this.generations.active();
    const targetId = input.toGenerationId ?? active?.previousGenerationId;
    if (typeof targetId !== "string")
      throw new ControlError(
        "rollback_unavailable",
        "No previous generation is available",
      );
    return await this.activate({
      transactionId: input.transactionId ?? `rollback-${crypto.randomUUID()}`,
      generationId: targetId,
      expectedActiveGenerationId:
        input.expectedActiveGenerationId ?? active?.generationId,
      networkRevision: input.networkRevision,
      networkConfig: input.networkConfig,
    });
  }

  private async stopService(): Promise<JsonObject> {
    // A stopped core cannot accept intercepted traffic. Fail closed here would
    // black-hole the router, so explicit stop withdraws the owned rules first.
    const network = await this.network.withdraw();
    const service = await this.service.stop();
    return { ...service, network };
  }

  private async runScript(input: JsonObject): Promise<Envelope> {
    const source = requiredString(input.source, "source", 1024 * 1024);
    const profileName =
      typeof input.profileName === "string" ? input.profileName : "";
    const configJson = record(input.configJson, "configJson");
    const timeoutMs = clampInteger(
      input.timeoutMs,
      5000,
      100,
      8000,
      "timeoutMs",
    );
    const memoryBytes = clampInteger(
      input.memoryBytes,
      64 * 1024 * 1024,
      8 * 1024 * 1024,
      64 * 1024 * 1024,
      "memoryBytes",
    );
    if (this.config.dryRun && !(await pathExists(this.paths.cno))) {
      return failed(
        new ControlError(
          "script_unavailable",
          "cno is unavailable in dry-run root",
        ),
      );
    }
    const result = await runCommand(
      this.paths.cno,
      ["run", this.paths.scriptRunner],
      {
        input: encoder.encode(
          JSON.stringify({ source, profileName, configJson, memoryBytes }),
        ),
        timeoutMs,
        outputLimit: MAX_SCRIPT_RUNNER_OUTPUT,
        env: {},
      },
    ).catch((error) => {
      if (error instanceof ControlError && error.code === "command_timeout")
        throw new ControlError(
          "script_timeout",
          "Profile script exceeded its watchdog",
        );
      throw error;
    });
    const text = result.stdout.trim();
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      throw new ControlError(
        "script_failed",
        result.stderr.trim() || "Script runner returned invalid JSON",
      );
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      typeof envelope.ok !== "boolean"
    ) {
      throw new ControlError(
        "script_failed",
        "Script runner returned an invalid envelope",
      );
    }
    return envelope;
  }
}

async function loadConfig(paths: RuntimePaths): Promise<LoadedConfig> {
  const value = (await readJsonIfPresent<JsonObject>(paths.daemonConfig)) ?? {};
  const secretFile = await readTextIfPresent(paths.controllerSecret);
  const controllerSecret = secretFile?.trim() ?? "";
  if (controllerSecret.length > 4096)
    throw new ControlError(
      "invalid_config",
      "Controller secret exceeds 4096 characters",
    );
  const dryRun =
    Deno.env.get("CNO_MIHOMO_DRY_RUN") === "1" || value.dryRun === true;
  const number = (
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number => clampInteger(value[key], fallback, minimum, maximum, key);
  const controllerUrl =
    typeof value.controllerUrl === "string"
      ? value.controllerUrl
      : "http://127.0.0.1:9090";
  return {
    dryRun,
    controllerUrl,
    ...(controllerSecret ? { controllerSecret } : {}),
    requireControllerHealth: value.requireControllerHealth !== false,
    healthTimeoutMs: number("healthTimeoutMs", 15_000, 1_000, 60_000),
    shutdownTimeoutMs: number("shutdownTimeoutMs", 10_000, 1_000, 60_000),
    restartDelayMs: number("restartDelayMs", 1_000, 100, 60_000),
    redirectPort: number("redirectPort", 7892, 1, 65535),
    tproxyPort: number("tproxyPort", 7893, 1, 65535),
    dnsPort: number("dnsPort", 1053, 1, 65535),
    routeMark: number("routeMark", 0x162, 1, 0xffff),
    bypassMark: number("bypassMark", 0x163, 1, 0xffff),
    routeTable: number("routeTable", 162, 1, 252),
    ipv4RulePriority: number("ipv4RulePriority", 11062, 1, 32765),
    ipv6RulePriority: number("ipv6RulePriority", 11063, 1, 32765),
  };
}

function parseRequest(text: string): RequestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ControlError("invalid_json", "Control request is not valid JSON");
  }
  const input = record(value, "control request");
  if (input.version !== 1)
    throw new ControlError(
      "unsupported_protocol",
      "Control protocol version must be 1",
    );
  if (typeof input.verb !== "string" || !isControlVerb(input.verb))
    throw new ControlError("unknown_verb", "Control verb is not supported");
  return {
    version: 1,
    verb: input.verb,
    input: record(input.input ?? {}, "input"),
  };
}

function jsonResponse(envelope: Envelope, status: number): Response {
  return new Response(`${JSON.stringify(envelope)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function assertActiveCas(
  expected: unknown,
  active: ActiveGeneration | undefined,
): void {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== "string")
    throw new ControlError(
      "invalid_request",
      "expectedActiveGenerationId must be a string or null",
    );
  if (expected !== active?.generationId)
    throw new ControlError(
      "active_generation_conflict",
      "Active generation changed",
      {
        expected,
        current: active?.generationId ?? null,
      },
    );
}

function profileContent(input: JsonObject): string {
  if (typeof input.content === "string")
    return requiredString(input.content, "content", 5 * 1024 * 1024);
  if (input.profile && typeof input.profile === "object") {
    return requiredString(
      (input.profile as JsonObject).content,
      "profile.content",
      5 * 1024 * 1024,
    );
  }
  throw new ControlError(
    "invalid_request",
    "content or profile.content is required",
  );
}

function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new ControlError(
      "invalid_config",
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

if (import.meta.main) {
  void main().catch(async (error) => {
    console.error(
      `cno-mihomod: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    await delay(10);
    Deno.exit(1);
  });
}
