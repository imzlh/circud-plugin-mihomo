import { isMap, isSeq, parseDocument, stringify } from 'yaml';
import { jsonMap, safeJson, sha256, stableStringify, utf8Bytes, type Sha256 } from './json.ts';
import {
  COMPILER_LIMITS,
  COMPILER_PROTOCOL,
  SCRIPT_RUNNER_PROTOCOL,
  type CompileFailure,
  type CompileRequest,
  type CompileResult,
  type CompileStageResult,
  type CompilerErrorCode,
  type JsonValue,
  type PipelineStage,
  type ProfileConfig,
  type ScriptLog,
  type ScriptRunner,
} from './protocol.ts';

class CompileError extends Error {
  constructor(public readonly code: CompilerErrorCode, message: string) {
    super(message);
  }
}

function invalid(code: CompilerErrorCode, message: string): never {
  throw new CompileError(code, message);
}

export function parseProfileYaml(content: string): ProfileConfig {
  if (typeof content !== 'string' || !content.trim()) invalid('INVALID_YAML', 'YAML must be a non-empty mapping.');
  if (utf8Bytes(content) > COMPILER_LIMITS.yamlBytes) invalid('LIMIT_EXCEEDED', 'YAML exceeds 5 MiB.');
  const document = parseDocument(content, { merge: true, uniqueKeys: true });
  if (document.errors.length) invalid('INVALID_YAML', document.errors[0]!.message);
  if (document.warnings.length) invalid('INVALID_YAML', document.warnings[0]!.message);
  if (!isMap(document.contents)) invalid('INVALID_YAML', 'YAML root must be a mapping.');
  const pending: { node: unknown; depth: number }[] = [{ node: document.contents, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > COMPILER_LIMITS.maxDepth) invalid('LIMIT_EXCEEDED', 'YAML nesting exceeds 100 levels.');
    if (++nodes > COMPILER_LIMITS.maxNodes) invalid('LIMIT_EXCEEDED', 'YAML node count exceeds the limit.');
    if (isMap(node)) for (const pair of node.items)
      pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
    else if (isSeq(node)) for (const child of node.items) pending.push({ node: child, depth: depth + 1 });
  }
  try {
    const output = safeJson(document.toJS({ mapAsMap: true, maxAliasCount: 100 }));
    if (!jsonMap(output)) invalid('INVALID_YAML', 'YAML root must be a mapping.');
    return output;
  } catch (error) {
    invalid('INVALID_YAML', error instanceof Error ? error.message : 'Invalid YAML value.');
  }
}

const asciiLowercase = (key: string) => key.replace(/[A-Z]/g, (character) => character.toLowerCase());
function lowercase(config: ProfileConfig): ProfileConfig {
  const output: ProfileConfig = Object.create(null);
  for (const [key, value] of Object.entries(config)) output[asciiLowercase(key)] = value;
  return output;
}

function equal(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function changedKeys(before: ProfileConfig, after: ProfileConfig): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => Object.hasOwn(before, key) !== Object.hasOwn(after, key) || !equal(before[key], after[key]),
  );
}

export function applyMerge(config: ProfileConfig, overlay: ProfileConfig): ProfileConfig {
  const mergeMap = (target: ProfileConfig, source: ProfileConfig, root: boolean) => {
    for (const [key, value] of Object.entries(source)) {
      const old = Object.hasOwn(target, key) ? target[key] : undefined;
      if (root && key === 'hosts') target[key] = value;
      else if (jsonMap(old) && jsonMap(value)) {
        if (root && key === 'dns') for (const [childKey, child] of Object.entries(value)) old[childKey] = child;
        else mergeMap(old, value, false);
      } else target[key] = value;
    }
  };
  mergeMap(config, lowercase(overlay), true);
  return config;
}

function entryName(value: JsonValue): string | undefined {
  if (typeof value === 'string') return value;
  return jsonMap(value) && typeof value.name === 'string' ? value.name : undefined;
}

