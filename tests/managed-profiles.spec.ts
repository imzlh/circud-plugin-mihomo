import { expect, test, type Page, type Route } from '@playwright/test';

interface Profile {
  id: string;
  name: string;
  description: string;
  sourceUrl: string | null;
  enhancement: Record<string, unknown>;
  position: number;
  revision: number;
  contentBytes: number;
  createdAt: number;
  updatedAt: number;
  activeRevision: number;
  content: string;
  revisionCreatedAt: number;
}

const controllerBase = '/io.cno.mihomo/controller';
const managerBase = '/io.cno.mihomo/api/v1';
const yaml = 'mode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n';

async function fixture(page: Page) {
  const profiles: Profile[] = [];
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  const response = (route: Route, result: unknown, status = 200) =>
    route.fulfill({ status, json: { ok: status < 400, ...(status < 400 ? { result } : { error: result }) } });

  await page.route(`**${managerBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(managerBase.length);
    const body = request.postData() ? request.postDataJSON() : {};
    calls.push({ method: request.method(), path, headers: request.headers(), body });
    if (path === '/profiles' && request.method() === 'GET') return response(route, profiles.map(({ content: _content, activeRevision: _active, revisionCreatedAt: _created, ...profile }) => profile));
    if (path === '/profiles' && request.method() === 'POST') {
      const now = Date.now();
      const input = body as { name: string; description: string; content: string; sourceUrl?: string; enhancement?: Record<string, unknown> };
      const profile: Profile = {
        id: 'managed-profile',
        name: input.name,
        description: input.description,
        sourceUrl: input.sourceUrl ?? null,
        enhancement: input.enhancement ?? {},
        position: profiles.length,
        revision: 1,
        contentBytes: new TextEncoder().encode(input.content).byteLength,
        createdAt: now,
        updatedAt: now,
        activeRevision: 1,
        content: input.content,
        revisionCreatedAt: now,
      };
      profiles.push(profile);
      return response(route, profile, 201);
    }
    if (path === '/enhancement/global' && request.method() === 'GET') {
      return response(route, {
        revision: 0,
        enhancement: {
          version: 1,
          merge: { enabled: false, content: '{}\n' },
          script: { enabled: false, content: 'function main(config) { return config; }\n' },
        },
      });
    }
    if (path === '/profiles/managed-profile' && request.method() === 'GET') return response(route, profiles[0]);
    if (path === '/profiles/managed-profile/preview' && request.method() === 'POST') {
      return response(route, {
        profileId: 'managed-profile',
        profileRevision: 1,
        compilerRevision: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        content: profiles[0]!.content,
        logs: [],
        stages: [],
      });
    }
    if (path === '/profiles/managed-profile/apply' && request.method() === 'POST') {
      return response(route, { operationId: 'op-1' }, 202);
    }
    if (path === '/operations/op-1' && request.method() === 'GET') {
      return response(route, {
        id: 'op-1', kind: 'profile.apply', state: 'succeeded',
        startedAt: 1, finishedAt: 2, result: {}, error: null,
      });
    }
    return response(route, { code: 'not_found', message: `${request.method()} ${path}` }, 404);
  });

  await page.route(`**${controllerBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(controllerBase.length);
    const values: Record<string, unknown> = {
      '/version': { version: 'v1.19.15', meta: true },
      '/configs': { mode: 'rule', 'mixed-port': 7890, 'log-level': 'info' },
      '/proxies': { proxies: {} },
      '/providers/proxies': { providers: {} },
      '/providers/rules': { providers: {} },
      '/rules': { rules: [] },
      '/connections': { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    return route.fulfill({ status: path in values ? 200 : 404, json: values[path] ?? {} });
  });
  await page.routeWebSocket(`**${controllerBase}/**`, (socket) => {
    const stream = new URL(socket.url()).pathname.split('/').at(-1);
    const values: Record<string, unknown> = {
      traffic: { up: 0, down: 0 },
      memory: { inuse: 4096 },
      connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
    };
    if (stream && stream in values) socket.send(JSON.stringify(values[stream]));
  });
  return { profiles, calls };
}

test('production profiles use Manager API, never browser credentials, and apply by revision', async ({ page }) => {
  const api = await fixture(page);
  await page.addInitScript(() => {
    localStorage.setItem('mihomo-verge.backend', JSON.stringify({ url: 'http://evil.invalid', secret: 'must-not-be-used' }));
    localStorage.setItem('mihomo-verge.profile-library:local', JSON.stringify({
      version: 1,
      profiles: [{ id: 'legacy', name: 'Legacy local profile', description: '', content: 'mode: direct\n', createdAt: 1, updatedAt: 1 }],
    }));
  });
  await page.goto('./#/profiles');
  await expect(page.getByRole('heading', { name: '配置', exact: true })).toBeVisible();
  await expect(page.getByText('Legacy local profile', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '新建配置', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: '新建配置', exact: true });
  await editor.getByLabel('配置名称', { exact: true }).fill('Managed profile');
  await editor.getByLabel('描述', { exact: true }).fill('Stored by circud package');
  await editor.getByLabel('YAML 原文', { exact: false }).fill(yaml);
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('button', { name: '选择配置 Managed profile', exact: true })).toBeVisible();
  expect(api.profiles).toHaveLength(1);

  await page.getByRole('button', { name: '选择配置 Managed profile', exact: true }).click();
  await page.getByRole('button', { name: '应用配置', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '应用配置', exact: true });
  await expect(confirmation).toContainText('Managed profile');
  await confirmation.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(confirmation).not.toBeVisible();

  const writes = api.calls.filter((call) => call.method !== 'GET');
  expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
    'POST /profiles',
    'POST /profiles/managed-profile/preview',
    'POST /profiles/managed-profile/apply',
  ]);
  expect(api.calls.some((call) => call.method === 'GET' && call.path === '/operations/op-1')).toBe(true);
  for (const call of writes) {
    expect(call.headers['x-cno-mihomo-request']).toBe('1');
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.stringify(call.body)).not.toContain('must-not-be-used');
  }
});
