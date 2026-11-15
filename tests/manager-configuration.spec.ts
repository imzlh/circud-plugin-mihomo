import { expect, test, type Page, type Route } from "@playwright/test";
import { parse } from "yaml";

interface Profile {
  id: string;
  name: string;
  description: string;
  sourceUrl: string | null;
  enhancement: Record<string, unknown>;
  mixins: Array<{ id: string; enabled: boolean }>;
  position: number;
  revision: number;
  contentBytes: number;
  createdAt: number;
  updatedAt: number;
  activeRevision: number;
  content: string;
  revisionCreatedAt: number;
}

interface Mixin {
  id: string;
  name: string;
  description: string;
  kind: "merge" | "seq" | "script";
  target: "rules" | "proxies" | "groups" | null;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface Subscription {
  id: string;
  name: string;
  url: string;
  infoUrl: string;
  userAgent: string;
  prefer: "remote" | "local";
  updateIntervalMinutes: number;
  metadata: Record<string, unknown>;
  profileId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastRefreshAt: number | null;
  lastError: string | null;
}

const managerBase = "/io.cno.mihomo/api/v1";
const controllerBase = "/io.cno.mihomo/controller";
const yaml =
  "mode: rule\nproxies:\n  - name: direct\n    type: direct\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";

async function fixture(page: Page) {
  const now = 1_800_000_000_000;
  const profiles: Profile[] = [
    {
      id: "main",
      name: "主配置",
      description: "Manager profile",
      sourceUrl: null,
      enhancement: {},
      mixins: [],
      position: 0,
      revision: 1,
      contentBytes: new TextEncoder().encode(yaml).byteLength,
      createdAt: now,
      updatedAt: now,
      activeRevision: 1,
      content: yaml,
      revisionCreatedAt: now,
    },
  ];
  const mixins: Mixin[] = [];
  const subscriptions: Subscription[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  let refreshIds: string[] = [];
  const response = (route: Route, result: unknown, status = 200) =>
    route.fulfill({
      status,
      json: {
        ok: status < 400,
        ...(status < 400 ? { result } : { error: result }),
      },
    });

  await page.route(`**${managerBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(managerBase.length);
    const body = request.postData() ? request.postDataJSON() : {};
    if (request.method() !== "GET")
      writes.push({ method: request.method(), path, body });

    if (path === "/profiles" && request.method() === "GET")
      return response(
        route,
        profiles.map(
          ({
            content: _content,
            activeRevision: _active,
            revisionCreatedAt: _created,
            ...profile
          }) => profile,
        ),
      );
    const profileMatch = path.match(/^\/profiles\/([^/]+)$/);
    if (profileMatch && request.method() === "GET") {
      const profile = profiles.find(
        (item) => item.id === decodeURIComponent(profileMatch[1]!),
      );
      return profile
        ? response(route, profile)
        : response(route, { code: "not_found", message: "profile" }, 404);
    }
    if (path === "/profiles/main" && request.method() === "PUT") {
      const input = body as Partial<Profile>;
      Object.assign(profiles[0]!, input, {
        revision: profiles[0]!.revision + 1,
        activeRevision: profiles[0]!.revision + 1,
        updatedAt: now + 1,
      });
      return response(route, profiles[0]);
    }
    if (path === "/enhancement/global" && request.method() === "GET")
      return response(route, {
        revision: 0,
        enhancement: {
          version: 1,
          merge: { enabled: false, content: "{}\n" },
          script: {
            enabled: false,
            content: "function main(config) { return config; }\n",
          },
        },
      });

    if (path === "/mixins" && request.method() === "GET")
      return response(route, mixins);
    if (path === "/mixins" && request.method() === "POST") {
      const input = body as Omit<
        Mixin,
        "id" | "revision" | "createdAt" | "updatedAt"
      >;
      const mixin: Mixin = {
        ...input,
        id: "advanced",
        target: input.kind === "seq" ? input.target : null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      mixins.push(mixin);
      return response(route, mixin, 201);
    }

    if (path === "/subscriptions" && request.method() === "GET")
      return response(route, subscriptions);
    if (path === "/subscriptions" && request.method() === "POST") {
      const input = body as Omit<
        Subscription,
        | "id"
        | "metadata"
        | "revision"
        | "createdAt"
        | "updatedAt"
        | "lastRefreshAt"
        | "lastError"
      >;
      const subscription: Subscription = {
        ...input,
        id: "subscription",
        metadata: {
          refreshStatus: "not-modified",
          etag: '"config-v1"',
          infoError: "info endpoint unavailable",
        },
        revision: 1,
        createdAt: now,
        updatedAt: now,
        lastRefreshAt: now,
        lastError: null,
      };
      subscriptions.push(subscription);
      return response(route, subscription, 201);
    }
    if (path === "/subscriptions/refresh" && request.method() === "POST") {
      refreshIds = Array.isArray((body as { ids?: unknown }).ids)
        ? ((body as { ids: string[] }).ids ?? [])
        : [];
      return response(route, { operationId: "refresh-batch" }, 202);
    }
    if (path === "/operations/refresh-batch" && request.method() === "GET") {
      const results = refreshIds.map((id) => ({
        id,
        ok: id !== "failing",
        ...(id === "failing"
          ? { error: "upstream returned HTTP 503" }
          : { revision: 2 }),
      }));
      return response(route, {
        id: "refresh-batch",
        kind: "subscription.refresh-many",
        state: "succeeded",
        startedAt: now,
        finishedAt: now + 1,
        result: {
          total: results.length,
          succeeded: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
          results,
        },
        error: null,
      });
    }

    return response(
      route,
      { code: "not_found", message: `${request.method()} ${path}` },
      404,
    );
  });

  await page.route(`**${controllerBase}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      controllerBase.length,
    );
    const values: Record<string, unknown> = {
      "/version": { version: "v1.19.15", meta: true },
      "/configs": { mode: "rule", "mixed-port": 7890, "log-level": "info" },
      "/proxies": { proxies: {} },
      "/providers/proxies": { providers: {} },
      "/providers/rules": { providers: {} },
      "/rules": { rules: [] },
      "/connections": { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    return route.fulfill({
      status: path in values ? 200 : 404,
      json: values[path] ?? {},
    });
  });
  await page.routeWebSocket(`**${controllerBase}/**`, (socket) => {
    const stream = new URL(socket.url()).pathname.split("/").at(-1);
    const values: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 4096 },
      connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (stream && stream in values) socket.send(JSON.stringify(values[stream]));
  });

  return {
    profiles,
    mixins,
    subscriptions,
    writes,
    refreshIds: () => refreshIds,
  };
}

test("structured advanced mixin writes common Mihomo YAML without losing ownership boundaries", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("./#/profiles");
  await expect(page.getByText("主配置", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "新建高级配置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建混入", exact: true });
  await expect(
    dialog.getByRole("button", { name: "常用配置" }),
  ).toHaveAttribute("aria-pressed", "true");

  await dialog
    .getByRole("switch", { name: "覆盖 HTTP/SOCKS 混合端口" })
    .click();
  await dialog.getByLabel("HTTP/SOCKS 混合端口", { exact: true }).fill("7897");
  await dialog.getByRole("switch", { name: "覆盖 入站监听地址" }).click();
  await dialog.getByLabel("入站监听地址", { exact: true }).fill("0.0.0.0");

  await dialog.getByText("DNS", { exact: true }).click();
  await dialog.getByRole("switch", { name: "覆盖 Nameserver Policy" }).click();
  await dialog
    .getByLabel("Nameserver Policy", { exact: true })
    .fill("geosite:cn:\n  - 223.5.5.5\n");
  await dialog.getByRole("button", { name: "写入 Nameserver Policy" }).click();
  await dialog.getByRole("switch", { name: "覆盖 Hosts 映射" }).click();
  await dialog
    .getByLabel("Hosts 映射", { exact: true })
    .fill("router.home: 192.168.1.1\n");
  await dialog.getByRole("button", { name: "写入 Hosts 映射" }).click();

  await dialog.getByText("Sniffer", { exact: true }).click();
  await dialog.getByRole("switch", { name: "覆盖 HTTP 端口" }).click();
  await dialog.getByLabel("HTTP 端口", { exact: true }).fill("80\n8080-8880");
  await dialog.getByRole("switch", { name: "覆盖 HTTP 覆盖目标地址" }).click();

  await dialog.getByRole("button", { name: "保存混入", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("高级配置", { exact: true }).first(),
  ).toBeVisible();

  expect(api.mixins).toHaveLength(1);
  const output = parse(api.mixins[0]!.content) as Record<string, unknown>;
  expect(output).toMatchObject({
    "mixed-port": 7897,
    "bind-address": "0.0.0.0",
    dns: { "nameserver-policy": { "geosite:cn": ["223.5.5.5"] } },
    hosts: { "router.home": "192.168.1.1" },
    sniffer: {
      sniff: {
        HTTP: { port: ["80", "8080-8880"], "override-destination": true },
      },
    },
  });
  expect(output).not.toHaveProperty("redir-port");
  expect(output).not.toHaveProperty("tproxy-port");
  expect(output).not.toHaveProperty("external-controller");
  expect(output).not.toHaveProperty("secret");
  expect(api.writes.at(-1)).toMatchObject({ method: "POST", path: "/mixins" });
});

test("subscription UI persists scheduling and source preference and shows conditional status", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("./#/profiles");
  await page.getByRole("button", { name: "添加订阅", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加订阅", exact: true });
  await dialog.getByLabel("订阅名称", { exact: true }).fill("机场订阅");
  await dialog
    .getByLabel("订阅 URL", { exact: true })
    .fill("https://example.test/subscription.yaml");
  await dialog
    .getByLabel("订阅信息 URL（可选）", { exact: true })
    .fill("https://example.test/info");
  await dialog
    .getByLabel("设备端自动刷新", { exact: true })
    .selectOption("360");
  await dialog
    .getByLabel("应用配置时优先来源", { exact: true })
    .selectOption("local");
  await dialog.getByText("关联已有配置", { exact: true }).click();
  await dialog.getByLabel("关联配置", { exact: true }).selectOption("main");
  await dialog.getByRole("button", { name: "保存订阅", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await expect(page.getByText("机场订阅", { exact: true })).toBeVisible();
  await expect(page.getByText("远端无变化", { exact: true })).toBeVisible();
  await expect(page.getByText(/每 6 小时自动刷新/)).toBeVisible();
  await expect(page.getByText(/应用时仅用本地/)).toBeVisible();
  await expect(page.getByText(/条件缓存 · ETag "config-v1"/)).toBeVisible();
  await expect(
    page.getByText(/订阅信息接口：info endpoint unavailable/),
  ).toBeVisible();

  expect(api.subscriptions).toHaveLength(1);
  expect(api.subscriptions[0]).toMatchObject({
    profileId: "main",
    prefer: "local",
    updateIntervalMinutes: 360,
    userAgent: "clash",
    infoUrl: "https://example.test/info",
  });
  expect(api.writes.at(-1)).toMatchObject({
    method: "POST",
    path: "/subscriptions",
  });
});

test("subscription refresh-all skips unlinked entries and reports partial failures", async ({
  page,
}) => {
  const api = await fixture(page);
  const now = 1_800_000_000_000;
  const subscription = (
    id: string,
    name: string,
    profileId: string | null,
  ): Subscription => ({
    id,
    name,
    url: `https://example.test/${id}.yaml`,
    infoUrl: "",
    userAgent: "clash",
    prefer: "remote",
    updateIntervalMinutes: 60,
    metadata: {},
    profileId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastRefreshAt: null,
    lastError: null,
  });
  api.profiles.push({
    ...structuredClone(api.profiles[0]!),
    id: "secondary",
    name: "备用配置",
  });
  api.subscriptions.push(
    subscription("healthy", "正常订阅", "main"),
    subscription("failing", "故障订阅", "secondary"),
    subscription("unlinked", "未关联订阅", null),
  );

  await page.goto("./#/profiles");
  const manager = page.getByRole("region", { name: "配置订阅" });
  await expect(manager.getByLabel("选择订阅 未关联订阅")).toBeDisabled();
  await manager.getByRole("button", { name: "刷新全部" }).click();

  await expect(manager.getByRole("alert")).toContainText(
    "1 个订阅刷新失败，1 个成功",
  );
  await expect(manager.getByRole("alert")).toContainText(
    "故障订阅：upstream returned HTTP 503",
  );
  expect(api.refreshIds()).toEqual(["healthy", "failing"]);
  expect(
    api.writes.find((write) => write.path === "/subscriptions/refresh"),
  ).toMatchObject({
    method: "POST",
    body: { ids: ["healthy", "failing"] },
  });
});
