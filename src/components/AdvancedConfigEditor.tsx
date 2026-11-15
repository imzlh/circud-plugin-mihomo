import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import {
  advancedValue,
  linesValue,
  mappingYaml,
  parseMappingYaml,
  parseRuleProvidersYaml,
  readAdvancedConfig,
  ruleProvidersYaml,
  setAdvancedValue,
  writeAdvancedConfig,
  type AdvancedConfig,
} from "../lib/advanced-config";
import type { JsonValue } from "../lib/types";
import { Toggle } from "./ui";
import "./advanced-config-editor.css";

interface AdvancedConfigEditorProps {
  content: string;
  onChange: (content: string) => void;
}

type Path = readonly string[];

export function AdvancedConfigEditor({
  content,
  onChange,
}: AdvancedConfigEditorProps) {
  const parsed = useMemo(() => {
    try {
      return { config: readAdvancedConfig(content), error: "" };
    } catch (error) {
      return {
        config: {} as AdvancedConfig,
        error: error instanceof Error ? error.message : "Merge YAML 无法解析。",
      };
    }
  }, [content]);
  const [providerDraft, setProviderDraft] = useState<string | null>(null);
  const [providerError, setProviderError] = useState("");
  const config = parsed.config;

  function change(path: Path, value: JsonValue | undefined) {
    if (parsed.error) return;
    onChange(writeAdvancedConfig(setAdvancedValue(config, path, value)));
  }

  function saveProviders() {
    try {
      const providers = parseRuleProvidersYaml(providerDraft ?? "{}\n");
      change(
        ["rule-providers"],
        Object.keys(providers).length ? providers : undefined,
      );
      setProviderDraft(null);
      setProviderError("");
    } catch (error) {
      setProviderError(
        error instanceof Error
          ? error.message
          : "Rule Provider YAML 无法解析。",
      );
    }
  }

  if (parsed.error)
    return (
      <div className="advanced-config-error" role="alert">
        当前 Merge 原文无法结构化编辑：{parsed.error}。请切回“原文”修复后重试。
      </div>
    );

  return (
    <div className="advanced-config-editor">
      <div className="advanced-config-intro">
        <Settings2 size={16} />
        <p>
          只覆盖勾选的字段；未展示的键保持原样。透明代理端口、Controller、Secret、DNS
          监听和 TUN 路由参数由 Manager 最后覆盖。
        </p>
      </div>

      <Section title="常规" open>
        <SelectField
          config={config}
          path={["mode"]}
          label="运行模式"
          onChange={change}
        >
          <option value="rule">Rule</option>
          <option value="global">Global</option>
          <option value="direct">Direct</option>
        </SelectField>
        <SelectField
          config={config}
          path={["log-level"]}
          label="日志级别"
          onChange={change}
        >
          {["debug", "info", "warning", "error", "silent"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>
        <SelectField
          config={config}
          path={["find-process-mode"]}
          label="进程匹配"
          onChange={change}
        >
          <option value="off">Off</option>
          <option value="strict">Strict</option>
          <option value="always">Always</option>
        </SelectField>
        <TextField
          config={config}
          path={["interface-name"]}
          label="出站接口"
          onChange={change}
        />
        <TextField
          config={config}
          path={["bind-address"]}
          label="入站监听地址"
          onChange={change}
        />
        <NumberField
          config={config}
          path={["port"]}
          label="HTTP 代理端口"
          min={0}
          max={65535}
          onChange={change}
        />
        <NumberField
          config={config}
          path={["socks-port"]}
          label="SOCKS 代理端口"
          min={0}
          max={65535}
          onChange={change}
        />
        <NumberField
          config={config}
          path={["mixed-port"]}
          label="HTTP/SOCKS 混合端口"
          min={0}
          max={65535}
          onChange={change}
        />
        <ListField
          config={config}
          path={["authentication"]}
          label="入站认证（用户名:密码）"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["ipv6"]}
          label="IPv6"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["allow-lan"]}
          label="允许 LAN 监听"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["unified-delay"]}
          label="统一延迟"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["tcp-concurrent"]}
          label="TCP 并发"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["disable-keep-alive"]}
          label="停用 TCP Keepalive"
          onChange={change}
        />
        <NumberField
          config={config}
          path={["keep-alive-idle"]}
          label="Keepalive 空闲秒数"
          min={0}
          max={86400}
          onChange={change}
        />
        <NumberField
          config={config}
          path={["keep-alive-interval"]}
          label="Keepalive 探测间隔（秒）"
          min={0}
          max={86400}
          onChange={change}
        />
      </Section>

      <Section title="DNS">
        <BooleanField
          config={config}
          path={["dns", "enable"]}
          label="启用 DNS"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["dns", "ipv6"]}
          label="返回 IPv6"
          onChange={change}
        />
        <SelectField
          config={config}
          path={["dns", "enhanced-mode"]}
          label="增强模式"
          onChange={change}
        >
          <option value="normal">Normal</option>
          <option value="fake-ip">Fake-IP</option>
          <option value="redir-host">Redir-Host</option>
        </SelectField>
        <SelectField
          config={config}
          path={["dns", "cache-algorithm"]}
          label="缓存算法"
          onChange={change}
        >
          <option value="lru">LRU</option>
          <option value="arc">ARC</option>
        </SelectField>
        <TextField
          config={config}
          path={["dns", "fake-ip-range"]}
          label="Fake-IP IPv4 范围"
          onChange={change}
        />
        <TextField
          config={config}
          path={["dns", "fake-ip-range6"]}
          label="Fake-IP IPv6 范围"
          onChange={change}
        />
        <NumberField
          config={config}
          path={["dns", "fake-ip-ttl"]}
          label="Fake-IP TTL（秒）"
          min={1}
          max={86400}
          onChange={change}
        />
        <SelectField
          config={config}
          path={["dns", "fake-ip-filter-mode"]}
          label="Fake-IP 过滤模式"
          onChange={change}
        >
          <option value="blacklist">Blacklist</option>
          <option value="whitelist">Whitelist</option>
          <option value="rule">Rule</option>
        </SelectField>
        <BooleanField
          config={config}
          path={["dns", "respect-rules"]}
          label="DNS 遵循规则"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["dns", "prefer-h3"]}
          label="DoH 优先 HTTP/3"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["dns", "use-system-hosts"]}
          label="读取系统 Hosts"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["dns", "use-hosts"]}
          label="使用配置 Hosts"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["dns", "direct-nameserver-follow-policy"]}
          label="直连 DNS 遵循策略"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "default-nameserver"]}
          label="默认 DNS"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "nameserver"]}
          label="代理 DNS"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "proxy-server-nameserver"]}
          label="代理节点域名 DNS"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "direct-nameserver"]}
          label="直连 DNS"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "fallback"]}
          label="Fallback DNS"
          onChange={change}
        />
        <ListField
          config={config}
          path={["dns", "fake-ip-filter"]}
          label="Fake-IP 过滤"
          onChange={change}
        />
        <MappingField
          config={config}
          path={["dns", "nameserver-policy"]}
          label="Nameserver Policy"
          help="键为域名、通配符、GEOSITE 或规则集匹配器；值为 DNS 地址或地址列表。"
          onChange={change}
        />
        <MappingField
          config={config}
          path={["dns", "proxy-server-nameserver-policy"]}
          label="代理节点 DNS Policy"
          help="为代理节点域名指定 DNS；键为匹配器，值为 DNS 地址或地址列表。"
          onChange={change}
        />
        <MappingField
          config={config}
          path={["hosts"]}
          label="Hosts 映射"
          help="键为域名，值可以是一个地址或地址列表。"
          onChange={change}
        />
      </Section>

      <Section title="Sniffer">
        <BooleanField
          config={config}
          path={["sniffer", "enable"]}
          label="启用嗅探"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["sniffer", "force-dns-mapping"]}
          label="强制 DNS 映射"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["sniffer", "parse-pure-ip"]}
          label="解析纯 IP"
          onChange={change}
        />
        <ListField
          config={config}
          path={["sniffer", "force-domain"]}
          label="强制嗅探域名"
          onChange={change}
        />
        <ListField
          config={config}
          path={["sniffer", "skip-domain"]}
          label="跳过嗅探域名"
          onChange={change}
        />
        {(["HTTP", "TLS", "QUIC"] as const).map((protocol) => (
          <div className="advanced-protocol-fields" key={protocol}>
            <ListField
              config={config}
              path={["sniffer", "sniff", protocol, "port"]}
              label={`${protocol} 端口`}
              onChange={change}
            />
            <BooleanField
              config={config}
              path={["sniffer", "sniff", protocol, "override-destination"]}
              label={`${protocol} 覆盖目标地址`}
              onChange={change}
            />
          </div>
        ))}
      </Section>

      <Section title="缓存与 GeoX">
        <BooleanField
          config={config}
          path={["profile", "store-selected"]}
          label="保存节点选择"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["profile", "store-fake-ip"]}
          label="保存 Fake-IP"
          onChange={change}
        />
        <BooleanField
          config={config}
          path={["geodata-mode"]}
          label="使用 GeoData"
          onChange={change}
        />
        <SelectField
          config={config}
          path={["geodata-loader"]}
          label="GeoData 加载器"
          onChange={change}
        >
          <option value="standard">Standard</option>
          <option value="memconservative">Memory Conservative</option>
        </SelectField>
        <BooleanField
          config={config}
          path={["geo-auto-update"]}
          label="自动更新 GeoX"
          onChange={change}
        />
        <NumberField
          config={config}
          path={["geo-update-interval"]}
          label="GeoX 更新间隔（小时）"
          min={1}
          max={720}
          onChange={change}
        />
        <TextField
          config={config}
          path={["geox-url", "geosite"]}
          label="GeoSite URL"
          onChange={change}
        />
        <TextField
          config={config}
          path={["geox-url", "geoip"]}
          label="GeoIP DAT URL"
          onChange={change}
        />
        <TextField
          config={config}
          path={["geox-url", "mmdb"]}
          label="GeoIP MMDB URL"
          onChange={change}
        />
        <TextField
          config={config}
          path={["geox-url", "asn"]}
          label="ASN URL"
          onChange={change}
        />
      </Section>

      <Section title="Rule Provider">
        <div className="advanced-provider-editor">
          <p>
            以 Mihomo 的 <code>rule-providers</code>{" "}
            映射格式编辑；规则本身请使用 Seq 混入，便于独立排序。
          </p>
          <textarea
            className="field"
            aria-label="Rule Provider YAML"
            spellCheck={false}
            value={providerDraft ?? ruleProvidersYaml(config)}
            onChange={(event) => {
              setProviderDraft(event.target.value);
              setProviderError("");
            }}
          />
          {providerError && <span role="alert">{providerError}</span>}
          <button
            className="button small"
            type="button"
            disabled={providerDraft === null}
            onClick={saveProviders}
          >
            写入 Rule Provider
          </button>
        </div>
      </Section>
    </div>
  );
}

