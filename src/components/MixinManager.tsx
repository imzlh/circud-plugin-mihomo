import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Layers3,
  Link2,
  Plus,
  Settings2,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  managerClient,
  type ManagedMixin,
  type MixinInput,
  type MixinKind,
  type MixinTarget,
  type ProfileMixinReference,
} from "../lib/manager";
import {
  profileInput,
  validateProfileYaml,
  type ProfileEntry,
} from "../lib/profile-library";
import { Badge, Modal, Spinner } from "./ui";
import { AdvancedConfigEditor } from "./AdvancedConfigEditor";
import "./mixin-manager.css";

interface MixinManagerProps {
  selected?: ProfileEntry;
  onProfilesChanged: () => Promise<ProfileEntry[]>;
}

interface MixinDraft extends MixinInput {
  original?: ManagedMixin;
}

const sequenceTemplate = "prepend: []\nappend: []\ndelete: []\n";
const scriptTemplate =
  "function main(config, profileName) {\n  return config;\n}\n";

const emptyDraft = (): MixinDraft => ({
  name: "",
  description: "",
  kind: "merge",
  content: "{}\n",
});

const advancedDraft = (): MixinDraft => ({
  name: "高级配置",
  description: "常用 Mihomo 入站、DNS、嗅探、缓存与 GeoX 参数",
  kind: "merge",
  content: "{}\n",
});

const kindLabel: Record<MixinKind, string> = {
  merge: "Merge",
  seq: "Seq",
  script: "Script",
};

