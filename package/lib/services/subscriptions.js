import { ApiError } from "../api-error.js";
import { parseProfileYaml } from "../profile-compiler.js";

/** Coordinates remote I/O, content validation and atomic repository commits. */
export class SubscriptionService {
  constructor({
    controller,
    profiles,
    operations,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.controller = controller;
    this.profiles = profiles;
    this.operations = operations;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.closed = false;
    this.batchDepth = 0;
  }

  start() {
    this.#schedule();
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  reschedule() {
    if (this.closed || this.batchDepth > 0) return;
    this.#schedule();
  }

  async import(input, signal) {
    const fetched = await this.#fetch(input.url, input.userAgent, signal);
    validateSubscriptionYaml(fetched.content);
    const metadata = await this.#metadata(input, fetched.metadata, signal);
    return this.profiles.importSubscription(
      { ...input, metadata },
      fetched.content,
    );
  }

  async refresh(id, signal) {
    const subscription = this.profiles.subscription(id);
    if (!subscription)
      throw new ApiError(
        404,
        "subscription_not_found",
        "Subscription not found",
      );
    if (!subscription.profileId)
      throw new ApiError(
        409,
        "subscription_profile_unlinked",
        "Subscription is not linked to a profile",
      );
    try {
      const fetched = await this.#fetch(
        subscription.url,
        subscription.userAgent,
        signal,
        {
          etag: subscription.metadata.etag,
          lastModified: subscription.metadata.lastModified,
        },
      );
      const current = subscription.profileId
        ? this.profiles.profile(subscription.profileId)
        : null;
      const contentChanged =
        fetched.notModified !== true && fetched.content !== current?.content;
      if (contentChanged) validateSubscriptionYaml(fetched.content);
      const metadata = await this.#metadata(
        subscription,
        {
          ...subscription.metadata,
          ...fetched.metadata,
        },
        signal,
      );
      const updated = this.profiles.finishRefresh(
        id,
        subscription.revision,
        fetched.content ?? current?.content ?? "",
        metadata,
        { contentChanged },
      );
      this.operations.emit("subscription.refreshed", updated);
      return updated;
    } catch (error) {
      this.profiles.markRefreshError(id, subscription.revision, message(error));
      throw error;
    } finally {
      this.reschedule();
    }
  }

  async refreshMany(ids, signal) {
    const selected = selectSubscriptions(this.profiles.subscriptions(), ids);
    const results = [];
    this.batchDepth++;
    try {
      for (const subscription of selected) {
        if (signal?.aborted)
          throw new ApiError(
            499,
            "request_aborted",
            "Subscription refresh was cancelled",
          );
        try {
          const updated = await this.refresh(subscription.id, signal);
          results.push({
            id: subscription.id,
            ok: true,
            revision: updated.revision,
          });
        } catch (error) {
          results.push({
            id: subscription.id,
            ok: false,
            error: message(error),
          });
        }
      }
    } finally {
      this.batchDepth--;
      this.reschedule();
    }
    return {
      total: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    };
  }

