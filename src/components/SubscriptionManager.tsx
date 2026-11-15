import { useEffect, useMemo, useRef, useState } from "react";
import { Edit3, Link2, Plus, RefreshCw, Rss, Trash2 } from "lucide-react";
import {
  managerClient,
  type ManagedSubscription,
  type SubscriptionRefreshBatchResult,
  type SubscriptionInput,
  type SubscriptionImportInput,
} from "../lib/manager";
import type { ProfileEntry } from "../lib/profile-library";
import { Badge, Modal, Spinner } from "./ui";
import "./subscription-manager.css";

interface SubscriptionManagerProps {
  profiles: ProfileEntry[];
  onProfilesChanged: () => Promise<unknown>;
}

interface SubscriptionDraft extends SubscriptionInput {
  target: "new" | "existing";
  profileName: string;
  original?: ManagedSubscription;
}

const emptyDraft = (
  profiles: ProfileEntry[],
  subscriptions: ManagedSubscription[],
): SubscriptionDraft => ({
  name: "",
  url: "",
  infoUrl: "",
  userAgent: "clash",
  prefer: "remote",
  updateIntervalMinutes: 0,
  target: "new",
  profileName: "",
  profileId:
    profiles.find(
      (profile) => !subscriptions.some((item) => item.profileId === profile.id),
    )?.id ?? null,
});

const message = (error: unknown) =>
  error instanceof Error ? error.message : "订阅操作失败，请重试。";

const dateText = (value: number | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未刷新";

const byteText = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};

function usageText(metadata: Record<string, unknown>): string | null {
  const usage = metadata.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const used = byteText(record.used);
  const total = byteText(record.total);
  const remaining = byteText(record.remaining);
  if (!used && !total) return null;
  return total
    ? `流量 ${used ?? "未知"} / ${total}${remaining ? `，剩余 ${remaining}` : ""}`
    : `已用流量 ${used}`;
}

function expiryText(metadata: Record<string, unknown>): string | null {
  const usage = metadata.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const expireAt = (usage as Record<string, unknown>).expireAt;
  return typeof expireAt === "number" && Number.isFinite(expireAt)
    ? `到期 ${dateText(expireAt)}`
    : null;
}

function cacheText(metadata: Record<string, unknown>): string | null {
  const fields = [
    typeof metadata.etag === "string" && metadata.etag
      ? `ETag ${metadata.etag}`
      : null,
    typeof metadata.lastModified === "string" && metadata.lastModified
      ? `Last-Modified ${metadata.lastModified}`
      : null,
  ].filter(Boolean);
  return fields.length ? `条件缓存 · ${fields.join(" · ")}` : null;
}

