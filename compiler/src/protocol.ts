export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ProfileConfig = Record<string, JsonValue>;

export const COMPILER_PROTOCOL = 'mihomo-profile-compiler/v1' as const;
export const SCRIPT_RUNNER_PROTOCOL = 'mihomo-profile-script-runner/v1' as const;

export const COMPILER_LIMITS = Object.freeze({
  requestBytes: 12 * 1024 * 1024,
  yamlBytes: 5 * 1024 * 1024,
  scriptBytes: 1024 * 1024,
  profileNameBytes: 1024,
  configBytes: 10 * 1024 * 1024,
  maxDepth: 100,
  maxNodes: 250_000,
  stageCount: 64,
  stageIdBytes: 256,
});

export const SCRIPT_RUNNER_LIMITS = Object.freeze({
  inputBytes: 12 * 1024 * 1024,
  outputBytes: 12 * 1024 * 1024,
  logCount: 1000,
  logBytes: 1024 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  watchdogMs: 8000,
});

export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'table';
  message: string;
}

export type PipelineStage =
  | { id: string; kind: 'seq'; target: 'rules' | 'proxies' | 'groups'; yaml: string }
  | { id: string; kind: 'merge'; yaml: string }
  | { id: string; kind: 'script'; script: string };

export interface CompileRequest {
  protocol: typeof COMPILER_PROTOCOL;
  profileName: string;
  sourceYaml: string;
  pipeline: PipelineStage[];
}

export interface CompileStageResult {
  id: string;
  kind: PipelineStage['kind'] | 'cleanup';
  changedKeys: string[];
}

export interface CompileSuccess {
  protocol: typeof COMPILER_PROTOCOL;
  ok: true;
  revision: string;
  contentHash: string;
  content: string;
  logs: (ScriptLog & { stage: string })[];
  stages: CompileStageResult[];
  changedKeys: string[];
}

export interface CompileFailure {
  protocol: typeof COMPILER_PROTOCOL;
  ok: false;
  code: CompilerErrorCode;
  message: string;
  stage?: string;
  logs: (ScriptLog & { stage: string })[];
  stages: CompileStageResult[];
}

export type CompileResult = CompileSuccess | CompileFailure;
export type CompilerErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_YAML'
  | 'LIMIT_EXCEEDED'
  | 'SCRIPT_FAILED'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export interface ScriptRunnerRequest {
  protocol: typeof SCRIPT_RUNNER_PROTOCOL;
  requestId: string;
  profileName: string;
  script: string;
  config: ProfileConfig;
}

export type ScriptRunnerResult =
  | {
      protocol: typeof SCRIPT_RUNNER_PROTOCOL;
      requestId: string;
      ok: true;
      config: ProfileConfig;
      logs: ScriptLog[];
    }
  | {
      protocol: typeof SCRIPT_RUNNER_PROTOCOL;
      requestId: string;
      ok: false;
      error: { code: 'INVALID_INPUT' | 'SCRIPT_ERROR' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR'; message: string };
      logs: ScriptLog[];
    };

export interface ScriptRunner {
  run(request: ScriptRunnerRequest, options?: { signal?: AbortSignal }): Promise<ScriptRunnerResult>;
}
