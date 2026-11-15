import { COMPILER_LIMITS, type JsonValue, type ProfileConfig } from './protocol.ts';

export type Sha256 = (value: string) => Promise<string>;

export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 && code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export function jsonMap(value: JsonValue | undefined): value is ProfileConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function safeJson(value: unknown, maximumBytes = COMPILER_LIMITS.configBytes): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > COMPILER_LIMITS.maxDepth) throw new Error('JSON nesting exceeds 100 levels.');
    if (++nodes > COMPILER_LIMITS.maxNodes) throw new Error('JSON node count exceeds the limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object') throw new Error('Only lossless JSON values are allowed.');
    if (!Array.isArray(item) && !(item instanceof Map) && !isRecord(item))
      throw new Error('Only plain JSON objects are allowed.');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Symbol properties are not allowed.');
    if (ancestors.has(item)) throw new Error('Cycles and recursive aliases are not allowed.');
    ancestors.add(item);
    let output: JsonValue;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new Error('Sparse arrays are not allowed.');
      output = item.map((child) => visit(child, depth + 1));
    } else {
      const record: ProfileConfig = Object.create(null);
      if (item instanceof Map) {
        for (const [key, child] of item.entries()) {
          if (typeof key !== 'string') throw new Error('Object keys must be strings.');
          record[key] = visit(child, depth + 1);
        }
      } else {
        for (const key of Object.keys(item)) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor)) throw new Error('Getters and setters are not allowed.');
          record[key] = visit(descriptor.value, depth + 1);
        }
      }
      output = record;
    }
    ancestors.delete(item);
    return output;
  };
  const output = visit(value, 0);
  if (utf8Bytes(stableStringify(output)) > maximumBytes) throw new Error('JSON value exceeds the byte limit.');
  return output;
}

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(',')}}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
