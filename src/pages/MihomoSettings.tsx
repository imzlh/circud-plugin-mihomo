import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload } from "react-router-dom";
import {
  Check,
  Database,
  Gauge,
  Globe2,
  ListTree,
  LogIn,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ScanSearch,
  SlidersHorizontal,
} from "lucide-react";
import {
  AdvancedConfigEditor,
  type AdvancedConfigSection,
} from "../components/AdvancedConfigEditor";
import { ManagerSettings } from "../components/ManagerSettings";
import { Badge, PageHeader, Spinner, Toggle } from "../components/ui";
import { managerClient, ManagerApiError } from "../lib/manager";
import {
  defaultGlobalProfileEnhancement,
  parseProfileYaml,
  type GlobalProfileEnhancement,
} from "../lib/profile-enhancement";
import "./settings.css";
import "./mihomo-settings.css";

type SettingsArea = AdvancedConfigSection | "network";

const settingsAreas: Array<{
  id: SettingsArea;
  label: string;
  icon: typeof SlidersHorizontal;
}> = [
  { id: "base", label: "基础", icon: SlidersHorizontal },
  { id: "inbound", label: "入站与认证", icon: LogIn },
  { id: "performance", label: "性能与兼容", icon: Gauge },
  { id: "dns", label: "DNS", icon: Globe2 },
  { id: "sniffer", label: "Sniffer", icon: ScanSearch },
  { id: "geo", label: "缓存与 GeoX", icon: Database },
  { id: "providers", label: "Rule Provider", icon: ListTree },
  { id: "network", label: "路由器接管", icon: Network },
];

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "内核设置读取失败，请稍后重试。";
}

