export const PROTOCOL_VERSION = 1;
// Profile compilation accepts 5 MiB YAML plus a bounded JSON envelope. Keep
// the privileged protocol finite, but do not truncate valid compiler output.
export const MAX_CONTROL_BYTES = 12 * 1024 * 1024;
export const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT = 1024 * 1024;
export const MAX_SCRIPT_RUNNER_OUTPUT = 12 * 1024 * 1024;

export const CONTROL_VERBS = Object.freeze([
  "capabilities",
  "status",
  "status.get",
  "profile.compile",
  "profile.apply",
  "generation.stage",
  "generation.activate",
  "generation.rollback",
  "service.start",
  "service.reload",
  "service.restart",
  "service.stop",
  "network.enable",
  "network.disable",
  "network.reconcile",
  "script.run",
] as const);

export type ControlVerb = (typeof CONTROL_VERBS)[number];
export type JsonObject = Record<string, unknown>;
export type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export class ControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });

export function isControlVerb(value: string): value is ControlVerb {
  return (CONTROL_VERBS as readonly string[]).includes(value);
}

export function ok(result: unknown): Envelope {
  return { ok: true, result };
}

export function failed(error: unknown): Envelope {
  if (error instanceof ControlError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: cleanMessage(error.message),
        ...(error.details === undefined
          ? {}
          : { details: jsonSafe(error.details) }),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "internal_error",
      message: cleanMessage(
        error instanceof Error ? error.message : "Internal control error",
      ),
    },
  };
}

export function record(value: unknown, field = "request"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError("invalid_request", `${field} must be a JSON object`);
  }
  return value as JsonObject;
}

export function optionalRecord(
  value: unknown,
  field: string,
): JsonObject | undefined {
  return value === undefined || value === null
    ? undefined
    : record(value, field);
}

export function requiredString(
  value: unknown,
  field: string,
  maximum = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maximum
  ) {
    throw new ControlError(
      "invalid_request",
      `${field} must be a non-empty string no larger than ${maximum} bytes`,
    );
  }
  return value;
}

export function safeId(value: unknown, field: string, maximum = 128): string {
  const id = requiredString(value, field, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new ControlError(
      "invalid_request",
      `${field} contains unsupported characters`,
    );
  }
  return id;
}

export function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ControlError(
      "invalid_request",
      `${field} must be a positive integer`,
    );
  }
  return value as number;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new ControlError("invalid_request", "Expected a boolean value");
  return value;
}

export function rootDirectory(): string {
  const configured = Deno.env.get("CNO_MIHOMO_ROOT");
  if (!configured || configured === "/") return "/";
  if (!configured.startsWith("/") || configured.includes("\0")) {
    throw new ControlError(
      "invalid_environment",
      "CNO_MIHOMO_ROOT must be an absolute path",
    );
  }
  return configured.replace(/\/+$/, "") || "/";
}

export function rooted(root: string, absolutePath: string): string {
  if (!absolutePath.startsWith("/"))
    throw new Error(`Expected an absolute path: ${absolutePath}`);
  return root === "/" ? absolutePath : `${root}${absolutePath}`;
}

export interface RuntimePaths {
  root: string;
  stateDir: string;
  generationDir: string;
  runtimeDir: string;
  mihomoWorkDir: string;
  socket: string;
  active: string;
  activeConfig: string;
  activation: string;
  service: string;
  network: string;
  ownership: string;
  runtimeRules: string;
  persistentRules: string;
  daemonConfig: string;
  controllerSecret: string;
  mihomo: string;
  nft: string;
  ip: string;
  cno: string;
  ubus: string;
  coreInit: string;
  scriptRunner: string;
}

export function runtimePaths(root = rootDirectory()): RuntimePaths {
  const choose = (...paths: string[]): string => {
    for (const path of paths) {
      const target = rooted(root, path);
      try {
        const stat = Deno.statSync(target);
        if (stat.isFile || stat.isSymlink) return target;
      } catch {
        /* select the first conventional path below */
      }
    }
    return rooted(root, paths[0]!);
  };
  return {
    root,
    stateDir: rooted(root, "/var/lib/io.cno.mihomo"),
    generationDir: rooted(root, "/var/lib/io.cno.mihomo/generations"),
    runtimeDir: rooted(root, "/var/run/io.cno.mihomo"),
    mihomoWorkDir: rooted(root, "/var/lib/io.cno.mihomo/runtime"),
    socket: rooted(root, "/var/run/io.cno.mihomo/control.sock"),
    active: rooted(root, "/var/lib/io.cno.mihomo/active.json"),
    activeConfig: rooted(root, "/var/lib/io.cno.mihomo/active.yaml"),
    activation: rooted(root, "/var/lib/io.cno.mihomo/activation.json"),
    service: rooted(root, "/var/lib/io.cno.mihomo/service.json"),
    network: rooted(root, "/var/lib/io.cno.mihomo/network.json"),
    ownership: rooted(root, "/var/lib/io.cno.mihomo/ownership.json"),
    runtimeRules: rooted(root, "/var/run/io.cno.mihomo/firewall.nft"),
    persistentRules: rooted(root, "/etc/io.cno.mihomo/firewall.nft"),
    daemonConfig: rooted(root, "/etc/io.cno.mihomo/daemon.json"),
    controllerSecret: rooted(root, "/etc/io.cno.mihomo/controller.secret"),
    mihomo: choose("/usr/bin/mihomo", "/usr/sbin/mihomo"),
    nft: choose("/usr/sbin/nft", "/sbin/nft"),
    ip: choose("/sbin/ip", "/usr/sbin/ip"),
    cno: choose("/usr/bin/cno"),
    ubus: choose("/sbin/ubus", "/usr/bin/ubus"),
    coreInit: rooted(root, "/etc/init.d/cno-mihomo-core"),
    scriptRunner: rooted(root, "/usr/lib/io.cno.mihomo/script-runner.ts"),
  };
}

