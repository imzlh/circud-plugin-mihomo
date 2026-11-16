import { Application } from "../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/daemon.ts";
import { NetworkManager } from "../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/network.ts";
import {
  ensureDirectories,
  runtimePaths,
  type Envelope,
  type JsonObject,
} from "../cno-mihomo-companion/files/usr/lib/io.cno.mihomo/runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`failure integration assertion failed: ${message}`);
}

function result(envelope: Envelope): JsonObject {
  assert(envelope.ok, `expected success, received ${JSON.stringify(envelope)}`);
  assert(
    envelope.result !== null &&
      typeof envelope.result === "object" &&
      !Array.isArray(envelope.result),
    "result must be an object",
  );
  return envelope.result as JsonObject;
}

async function executable(path: string, source: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, source, { mode: 0o755 });
  await Deno.chmod(path, 0o755);
}

async function networkFailureModel(root: string): Promise<void> {
  const paths = runtimePaths(root);
  await Deno.mkdir(paths.stateDir, { recursive: true });
  await Deno.mkdir(paths.runtimeDir, { recursive: true });
  await Deno.mkdir(`${root}/etc/io.cno.mihomo`, { recursive: true });
  const log = `${root}/commands.log`;
  const failCheck = `${root}/fail-check`;
  const failApply = `${root}/fail-apply`;
  await executable(
    paths.nft,
    `#!/bin/sh
printf 'nft %s\\n' "$*" >> '${log}'
if [ "$1" = '-c' ] && [ -e '${failCheck}' ]; then echo preflight-failed >&2; exit 1; fi
if [ "$1" = '-f' ] && [ -e '${failApply}' ]; then echo apply-failed >&2; exit 1; fi
exit 0
`,
  );
  await executable(
    paths.ip,
    `#!/bin/sh
printf 'ip %s\\n' "$*" >> '${log}'
exit 0
`,
  );
  const manager = new NetworkManager(paths, false, {
    redirect: 7892,
    tproxy: 7893,
    dns: 1053,
    routeMark: 0x162,
    bypassMark: 0x163,
    routeTable: 162,
    ipv4RulePriority: 11062,
    ipv6RulePriority: 11063,
  });
  await manager.initialize();
  const config = {
    tcpMode: "tproxy",
    udpMode: "tproxy",
    ipv4: true,
    ipv6: false,
    router: { proxy: false, dns: false },
    lan: { proxy: true, dns: true },
    bypassReserved: true,
    bypassCn: false,
    routerAcl: [],
    lanAcl: [],
  };

  await manager.enable({ expectedRevision: 1, config });
  const successful = (await Deno.readTextFile(log)).trim().split("\n");
  const checkIndex = successful.findIndex((line) =>
    line.startsWith("nft -c -f "),
  );
  const mutationIndex = successful.findIndex(
    (line) =>
      line.startsWith("ip -4 route add ") ||
      line.startsWith("ip -4 rule add ") ||
      line.startsWith("nft -f "),
  );
  assert(checkIndex >= 0, "nft -c preflight must run");
  assert(
    mutationIndex > checkIndex,
    "nft -c must precede every kernel mutation",
  );

  await manager.disable({ expectedRevision: 2 });
  await Deno.writeTextFile(failCheck, "1");
  let preflightError: unknown;
  try {
    await manager.enable({ expectedRevision: 3, config });
  } catch (error) {
    preflightError = error;
  }
  assert(
    preflightError instanceof Error &&
      preflightError.message.includes("preflight-failed"),
    "preflight failure must be returned",
  );
  assert(
    manager.publicValue().revision === 3,
    "preflight failure must roll back the tentative revision",
  );
  assert(
    manager.publicValue().desired === false,
    "preflight failure must preserve the disabled policy",
  );
  await Deno.remove(failCheck);

  await Deno.writeTextFile(failApply, "1");
  let applyError: unknown;
  try {
    await manager.enable({ expectedRevision: 3, config });
  } catch (error) {
    applyError = error;
  }
  assert(
    applyError instanceof Error && applyError.message.includes("apply-failed"),
    "apply failure must be returned",
  );
  assert(
    manager.publicValue().state === "degraded",
    "post-mutation failure must enter degraded state",
  );
  assert(
    !(await exists(paths.ownership)),
    "fail-open must remove the ownership journal",
  );
  assert(
    (await Deno.readTextFile(paths.persistentRules)).includes("disabled"),
    "fail-open must publish disabled persistent rules",
  );
  const failed = (await Deno.readTextFile(log)).trim().split("\n");
  const failedApplyIndex = failed.findLastIndex((line) =>
    line.startsWith("nft -f "),
  );
  const cleanupIndex = failed.findIndex(
    (line, index) =>
      index > failedApplyIndex && line === "nft delete table inet cno_mihomo",
  );
  assert(
    cleanupIndex > failedApplyIndex,
    "failed mutation must trigger nft cleanup",
  );
}

