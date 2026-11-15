import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Monitor, Moon, Palette, Server, ShieldCheck, Sun } from "lucide-react";
import { RuntimeSettings } from "../components/RuntimeSettings";
import { PreferenceBackup } from "../components/PreferenceBackup";
import { Badge, PageHeader } from "../components/ui";
import type { MihomoConfigPatch } from "../lib/types";
import { maintenanceStore } from "../lib/core-maintenance";
import { useMihomo } from "../state/mihomo";
import "./settings.css";

type ThemePreference = "light" | "dark" | "system";
const themeKey = "mihomo-verge.theme";
const themes = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(themeKey);
    if (value === "light" || value === "dark" || value === "system")
      return value;
  } catch {
    /* Theme selection still works for the current browser session. */
  }
  return "system";
}

export default function Settings() {
  const { client } = useMihomo();
  const [scope, setScope] = useState({ client, id: 0 });
  if (scope.client !== client) {
    setScope({ client, id: scope.id + 1 });
  }
  return <SessionSettings key={scope.id} />;
}

/** A new controller session starts with fresh drafts, confirmations and busy state. */
function SessionSettings() {
  const {
    profile,
    client,
    connected,
    status,
    config,
    version,
    patchConfig,
    notify,
  } = useMihomo();
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const [pending, setPending] = useState<string | null>(null);
  const active = useRef(false);
  const maintenance = maintenanceStore(client);
  const { pending: maintenancePending, configWriting } = useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
  );
  const coreDisabled =
    !connected ||
    !config ||
    pending !== null ||
    maintenancePending !== null ||
    configWriting;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener("theme-change", sync);
    return () => window.removeEventListener("theme-change", sync);
  }, []);

  const selectTheme = (value: ThemePreference) => {
    try {
      localStorage.setItem(themeKey, value);
    } catch {
      notify("主题已应用，浏览器未允许保存偏好", "info");
    }
    document.documentElement.dataset.theme =
      value === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : value;
    window.dispatchEvent(new Event("theme-change"));
    setTheme(value);
  };

  const updateCore = async (
    name: string,
    patch: MihomoConfigPatch,
  ): Promise<boolean> => {
    if (coreDisabled) return false;
    setPending(name);
    try {
      const success = await patchConfig(patch);
      return active.current && success;
    } finally {
      if (active.current) setPending(null);
    }
  };

  const backendLabel = connected
    ? "已连接"
    : status === "connecting"
      ? "连接中"
      : "连接不可用";

  return (
    <div className="settings-page">
      <PageHeader title="设置" description="让每一次连接，都更合你意。" />

      <section
        className="panel settings-section"
        aria-labelledby="backend-heading"
      >
        <div className="settings-section-heading">
          <Server size={19} />
          <h2 id="backend-heading">后端连接</h2>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <div className="settings-title-line">
              <strong>Mihomo 内核</strong>
              <Badge
                tone={connected ? "green" : profile ? "orange" : "neutral"}
              >
                {backendLabel}
              </Badge>
            </div>
            <p className="settings-backend-address">{profile.url}</p>
            {connected && (
              <span className="settings-version">内核版本 {version}</span>
            )}
          </div>
          <div className="settings-backend-actions">
            <span className="button" aria-label="连接由管理服务托管">
              <ShieldCheck size={16} />
              同源托管
            </span>
          </div>
        </div>
      </section>

      <section
        className="panel settings-section"
        aria-labelledby="appearance-heading"
      >
        <div className="settings-section-heading">
          <Palette size={19} />
          <h2 id="appearance-heading">外观</h2>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>界面主题</strong>
            <p>选择你喜欢的明暗风格</p>
          </div>
          <div
            className="segmented settings-theme-options"
            role="group"
            aria-label="界面主题"
          >
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                className={theme === value ? "active" : ""}
                aria-pressed={theme === value}
                onClick={() => selectTheme(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <PreferenceBackup />

      <RuntimeSettings
        key={profile.url}
        config={config}
        connected={connected}
        pending={pending ?? (configWriting ? "config-write" : null)}
        disabled={coreDisabled}
        updateCore={updateCore}
      />
    </div>
  );
}