export function applySequence(
  config: ProfileConfig,
  target: 'rules' | 'proxies' | 'groups',
  patch: ProfileConfig,
): ProfileConfig {
  const { prepend, append, delete: removed } = patch;
  if (!Array.isArray(prepend) || !Array.isArray(append) || !Array.isArray(removed) ||
      !removed.every((item) => typeof item === 'string'))
    invalid('INVALID_REQUEST', 'Seq requires prepend, append and delete arrays; delete entries must be strings.');
  const key = target === 'groups' ? 'proxy-groups' : target;
  const removals = new Set(removed as string[]);
  const previous = Array.isArray(config[key]) ? config[key] : [];
  config[key] = [...prepend, ...previous.filter((entry) => {
    const name = entryName(entry);
    return name === undefined || !removals.has(name);
  }), ...append];
  if (target === 'proxies' && Array.isArray(config['proxy-groups'])) {
    const additions = [...new Set([...prepend, ...append].map(entryName).filter((name): name is string => name !== undefined))];
    let selectorSeen = false;
    for (const group of config['proxy-groups']) {
      if (!jsonMap(group)) continue;
      if (Array.isArray(group.proxies))
        group.proxies = group.proxies.filter((name) => typeof name !== 'string' || !removals.has(name));
      if (!selectorSeen && additions.length && typeof group.type === 'string' &&
          ['select', 'selector'].includes(asciiLowercase(group.type))) {
        selectorSeen = true;
        const seen = new Set<string>();
        group.proxies = [...additions, ...(Array.isArray(group.proxies) ? group.proxies : [])].filter((name) => {
          if (typeof name !== 'string') return true;
          if (seen.has(name)) return false;
          seen.add(name);
          return true;
        });
      }
    }
  }
  return config;
}

function cleanup(config: ProfileConfig): void {
  const providers = new Set(jsonMap(config['proxy-providers']) ? Object.keys(config['proxy-providers']) : []);
  const names = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', ...providers]);
  if (Array.isArray(config.proxies)) for (const proxy of config.proxies) {
    const name = entryName(proxy); if (name !== undefined) names.add(name);
  }
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  for (const group of groups) if (jsonMap(group) && typeof group.name === 'string') names.add(group.name);
  for (const group of groups) {
    if (!jsonMap(group)) continue;
    let hasProvider = false;
    if (Array.isArray(group.use)) {
      group.use = group.use.filter((name) => typeof name === 'string' && providers.has(name));
      hasProvider = group.use.length > 0;
    }
    if (Array.isArray(group.proxies))
      group.proxies = group.proxies.filter((name) => typeof name !== 'string' || hasProvider || names.has(name));
  }
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.delete(key)) && expected.size === 0;
}

function validateRequest(request: CompileRequest): void {
  if (!request || request.protocol !== COMPILER_PROTOCOL || typeof request.profileName !== 'string' ||
      typeof request.sourceYaml !== 'string' || !Array.isArray(request.pipeline) ||
      !hasOnlyKeys(request, ['protocol', 'profileName', 'sourceYaml', 'pipeline']))
    invalid('INVALID_REQUEST', 'Invalid compiler request envelope.');
  if (utf8Bytes(request.profileName) > COMPILER_LIMITS.profileNameBytes)
    invalid('LIMIT_EXCEEDED', 'Profile name exceeds 1024 bytes.');
  if (request.pipeline.length > COMPILER_LIMITS.stageCount) invalid('LIMIT_EXCEEDED', 'Pipeline has too many stages.');
  const ids = new Set<string>();
  for (const stage of request.pipeline) {
    if (!stage || typeof stage.id !== 'string' || !stage.id || utf8Bytes(stage.id) > COMPILER_LIMITS.stageIdBytes || ids.has(stage.id))
      invalid('INVALID_REQUEST', 'Pipeline stage ids must be unique non-empty strings up to 256 bytes.');
    ids.add(stage.id);
    if (stage.kind === 'script') {
      if (!hasOnlyKeys(stage, ['id', 'kind', 'script'])) invalid('INVALID_REQUEST', 'Script stage contains unknown fields.');
      if (typeof stage.script !== 'string' || !stage.script.trim()) invalid('INVALID_REQUEST', 'Script stage is empty.');
      if (utf8Bytes(stage.script) > COMPILER_LIMITS.scriptBytes) invalid('LIMIT_EXCEEDED', 'Script exceeds 1 MiB.');
    } else if ((stage.kind === 'merge' || stage.kind === 'seq') && typeof stage.yaml === 'string') {
      if (!hasOnlyKeys(stage, stage.kind === 'merge' ? ['id', 'kind', 'yaml'] : ['id', 'kind', 'target', 'yaml']))
        invalid('INVALID_REQUEST', 'Pipeline stage contains unknown fields.');
      if (stage.kind === 'seq' && !['rules', 'proxies', 'groups'].includes(stage.target))
        invalid('INVALID_REQUEST', 'Invalid Seq target.');
    } else invalid('INVALID_REQUEST', 'Unknown or malformed pipeline stage.');
  }
}