function MappingField(props: FieldProps & { help: string }) {
  const enabled = advancedValue(props.config, props.path) !== undefined;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");

  function save() {
    try {
      const mapping = parseMappingYaml(draft ?? "{}\n");
      props.onChange(props.path, mapping);
      setDraft(null);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "YAML 映射无法解析。",
      );
    }
  }

  return (
    <div className="advanced-mapping-field">
      <div className="advanced-mapping-heading">
        <div>
          <strong>{props.label}</strong>
          <small>{props.help}</small>
        </div>
        <Toggle
          label={`覆盖 ${props.label}`}
          checked={enabled}
          onChange={(checked) => {
            setDraft(null);
            setError("");
            props.onChange(props.path, checked ? {} : undefined);
          }}
        />
      </div>
      {enabled && (
        <>
          <textarea
            className="field"
            aria-label={props.label}
            spellCheck={false}
            value={draft ?? mappingYaml(props.config, props.path)}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
          />
          {error && <span role="alert">{error}</span>}
          <button
            className="button small"
            type="button"
            disabled={draft === null}
            onClick={save}
          >
            写入 {props.label}
          </button>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="advanced-config-section" open={open}>
      <summary>
        <span>{title}</span>
        <ChevronDown size={15} />
      </summary>
      <div className="advanced-config-grid">{children}</div>
    </details>
  );
}

function FieldShell({
  config,
  path,
  label,
  children,
  onChange,
  initial,
}: {
  config: AdvancedConfig;
  path: Path;
  label: string;
  children: (enabled: boolean) => ReactNode;
  onChange: (path: Path, value: JsonValue | undefined) => void;
  initial: JsonValue;
}) {
  const enabled = advancedValue(config, path) !== undefined;
  return (
    <div className="advanced-config-field">
      <div>
        <label>{label}</label>
        <Toggle
          label={`覆盖 ${label}`}
          checked={enabled}
          onChange={(checked) => onChange(path, checked ? initial : undefined)}
        />
      </div>
      {children(enabled)}
    </div>
  );
}

function TextField(props: FieldProps) {
  const value = advancedValue(props.config, props.path);
  return (
    <FieldShell {...props} initial="">
      {(enabled) => (
        <input
          className="field"
          aria-label={props.label}
          disabled={!enabled}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => props.onChange(props.path, event.target.value)}
        />
      )}
    </FieldShell>
  );
}

