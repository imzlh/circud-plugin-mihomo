import { describe, expect, it } from 'vitest';
import { parseRunnerRequest, serializeRunnerResult } from '../src/runner-protocol.ts';
import { SCRIPT_RUNNER_PROTOCOL } from '../src/protocol.ts';

describe('one-shot runner envelopes', () => {
  const valid = {
    protocol: SCRIPT_RUNNER_PROTOCOL,
    requestId: 'stage-1',
    profileName: 'profile',
    script: 'function main(config) { return config; }',
    config: { mode: 'rule' },
  };

  it('round-trips valid input and output', () => {
    expect(parseRunnerRequest(JSON.stringify(valid))).toEqual(valid);
    expect(JSON.parse(serializeRunnerResult({
      protocol: SCRIPT_RUNNER_PROTOCOL, requestId: 'stage-1', ok: true,
      config: { mode: 'rule' }, logs: [],
    }))).toMatchObject({ ok: true, requestId: 'stage-1' });
  });

  it.each([
    'not json',
    'null',
    JSON.stringify({ ...valid, protocol: 'wrong' }),
    JSON.stringify({ ...valid, requestId: '' }),
    JSON.stringify({ ...valid, script: '' }),
    JSON.stringify({ ...valid, config: [] }),
    JSON.stringify({ ...valid, unknown: true }),
    JSON.stringify({ ...valid, config: { bad: null }, extra: { ignored: true } }).replace('"bad":null', '"bad":1e999'),
  ])('rejects malformed or lossy input: %s', (input) => {
    expect(() => parseRunnerRequest(input)).toThrow();
  });

  it('preserves hostile property names as inert data', () => {
    const parsed = parseRunnerRequest(JSON.stringify({ ...valid, config: { '__proto__': { polluted: true }, constructor: { prototype: { polluted: true } } } }));
    expect(Object.getPrototypeOf(parsed.config)).toBeNull();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