function failure(
  code: CompilerErrorCode,
  message: string,
  logs: (ScriptLog & { stage: string })[],
  stages: CompileStageResult[],
  stage?: string,
): CompileFailure {
  return { protocol: COMPILER_PROTOCOL, ok: false, code, message, ...(stage ? { stage } : {}), logs, stages };
}

export async function compileProfile(
  input: CompileRequest,
  options: { runner?: ScriptRunner; signal?: AbortSignal; sha256?: Sha256 } = {},
): Promise<CompileResult> {
  const logs: (ScriptLog & { stage: string })[] = [];
  const stages: CompileStageResult[] = [];
  let active: PipelineStage | undefined;
  try {
    let normalized: JsonValue;
    try {
      normalized = safeJson(input, COMPILER_LIMITS.requestBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid compiler request.';
      invalid(message.includes('byte limit') ? 'LIMIT_EXCEEDED' : 'INVALID_REQUEST', message);
    }
    if (!jsonMap(normalized)) invalid('INVALID_REQUEST', 'Invalid compiler request envelope.');
    const request = normalized as unknown as CompileRequest;
    validateRequest(request);
    if (options.signal?.aborted) invalid('CANCELLED', 'Compilation cancelled.');
    const original = parseProfileYaml(request.sourceYaml);
    let config = safeJson(original) as ProfileConfig;
    for (const stage of request.pipeline) {
      active = stage;
      if (options.signal?.aborted) invalid('CANCELLED', 'Compilation cancelled.');
      const before = safeJson(config) as ProfileConfig;
      if (stage.kind === 'merge') config = applyMerge(config, parseProfileYaml(stage.yaml));
      else if (stage.kind === 'seq') config = applySequence(config, stage.target, parseProfileYaml(stage.yaml));
      else {
        if (!options.runner) invalid('SCRIPT_FAILED', 'Script runner is unavailable.');
        const result = await options.runner.run({
          protocol: SCRIPT_RUNNER_PROTOCOL,
          requestId: stage.id,
          profileName: request.profileName,
          script: stage.script,
          config: lowercase(config),
        }, { signal: options.signal });
        if (result.protocol !== SCRIPT_RUNNER_PROTOCOL || result.requestId !== stage.id)
          invalid('SCRIPT_FAILED', 'Script runner returned a mismatched envelope.');
        logs.push(...result.logs.map((log) => ({ ...log, stage: stage.id })));
        if (!result.ok) invalid('SCRIPT_FAILED', result.error.message);
        const output = safeJson(result.config);
        if (!jsonMap(output)) invalid('SCRIPT_FAILED', 'Script must return a non-empty JSON mapping.');
        config = lowercase(output);
      }
      config = safeJson(config, COMPILER_LIMITS.yamlBytes) as ProfileConfig;
      stages.push({ id: stage.id, kind: stage.kind, changedKeys: changedKeys(before, config) });
    }
    active = undefined;
    const beforeCleanup = safeJson(config) as ProfileConfig;
    cleanup(config);
    stages.push({ id: 'cleanup', kind: 'cleanup', changedKeys: changedKeys(beforeCleanup, config) });
    const content = request.pipeline.length
      ? stringify(config, { lineWidth: 0, aliasDuplicateObjects: false })
      : request.sourceYaml;
    if (utf8Bytes(content) > COMPILER_LIMITS.yamlBytes) invalid('LIMIT_EXCEEDED', 'Generated YAML exceeds 5 MiB.');
    const digest = options.sha256 ?? sha256;
    const revision = await digest(`${COMPILER_PROTOCOL}\0${stableStringify(normalized)}`);
    const contentHash = await digest(content);
    return {
      protocol: COMPILER_PROTOCOL, ok: true, revision, contentHash, content,
      logs, stages: request.pipeline.length ? stages : [], changedKeys: changedKeys(original, config),
    };
  } catch (error) {
    const code = error instanceof CompileError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof Error ? error.message : 'Profile compilation failed.';
    return failure(code, message, logs, stages, active?.id);
  }
}
