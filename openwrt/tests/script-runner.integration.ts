import {
  runtimePaths,
  type Envelope,
  type JsonObject,
} from "../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/runtime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runner =
  runtimePaths(Deno.cwd()).root === "/"
    ? "/usr/lib/io.cno.mihomo/script-runner.ts"
    : `${Deno.cwd()}/openwrt/cno-mihomo-companion/files/usr/lib/io.cno.mihomo/script-runner.ts`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`script runner integration assertion failed: ${message}`);
}

async function execute(
  source: string,
  configJson: JsonObject = { mode: "rule" },
): Promise<Envelope> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", runner],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {},
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    encoder.encode(
      JSON.stringify({
        source,
        profileName: "integration",
        configJson,
        memoryBytes: 64 * 1024 * 1024,
      }),
    ),
  );
  await writer.close();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  assert(status.success, `runner exited ${status.code}: ${stderr.trim()}`);
  return JSON.parse(decoder.decode(stdout)) as Envelope;
}

async function main(): Promise<void> {
  const success = await execute(`function main(config, profileName) {
    console.info(profileName);
    config.mode = 'direct';
    config.capabilities = {
      deno: typeof Deno,
      fetch: typeof fetch,
      process: typeof process,
      require: typeof require,
    };
    return config;
  }`);
  assert(success.ok, `successful script failed: ${JSON.stringify(success)}`);
  const result = success.result as JsonObject;
  const config = result.configJson as JsonObject;
  assert(config.mode === "direct", "script must return its transformed config");
  assert(
    JSON.stringify(config.capabilities) ===
      JSON.stringify({
        deno: "undefined",
        fetch: "undefined",
        process: "undefined",
        require: "undefined",
      }),
    "sandbox must not expose host capability globals",
  );
  const logs = result.logs as JsonObject[];
  assert(
    logs.length === 1 && logs[0]?.level === "info",
    "sandbox console logs must be captured",
  );

  const asynchronous = await execute(
    "async function main(config) { return config; }",
  );
  assert(
    !asynchronous.ok &&
      asynchronous.error.code === "script_failed" &&
      asynchronous.error.message.includes("synchronously"),
    "async Script stages must fail explicitly",
  );

  const invalid = await execute("function main() { return {}; }");
  assert(
    !invalid.ok && invalid.error.code === "script_failed",
    "empty Script results must be rejected",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        verified: [
          "native-sandbox-execution",
          "capability-globals-absent",
          "bounded-console-capture",
          "async-result-rejected",
          "empty-result-rejected",
        ],
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) await main();
