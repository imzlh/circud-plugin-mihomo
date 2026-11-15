import { expect, test, type Page } from "@playwright/test";

const healthy = {
  service: { enabled: true, state: "running", pid: 8842 },
  controller: { reachable: true, version: "1.19.0" },
  config: {
    state: "active",
    activeProfileId: "home",
    activeRevision: 17,
    sha256: "0123456789abcdef0123456789abcdef",
  },
  network: {
    state: "active",
    desired: true,
    tcpMode: "redirect",
    udpMode: "tproxy",
    ipv4: true,
    ipv6: false,
  },
};

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return (
          Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ) - viewport
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

test("home renders manager service, controller, generation and fw4-managed network status", async ({
  page,
}) => {
  await page.route("**/io.cno.mihomo/api/v1/status", (route) =>
    route.fulfill({ json: { ok: true, result: healthy } }),
  );
  await page.goto("./");

  const overview = page.getByRole("region", { name: "Mihomo Manager 状态" });
  await expect(
    overview.getByText("Mihomo 服务", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("Controller", { exact: true })).toBeVisible();
  await expect(overview.getByText("Generation", { exact: true })).toBeVisible();
  await expect(
    overview.getByText("透明代理 · fw4", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("PID 8842", { exact: true })).toBeVisible();
  await expect(overview.getByText("1.19.0", { exact: true })).toBeVisible();
  await expect(
    overview.getByText("revision 17 · 0123456789ab", { exact: true }),
  ).toBeVisible();
  await expect(
    overview.getByText("TCP REDIRECT · UDP TPROXY", { exact: true }),
  ).toBeVisible();
});

test("home distinguishes a degraded fw4 snapshot from a manager transport failure", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/io.cno.mihomo/api/v1/status", (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Manager 暂时不可用" }),
      });
    return route.fulfill({
      json: {
        ok: true,
        result: {
          ...healthy,
          controller: { reachable: false },
          config: {
            state: "failed",
            activeRevision: 16,
            sha256: "previous-generation",
          },
          network: {
            ...healthy.network,
            state: "degraded",
            lastError: "fw4 generation mismatch",
          },
        },
      },
    });
  });
  await page.goto("./");

  const overview = page.getByRole("region", { name: "Mihomo Manager 状态" });
  await expect(overview.getByText("不可访问", { exact: true })).toBeVisible();
  await expect(overview.getByText("生成失败", { exact: true })).toBeVisible();
  await expect(overview.getByText("状态异常", { exact: true })).toBeVisible();
  await expect(
    overview.getByText("fw4 generation mismatch", { exact: true }),
  ).toBeVisible();

  fail = true;
  await overview.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(overview.getByRole("alert")).toContainText("Manager 暂时不可用");
  await expect(overview.getByRole("alert")).toContainText("状态可能已过期");
  await expect(
    overview.getByText("fw4 generation mismatch", { exact: true }),
  ).toBeVisible();
});

test("manager error state stays explicit and contained on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/io.cno.mihomo/api/v1/status", (route) =>
    route.fulfill({ status: 503, body: "<html>gateway unavailable</html>" }),
  );
  await page.goto("./");

  const overview = page.getByRole("region", { name: "Mihomo Manager 状态" });
  await expect(overview.getByRole("alert")).toContainText("管理请求失败");
  await expect(overview.getByText("不可用", { exact: true })).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
});
