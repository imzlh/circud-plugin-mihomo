import { safeJson, utf8Bytes } from './json.ts';
import {
  COMPILER_LIMITS,
  SCRIPT_RUNNER_LIMITS,
  SCRIPT_RUNNER_PROTOCOL,
  type ProfileConfig,
  type ScriptRunnerRequest,
  type ScriptRunnerResult,
} from './protocol.ts';

export function parseRunnerRequest(text: string): ScriptRunnerRequest {
  if (utf8Bytes(text) > SCRIPT_RUNNER_LIMITS.inputBytes) throw new Error('Runner input exceeds 12 MiB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Runner input is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runner envelope.');
  const input = value as Record<string, unknown>;
  const keys = new Set(Object.keys(input));
  for (const key of ['protocol', 'requestId', 'profileName', 'script', 'config']) keys.delete(key);
  if (keys.size || Object.keys(input).length !== 5) throw new Error('Runner envelope contains unknown or missing fields.');
  if (input.protocol !== SCRIPT_RUNNER_PROTOCOL || typeof input.requestId !== 'string' || !input.requestId ||
      typeof input.profileName !== 'string' || typeof input.script !== 'string')
    throw new Error('Invalid runner envelope.');
  if (utf8Bytes(input.requestId) > COMPILER_LIMITS.stageIdBytes ||
      utf8Bytes(input.profileName) > COMPILER_LIMITS.profileNameBytes ||
      !input.script.trim() || utf8Bytes(input.script) > COMPILER_LIMITS.scriptBytes)
    throw new Error('Runner input field exceeds its limit.');
  const config = safeJson(input.config) as ProfileConfig;
  if (!config || Array.isArray(config) || !Object.keys(config).length)
    throw new Error('Runner config must be a non-empty JSON mapping.');
  return {
    protocol: SCRIPT_RUNNER_PROTOCOL,
    requestId: input.requestId,
    profileName: input.profileName,
    script: input.script,
    config,
  };
}

export function serializeRunnerResult(result: ScriptRunnerResult): string {
  const safe = safeJson(result);
  const text = JSON.stringify(safe);
  if (utf8Bytes(text) > SCRIPT_RUNNER_LIMITS.outputBytes) throw new Error('Runner output exceeds 12 MiB.');
  return text;
}

export function runnerFailure(
  requestId: string,
  code: 'INVALID_INPUT' | 'SCRIPT_ERROR' | 'LIMIT_EXCEEDED' | 'INTERNAL_ERROR',
  message: string,
): ScriptRunnerResult {
  return {
    protocol: SCRIPT_RUNNER_PROTOCOL,
    requestId,
    ok: false,
    error: { code, message: message.slice(0, 16 * 1024) },
    logs: [],
  };
}
