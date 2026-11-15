import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  linesValue,
  mappingYaml,
  parseMappingYaml,
  readAdvancedConfig,
  ruleProvidersYaml,
  setAdvancedValue,
  writeAdvancedConfig,
} from "./advanced-config";

describe("advanced config structured editing", () => {
  it("preserves unknown keys while changing a known nested field", () => {
    const input = readAdvancedConfig(`
x-private:
  nested: keep
dns:
  enable: true
  unknown-dns-key: keep-too
`);
    const output = setAdvancedValue(input, ["dns", "prefer-h3"], true);
    expect(parse(writeAdvancedConfig(output))).toEqual({
      "x-private": { nested: "keep" },
      dns: { enable: true, "unknown-dns-key": "keep-too", "prefer-h3": true },
    });
  });

  it("removes empty parent mappings when the last nested override is unset", () => {
    const input = readAdvancedConfig(
      "sniffer:\n  sniff:\n    HTTP:\n      port: [80]\n",
    );
    const output = setAdvancedValue(
      input,
      ["sniffer", "sniff", "HTTP", "port"],
      undefined,
    );
    expect(output).toEqual({});
  });

  it("round-trips rule providers and arbitrary policy mappings", () => {
    const config = readAdvancedConfig(`
rule-providers:
  privacy:
    type: http
    behavior: domain
    url: https://example.test/privacy.yaml
dns:
  nameserver-policy:
    geosite:cn: [223.5.5.5, 119.29.29.29]
`);
    expect(parseMappingYaml(ruleProvidersYaml(config))).toEqual(
      config["rule-providers"],
    );
    expect(
      parseMappingYaml(mappingYaml(config, ["dns", "nameserver-policy"])),
    ).toEqual((config.dns as Record<string, unknown>)["nameserver-policy"]);
  });

  it("normalizes one-item-per-line values without duplicates or blanks", () => {
    expect(linesValue("  1.1.1.1\n\n8.8.8.8\n1.1.1.1\r\n")).toEqual([
      "1.1.1.1",
      "8.8.8.8",
    ]);
  });
});
