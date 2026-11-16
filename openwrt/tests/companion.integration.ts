import { Application } from '../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/daemon.ts';
import {
  runtimePaths,
  type Envelope,
  type JsonObject,
} from '../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/runtime.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const repoRoot = Deno.cwd();
const daemonEntry = `${repoRoot}/openwrt/cno-mihomo-companion/files/usr/lib/io.cno.mihomo/daemon.ts`;
const ctlEntry = `${repoRoot}/openwrt/cno-mihomo-companion/files/usr/lib/io.cno.mihomo/ctl.ts`;
const cno = Deno.execPath();

interface ChildCapture {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`integration assertion failed: ${message}`);
}

function object(value: unknown, message: string): JsonObject {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonObject;
}

function field(value: JsonObject, name: string): JsonObject {
  return object(value[name], `${name} must be an object`);
}

function startCaptured(command: Deno.Command): ChildCapture {
  const child = command.spawn();
  return {
    child,
    status: child.status,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

async function waitForSocket(
  socket: string,
  capture: ChildCapture,
  timeoutMs = 10_000,
): Promise<void> {
  let exited: Deno.CommandStatus | undefined;
  void capture.status.then((status) => {
    exited = status;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      const stderr = await capture.stderr;
      throw new Error(`daemon exited before creating its socket (${exited.code}): ${stderr.trim()}`);
    }
    try {
      const info = await Deno.stat(socket);
      if (info.isSocket) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not create ${socket} within ${timeoutMs} ms`);
}

async function callControl(
  env: Record<string, string>,
  verb: string,
  input: JsonObject = {},
): Promise<JsonObject> {
  const child = new Deno.Command(cno, {
    args: ['run', ctlEntry, verb],
    env,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(encoder.encode(`${JSON.stringify(input)}\n`));
  await writer.close();
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert(status.success, `${verb} control process failed (${status.code}): ${stderr.trim()}`);
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout) as Envelope;
  } catch {
    throw new Error(`${verb} returned invalid JSON: ${stdout.slice(0, 500)}`);
  }
  if (!envelope.ok) {
    throw new Error(`${verb} failed: ${envelope.error.code}: ${envelope.error.message}`);
  }
  return object(envelope.result, `${verb} result must be an object`);
}

async function assertExplicitStopOrder(root: string): Promise<void> {
  const calls: string[] = [];
  const application = new Application(runtimePaths(root), {
    dryRun: true,
    controllerUrl: 'http://127.0.0.1:9090',
    requireControllerHealth: false,
    healthTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    restartDelayMs: 100,
    redirectPort: 7892,
    tproxyPort: 7893,
    dnsPort: 1053,
    routeMark: 0x162,
    bypassMark: 0x163,
    routeTable: 162,
    ipv4RulePriority: 11062,
    ipv6RulePriority: 11063,
  });

  Reflect.set(application, 'network', {
    async withdraw() {
      calls.push('network.withdraw');
      return { desired: true, state: 'inactive' };
    },
  });
  Reflect.set(application, 'service', {
    async stop() {
      calls.push('service.stop');
      return { service: { state: 'stopped' } };
    },
  });

  const response = await application.handle('service.stop', {});
  assert(response.ok, 'mocked explicit stop must succeed');
  assert(
    calls.join(',') === 'network.withdraw,service.stop',
    `explicit stop order was ${calls.join(',')}`,
  );
}

async function main(): Promise<void> {
  assert(await Deno.stat(daemonEntry).then((entry) => entry.isFile), 'daemon entry is missing');
  assert(await Deno.stat(ctlEntry).then((entry) => entry.isFile), 'control entry is missing');

  const root = await Deno.makeTempDir({ prefix: 'cno-mihomo-integration-' });
  const paths = runtimePaths(root);
  const env = {
    CNO_MIHOMO_ROOT: root,
    CNO_MIHOMO_DRY_RUN: '1',
  };
  let daemon: ChildCapture | undefined;
  let daemonStopped = false;

  try {
    await Deno.mkdir(`${root}/etc/io.cno.mihomo`, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      `${root}/etc/io.cno.mihomo/daemon.json`,
      `${JSON.stringify({
        dryRun: true,
        requireControllerHealth: false,
        healthTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
      })}\n`,
      { mode: 0o600 },
    );

    daemon = startCaptured(new Deno.Command(cno, {
      args: ['run', daemonEntry],
      env,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }));
    await waitForSocket(paths.socket, daemon);

    const initial = await callControl(env, 'status.get');
    assert(field(initial, 'service').state === 'stopped', 'initial service must be stopped');
    assert(field(initial, 'config').state === 'pending', 'initial config must be pending');
    assert(field(initial, 'network').state === 'inactive', 'initial network must be inactive');
    assert(field(initial, 'networkConfig').desired === false, 'initial network must not be desired');

    const content = [
      'mixed-port: 7890',
      'external-controller: 127.0.0.1:9090',
      'proxies: []',
      'proxy-groups: []',
      'rules:',
      '  - MATCH,DIRECT',
      '',
    ].join('\n');
    const compiled = await callControl(env, 'profile.compile', {
      profileId: 'integration-profile',
      profileRevision: 1,
      content,
    });
    assert(compiled.compiledContent === content, 'compile must preserve the already compiled YAML');
    assert(typeof compiled.sha256 === 'string' && compiled.sha256.length === 64, 'compile must return sha256');
    assert(
      Array.isArray(compiled.warnings) && compiled.warnings.some((warning) =>
        typeof warning === 'string' && warning.includes('dry-run')
      ),
      'compile must report skipped Mihomo validation in dry-run mode',
    );

    const applied = await callControl(env, 'profile.apply', {
      transactionId: 'integration-apply-1',
      profileId: 'integration-profile',
      profileRevision: 1,
      name: 'Integration profile',
      content,
      expectedSignature: compiled.enhancementSignature,
      networkRevision: 1,
    });
    assert(typeof applied.generationId === 'string', 'apply must create a generation');
    assert(field(applied, 'service').restarted === true, 'apply must restart the procd mock');
    assert(field(applied, 'service').controllerHealthy === true, 'dry-run controller must become healthy');

    const afterApply = await callControl(env, 'status.get');
    assert(field(afterApply, 'service').state === 'running', 'procd mock must report running after apply');
    assert(field(afterApply, 'service').pid === 4242, 'procd mock must expose its deterministic pid');
    assert(field(afterApply, 'config').state === 'active', 'applied generation must be active');
    assert(
      field(afterApply, 'config').generationId === applied.generationId,
      'status must expose the applied generation',
    );

    const networkConfig = {
      tcpMode: 'tproxy',
      udpMode: 'tproxy',
      ipv4: true,
      ipv6: false,
      router: { proxy: false, dns: false },
      lan: { proxy: true, dns: true },
      bypassReserved: true,
      bypassCn: false,
      routerAcl: [],
      lanAcl: [],
    };
    const enabled = await callControl(env, 'network.enable', {
      expectedRevision: 1,
      config: networkConfig,
    });
    assert(enabled.revision === 2, 'network enable must advance the revision');
    assert(enabled.desired === true && enabled.state === 'active', 'network enable must become active');
    const ownership = object(
      JSON.parse(await Deno.readTextFile(paths.ownership)),
      'ownership journal must be an object',
    );
    assert(ownership.state === 'active', 'network ownership journal must be active');
    assert(
      (await Deno.readTextFile(paths.persistentRules)).includes('table inet cno_mihomo'),
      'network enable must publish the generated nftables rules',
    );

    const reconciled = await callControl(env, 'network.reconcile', { expectedRevision: 2 });
    assert(reconciled.state === 'active' && reconciled.revision === 2, 'reconcile must retain active revision');

    const disabled = await callControl(env, 'network.disable', { expectedRevision: 2 });
    assert(disabled.revision === 3, 'network disable must advance the revision');
    assert(disabled.desired === false && disabled.state === 'inactive', 'network disable must withdraw interception');
    await Deno.stat(paths.ownership).then(
      () => {
        throw new Error('integration assertion failed: disable must remove the ownership journal');
      },
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
    assert(
      (await Deno.readTextFile(paths.persistentRules)).includes('disabled'),
      'network disable must publish a fail-open persistent rules file',
    );

    const reenabled = await callControl(env, 'network.enable', {
      expectedRevision: 3,
      config: networkConfig,
    });
    assert(reenabled.revision === 4 && reenabled.state === 'active', 'network must re-enable before explicit stop');

    const stopped = await callControl(env, 'service.stop');
    assert(field(stopped, 'network').state === 'inactive', 'explicit stop must withdraw network interception');
    assert(field(stopped, 'service').state === 'stopped', 'explicit stop must stop the procd mock');
    assert(field(stopped, 'network').desired === true, 'explicit stop must preserve desired network policy for a later start');
    await assertExplicitStopOrder(root);

    const started = await callControl(env, 'service.start');
    assert(field(started, 'service').state === 'running', 'service must restart before daemon shutdown');

    daemon.child.kill('SIGTERM');
    const exit = await daemon.status;
    daemonStopped = true;
    assert(exit.success, `daemon shutdown failed with exit code ${exit.code}`);
    const daemonStderr = await daemon.stderr;
    assert(!daemonStderr.trim(), `daemon emitted stderr during integration run: ${daemonStderr.trim()}`);

    const storedService = object(
      JSON.parse(await Deno.readTextFile(paths.service)),
      'stored service state must be an object',
    );
    assert(storedService.enabled === true, 'daemon shutdown must preserve core autostart state');
    assert(storedService.dryRunRunning === true, 'daemon shutdown must not stop the running procd mock');

    console.log(JSON.stringify({
      ok: true,
      flow: [
        'status.get',
        'profile.compile',
        'profile.apply',
        'network.enable',
        'network.reconcile',
        'network.disable',
        'service.stop(network-first)',
        'service.start',
        'daemon.shutdown(core-preserved)',
      ],
      generationId: applied.generationId,
      finalService: storedService,
    }, null, 2));
  } finally {
    if (daemon && !daemonStopped) {
      try {
        daemon.child.kill('SIGTERM');
      } catch {
        // The child may already have exited after an assertion failure.
      }
      await daemon.status.catch(() => undefined);
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  await main();
}
