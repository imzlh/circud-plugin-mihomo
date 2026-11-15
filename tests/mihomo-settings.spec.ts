import { expect, test, type Page, type Route } from "@playwright/test";
import { parse } from "yaml";

const managerBase = "/io.cno.mihomo/api/v1";
const enhancement = {
  version: 1 as const,
  merge: { enabled: false, content: "dns:\n  enable: true\n" },
  script: {
    enabled: true,
    content: "function main(config) { return config; }\n",
  },
};

async function liveManager(page: Page) {
  let revision = 7;
  let current = structuredClone(enhancement);
  const writes: unknown[] = [];
  const response = (route: Route, result: unknown) =>
    route.fulfill({ json: { ok: true, result } });

  await page.route(`**${managerBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(managerBase.length);
    if (path === "/enhancement/global" && request.method() === "GET")
      return response(route, { revision, enhancement: current });
    if (path === "/enhancement/global" && request.method() === "PUT") {
      const body = request.postDataJSON();
      writes.push(body);
      current = body.enhancement;
      revision++;
      return response(route, { revision, enhancement: current });
    }
    if (path === "/status")
      return response(route, {
        service: { enabled: true, state: "running", pid: 1000 },
        controller: { reachable: true, version: "v1.19.15" },
        config: { state: "active", generationId: "generation-current" },
        network: {
          state: "inactive",
          desired: false,
          tcpMode: "redirect",
          udpMode: "tproxy",
          ipv4: true,
          ipv6: false,
        },
      });
    if (path === "/network")
      return response(route, {
        revision: 2,
        config: {
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
          reservedCidrs: ["10.0.0.0/8"],
          fakeIp: { pingHijack: false, ipv4Range: "", ipv6Range: "" },
          tun: { device: "mihomo", stack: "mixed", mtu: 9000, gso: true },
        },
      });
    if (path === "/service/schedule")
      return response(route, {
        revision: 1,
        config: {
          enabled: false,
          time: "03:00",
          days: [0, 1, 2, 3, 4, 5, 6],
        },
      });
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
  return { writes };
}

test("Mihomo settings are first-class navigation and persist global merge with CAS", async ({
  page,
}) => {
  const api = await liveManager(page);
  await page.goto("./#/mihomo-settings");

  await expect(page.getByRole("link", { name: "Mihomo 设置" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "全局内核配置" }),
  ).toBeVisible();
  await expect(page.getByText("DNS", { exact: true })).toBeVisible();
  await expect(page.getByText("Sniffer", { exact: true })).toBeVisible();
  await expect(page.getByText("缓存与 GeoX", { exact: true })).toBeVisible();
  await expect(page.getByText("Rule Provider", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "路由器服务" })).toBeVisible();

  await page.getByRole("switch", { name: "覆盖 运行模式" }).click();
  await page.getByLabel("运行模式", { exact: true }).selectOption("global");
  await page.getByRole("button", { name: "保存 Mihomo 设置" }).click();

  await expect(page.getByText("Mihomo 设置已保存 · revision 8")).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0]).toMatchObject({
    expectedRevision: 7,
    enhancement: {
      version: 1,
      merge: { enabled: true },
      script: enhancement.script,
    },
  });
  const body = api.writes[0] as {
    enhancement: { merge: { content: string } };
  };
  expect(parse(body.enhancement.merge.content)).toMatchObject({
    mode: "global",
    dns: { enable: true },
  });
});

test("Mihomo settings keep the full form visible when Manager is unavailable", async ({
  page,
}) => {
  await page.route(`**${managerBase}/**`, (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, error: "Manager unavailable" },
    }),
  );
  await page.route("**/io.cno.mihomo/controller/**", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("./#/mihomo-settings");

  await expect(
    page.getByText("只读预览", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByLabel("运行模式", { exact: true })).toBeVisible();
  await expect(page.getByLabel("TCP 模式", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("路由器来源 ACL", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存 Mihomo 设置" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存网络配置" }),
  ).toBeDisabled();
});
