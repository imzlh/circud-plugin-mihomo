import { expect, test, type Page, type Route } from "@playwright/test";

const managerBase = "/io.cno.mihomo/api/v1";

const initial = {
  tcpMode: "redirect",
  udpMode: "tproxy",
  ipv4: true,
  ipv6: false,
  router: { proxy: false, dns: false },
  lan: { proxy: true, dns: false },
  bypassReserved: true,
  bypassCn: false,
  routerAcl: [],
  lanAcl: [],
  lanInterfaces: [],
  tcpPorts: ["0-65535"],
  udpPorts: ["0-65535"],
  bypassDscp: [],
  bypassMarks: [],
  reservedCidrs: ["10.0.0.0/8", "fc00::/7"],
  fakeIp: { pingHijack: false, ipv4Range: "", ipv6Range: "" },
  tun: { device: "mihomo", stack: "mixed", mtu: 9000, gso: true },
} as const;

async function fixture(page: Page) {
  let revision = 4;
  let scheduleRevision = 2;
  let config: Record<string, unknown> = structuredClone(initial);
  let schedule = {
    enabled: false,
    time: "03:00",
    days: [0, 1, 2, 3, 4, 5, 6],
  };
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const response = (route: Route, result: unknown, status = 200) =>
    route.fulfill({
      status,
      json: { ok: true, result },
    });
  await page.route(`**${managerBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(managerBase.length);
    const body = request.postData() ? request.postDataJSON() : {};
    if (request.method() !== "GET")
      writes.push({ method: request.method(), path, body });
    if (path === "/status")
      return response(route, {
        service: { enabled: true, state: "running", pid: 1000 },
        controller: { reachable: true, version: "v1.19.15" },
        config: { state: "active", generationId: "g-current" },
        network: {
          state: "inactive",
          desired: false,
          tcpMode: config.tcpMode,
          udpMode: config.udpMode,
          ipv4: config.ipv4,
          ipv6: config.ipv6,
        },
      });
    if (path === "/network" && request.method() === "GET")
      return response(route, { revision, config });
    if (path === "/network" && request.method() === "PUT") {
      config = (body as { config: Record<string, unknown> }).config;
      revision++;
      return response(route, { revision, config });
    }
    if (path === "/service/schedule" && request.method() === "GET")
      return response(route, { revision: scheduleRevision, config: schedule });
    if (path === "/service/schedule" && request.method() === "PUT") {
      schedule = (body as { config: typeof schedule }).config;
      scheduleRevision++;
      return response(route, { revision: scheduleRevision, config: schedule });
    }
    if (path === "/capabilities")
      return response(route, {
        protocolVersion: 1,
        implementation: "io.cno.mihomo.openwrt",
        verbs: [],
        atomicGenerations: true,
        generationRollback: true,
        networkOwnershipJournal: true,
        failOpen: true,
        mihomoSupervision: "procd",
        scriptIsolation: "fresh-cno-process",
        networkModes: ["redirect", "tproxy", "tun"],
        tunOwnership: "mihomo-device-companion-routes",
        dryRun: false,
      });
    return route.fulfill({
      status: 404,
      json: { ok: false, error: "not found" },
    });
  });
  await page.route("**/io.cno.mihomo/controller/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  return { writes, config: () => config, schedule: () => schedule };
}

test("Manager settings save TUN ownership and advanced interception policy", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("./#/mihomo-settings");
  const manager = page.getByRole("region", { name: "路由器服务" });
  await expect(manager.getByText("revision 4", { exact: true })).toBeVisible();

  await manager.getByRole("switch", { name: "TUN 接管" }).click();
  await manager.getByLabel("TUN 设备", { exact: true }).fill("mihomo0");
  await manager.getByLabel("TUN Stack", { exact: true }).selectOption("system");
  await manager.getByLabel("TUN MTU", { exact: true }).fill("1500");
  await manager.getByRole("switch", { name: "GSO" }).click();
  await manager.getByRole("switch", { name: "IPv6" }).click();
  await manager
    .getByLabel("路由器来源 ACL", { exact: true })
    .fill("192.168.1.1\n2001:db8::1/128\n192.168.1.1");
  await manager
    .getByLabel("局域网来源 ACL", { exact: true })
    .fill("192.168.0.0/16");
  await manager
    .getByLabel("LAN 入站接口", { exact: true })
    .fill("br-lan\nguest0");
  await manager
    .getByLabel("TCP 目标端口", { exact: true })
    .fill("80\n443\n8000-8999");
  await manager.getByLabel("UDP 目标端口", { exact: true }).fill("53\n443");
  await manager.getByLabel("绕过 DSCP", { exact: true }).fill("4\n46");
  await manager.getByLabel("绕过 FWMark", { exact: true }).fill("0x80/0xff");
  await manager.getByRole("switch", { name: "Fake-IP Ping 接管" }).click();
  await manager
    .getByLabel("Fake-IP IPv4 范围", { exact: true })
    .fill("198.18.0.1/16");
  await manager
    .getByLabel("Fake-IP IPv6 范围", { exact: true })
    .fill("fc00::/18");
  await manager.getByRole("button", { name: "保存网络配置" }).click();

  await expect(manager.getByText("网络配置已保存 · revision 5")).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({ method: "PUT", path: "/network" });
  expect(api.config()).toMatchObject({
    tcpMode: "tun",
    udpMode: "tun",
    ipv6: true,
    routerAcl: ["192.168.1.1", "2001:db8::1/128"],
    lanAcl: ["192.168.0.0/16"],
    lanInterfaces: ["br-lan", "guest0"],
    tcpPorts: ["80", "443", "8000-8999"],
    udpPorts: ["53", "443"],
    bypassDscp: [4, 46],
    bypassMarks: ["0x80/0xff"],
    fakeIp: {
      pingHijack: true,
      ipv4Range: "198.18.0.1/16",
      ipv6Range: "fc00::/18",
    },
    tun: { device: "mihomo0", stack: "system", mtu: 1500, gso: false },
  });
});

test("Manager settings persist the device-side restart schedule", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("./#/mihomo-settings");
  const manager = page.getByRole("region", { name: "路由器服务" });
  await manager.getByRole("switch", { name: "启用定时重启" }).click();
  await manager.getByLabel("重启时间", { exact: true }).fill("04:15");
  await manager.getByLabel("星期日", { exact: true }).uncheck();
  await manager.getByLabel("星期六", { exact: true }).uncheck();
  await manager.getByRole("button", { name: "保存定时重启" }).click();

  await expect(manager.getByText("定时重启已保存 · revision 3")).toBeVisible();
  expect(api.writes.at(-1)).toMatchObject({
    method: "PUT",
    path: "/service/schedule",
    body: {
      expectedRevision: 2,
      config: { enabled: true, time: "04:15", days: [1, 2, 3, 4, 5] },
    },
  });
  expect(api.schedule()).toEqual({
    enabled: true,
    time: "04:15",
    days: [1, 2, 3, 4, 5],
  });
});