async function tunOwnershipModel(root: string): Promise<void> {
  const paths = runtimePaths(root);
  await Deno.mkdir(paths.stateDir, { recursive: true });
  await Deno.mkdir(paths.runtimeDir, { recursive: true });
  await Deno.mkdir(`${root}/etc/io.cno.mihomo`, { recursive: true });
  const log = `${root}/commands.log`;
  await executable(
    paths.nft,
    `#!/bin/sh
printf 'nft %s\\n' "$*" >> '${log}'
exit 0
`,
  );
  await executable(
    paths.ip,
    `#!/bin/sh
printf 'ip %s\\n' "$*" >> '${log}'
if [ "$1" = link ] && [ "$2" = show ] && [ "$3" = dev ] && [ "$4" = mihomo ]; then
  echo '9: mihomo: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 9000 state UNKNOWN'
fi
exit 0
`,
  );
  const manager = new NetworkManager(paths, false, {
    redirect: 7892,
    tproxy: 7893,
    dns: 1053,
    routeMark: 0x162,
    bypassMark: 0x163,
    routeTable: 162,
    ipv4RulePriority: 11062,
    ipv6RulePriority: 11063,
  });
  await manager.initialize();
  const config = {
    tcpMode: "tun",
    udpMode: "tun",
    ipv4: true,
    ipv6: true,
    router: { proxy: true, dns: false },
    lan: { proxy: true, dns: true },
    bypassReserved: true,
    bypassCn: false,
    routerAcl: [],
    lanAcl: [],
    tun: { device: "mihomo", stack: "mixed", mtu: 9000, gso: true },
  } as const;
  const enabled = await manager.enable({ expectedRevision: 1, config });
  assert(enabled.state === "active", "TUN enable must become active");
  const commands = (await Deno.readTextFile(log)).trim().split("\n");
  const deviceIndex = commands.findIndex(
    (line) => line === "ip link show dev mihomo",
  );
  const route4Index = commands.findIndex(
    (line) => line === "ip -4 route add default dev mihomo table 162",
  );
  const route6Index = commands.findIndex(
    (line) => line === "ip -6 route add default dev mihomo table 162",
  );
  assert(deviceIndex >= 0, "TUN mode must wait for the device");
  assert(
    route4Index > deviceIndex && route6Index > deviceIndex,
    "TUN routes must be installed after the device is UP",
  );
  const ownership = JSON.parse(
    await Deno.readTextFile(paths.ownership),
  ) as JsonObject;
  const resources = ownership.resources as JsonObject[];
  assert(
    resources.some(
      (resource) =>
        resource.kind === "ip_route" &&
        resource.mode === "tun" &&
        resource.device === "mihomo",
    ),
    "ownership journal must describe the TUN route",
  );
  const rules = await Deno.readTextFile(paths.persistentRules);
  assert(
    rules.includes("chain tun_prerouting") &&
      rules.includes("chain tun_output"),
    "TUN nft chains must cover LAN and router traffic",
  );

  await manager.disable({ expectedRevision: 2 });
  const afterDisable = (await Deno.readTextFile(log)).trim().split("\n");
  assert(
    afterDisable.includes("ip -4 route del default dev mihomo table 162"),
    "disable must delete the owned IPv4 TUN route",
  );
  assert(
    afterDisable.includes("ip -6 route del default dev mihomo table 162"),
    "disable must delete the owned IPv6 TUN route",
  );
  assert(
    !(await exists(paths.ownership)),
    "disable must remove the TUN ownership journal",
  );
}

