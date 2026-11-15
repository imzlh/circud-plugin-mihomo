import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compileProfile, parseProfileYaml } from '../src/compiler.ts';
import { COMPILER_PROTOCOL, SCRIPT_RUNNER_PROTOCOL, type CompileRequest, type ScriptRunner } from '../src/protocol.ts';

const request = (pipeline: CompileRequest['pipeline'], sourceYaml = 'MODE: rule\n'): CompileRequest => ({
  protocol: COMPILER_PROTOCOL,
  profileName: '测试配置',
  sourceYaml,
  pipeline,
});

describe('authoritative profile compiler', () => {
  it('implements Mihomo merge semantics without prototype pollution', async () => {
    const result = await compileProfile(request([{ id: 'merge', kind: 'merge', yaml: `
MODE: direct
hosts: {next: 2.2.2.2}
dns: {nameserver-policy: {next: b}}
__proto__: {polluted: true}
` }], `mode: rule
hosts: {old: 1.1.1.1}
dns: {enable: true, nameserver-policy: {old: a}}
__proto__: {base: true}
`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = parseProfileYaml(result.content);
    expect(value).toMatchObject({
      mode: 'direct', hosts: { next: '2.2.2.2' },
      dns: { enable: true, 'nameserver-policy': { next: 'b' } },
      __proto__: { base: true, polluted: true },
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('applies Seq deletion and inserts named proxies into only the first selector', async () => {
    const result = await compileProfile(request([{ id: 'nodes', kind: 'seq', target: 'proxies', yaml: `
prepend: [{name: new}]
append: [tail]
delete: [old]
` }], `proxies: [{name: old}, {name: keep}]
proxy-groups:
  - {name: first, type: SELECTOR, proxies: [old, keep, keep]}
  - {name: second, type: select, proxies: [old, keep]}
`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = parse(result.content);
    expect(value.proxies).toEqual([{ name: 'new' }, { name: 'keep' }, 'tail']);
    expect(value['proxy-groups'][0].proxies).toEqual(['new', 'tail', 'keep']);
    expect(value['proxy-groups'][1].proxies).toEqual(['keep']);
  });

  it('runs Script stages through the injected one-shot runner protocol', async () => {
    const runner: ScriptRunner = { run: async (input) => ({
      protocol: SCRIPT_RUNNER_PROTOCOL, requestId: input.requestId, ok: true,
      config: { ...input.config, touched: input.profileName }, logs: [{ level: 'info', message: 'ran' }],
    }) };
    const result = await compileProfile(request([{ id: 'script', kind: 'script', script: 'function main(c){return c}' }]), { runner });
    expect(result).toMatchObject({ ok: true, logs: [{ level: 'info', message: 'ran', stage: 'script' }] });
    if (result.ok) expect(parse(result.content).touched).toBe('测试配置');
  });

  it('produces stable revisions and distinguishes input revision from artifact hash', async () => {
    const first = await compileProfile(request([{ id: 'merge', kind: 'merge', yaml: 'mode: direct\n' }]));
    const second = await compileProfile(request([{ id: 'merge', kind: 'merge', yaml: 'mode: direct\n' }]));
    const renamed = await compileProfile({ ...request([{ id: 'merge', kind: 'merge', yaml: 'mode: direct\n' }]), profileName: 'other' });
    expect(first.ok && second.ok && renamed.ok).toBe(true);
    if (!first.ok || !second.ok || !renamed.ok) return;
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toMatchObject({ revision: second.revision, contentHash: second.contentHash });
    expect(renamed.revision).not.toBe(first.revision);
    expect(renamed.contentHash).toBe(first.contentHash);
  });

  it.each([
    'mode: rule\nmode: direct\n',
    'value: !!set {a, b}\n',
    'value: !!binary aGVsbG8=\n',
    'value: &a [*a]\n',
    '? [complex, key]\n: invalid\n',
  ])('rejects hostile or lossy YAML: %s', (yaml) => {
    expect(() => parseProfileYaml(yaml)).toThrow();
  });

  it('rejects duplicate stage ids, malformed Seq, excessive nesting and oversized scripts', async () => {
    expect((await compileProfile(request([
      { id: 'same', kind: 'merge', yaml: '{}' },
      { id: 'same', kind: 'merge', yaml: '{}' },
    ]))).ok).toBe(false);
    const seq = await compileProfile(request([{ id: 'seq', kind: 'seq', target: 'rules', yaml: 'prepend: []\nappend: []\n' }]));
    expect(seq).toMatchObject({ ok: false, code: 'INVALID_REQUEST', stage: 'seq' });
    expect(() => parseProfileYaml(`value: ${'['.repeat(102)}0${']'.repeat(102)}`)).toThrow();
    const huge = await compileProfile(request([{ id: 'script', kind: 'script', script: 'x'.repeat(1024 * 1024 + 1) }]));
    expect(huge).toMatchObject({ ok: false, code: 'LIMIT_EXCEEDED' });
  });
});
