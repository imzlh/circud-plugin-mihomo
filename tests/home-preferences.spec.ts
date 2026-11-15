import { expect, test, type Page } from '@playwright/test';
import type { ProxyNode, ProxyProvider } from '../src/lib/types';

const controllerPath = '/io.cno.mihomo/controller';

async function controllerFixture(page: Page) {
  const proxies: Record<string, ProxyNode> = {
    Exit: {
      name: 'Exit',
      type: 'URLTest',
      all: ['Local'],
      now: 'Local',
      fixed: 'Local',
      history: [],
      testUrl: 'https://example.com/check',
      expectedStatus: '204',
    },
    Local: { name: 'Local', type: 'Shadowsocks', history: [] },
  };
  const providers: Record<string, ProxyProvider> = {};
  const delays: { url: URL }[] = [];
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  await page.route(`**${controllerPath}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const url = new URL(request.url());
    const path = url.pathname.slice(controllerPath.length);
    const json = (value: unknown) => route.fulfill({ json: value, headers });
    if (path.endsWith('/delay') || path.endsWith('/healthcheck')) {
      delays.push({ url });
      await route.fulfill({ status: 204, headers });
    } else if (path === '/version') await json({ version: 'test', meta: true });
    else if (path === '/configs')
      await json({
        mode: 'rule',
        'mixed-port': 7890,
        'allow-lan': false,
        ipv6: false,
        'log-level': 'info',
      });
    else if (path === '/proxies') await json({ proxies });
    else if (path === '/providers/proxies') await json({ providers });
    else if (path === '/providers/rules') await json({ providers: {} });
    else if (path === '/rules') await json({ rules: [] });
    else if (path === '/connections')
      await json({ connections: [], uploadTotal: 0, downloadTotal: 0 });
    else await route.fulfill({ status: 404, headers });
  });
  await page.routeWebSocket(`**${controllerPath}/**`, () => {});
  await page.goto('./');
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  return { delays };
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport;
      }),
    )
    .toBeLessThanOrEqual(1);
}

test('home defaults are safe and hidden memory and cards persist after a reload', async ({
  page,
}) => {
  await controllerFixture(page);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).not.toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' })).toHaveValue('5');
  await expect(dialog.getByRole('combobox', { name: '流量图表样式' })).toHaveValue('area');
  await dialog.getByRole('switch', { name: '显示内存占用', exact: true }).click();
  await dialog.getByRole('switch', { name: '显示流量趋势', exact: true }).click();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(3);
  await expect(page.locator('.stat-card').filter({ hasText: '内存占用' })).toHaveCount(0);
  await expect(page.locator('.traffic-panel')).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(3);
  await expect(page.locator('.stat-card').filter({ hasText: '内存占用' })).toHaveCount(0);
  await expect(page.locator('.traffic-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '显示内存占用', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: '显示流量趋势', exact: true })).not.toBeChecked();
});

test('both chart styles and every member sort persist across reloads', async ({ page }) => {
  await controllerFixture(page);
  const chart = page.locator('.traffic-panel .traffic-chart');
  const sort = page.getByRole('combobox', { name: '首页成员排序', exact: true });
  await expect(chart).toHaveAttribute('data-chart-style', 'area');
  await expect(sort).toHaveValue('default');

  await page.getByRole('button', { name: '切换流量图表样式', exact: true }).click();
  await sort.selectOption('delay');
  await page.reload();
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  await expect(chart).toHaveAttribute('data-chart-style', 'line');
  await expect(sort).toHaveValue('delay');

  await sort.selectOption('name');
  await page.reload();
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  await expect(sort).toHaveValue('name');
  await expect(chart).toHaveAttribute('data-chart-style', 'line');

  await sort.selectOption('default');
  await page.getByRole('button', { name: '切换流量图表样式', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('首页代理组成员')).toBeEnabled();
  await expect(sort).toHaveValue('default');
  await expect(chart).toHaveAttribute('data-chart-style', 'area');
});

test('narrow home restores hidden cards and exit delay testing makes no requests when off or hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { delays } = await controllerFixture(page);
  await page.clock.install();
  await expectNoHorizontalOverflow(page);
  await page.clock.runFor(120_000);
  expect(delays).toEqual([]);

  await page.getByRole('button', { name: '首页设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('switch', { name: '自动测试当前出口延迟', exact: true }).click();
  await dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' }).fill('1');
  for (const label of [
    '内存占用',
    '实时网络指标',
    '流量趋势',
    '出站模式',
    '代理组出口',
    '代理集',
    '内核配置',
  ]) {
    await dialog.getByRole('switch', { name: `显示${label}`, exact: true }).click();
  }
  // Enabling auto testing measures the visible exit once immediately; that
  // request is legitimate. From here on the cards stay hidden or the switch
  // is off, so no further requests may appear.
  const requestsWhileVisible = delays.length;
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-grid, .overview-main-grid, .overview-bottom-grid')).toHaveCount(
    0,
  );
  await expectNoHorizontalOverflow(page);
  await page.clock.runFor(120_000);
  expect(delays).toHaveLength(requestsWhileVisible);

  await page.reload();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置显示卡片', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: '自动测速间隔（分钟）' })).toHaveValue('1');
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: '自动测试当前出口延迟' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('首页卡片已隐藏', { exact: true })).toHaveCount(0);
  await expect(page.locator('.stats-grid .stat-card')).toHaveCount(4);
  for (const title of ['流量趋势', '出站模式', '代理组出口', '代理集', '内核配置']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
  expect(delays).toHaveLength(requestsWhileVisible);
});