export function SubscriptionManager({
  profiles,
  onProfilesChanged,
}: SubscriptionManagerProps) {
  const [subscriptions, setSubscriptions] = useState<ManagedSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<SubscriptionDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedSubscription | null>(
    null,
  );
  const active = useRef(false);
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );
  const linkedProfiles = useMemo(
    () =>
      new Map(
        subscriptions.flatMap((subscription) =>
          subscription.profileId
            ? [[subscription.profileId, subscription] as const]
            : [],
        ),
      ),
    [subscriptions],
  );
  const refreshable = useMemo(
    () => subscriptions.filter((item) => item.profileId !== null),
    [subscriptions],
  );

  async function reload(signal?: AbortSignal) {
    const next = await managerClient.subscriptions(signal);
    if (active.current) {
      setSubscriptions(next);
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

  async function saveDraft() {
    if (!draft || pending) return;
    if (!draft.name.trim()) {
      setError("请填写订阅名称。");
      return;
    }
    try {
      const target = new URL(draft.url);
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error();
    } catch {
      setError("订阅地址必须使用 HTTP/HTTPS，且不能包含账号密码或片段。");
      return;
    }
    if (draft.infoUrl.trim()) {
      try {
        const target = new URL(draft.infoUrl);
        if (
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password ||
          target.hash
        )
          throw new Error();
      } catch {
        setError("信息地址必须使用 HTTP/HTTPS，且不能包含账号密码或片段。");
        return;
      }
    }
    if (draft.target === "existing" && !draft.profileId) {
      setError("请选择订阅要更新的配置。");
      return;
    }
    if (draft.target === "new" && !draft.profileName.trim()) {
      setError("请填写要创建的配置名称。");
      return;
    }
    setPending("save");
    setError("");
    const input: SubscriptionInput = {
      name: draft.name.trim(),
      url: draft.url.trim(),
      infoUrl: draft.infoUrl.trim(),
      userAgent: draft.userAgent.trim(),
      prefer: draft.prefer,
      updateIntervalMinutes: draft.updateIntervalMinutes,
      profileId: draft.profileId,
    };
    try {
      if (draft.original)
        await managerClient.updateSubscription(
          draft.original.id,
          input,
          draft.original.revision,
        );
      else if (draft.target === "new") {
        const create: SubscriptionImportInput = {
          name: draft.name.trim(),
          url: draft.url.trim(),
          infoUrl: draft.infoUrl.trim(),
          userAgent: draft.userAgent.trim(),
          prefer: draft.prefer,
          updateIntervalMinutes: draft.updateIntervalMinutes,
          profileName: draft.profileName.trim(),
        };
        await managerClient.importSubscription(create);
      } else await managerClient.createSubscription(input);
      await reload();
      if (active.current) setDraft(null);
    } catch (failure) {
      if (active.current) setError(message(failure));
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function refresh(item: ManagedSubscription) {
    if (pending) return;
    setPending(`refresh:${item.id}`);
    setError("");
    try {
      await managerClient.refreshSubscription(item.id);
      await Promise.all([reload(), onProfilesChanged()]);
    } catch (failure) {
      if (active.current) {
        setError(message(failure));
        await reload().catch(() => undefined);
      }
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function refreshAll(ids?: string[]) {
    const requested = (ids ?? refreshable.map((item) => item.id)).filter((id) =>
      subscriptions.some((item) => item.id === id && item.profileId),
    );
    if (pending || requested.length === 0) return;
    setPending("refresh-all");
    setError("");
    try {
      const accepted = await managerClient.refreshSubscriptions(requested);
      const operation =
        await managerClient.waitForOperation<SubscriptionRefreshBatchResult>(
          accepted,
          { timeout: 180_000 },
        );
      await Promise.all([reload(), onProfilesChanged()]);
      if (active.current) {
        if (ids) setSelection(new Set());
        if (operation.result?.failed) {
          const failed = operation.result.results
            .filter((item) => !item.ok)
            .slice(0, 2)
            .map(
              (item) =>
                `${subscriptions.find((entry) => entry.id === item.id)?.name ?? item.id}：${item.error ?? "刷新失败"}`,
            );
          setError(
            `${operation.result.failed} 个订阅刷新失败，${operation.result.succeeded} 个成功。${failed.join("；")}`,
          );
        }
      }
    } catch (failure) {
      if (active.current) {
        setError(message(failure));
        await Promise.allSettled([reload(), onProfilesChanged()]);
      }
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function remove() {
    if (!deleteTarget || pending) return;
    setPending(`delete:${deleteTarget.id}`);
    setError("");
    try {
      await managerClient.deleteSubscription(
        deleteTarget.id,
        deleteTarget.revision,
      );
      await reload();
      if (active.current) setDeleteTarget(null);
    } catch (failure) {
      if (active.current) setError(message(failure));
    } finally {
      if (active.current) setPending(null);
    }
  }

  return (
    <section
      className="panel subscription-manager"
      aria-labelledby="subscriptions-heading"
    >
      <div className="subscription-heading">
        <div>
          <span className="subscription-title-line">
            <Rss size={17} />
            <strong id="subscriptions-heading">配置订阅</strong>
            <Badge tone="purple">{subscriptions.length}</Badge>
          </span>
          <p>
            由路由器获取远程 YAML；刷新成功后为关联配置创建新
            revision，不会自动应用。
          </p>
        </div>
        <div className="subscription-heading-actions">
          <button
            className="button small"
            disabled={
              loading ||
              pending !== null ||
              ![...selection].some((id) =>
                subscriptions.some(
                  (item) => item.id === id && item.profileId !== null,
                ),
              )
            }
            onClick={() => void refreshAll([...selection])}
          >
            {pending === "refresh-all" ? <Spinner /> : <RefreshCw size={14} />}
            刷新选中 ({selection.size})
          </button>
          <button
            className="button small"
            disabled={loading || pending !== null || refreshable.length === 0}
            onClick={() => void refreshAll()}
          >
            {pending === "refresh-all" ? <Spinner /> : <RefreshCw size={14} />}
            刷新全部
          </button>
          <button
            className="button small"
            disabled={loading || pending !== null}
            title="添加配置订阅"
            onClick={() => setDraft(emptyDraft(profiles, subscriptions))}
          >
            <Plus size={14} />
            添加订阅
          </button>
        </div>
      </div>

      {error && (
        <div className="profile-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p className="subscription-loading">
          <Spinner />
          正在读取订阅…
        </p>
      ) : subscriptions.length === 0 ? (
        <p className="subscription-empty">
          尚无订阅。可直接从订阅创建配置，也可关联已有配置。
        </p>
      ) : (
        <div className="subscription-list">
          {subscriptions.map((item) => (
            <article key={item.id} className="subscription-item">
              <input
                className="subscription-checkbox"
                type="checkbox"
                aria-label={`选择订阅 ${item.name}`}
                checked={selection.has(item.id)}
                disabled={pending !== null || !item.profileId}
                onChange={(event) =>
                  setSelection((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
              />
              <div className="subscription-copy">
                <div>
                  <strong>{item.name}</strong>
                  {item.lastError ? (
                    <Badge tone="red">刷新失败</Badge>
                  ) : item.metadata.refreshStatus === "not-modified" ? (
                    <Badge tone="neutral">远端无变化</Badge>
                  ) : item.lastRefreshAt ? (
                    <Badge tone="green">已刷新</Badge>
                  ) : (
                    <Badge tone="neutral">未刷新</Badge>
                  )}
                </div>
                <span>
                  <Link2 size={12} />
                  {item.url}
                </span>
                <small>
                  更新：{profileNames.get(item.profileId ?? "") ?? "未关联配置"}
                  {" · "}
                  上次尝试：{dateText(item.lastRefreshAt)}
                  {item.updateIntervalMinutes > 0
                    ? ` · 每 ${item.updateIntervalMinutes < 60 ? `${item.updateIntervalMinutes} 分钟` : `${item.updateIntervalMinutes / 60} 小时`}自动刷新`
                    : ""}
                  {` · 应用时${item.prefer === "remote" ? "优先远端" : "仅用本地"}`}
                </small>
                {(usageText(item.metadata) || expiryText(item.metadata)) && (
                  <small>
                    {[usageText(item.metadata), expiryText(item.metadata)]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                )}
                {cacheText(item.metadata) && (
                  <small>{cacheText(item.metadata)}</small>
                )}
                {item.lastError && <p>{item.lastError}</p>}
                {typeof item.metadata.infoError === "string" && (
                  <p>订阅信息接口：{item.metadata.infoError}</p>
                )}
              </div>
              <div className="subscription-actions">
                <button
                  className="button small"
                  disabled={pending !== null || !item.profileId}
                  onClick={() => void refresh(item)}
                >
                  {pending === `refresh:${item.id}` ? (
                    <Spinner />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  刷新
                </button>
                <button
                  className="icon-button"
                  aria-label={`编辑订阅 ${item.name}`}
                  disabled={pending !== null}
                  onClick={() =>
                    setDraft({
                      name: item.name,
                      url: item.url,
                      infoUrl: item.infoUrl,
                      userAgent: item.userAgent,
                      prefer: item.prefer,
                      updateIntervalMinutes: item.updateIntervalMinutes,
                      target: "existing",
                      profileName: "",
                      profileId: item.profileId,
                      original: item,
                    })
                  }
                >
                  <Edit3 size={14} />
                </button>
                <button
                  className="icon-button subscription-delete"
                  aria-label={`删除订阅 ${item.name}`}
                  disabled={pending !== null}
                  onClick={() => setDeleteTarget(item)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {draft && (
        <Modal
          title={draft.original ? "编辑订阅" : "添加订阅"}
          description={
            draft.original
              ? "修改订阅来源或关联配置；不会自动刷新或应用。"
              : "可抓取订阅并原子创建配置。创建后仍需预览并手动应用，不会自动接管网络。"
          }
          onClose={() => !pending && setDraft(null)}
        >
          <form
            className="subscription-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <label>
              <span>订阅名称</span>
              <input
                className="field"
                aria-label="订阅名称"
                value={draft.name}
                maxLength={100}
                required
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>订阅 URL</span>
              <input
                className="field"
                type="url"
                aria-label="订阅 URL"
                value={draft.url}
                required
                placeholder="https://example.com/config.yaml"
                onChange={(event) =>
                  setDraft({ ...draft, url: event.target.value })
                }
              />
            </label>
            <label>
              <span>User-Agent</span>
              <input
                className="field"
                aria-label="User-Agent"
                value={draft.userAgent}
                maxLength={256}
                placeholder="clash"
                onChange={(event) =>
                  setDraft({ ...draft, userAgent: event.target.value })
                }
              />
              <small>
                部分订阅服务会按 User-Agent 返回不同格式；留空使用管理器默认值。
              </small>
            </label>
            <label>
              <span>订阅信息 URL（可选）</span>
              <input
                className="field"
                type="url"
                aria-label="订阅信息 URL（可选）"
                value={draft.infoUrl}
                placeholder="https://example.com/subscription-info"
                onChange={(event) =>
                  setDraft({ ...draft, infoUrl: event.target.value })
                }
              />
              <small>
                仅读取 Subscription-Userinfo
                响应头；信息接口失败不会阻断配置刷新。
              </small>
            </label>
            <label>
              <span>设备端自动刷新</span>
              <select
                className="field"
                aria-label="设备端自动刷新"
                value={draft.updateIntervalMinutes}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    updateIntervalMinutes: Number(event.target.value),
                  })
                }
              >
                <option value={0}>关闭</option>
                <option value={60}>每小时</option>
                <option value={360}>每 6 小时</option>
                <option value={720}>每 12 小时</option>
                <option value={1440}>每天</option>
                <option value={10080}>每周</option>
              </select>
              <small>
                由设备上的管理包调度；关闭浏览器后仍会继续，不会自动应用配置。
              </small>
            </label>
            <label>
              <span>应用配置时优先来源</span>
              <select
                className="field"
                aria-label="应用配置时优先来源"
                value={draft.prefer}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    prefer: event.target.value as "remote" | "local",
                  })
                }
              >
                <option value="remote">远端（条件刷新，失败回退本地）</option>
                <option value="local">本地（不发起网络请求）</option>
              </select>
              <small>
                远端模式会在预览和应用前检查更新；若内容改变，必须重新确认新
                revision。
              </small>
            </label>
            {!draft.original && (
              <fieldset className="subscription-target">
                <legend>订阅目标</legend>
                <label>
                  <input
                    type="radio"
                    name="subscription-target"
                    checked={draft.target === "new"}
                    onChange={() => setDraft({ ...draft, target: "new" })}
                  />
                  创建新配置
                </label>
                <label>
                  <input
                    type="radio"
                    name="subscription-target"
                    checked={draft.target === "existing"}
                    disabled={profiles.length === 0}
                    onChange={() => setDraft({ ...draft, target: "existing" })}
                  />
                  关联已有配置
                </label>
              </fieldset>
            )}
            {draft.target === "new" && !draft.original ? (
              <label>
                <span>新配置名称</span>
                <input
                  className="field"
                  aria-label="新配置名称"
                  value={draft.profileName}
                  maxLength={100}
                  required
                  placeholder="例如：主订阅"
                  onChange={(event) =>
                    setDraft({ ...draft, profileName: event.target.value })
                  }
                />
              </label>
            ) : (
              <label>
                <span>关联配置</span>
                <select
                  className="field"
                  aria-label="关联配置"
                  value={draft.profileId ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      profileId: event.target.value || null,
                    })
                  }
                >
                  <option value="">
                    {draft.original ? "暂不关联配置" : "请选择配置"}
                  </option>
                  {profiles.map((profile) => (
                    <option
                      key={profile.id}
                      value={profile.id}
                      disabled={
                        linkedProfiles.has(profile.id) &&
                        linkedProfiles.get(profile.id)?.id !==
                          draft.original?.id
                      }
                    >
                      {profile.name}
                      {linkedProfiles.has(profile.id) &&
                      linkedProfiles.get(profile.id)?.id !== draft.original?.id
                        ? "（已关联其他订阅）"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <div className="profile-error" role="alert">
                {error}
              </div>
            )}
            <div className="profile-modal-actions">
              <button
                type="button"
                className="button"
                disabled={pending !== null}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={pending !== null}
              >
                {pending === "save" ? <Spinner /> : null}
                {pending === "save"
                  ? "处理中…"
                  : draft.target === "new" && !draft.original
                    ? "抓取并创建"
                    : "保存订阅"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="删除订阅"
          description={`删除“${deleteTarget.name}”？关联配置及其历史 revision 会保留。`}
          onClose={() => !pending && setDeleteTarget(null)}
        >
          {error && (
            <div className="profile-error" role="alert">
              {error}
            </div>
          )}
          <div className="profile-modal-actions">
            <button
              className="button"
              disabled={pending !== null}
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={pending !== null}
              onClick={() => void remove()}
            >
              {pending === `delete:${deleteTarget.id}` ? <Spinner /> : null}
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
