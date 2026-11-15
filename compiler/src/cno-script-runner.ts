import { safeJson, stableStringify, utf8Bytes } from "./json.ts";
import {
  parseRunnerRequest,
  runnerFailure,
  serializeRunnerResult,
} from "./runner-protocol.ts";
import {
  SCRIPT_RUNNER_LIMITS,
  SCRIPT_RUNNER_PROTOCOL,
  type ProfileConfig,
  type ScriptLog,
  type ScriptRunnerRequest,
  type ScriptRunnerResult,
} from "./protocol.ts";

interface CnoEngine {
  EVAL_GLOBAL: number;
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  Sandbox: new () => {
    initGlobal(features?: string[]): void;
    call<T>(code: string, name?: string): T;
    global: Record<string, unknown>;
  };
}

declare global {
  interface ImportMeta {
    use(name: "engine"): CnoEngine;
  }
  const Deno: {
    stdin: { readable: ReadableStream<Uint8Array> };
    stdout: { write(data: Uint8Array): Promise<number> };
    stderr: { write(data: Uint8Array): Promise<number> };
    exit(code?: number): never;
  };
}

const bootstrap = `(() => {
  const parse = JSON.parse, stringify = JSON.stringify, keys = Object.keys;
  const functionSource = Function.prototype.toString;
  const symbols = Object.getOwnPropertySymbols, descriptor = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf, objectPrototype = Object.prototype;
  const isArray = Array.isArray, finite = Number.isFinite, asString = String;
  const emit = globalThis.__emit__; delete globalThis.__emit__;
  const console = {};
  for (const level of ['log','info','warn','error','debug','table']) console[level] = (...args) => {
    let message = '';
    for (let i = 0; i < args.length; i++) {
      const text = stringify(args[i], null, 2);
      message += (i ? ' ' : '') + (text === undefined ? asString(args[i]) : text);
    }
    emit(level, message);
  };
  Object.defineProperty(globalThis, 'console', { value: Object.freeze(console), writable: false, configurable: false });
  function serialize(value) {
    if (!value || typeof value !== 'object' || isArray(value) || !keys(value).length)
      throw new Error('main must synchronously return a non-empty JSON mapping.');
    const ancestors = [];
    function visit(item, depth) {
      if (depth > 100) throw new Error('Script result nesting exceeds 100 levels.');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return stringify(item);
      if (typeof item === 'number' && finite(item)) return stringify(item);
      if (!item || typeof item !== 'object') throw new Error('Script result contains a non-JSON value.');
      const array = isArray(item), proto = prototype(item);
      if (!array && proto !== objectPrototype && proto !== null) throw new Error('Script result must be plain JSON.');
      if (symbols(item).length) throw new Error('Script result contains Symbol properties.');
      for (const ancestor of ancestors) if (ancestor === item) throw new Error('Script result contains a cycle.');
      ancestors.push(item); const names = keys(item);
      if (array && names.length !== item.length) throw new Error('Script result contains a sparse array.');
      let output = array ? '[' : '{';
      for (let i = 0; i < names.length; i++) {
        const key = array ? asString(i) : names[i], field = descriptor(item, key);
        if (!field || !('value' in field)) throw new Error('Script result contains an accessor.');
        output += (i ? ',' : '') + (array ? '' : stringify(key) + ':') + visit(field.value, depth + 1);
      }
      ancestors.pop(); return output + (array ? ']' : '}');
    }
    return visit(value, 0);
  }
  const config = parse(globalThis.__config_json__); delete globalThis.__config_json__;
  const profileName = globalThis.__profile_name__; delete globalThis.__profile_name__;
  (0, eval)(globalThis.__script__); delete globalThis.__script__;
  if (typeof main !== 'function') throw new Error('Script must define main(config, profileName).');
  const mainTag = Object.prototype.toString.call(main);
  const mainSource = functionSource.call(main).trimStart();
  if (mainTag === '[object AsyncFunction]' || mainTag === '[object AsyncGeneratorFunction]' || mainSource.slice(0, 5) === 'async')
    throw new Error('main must return synchronously.');
  return serialize(main(config, profileName));
})()`;

export function evaluateInCno(
  request: ScriptRunnerRequest,
  engine: CnoEngine,
): ScriptRunnerResult {
  const logs: ScriptLog[] = [];
  let logBytes = 0;
  try {
    // This runner is one-shot, so process-runtime limits are also per invocation.
    engine.setMemoryLimit(SCRIPT_RUNNER_LIMITS.memoryBytes);
    engine.setMaxStackSize(SCRIPT_RUNNER_LIMITS.stackBytes);
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal(["json", "map", "typedarrays", "bigint"]);
    sandbox.global.__config_json__ = stableStringify(request.config);
    sandbox.global.__profile_name__ = request.profileName;
    sandbox.global.__script__ = request.script;
    sandbox.global.__emit__ = (level: ScriptLog["level"], message: string) => {
      if (!["log", "info", "warn", "error", "debug", "table"].includes(level))
        throw new Error("Invalid log level.");
      const bytes = utf8Bytes(level) + utf8Bytes(message);
      if (
        logs.length >= SCRIPT_RUNNER_LIMITS.logCount ||
        logBytes + bytes > SCRIPT_RUNNER_LIMITS.logBytes
      )
        throw new Error("Script log limit exceeded.");
      logBytes += bytes;
      logs.push({ level, message });
    };
    const json = sandbox.call<string>(bootstrap, "mihomo-profile-script.js");
    if (typeof json !== "string")
      throw new Error("Script runner returned a non-string result.");
    const config = safeJson(JSON.parse(json)) as ProfileConfig;
    if (!config || Array.isArray(config) || !Object.keys(config).length)
      throw new Error("Script must return a non-empty JSON mapping.");
    return {
      protocol: SCRIPT_RUNNER_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      config,
      logs,
    };
  } catch (error) {
    const message = errorMessage(error, "Script execution failed.");
    return {
      protocol: SCRIPT_RUNNER_PROTOCOL,
      requestId: request.requestId,
      ok: false,
      error: {
        code: /limit|memory|stack/i.test(message)
          ? "LIMIT_EXCEEDED"
          : "SCRIPT_ERROR",
        message: message.slice(0, 16 * 1024),
      },
      logs,
    };
  }
}

/** Preserve useful errors crossing the native Sandbox realm boundary. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    /* A foreign object may reject property access. */
  }
  return fallback;
}

async function main(): Promise<void> {
  const encoder = new TextEncoder();
  let result: ScriptRunnerResult;
  try {
    const text = await new Response(Deno.stdin.readable).text();
    const request = parseRunnerRequest(text);
    result = evaluateInCno(request, import.meta.use("engine"));
  } catch (error) {
    result = runnerFailure(
      "",
      "INVALID_INPUT",
      error instanceof Error ? error.message : "Invalid runner input.",
    );
  }
  let output: string;
  try {
    output = serializeRunnerResult(result);
  } catch (error) {
    output = JSON.stringify(
      runnerFailure(
        result.requestId,
        "INTERNAL_ERROR",
        error instanceof Error
          ? error.message
          : "Cannot serialize runner output.",
      ),
    );
  }
  await Deno.stdout.write(encoder.encode(`${output}\n`));
  Deno.exit(result.ok ? 0 : 1);
}

if (import.meta.main) void main();