  /**
   * Resolve the profile that may be previewed or applied. Remote-preferred
   * subscriptions are conditionally fetched first. A failed fetch falls back
   * to the last successful profile revision, matching Nikki's resilient start
   * behavior while returning the warning to the caller instead of hiding it.
   * @param {{id: string, revision: number}} profile
   * @param {AbortSignal | typeof SCHEDULER_SIGNAL} signal
   */
  async prepareProfile(profile, signal) {
    const subscription = this.profiles.subscriptionForProfile(profile.id);
    if (!subscription) return { profile, subscriptionRefresh: null };
    if (subscription.prefer === "local")
      return {
        profile,
        subscriptionRefresh: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          prefer: "local",
          attempted: false,
          ok: true,
          changed: false,
          status: "local",
        },
      };
    try {
      const refreshed = await this.refresh(subscription.id, signal);
      const current = this.profiles.profile(profile.id) ?? profile;
      return {
        profile: current,
        subscriptionRefresh: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          prefer: "remote",
          attempted: true,
          ok: true,
          changed: current.revision !== profile.revision,
          status: refreshed.metadata.refreshStatus ?? "updated",
        },
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return {
        profile: this.profiles.profile(profile.id) ?? profile,
        subscriptionRefresh: {
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          prefer: "remote",
          attempted: true,
          ok: false,
          changed: false,
          status: "fallback",
          message: message(error),
        },
      };
    }
  }

  async #fetch(url, userAgent, signal, conditions = {}) {
    try {
      return await this.controller.fetchSubscription(url, signal, {
        userAgent,
        ...conditions,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(502, "subscription_fetch_failed", message(error));
    }
  }

  async #metadata(subscription, metadata, signal) {
    let normalized = normalizeMetadata(metadata);
    if (!subscription.infoUrl) return normalized;
    try {
      const info = await this.#fetch(
        subscription.infoUrl,
        subscription.userAgent,
        signal,
      );
      const fromInfo = normalizeMetadata(info.metadata);
      if (fromInfo.usage)
        normalized = {
          ...normalized,
          subscriptionUserinfo: fromInfo.subscriptionUserinfo,
          usage: fromInfo.usage,
          infoFetchedAt: Date.now(),
        };
      if (fromInfo.usage) delete normalized.infoError;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // The optional info endpoint must not prevent a valid YAML refresh.
      normalized = { ...normalized, infoError: message(error).slice(0, 1024) };
    }
    return normalized;
  }

  #schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    const dueAt = this.profiles
      .subscriptions()
      .filter(
        (item) => item.profileId !== null && item.updateIntervalMinutes > 0,
      )
      .map(
        (item) =>
          (item.lastRefreshAt ?? item.createdAt) +
          item.updateIntervalMinutes * 60_000,
      )
      .sort((left, right) => left - right)[0];
    if (dueAt === undefined) return;
    const delay = Math.max(0, Math.min(dueAt - this.now(), 2_147_000_000));
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#runScheduled();
    }, delay);
  }

  async #runScheduled() {
    if (this.closed) return;
    const now = this.now();
    const ids = this.profiles
      .subscriptions()
      .filter(
        (item) =>
          item.profileId !== null &&
          item.updateIntervalMinutes > 0 &&
          (item.lastRefreshAt ?? item.createdAt) +
            item.updateIntervalMinutes * 60_000 <=
            now,
      )
      .map((item) => item.id);
    if (!ids.length) {
      this.#schedule();
      return;
    }
    try {
      await this.operations.run("subscription.scheduled-refresh", () =>
        this.refreshMany(ids, SCHEDULER_SIGNAL),
      );
    } finally {
      this.#schedule();
    }
  }
}

const SCHEDULER_SIGNAL = Object.freeze({
  aborted: false,
  addEventListener() {},
  removeEventListener() {},
});

export function validateSubscriptionYaml(content) {
  let config;
  try {
    config = parseProfileYaml(content);
  } catch (error) {
    throw new ApiError(
      422,
      "invalid_subscription_content",
      `Subscription is not valid Mihomo YAML: ${message(error)}`,
    );
  }
  const proxies = Array.isArray(config.proxies) && config.proxies.length > 0;
  const providers =
    config["proxy-providers"] &&
    typeof config["proxy-providers"] === "object" &&
    !Array.isArray(config["proxy-providers"]) &&
    Object.keys(config["proxy-providers"]).length > 0;
  if (!proxies && !providers)
    throw new ApiError(
      422,
      "invalid_subscription_content",
      "Subscription must contain at least one proxy or proxy-provider",
    );
  return config;
}

function normalizeMetadata(metadata) {
  const output = { ...(metadata ?? {}) };
  const usage = parseSubscriptionUserinfo(output.subscriptionUserinfo);
  if (usage) output.usage = usage;
  return output;
}

export function parseSubscriptionUserinfo(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const fields = Object.create(null);
  for (const field of value.split(";")) {
    const match = field.trim().match(/^([a-z][a-z0-9_-]*)\s*=\s*(\d+)$/i);
    if (!match) continue;
    const number = Number(match[2]);
    if (Number.isSafeInteger(number)) fields[match[1].toLowerCase()] = number;
  }
  const upload = fields.upload ?? 0;
  const download = fields.download ?? 0;
  const total = fields.total;
  const used = upload + download;
  if (total === undefined && fields.expire === undefined && used === 0)
    return null;
  return {
    upload,
    download,
    used,
    ...(total !== undefined
      ? { total, remaining: Math.max(0, total - used) }
      : {}),
    ...(fields.expire !== undefined ? { expireAt: fields.expire * 1000 } : {}),
  };
}

function selectSubscriptions(all, ids) {
  if (ids === undefined)
    return all.filter((subscription) => subscription.profileId !== null);
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string") ||
    new Set(ids).size !== ids.length
  )
    throw new ApiError(
      400,
      "invalid_subscription_ids",
      "ids must be a unique string array",
    );
  const byId = new Map(all.map((item) => [item.id, item]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length)
    throw new ApiError(
      404,
      "subscription_not_found",
      "One or more subscriptions were not found",
      { ids: missing },
    );
  return ids.map((id) => byId.get(id));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