export default function MihomoSettings() {
  const [activeArea, setActiveArea] = useState<SettingsArea>("base");
  const [networkDirty, setNetworkDirty] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [saved, setSaved] = useState<GlobalProfileEnhancement | null>(null);
  const [draft, setDraft] = useState<GlobalProfileEnhancement>(() =>
    defaultGlobalProfileEnhancement(),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const mounted = useRef(false);
  const loaded = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    setNotice("");
    setConflict(false);
    try {
      const current = await managerClient.globalEnhancement(signal);
      if (signal?.aborted || !mounted.current) return;
      setRevision(current.revision);
      setSaved(current.enhancement);
      setDraft(structuredClone(current.enhancement));
      setEditorSession((currentSession) => currentSession + 1);
      loaded.current = true;
    } catch (failure) {
      if (signal?.aborted || !mounted.current) return;
      if (!loaded.current) {
        setRevision(null);
        setSaved(null);
        setDraft(defaultGlobalProfileEnhancement());
      }
      setError(message(failure));
    } finally {
      if (!signal?.aborted && mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    const sections = settingsAreas
      .map(({ id }) => document.getElementById(`kernel-section-${id}`))
      .filter((section): section is HTMLElement => section !== null);
    if (!sections.length) return;
    let frame = 0;
    const updateActive = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const marker = 120;
        let current = settingsAreas[0]!.id;
        for (const section of sections) {
          if (section.getBoundingClientRect().top > marker) break;
          current = section.id.replace("kernel-section-", "") as SettingsArea;
        }
        setActiveArea(current);
      });
    };
    window.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateActive);
    };
  }, []);

  function scrollToArea(area: SettingsArea) {
    setActiveArea(area);
    document
      .getElementById(`kernel-section-${area}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateMerge(content: string) {
    setNotice("");
    setDraft((current) => ({
      ...current,
      merge: { ...current.merge, content },
    }));
  }

  async function save() {
    if (revision === null || saving) return;
    if (draft.merge.enabled) {
      try {
        parseProfileYaml(draft.merge.content);
      } catch (failure) {
        setError(`全局 Merge YAML 无效：${message(failure)}`);
        return;
      }
    }
    setSaving(true);
    setError("");
    setNotice("");
    setConflict(false);
    try {
      const updated = await managerClient.updateGlobalEnhancement(
        draft,
        revision,
      );
      if (!mounted.current) return;
      setRevision(updated.revision);
      setSaved(updated.enhancement);
      setDraft(structuredClone(updated.enhancement));
      setNotice(`内核设置已保存 · revision ${updated.revision}`);
    } catch (failure) {
      if (mounted.current) {
        setError(message(failure));
        setConflict(
          failure instanceof ManagerApiError &&
            (failure.status === 409 || failure.status === 412),
        );
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const changed =
    saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const dirty = changed || networkDirty;

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [dirty],
    ),
  );

  function resetDraft() {
    if (!saved) return;
    setDraft(structuredClone(saved));
    setError("");
    setNotice("");
    setConflict(false);
    setEditorSession((currentSession) => currentSession + 1);
  }

  return (
    <div className="settings-page mihomo-settings-page">
      <PageHeader
        title="内核设置"
        description="集中管理内核高级参数、DNS、嗅探，以及路由器透明代理。"
      >
        <Badge
          tone={dirty ? "orange" : revision === null ? "neutral" : "green"}
        >
          {dirty
            ? "有未保存修改"
            : loading
              ? "正在连接 Manager"
              : revision === null
                ? "只读预览"
                : `全局 revision ${revision}`}
        </Badge>
      </PageHeader>

      <div className="mihomo-settings-workspace">
        <nav className="mihomo-settings-areas" aria-label="内核设置分类">
          <span className="mihomo-settings-areas-title">设置分类</span>
          <div>
            {settingsAreas.map(({ id, label, icon: Icon }) => {
              const areaDirty = id === "network" ? networkDirty : changed;
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={activeArea === id ? "location" : undefined}
                  aria-label={`${label}${areaDirty ? "，未保存" : ""}`}
                  onClick={() => scrollToArea(id)}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="mihomo-settings-panels">
          <section
            className="panel settings-section mihomo-global-settings"
            aria-label="全局内核配置"
            aria-busy={loading || saving}
          >
            <div className="mihomo-settings-overview">
              <div>
                <strong>全局内核配置</strong>
                <p>这些字段会合并到所有配置中，下次预览或应用配置时生效。</p>
              </div>
              <button
                className="button small"
                type="button"
                disabled={loading || saving || changed}
                title={changed ? "请先保存或放弃当前修改" : undefined}
                onClick={() => void load()}
              >
                {loading ? <Spinner /> : <RefreshCw size={14} />}
                重新读取
              </button>
            </div>

            {revision === null && !loading && (
              <p className="mihomo-settings-preview" role="status">
                未连接管理服务，当前仅预览完整表单；连接 circud 后才能保存。
              </p>
            )}
            {error && (
              <div className="mihomo-settings-message error" role="alert">
                <span>{error}</span>
                {conflict && (
                  <button className="button small" onClick={() => void load()}>
                    丢弃草稿并读取最新
                  </button>
                )}
              </div>
            )}
            {notice && (
              <p className="mihomo-settings-message success" role="status">
                <Check size={14} />
                {notice}
              </p>
            )}

            <div className="mihomo-global-toggle">
              <div>
                <strong>启用全局内核配置</strong>
                <p>
                  关闭后保留当前内容，但预览和应用 profile 时不会执行全局覆盖。
                </p>
              </div>
              <Toggle
                label="启用全局内核配置"
                checked={draft.merge.enabled}
                disabled={revision === null || loading || saving}
                onChange={(enabled) => {
                  setNotice("");
                  setDraft((current) => ({
                    ...current,
                    merge: { ...current.merge, enabled },
                  }));
                }}
              />
            </div>

            <AdvancedConfigEditor
              key={editorSession}
              content={draft.merge.content}
              onChange={updateMerge}
              flat
            />

            <div className="mihomo-settings-footer">
              <p>未启用的字段不会覆盖订阅或本地配置中的原值。</p>
              <div>
                <button
                  className="button"
                  type="button"
                  disabled={loading || saving || !changed}
                  onClick={resetDraft}
                >
                  <RotateCcw size={15} />
                  放弃修改
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={revision === null || loading || saving || !changed}
                  onClick={() => void save()}
                >
                  {saving ? <Spinner /> : <Save size={15} />}
                  {saving ? "保存中…" : "保存内核设置"}
                </button>
              </div>
            </div>
          </section>

          <section
            id="kernel-section-network"
            className="mihomo-settings-network-section"
            aria-label="路由器接管"
          >
            <ManagerSettings onDirtyChange={setNetworkDirty} />
          </section>
        </div>
      </div>
    </div>
  );
}
