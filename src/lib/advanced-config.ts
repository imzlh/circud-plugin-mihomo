import { stringify } from "yaml";
import { parseProfileYaml } from "./profile-enhancement";
import type { JsonValue } from "./types";

export type AdvancedConfig = Record<string, JsonValue>;

export function readAdvancedConfig(content: string): AdvancedConfig {
  return parseProfileYaml(content || "{}\n");
}

export function writeAdvancedConfig(config: AdvancedConfig): string {
  return stringify(config, { lineWidth: 0, aliasDuplicateObjects: false });
}

export function advancedValue(
  config: AdvancedConfig,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue = config;
  for (const key of path) {
    if (!jsonMap(current)) return undefined;
    const next: JsonValue | undefined = current[key];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** Return a new config and remove empty parent mappings after a field is unset. */
export function setAdvancedValue(
  config: AdvancedConfig,
  path: readonly string[],
  value: JsonValue | undefined,
): AdvancedConfig {
  if (!path.length) return config;
  const output = structuredClone(config);
  let current: AdvancedConfig = output;
  const parents: Array<{ mapping: AdvancedConfig; key: string }> = [];
  for (const key of path.slice(0, -1)) {
    const existing = current[key];
    if (!jsonMap(existing)) current[key] = {};
    parents.push({ mapping: current, key });
    current = current[key] as AdvancedConfig;
  }
  const leaf = path[path.length - 1]!;
  if (value === undefined) delete current[leaf];
  else current[leaf] = value;
  for (const { mapping, key } of parents.reverse()) {
    const child = mapping[key];
    if (jsonMap(child) && Object.keys(child).length === 0) delete mapping[key];
    else break;
  }
  return output;
}

export function linesValue(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function mappingYaml(
  config: AdvancedConfig,
  path: readonly string[],
): string {
  const value = advancedValue(config, path);
  return jsonMap(value)
    ? stringify(value, { lineWidth: 0, aliasDuplicateObjects: false })
    : "{}\n";
}

export function parseMappingYaml(content: string): AdvancedConfig {
  const parsed = readAdvancedConfig(content || "{}\n");
  if (!jsonMap(parsed)) throw new Error("内容必须是 YAML 映射。");
  return parsed;
}

export function ruleProvidersYaml(config: AdvancedConfig): string {
  return mappingYaml(config, ["rule-providers"]);
}

export function parseRuleProvidersYaml(content: string): AdvancedConfig {
  return parseMappingYaml(content);
}

function jsonMap(value: JsonValue | undefined): value is AdvancedConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
