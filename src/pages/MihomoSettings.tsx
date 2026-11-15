import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload } from "react-router-dom";
import {
  Check,
  FileCode2,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { AdvancedConfigEditor } from "../components/AdvancedConfigEditor";
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

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Mihomo 设置读取失败，请稍后重试。";
}

export default function MihomoSettings() {
  const [area, setArea] = useState<"core" | "network">("core");
  const [networkVisited, setNetworkVisited] = useState(false);
  const [networkDirty, setNetworkDirty] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [saved, setSaved] = useState<GlobalProfileEnhancement | null>(null);
  const [draft, setDraft] = useState<GlobalProfileEnhancement>(() =>
    defaultGlobalProfileEnhancement(),
  );
  const [mode, setMode] = useState<"structured" | "source">("structured");
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
        setMode("source");
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
      setNotice(`Mihomo 设置已保存 · revision ${updated.revision}`);
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
        title="Mihomo 设置"
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

      <div
        className="mihomo-settings-areas"
        role="tablist"
        aria-label="Mihomo 设置分区"
      >
        <button
          id="mihomo-core-tab"
          type="button"
          role="tab"
          aria-selected={area === "core"}
          aria-controls="mihomo-core-panel"
          onClick={() => setArea("core")}
        >
          <SlidersHorizontal size={16} />
          <span>
            <strong>内核参数</strong>
            <small>DNS、Sniffer、GeoX 与入站</small>
          </span>
          {changed && <em>未保存</em>}
        </button>
        <button
          id="mihomo-network-tab"
          type="button"
          role="tab"
          aria-selected={area === "network"}
          aria-controls="mihomo-network-panel"
          onClick={() => {
            setNetworkVisited(true);
            setArea("network");
          }}
        >
          <Network size={16} />
          <span>
            <strong>路由器接管</strong>
            <small>TUN、透明代理、ACL 与定时重启</small>
          </span>
          {networkDirty && <em>未保存</em>}
        </button>
      </div>

      <div
        id="mihomo-core-panel"
        role="tabpanel"
        aria-labelledby="mihomo-core-tab"
        hidden={area !== "core"}
      >
        <section
          className="panel settings-section mihomo-global-settings"
          aria-labelledby="mihomo-global-heading"
          aria-busy={loading || saving}
        >
          <div className="settings-section-heading">
            <SlidersHorizontal size={19} />
            <h2 id="mihomo-global-heading">全局内核配置</h2>
          </div>
          <div className="mihomo-settings-intro">
            <p>
              这些字段会合并到所有配置中；保存不会立即改动正在运行的内核，下次预览或应用配置时生效。
            </p>
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

          <div
            className="segmented mihomo-editor-modes"
            role="group"
            aria-label="Mihomo 配置编辑模式"
          >
            <button
              type="button"
              aria-pressed={mode === "structured"}
              onClick={() => setMode("structured")}
            >
              常用设置
            </button>
            <button
              type="button"
              aria-pressed={mode === "source"}
              onClick={() => setMode("source")}
            >
              <FileCode2 size={14} />
              YAML 原文
            </button>
          </div>

          <div className="mihomo-global-toggle">
            <div>
              <strong>启用全局内核配置</strong>
              <p>
                关闭后保留当前内容，但预览和应用 profile 时不会执行这份 Merge。
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

          {mode === "structured" ? (
            <AdvancedConfigEditor
              key={editorSession}
              content={draft.merge.content}
              onChange={updateMerge}
            />
          ) : (
            <label className="mihomo-source-editor">
              <span>全局 Merge YAML</span>
              <textarea
                className="field"
                spellCheck={false}
                value={draft.merge.content}
                onChange={(event) => updateMerge(event.target.value)}
              />
            </label>
          )}

          <div className="mihomo-settings-footer">
            <p>未勾选的字段不会覆盖订阅或本地配置中的原值。</p>
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
                {saving ? "保存中…" : "保存 Mihomo 设置"}
              </button>
            </div>
          </div>
        </section>
      </div>

      <div
        id="mihomo-network-panel"
        role="tabpanel"
        aria-labelledby="mihomo-network-tab"
        hidden={area !== "network"}
      >
        {networkVisited && <ManagerSettings onDirtyChange={setNetworkDirty} />}
      </div>
    </div>
  );
}