function NumberField(props: FieldProps & { min: number; max: number }) {
  const value = advancedValue(props.config, props.path);
  return (
    <FieldShell {...props} initial={props.min}>
      {(enabled) => (
        <input
          className="field"
          type="number"
          min={props.min}
          max={props.max}
          aria-label={props.label}
          disabled={!enabled}
          value={typeof value === "number" ? value : props.min}
          onChange={(event) =>
            props.onChange(props.path, Number(event.target.value))
          }
        />
      )}
    </FieldShell>
  );
}

function BooleanField(props: FieldProps) {
  const value = advancedValue(props.config, props.path);
  return (
    <FieldShell {...props} initial={true}>
      {(enabled) => (
        <select
          className="field"
          aria-label={props.label}
          disabled={!enabled}
          value={value === false ? "false" : "true"}
          onChange={(event) =>
            props.onChange(props.path, event.target.value === "true")
          }
        >
          <option value="true">启用</option>
          <option value="false">停用</option>
        </select>
      )}
    </FieldShell>
  );
}

function SelectField({
  children,
  ...props
}: FieldProps & { children: ReactNode }) {
  const value = advancedValue(props.config, props.path);
  const first = firstOptionValue(children);
  return (
    <FieldShell {...props} initial={first}>
      {(enabled) => (
        <select
          className="field"
          aria-label={props.label}
          disabled={!enabled}
          value={typeof value === "string" ? value : first}
          onChange={(event) => props.onChange(props.path, event.target.value)}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}

function ListField(props: FieldProps) {
  const value = advancedValue(props.config, props.path);
  return (
    <FieldShell {...props} initial={[]}>
      {(enabled) => (
        <textarea
          className="field advanced-list-field"
          aria-label={props.label}
          disabled={!enabled}
          placeholder="每行一项"
          value={Array.isArray(value) ? value.map(String).join("\n") : ""}
          onChange={(event) =>
            props.onChange(props.path, linesValue(event.target.value))
          }
        />
      )}
    </FieldShell>
  );
}

interface FieldProps {
  config: AdvancedConfig;
  path: Path;
  label: string;
  onChange: (path: Path, value: JsonValue | undefined) => void;
}

function firstOptionValue(children: ReactNode): string {
  const values = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const child of values) {
    if (child && typeof child === "object" && "props" in child) {
      const value = (child as { props?: { value?: unknown } }).props?.value;
      if (typeof value === "string") return value;
    }
  }
  return "";
}
