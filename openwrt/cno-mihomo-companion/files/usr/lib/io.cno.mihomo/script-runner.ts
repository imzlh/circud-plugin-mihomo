interface CnoEngine {
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  Sandbox: new () => {
    initGlobal(features?: string[]): void;
    call<T>(source: string, name?: string): T;
    global: Record<string, unknown>;
  };
}

declare global {
  interface ImportMeta {
    use(name: "engine"): CnoEngine;
  }
}

const encoder = new TextEncoder();
const MAX_INPUT = 12 * 1024 * 1024;
const MAX_SOURCE = 1024 * 1024;
const MAX_OUTPUT = 12 * 1024 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOGS = 1000;

const bootstrap = `(() => {
  const functionSource = Function.prototype.toString;
  const emit = globalThis.__emit__; delete globalThis.__emit__;
  const source = globalThis.__source__; delete globalThis.__source__;
  const config = JSON.parse(globalThis.__config__); delete globalThis.__config__;
  const profileName = globalThis.__profile__; delete globalThis.__profile__;
  const safeConsole = {};
  for (const level of ['log','info','warn','error','debug']) safeConsole[level] = (...args) => {
    emit(level, args.map((value) => {
      try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; }
      catch { return String(value); }
    }).join(' '));
  };
  Object.defineProperty(globalThis, 'console', { value: Object.freeze(safeConsole), configurable: false });
  (0, eval)(source);
  if (typeof main !== 'function') throw new Error('Script must define main(config, profileName).');
  const mainTag = Object.prototype.toString.call(main);
  const mainSource = functionSource.call(main).trimStart();
  if (mainTag === '[object AsyncFunction]' || mainTag === '[object AsyncGeneratorFunction]' || mainSource.slice(0, 5) === 'async')
    throw new Error('main must return synchronously.');
  const result = main(config, profileName);
  if (result && typeof result.then === 'function') throw new Error('main must return synchronously.');
  const ancestors = [];
  function clean(value, depth) {
    if (depth > 100) throw new Error('Script result nesting exceeds 100 levels.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') throw new Error('Script result contains a non-JSON value.');
    if (ancestors.includes(value)) throw new Error('Script result contains a cycle.');
    ancestors.push(value);
    let output;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error('Script result contains a sparse array.');
      output = value.map((item) => clean(item, depth + 1));
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('Script result must be plain JSON.');
      if (Object.getOwnPropertySymbols(value).length) throw new Error('Script result contains Symbol keys.');
      output = {};
      for (const key of Object.keys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !('value' in field)) throw new Error('Script result contains an accessor.');
        output[key] = clean(field.value, depth + 1);
      }
    }
    ancestors.pop();
    return output;
  }
  const cleaned = clean(result, 0);
  if (!cleaned || Array.isArray(cleaned) || Object.keys(cleaned).length === 0)
    throw new Error('main must return a non-empty JSON mapping.');
  return JSON.stringify(cleaned);
})()`;

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const bytes = new Uint8Array(
      await new Response(Deno.stdin.readable).arrayBuffer(),
    );
    if (bytes.byteLength > MAX_INPUT)
      throw coded("script_invalid", "Runner input exceeds 12 MiB");
    const input = parseInput(bytes);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw coded("script_invalid", "Runner input must be an object");
    const source = input.source;
    const profileName = input.profileName;
    const configJson = input.configJson;
    if (
      typeof source !== "string" ||
      !source.trim() ||
      encoder.encode(source).byteLength > MAX_SOURCE
    )
      throw coded("script_invalid", "source is empty or exceeds 1 MiB");
    if (
      typeof profileName !== "string" ||
      encoder.encode(profileName).byteLength > 1024
    )
      throw coded("script_invalid", "profileName is invalid");
    if (
      !configJson ||
      typeof configJson !== "object" ||
      Array.isArray(configJson)
    )
      throw coded("script_invalid", "configJson must be a JSON mapping");
    const memoryBytes = integer(
      input.memoryBytes,
      64 * 1024 * 1024,
      8 * 1024 * 1024,
      64 * 1024 * 1024,
    );
    const engine = import.meta.use("engine");
    engine.setMemoryLimit(memoryBytes);
    engine.setMaxStackSize(512 * 1024);
    const sandbox = new engine.Sandbox();
    sandbox.initGlobal(["json", "map", "typedarrays", "bigint"]);
    const logs: { level: string; message: string }[] = [];
    let logBytes = 0;
    sandbox.global.__source__ = source;
    sandbox.global.__profile__ = profileName;
    sandbox.global.__config__ = JSON.stringify(configJson);
    sandbox.global.__emit__ = (level: string, message: string) => {
      const size =
        encoder.encode(level).byteLength + encoder.encode(message).byteLength;
      if (logs.length >= MAX_LOGS || logBytes + size > MAX_LOG_BYTES)
        throw coded("output_invalid", "Script log limit exceeded");
      logBytes += size;
      logs.push({ level, message });
    };
    const text = sandbox.call<string>(
      bootstrap,
      "cno-mihomo-profile-script.js",
    );
    response = { ok: true, result: { configJson: JSON.parse(text), logs } };
  } catch (error) {
    const message = errorMessage(error, "Script execution failed");
    const code =
      errorCode(error) ??
      (/memory/i.test(message) ? "script_memory_limit" : "script_failed");
    response = {
      ok: false,
      error: { code, message: message.slice(0, 16 * 1024) },
    };
  }
  let output = JSON.stringify(response);
  if (encoder.encode(output).byteLength > MAX_OUTPUT)
    output = JSON.stringify({
      ok: false,
      error: {
        code: "output_invalid",
        message: "Script output exceeds 12 MiB",
      },
    });
  await Deno.stdout.write(encoder.encode(`${output}\n`));
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw coded(
      "script_invalid",
      `Numeric limit must be between ${minimum} and ${maximum}`,
    );
  return value as number;
}

/** Decode and parse the outer runner protocol without conflating Script errors. */
function parseInput(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw coded("script_invalid", "Runner input is not valid UTF-8 JSON");
  }
}

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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

/** Read an application error code without trusting a foreign realm object. */
function errorCode(error: unknown): string | undefined {
  try {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" ? code : undefined;
    }
  } catch {
    /* A foreign object may reject property access. */
  }
  return undefined;
}

if (import.meta.main) void main();