const targetLabel: Record<MixinTarget, string> = {
  rules: "规则",
  proxies: "代理",
  groups: "代理组",
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : "混入操作失败，请重试。";

function contentTemplate(kind: MixinKind): string {
  return kind === "merge"
    ? "{}\n"
    : kind === "seq"
      ? sequenceTemplate
      : scriptTemplate;
}

export function MixinManager({
  selected,
  onProfilesChanged,
}: MixinManagerProps) {
  const [mixins, setMixins] = useState<ManagedMixin[]>([]);
  const [draft, setDraft] = useState<MixinDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedMixin | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editorMode, setEditorMode] = useState<"structured" | "source">(
    "structured",
  );
  const active = useRef(false);
  const references = selected?.mixins ?? [];
  const byId = useMemo(
    () => new Map(mixins.map((mixin) => [mixin.id, mixin])),
    [mixins],
  );

  async function reload(signal?: AbortSignal) {
    const next = await managerClient.mixins(signal);
    if (active.current) {
      setMixins(next);
      setError("");
    }
    return next;
  }

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void reload(controller.signal)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(message(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, []);

  function changeKind(kind: MixinKind) {
    if (!draft) return;
    const replaceTemplate = draft.content === contentTemplate(draft.kind);
    setDraft({
      ...draft,
      kind,
      content: replaceTemplate ? contentTemplate(kind) : draft.content,
      ...(kind === "seq" ? { target: draft.target ?? "rules" } : {}),
    });
  }

  async function saveDraft() {
    if (!draft || pending) return;
    if (!draft.name.trim()) {
      setError("请填写混入名称。");
      return;
    }
    if (draft.kind !== "script") {
      const yamlError = validateProfileYaml(draft.content);
      if (yamlError) {
        setError(`混入 YAML 校验失败：${yamlError}`);
        return;
      }
    } else if (!draft.content.trim()) {
      setError("Script 内容不能为空。");
      return;
    }
    setPending("save");
    setError("");
    const input: MixinInput = {
      name: draft.name.trim(),
      description: draft.description,
      kind: draft.kind,
      ...(draft.kind === "seq" ? { target: draft.target ?? "rules" } : {}),
      content: draft.content,
    };
    try {
      if (draft.original)
        await managerClient.updateMixin(
          draft.original.id,
          input,
          draft.original.revision,
        );
      else await managerClient.createMixin(input);
      await Promise.all([reload(), onProfilesChanged()]);
      if (active.current) setDraft(null);
    } catch (failure) {
      if (active.current) setError(message(failure));
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function updateReferences(next: ProfileMixinReference[]) {
    if (!selected || pending) return;
    setPending(`profile:${selected.id}`);
    setError("");
    try {
      await managerClient.updateProfile(
        selected.id,
        profileInput({ ...selected, mixins: next }),
        selected.revision ?? 0,
      );
      await onProfilesChanged();
    } catch (failure) {
      if (active.current) setError(message(failure));
    } finally {
      if (active.current) setPending(null);
    }
  }

  function attach(id: string) {
    if (references.some((reference) => reference.id === id)) return;
    void updateReferences([...references, { id, enabled: true }]);
  }

  function patchReference(
    id: string,
    update: (reference: ProfileMixinReference) => ProfileMixinReference | null,
  ) {
    const next = references.flatMap((reference) => {
      if (reference.id !== id) return [reference];
      const changed = update(reference);
      return changed ? [changed] : [];
    });
    void updateReferences(next);
  }

  function moveReference(id: string, direction: -1 | 1) {
    const index = references.findIndex((reference) => reference.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= references.length) return;
    const next = [...references];
    [next[index], next[target]] = [next[target]!, next[index]!];
    void updateReferences(next);
  }

  async function removeMixin() {
    if (!deleteTarget || pending) return;
    setPending(`delete:${deleteTarget.id}`);
    setError("");
    try {
      await managerClient.deleteMixin(deleteTarget.id, deleteTarget.revision);
      await Promise.all([reload(), onProfilesChanged()]);
      if (active.current) setDeleteTarget(null);
    } catch (failure) {
      if (active.current) setError(message(failure));
    } finally {
      if (active.current) setPending(null);
    }
  }

  return (
    <section className="panel mixin-manager" aria-labelledby="mixins-heading">
      <div className="mixin-heading">
        <div>
          <span className="mixin-title-line">
            <Layers3 size={17} />
            <strong id="mixins-heading">可复用配置混入</strong>
            <Badge tone="purple">{mixins.length}</Badge>
          </span>
          <p>资源内容集中维护；每份配置独立决定引用、启用状态与执行顺序。</p>
        </div>
        <button
          className="button small"
          disabled={loading || pending !== null}
          onClick={() => setDraft(emptyDraft())}
        >
          <Plus size={14} />
          新建混入
        </button>
        <button
          className="button small"
          disabled={loading || pending !== null}
          onClick={() => {
            setEditorMode("structured");
            setDraft(advancedDraft());
          }}
        >
          <Settings2 size={14} />
          新建高级配置
        </button>
      </div>

      {error && (
        <div className="profile-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p className="mixin-empty">
          <Spinner />
          正在读取混入…
        </p>
      ) : mixins.length === 0 ? (
        <p className="mixin-empty">
          尚无可复用混入。可创建通用 DNS、规则、代理组或高级参数模板。
        </p>
      ) : (
        <div className="mixin-library">
          {mixins.map((mixin) => {
            const reference = references.find((item) => item.id === mixin.id);
            return (
              <article key={mixin.id} className="mixin-resource">
                <div className="mixin-copy">
                  <div>
                    <strong>{mixin.name}</strong>
                    <Badge tone={reference?.enabled ? "green" : "neutral"}>
                      {kindLabel[mixin.kind]}
                      {mixin.target ? ` · ${targetLabel[mixin.target]}` : ""}
                    </Badge>
                  </div>
                  <small>{mixin.description || "无描述"}</small>
                </div>
                <div className="mixin-resource-actions">
                  {reference ? (
                    <button
                      className="button small"
                      disabled={pending !== null || !selected}
                      aria-pressed={reference.enabled}
                      onClick={() =>
                        patchReference(mixin.id, (current) => ({
                          ...current,
                          enabled: !current.enabled,
                        }))
                      }
                    >
                      {reference.enabled ? "已启用" : "已停用"}
                    </button>
                  ) : (
                    <button
                      className="button small"
                      disabled={pending !== null || !selected}
                      title={
                        selected ? `关联到 ${selected.name}` : "请先选择配置"
                      }
                      onClick={() => attach(mixin.id)}
                    >
                      <Link2 size={13} />
                      关联
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`编辑混入 ${mixin.name}`}
                    disabled={pending !== null}
                    onClick={() =>
                      setDraft({
                        ...mixin,
                        target: mixin.target ?? undefined,
                        original: mixin,
                      })
                    }
                  >
                    <Edit3 size={14} />
                  </button>
                  <button
                    className="icon-button mixin-delete"
                    aria-label={`删除混入 ${mixin.name}`}
                    disabled={pending !== null}
                    onClick={() => setDeleteTarget(mixin)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="mixin-chain">
        <div>
          <strong>
            {selected ? `${selected.name} 的混入链` : "选择配置后编辑混入链"}
          </strong>
          <small>按下列顺序执行，位于全局增强之后、配置专属增强之前。</small>
        </div>
        {selected && references.length === 0 && (
          <p className="mixin-empty">此配置尚未关联混入。</p>
        )}
        {selected && references.length > 0 && (
          <ol>
            {references.map((reference, index) => {
              const mixin = byId.get(reference.id);
              if (!mixin) return null;
              return (
                <li
                  key={reference.id}
                  className={reference.enabled ? "" : "disabled"}
                >
                  <span>{index + 1}</span>
                  <div>
                    <strong>{mixin.name}</strong>
                    <small>{kindLabel[mixin.kind]}</small>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`上移混入 ${mixin.name}`}
                    disabled={pending !== null || index === 0}
                    onClick={() => moveReference(reference.id, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`下移混入 ${mixin.name}`}
                    disabled={
                      pending !== null || index === references.length - 1
                    }
                    onClick={() => moveReference(reference.id, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`解除混入 ${mixin.name}`}
                    disabled={pending !== null}
                    onClick={() => patchReference(reference.id, () => null)}
                  >
                    <Unlink size={13} />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {draft && (
        <Modal
          title={draft.original ? "编辑混入" : "新建混入"}
          description="混入是独立编译阶段；保存资源不会直接应用到内核。"
          wide
          onClose={() => !pending && setDraft(null)}
        >
          <form
            className="mixin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <div className="mixin-form-grid">
              <label>
                <span>名称</span>
                <input
                  className="field"
                  value={draft.name}
                  maxLength={200}
                  required
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>类型</span>
                <select
                  className="field"
                  value={draft.kind}
                  onChange={(event) =>
                    changeKind(event.target.value as MixinKind)
                  }
                >
                  <option value="merge">Merge 对象合并</option>
                  <option value="seq">Seq 列表增删</option>
                  <option value="script">Script 脚本</option>
                </select>
              </label>
              {draft.kind === "seq" && (
                <label>
                  <span>目标</span>
                  <select
                    className="field"
                    value={draft.target ?? "rules"}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        target: event.target.value as MixinTarget,
                      })
                    }
                  >
                    <option value="rules">规则</option>
                    <option value="proxies">代理</option>
                    <option value="groups">代理组</option>
                  </select>
                </label>
              )}
              <label className="mixin-description">
                <span>描述</span>
                <input
                  className="field"
                  value={draft.description}
                  maxLength={4096}
                  onChange={(event) =>
                    setDraft({ ...draft, description: event.target.value })
                  }
                />
              </label>
            </div>
            {draft.kind === "merge" && (
              <div
                className="segmented mixin-editor-modes"
                role="group"
                aria-label="混入编辑模式"
              >
                <button
                  type="button"
                  aria-pressed={editorMode === "structured"}
                  onClick={() => setEditorMode("structured")}
                >
                  常用配置
                </button>
                <button
                  type="button"
                  aria-pressed={editorMode === "source"}
                  onClick={() => setEditorMode("source")}
                >
                  YAML 原文
                </button>
              </div>
            )}
            {draft.kind === "merge" && editorMode === "structured" ? (
              <AdvancedConfigEditor
                content={draft.content}
                onChange={(content) => setDraft({ ...draft, content })}
              />
            ) : (
              <label className="mixin-content-label">
                <span>
                  {draft.kind === "script" ? "JavaScript" : "YAML"} 内容
                </span>
                <textarea
                  className="field mixin-code"
                  value={draft.content}
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({ ...draft, content: event.target.value })
                  }
                />
              </label>
            )}
            <div className="profile-modal-actions">
              <span />
              <button
                className="button"
                type="button"
                disabled={pending !== null}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={pending !== null}>
                {pending === "save" && <Spinner />}保存混入
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="删除混入"
          description={`将删除“${deleteTarget.name}”，并从所有配置中原子清理引用。配置原文不会改变。`}
          onClose={() => !pending && setDeleteTarget(null)}
        >
          <div className="profile-modal-actions">
            <span />
            <button className="button" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={pending !== null}
              onClick={() => void removeMixin()}
            >
              {pending === `delete:${deleteTarget.id}` && <Spinner />}确认删除
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
