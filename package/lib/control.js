const ALLOWED_ACTIONS = new Set([
  "capabilities",
  "service.start",
  "service.reload",
  "service.restart",
  "service.stop",
  "network.enable",
  "network.disable",
  "network.reconcile",
  "generation.rollback",
  "profile.compile",
  "profile.apply",
  "profile.fetch",
  "script.run",
  "status",
]);

/**
 * @typedef {"capabilities" | "status" | "service.start" | "service.reload" |
 * "service.restart" | "service.stop" | "network.enable" | "network.disable" |
 * "network.reconcile" | "generation.rollback" | "profile.compile" |
 * "profile.apply" | "profile.fetch" | "script.run"} ControlAction
 */

export class ControlClient {
  /**
   * @param {{
   *   processModule: {spawn(args: string[], options: Record<string, unknown>): any},
   *   fs: {exists(path: string): boolean},
   *   executable?: string,
   *   encoder: {encode(value: string): Uint8Array},
   *   decoder: {decode(value: Uint8Array): string},
   * }} options
   */
  constructor({ processModule, fs, executable = "/usr/sbin/cno-mihomoctl", encoder, decoder }) {
    this.process = processModule;
    this.fs = fs;
    this.executable = executable;
    this.encoder = encoder;
    this.decoder = decoder;
    this.children = new Set();
    this.closed = false;
  }

  /**
   * @param {ControlAction} action
   * @param {Record<string, unknown>} input
   * @param {AbortSignal | {aborted: boolean, addEventListener: Function, removeEventListener: Function}} signal
   * @returns {Promise<any>}
   */
  async invoke(action, input, signal) {
    if (this.closed) throw new Error("Control client is closed");
    if (!ALLOWED_ACTIONS.has(action)) throw new Error("Invalid control action");
    if (!this.fs.exists(this.executable))
      throw new Error("OpenWrt companion is not installed");
    const child = this.process.spawn([this.executable, action], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      clearEnv: true,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    this.children.add(child);
    const abort = () => {
      try {
        child.kill();
      } catch (_) {}
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const inputBytes = this.encoder.encode(
        `${JSON.stringify(input ?? {})}\n`,
      );
      await child.stdin.write(inputBytes);
      child.stdin.close();
      const stdoutPromise = readAll(child.stdout, 12 * 1024 * 1024);
      const stderrPromise = readAll(child.stderr, 256 * 1024);
      const [status, stdout, stderr] = await Promise.all([
        child.wait(),
        stdoutPromise,
        stderrPromise,
      ]);
      if (signal.aborted) throw signal.reason;
      const stdoutText = this.decoder.decode(stdout).trim();
      const stderrText = this.decoder.decode(stderr).trim();
      if (status.exit_status !== 0)
        throw new Error(
          stderrText || `cno-mihomoctl exited with ${status.exit_status}`,
        );
      if (!stdoutText) return {};
      let envelope;
      try {
        envelope = JSON.parse(stdoutText);
      } catch (_) {
        throw new Error("cno-mihomoctl returned invalid JSON");
      }
      if (
        !envelope ||
        typeof envelope !== "object" ||
        typeof envelope.ok !== "boolean"
      )
        throw new Error("cno-mihomoctl returned an invalid envelope");
      if (!envelope.ok)
        throw new Error(
          envelope.error?.message ||
            envelope.error?.code ||
            "cno-mihomoctl failed",
        );
      return envelope.result;
    } finally {
      signal.removeEventListener("abort", abort);
      this.children.delete(child);
    }
  }

  close() {
    this.closed = true;
    for (const child of this.children) {
      try {
        child.kill();
      } catch (_) {}
    }
    this.children.clear();
  }
}

async function readAll(pipe, limit) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = new Uint8Array(16384);
    const read = await pipe.read(buffer);
    if (!read) break;
    total += read;
    if (total > limit) throw new Error("cno-mihomoctl output exceeds limit");
    chunks.push(buffer.slice(0, read));
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