export async function ensureDirectories(paths: RuntimePaths): Promise<void> {
  await Deno.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await Deno.mkdir(paths.generationDir, { recursive: true, mode: 0o700 });
  await Deno.mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await Deno.mkdir(paths.mihomoWorkDir, { recursive: true, mode: 0o700 });
  await Deno.mkdir(parentPath(paths.persistentRules), {
    recursive: true,
    mode: 0o700,
  });
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function readTextIfPresent(
  path: string,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export async function readJsonIfPresent<T>(
  path: string,
): Promise<T | undefined> {
  const text = await readTextIfPresent(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ControlError(
      "state_corrupt",
      `State file is not valid JSON: ${path}`,
    );
  }
}

export async function atomicWriteText(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const directory = parentPath(path);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true, mode });
    await writeAll(file, encoder.encode(content));
    await file.sync();
    file.close();
    file = undefined;
    try {
      await Deno.chmod(temporary, mode);
    } catch {
      /* best effort on unusual test filesystems */
    }
    await Deno.rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    try {
      file?.close();
    } catch {
      /* already closed */
    }
    try {
      await Deno.remove(temporary);
    } catch {
      /* no partial file to clean */
    }
    throw error;
  }
}

export function atomicWriteJson(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  return atomicWriteText(path, `${JSON.stringify(jsonSafe(value))}\n`, mode);
}

export async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await Deno.open(path, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } catch {
    // Some libc/filesystem combinations reject fsync on a directory. File data
    // was already synced; rename remains atomic even when durability is weaker.
  }
}

export async function removeIfPresent(
  path: string,
  recursive = false,
): Promise<void> {
  try {
    await Deno.remove(path, { recursive });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (seen.has(item))
        throw new ControlError(
          "invalid_request",
          "JSON value contains a cycle",
        );
      seen.add(item);
      const output = item.map(visit);
      seen.delete(item);
      return output;
    }
    if (item && typeof item === "object") {
      if (seen.has(item))
        throw new ControlError(
          "invalid_request",
          "JSON value contains a cycle",
        );
      seen.add(item);
      const output: JsonObject = {};
      for (const key of Object.keys(item as JsonObject).sort())
        output[key] = visit((item as JsonObject)[key]);
      seen.delete(item);
      return output;
    }
    throw new ControlError("invalid_request", "Value is not JSON serializable");
  };
  return JSON.stringify(visit(value));
}

export async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  errorCode = "request_too_large",
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum)
        throw new ControlError(errorCode, `Input exceeds ${maximum} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readConnectionLine(
  conn: Deno.Conn,
  maximum: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const buffer = new Uint8Array(Math.min(16 * 1024, maximum - total + 1));
    const count = await conn.read(buffer);
    if (count === null) break;
    const newline = buffer.subarray(0, count).indexOf(10);
    const used = newline === -1 ? count : newline;
    total += used;
    if (total > maximum)
      throw new ControlError(
        "request_too_large",
        `Control request exceeds ${maximum} bytes`,
      );
    chunks.push(buffer.slice(0, used));
    if (newline !== -1) break;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(output);
}

export async function writeAll(
  writer: { write(data: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength)
    offset += await writer.write(bytes.subarray(offset));
}

export interface CommandResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: {
    input?: Uint8Array;
    timeoutMs?: number;
    outputLimit?: number;
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<CommandResult> {
  const child = new Deno.Command(executable, {
    args,
    stdin: options.input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    cwd: options.cwd,
    clearEnv: true,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", ...(options.env ?? {}) },
  }).spawn();
  if (options.input) {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(options.input);
    } finally {
      await writer.close();
    }
  }
  const limit = options.outputLimit ?? MAX_COMMAND_OUTPUT;
  const stdoutPromise = readStreamLimited(
    child.stdout,
    limit,
    "command_output_too_large",
  );
  const stderrPromise = readStreamLimited(
    child.stderr,
    limit,
    "command_output_too_large",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      reject(
        new ControlError(
          "command_timeout",
          `Command exceeded ${options.timeoutMs ?? 10_000} ms`,
        ),
      );
    }, options.timeoutMs ?? 10_000);
  });
  try {
    const status = await Promise.race([child.status, timeout]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      code: status.code,
      success: status.success,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function cleanMessage(message: string): string {
  return message
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .slice(0, 16 * 1024);
}

export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 64) return "[depth limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value))
    return value
      .slice(0, 10_000)
      .map((item) => (item === undefined ? null : jsonSafe(item, depth + 1)));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject).slice(
      0,
      10_000,
    )) {
      if (
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol"
      )
        continue;
      output[key] = jsonSafe(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
