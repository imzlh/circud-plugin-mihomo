import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  FileCode2,
  RefreshCw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { AdvancedConfigEditor } from "../components/AdvancedConfigEditor";
import { ManagerSettings } from "../components/ManagerSettings";
import { Badge, PageHeader, Spinner } from "../components/ui";
import { managerClient } from "../lib/manager";
import {
  defaultGlobalProfileEnhancement,
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
  const mounted = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const current = await managerClient.globalEnhancement(signal);
      if (signal?.aborted || !mounted.current) return;
      setRevision(current.revision);
      setSaved(current.enhancement);
      setDraft(structuredClone(current.enhancement));
    } catch (failure) {
      if (signal?.aborted || !mounted.current) return;
      setRevision(null);
      setSaved(null);
      setDraft(defaultGlobalProfileEnhancement());
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
      merge: { enabled: true, content },
    }));
  }

  async function save() {
    if (revision === null || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
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
      if (mounted.current) setError(message(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const changed =
    saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  return (
    <div className="settings-page mihomo-settings-page">
      <PageHeader
        title="Mihomo 设置"
        description="集中管理内核高级参数、DNS、嗅探，以及路由器透明代理。"
      >
        <Badge tone={revision === null ? "neutral" : "green"}>
          {loading
            ? "正在连接 Manager"
            : revision === null
              ? "只读预览"
              : `全局 revision ${revision}`}
        </Badge>
      </PageHeader>

      <section
        className="panel settings-section mihomo-global-settings"
        aria-labelledby="mihomo-global-heading"
        aria-busy={loading || saving}
      >
        <div className="settings-section-heading mihomo-settings-heading">
          <SlidersHorizontal size={19} />
          <div>
            <h2 id="mihomo-global-heading">全局内核配置</h2>
            <p>
              这些字段会合并到所有配置中；保存不会立即改动正在运行的内核，下次预览或应用配置时生效。
            </p>
          </div>
          <button
            className="button small"
            type="button"
            disabled={loading || saving}
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
          <p className="mihomo-settings-message error" role="alert">
            {error}
          </p>
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

        {mode === "structured" ? (
          <AdvancedConfigEditor
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
      </section>

      <ManagerSettings />
    </div>
  );
}