async function advancedNetworkPolicyModel(root: string): Promise<void> {
  const paths = runtimePaths(root);
  await Deno.mkdir(`${root}/etc/io.cno.mihomo`, { recursive: true });
  const manager = new NetworkManager(paths, true, {
    redirect: 7892,
    tproxy: 7893,
    dns: 1053,
    routeMark: 0x162,
    bypassMark: 0x163,
    routeTable: 162,
    ipv4RulePriority: 11062,
    ipv6RulePriority: 11063,
  });
  await manager.initialize();
  await manager.enable({
    expectedRevision: 1,
    config: {
      tcpMode: "tproxy",
      udpMode: "tproxy",
      ipv4: true,
      ipv6: true,
      router: { proxy: true, dns: true },
      lan: { proxy: true, dns: true },
      bypassReserved: true,
      bypassCn: false,
      routerAcl: ["127.0.0.1/32", "::1/128"],
      lanAcl: ["192.168.50.0/24", "fd00:50::/64"],
      lanInterfaces: ["br-lan", "guest0"],
      tcpPorts: ["80", "443", "8000-8999"],
      udpPorts: ["53", "443"],
      bypassDscp: [4, 46],
      bypassMarks: ["0x80/0xff"],
      reservedCidrs: ["10.0.0.0/8", "fc00::/7"],
      fakeIp: {
        pingHijack: true,
        ipv4Range: "198.18.0.1/16",
        ipv6Range: "fc00::/18",
      },
      tun: { device: "mihomo", stack: "mixed", mtu: 9000, gso: true },
    },
  });
  const rules = await Deno.readTextFile(paths.persistentRules);
  assert(
    rules.includes("set lan_interfaces") && rules.includes('"br-lan"'),
    "LAN interface set must be rendered",
  );
  assert(
    rules.includes("set proxy_tcp_ports") && rules.includes("8000-8999"),
    "TCP port ranges must be rendered",
  );
  assert(
    rules.includes("set proxy_udp_ports") &&
      rules.includes("udp dport @proxy_udp_ports"),
    "UDP port ranges must constrain interception",
  );
  assert(
    rules.includes("ip dscp @bypass_dscp") &&
      rules.includes("meta mark & 0xff == 0x80 return"),
    "DSCP and FWMark bypass must be rendered before interception",
  );
  assert(
    rules.includes("elements = { 10.0.0.0/8 }") &&
      rules.includes("elements = { fc00::/7 }"),
    "custom reserved ranges must replace defaults",
  );
  assert(
    rules.includes(
      "iifname @lan_interfaces ip saddr @lan_acl4 meta l4proto { tcp, udp } th dport 53",
    ),
    "LAN interface and source ACL must constrain DNS hijack",
  );
  assert(
    rules.includes(
      "ip saddr @router_acl4 meta l4proto { tcp, udp } th dport 53",
    ),
    "router source ACL must constrain DNS hijack",
  );
  assert(
    rules.includes("ip daddr @bypass4 ip daddr != 198.18.0.1/16 return"),
    "Fake-IP IPv4 must be exempt from reserved bypass",
  );
  assert(
    rules.includes("meta l4proto tcp ip daddr 198.18.0.1/16 meta mark set"),
    "Fake-IP TCP must bypass the destination-port filter",
  );
  assert(
    rules.includes("meta l4proto udp ip6 daddr fc00::/18 meta mark set"),
    "Fake-IP IPv6 UDP must bypass the destination-port filter",
  );
  assert(
    rules.includes("chain fake_ip_ping_lan") &&
      rules.includes("icmp type echo-request ip daddr 198.18.0.1/16 redirect"),
    "Fake-IP ping hijack must cover LAN IPv4",
  );
  assert(
    rules.includes("chain fake_ip_ping_router") &&
      rules.includes("icmpv6 type echo-request ip6 daddr fc00::/18 redirect"),
    "Fake-IP ping hijack must cover router IPv6",
  );
}

async function generationRollback(root: string): Promise<void> {
  const paths = runtimePaths(root);
  await Deno.mkdir(`${root}/etc/io.cno.mihomo`, { recursive: true });
  await ensureDirectories(paths);
  const config = {
    dryRun: true,
    controllerUrl: "http://127.0.0.1:9090",
    requireControllerHealth: false,
    healthTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    restartDelayMs: 100,
    redirectPort: 7892,
    tproxyPort: 7893,
    dnsPort: 1053,
    routeMark: 0x162,
    bypassMark: 0x163,
    routeTable: 162,
    ipv4RulePriority: 11062,
    ipv6RulePriority: 11063,
  };
  const application = new Application(paths, config);
  await application.initialize();
  const first = result(
    await application.handle("profile.apply", {
      transactionId: "rollback-first",
      profileId: "first",
      profileRevision: 1,
      name: "First",
      content: "mode: rule\n",
    }),
  );
  const firstGeneration = String(first.generationId);

  let restartCalls = 0;
  Reflect.set(application, "service", {
    async restartGeneration() {
      restartCalls++;
      if (restartCalls === 1) throw new Error("mock restart failure");
      return { service: { state: "running" } };
    },
    async stopForRollback() {},
    controllerStatus() {
      return { reachable: true, version: "rollback-mock" };
    },
  });
  const second = await application.handle("profile.apply", {
    transactionId: "rollback-second",
    profileId: "second",
    profileRevision: 1,
    name: "Second",
    content: "mode: global\n",
  });
  assert(
    !second.ok && second.error.code === "activation_failed",
    "failed restart must fail activation",
  );
  const active = JSON.parse(
    await Deno.readTextFile(paths.active),
  ) as JsonObject;
  assert(
    active.generationId === firstGeneration,
    "rollback must restore the previous active pointer",
  );
  assert(
    (await Deno.readTextFile(paths.activeConfig)) === "mode: rule\n",
    "rollback must restore previous active YAML",
  );
  const journal = JSON.parse(
    await Deno.readTextFile(paths.activation),
  ) as JsonObject;
  assert(
    journal.state === "failed",
    "activation journal must retain failed rollback evidence",
  );
  const rollback = journal.rollback as JsonObject;
  assert(
    rollback.attempted === true && rollback.succeeded === true,
    "rollback must be recorded as successful",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "cno-mihomo-failure-" });
  try {
    await networkFailureModel(`${root}/network`);
    await tunOwnershipModel(`${root}/tun`);
    await advancedNetworkPolicyModel(`${root}/advanced-network`);
    await generationRollback(`${root}/generation`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          verified: [
            "nft-preflight-before-mutation",
            "preflight-preserves-disabled-policy",
            "post-mutation-fail-open-cleanup",
            "tun-device-route-journal-cleanup",
            "advanced-network-policy-rendering",
            "generation-active-pointer-rollback",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) await main();
