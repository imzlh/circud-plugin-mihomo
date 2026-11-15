const MAX_YAML = 5 * 1024 * 1024;
const MAX_MIXIN = 1024 * 1024;
const MAX_PROFILE_MIXINS = 48;
const STORE_SCHEMA = 3;

/**
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   content: string,
 *   sourceUrl?: string | null,
 *   enhancement?: Record<string, unknown>,
 *   mixins?: Array<{id: string, enabled: boolean}>,
 * }} ProfileInput
 * @typedef {"merge" | "seq" | "script"} MixinKind
 * @typedef {"rules" | "proxies" | "groups"} MixinTarget
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   kind: MixinKind,
 *   target: MixinTarget | null,
 *   content: string,
 *   revision: number,
 *   createdAt: number,
 *   updatedAt: number,
 * }} Mixin
 * @typedef {{
 *   id: string,
 *   name: string,
 *   url: string,
 *   infoUrl: string,
 *   userAgent: string,
 *   prefer: "remote" | "local",
 *   updateIntervalMinutes: number,
 *   profileId: string | null,
 *   metadata: Record<string, unknown>,
 *   revision: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   lastRefreshAt: number | null,
 *   lastError: string | null,
 * }} Subscription
 * @typedef {{
 *   subscription: Subscription,
 *   profile: ReturnType<Repository["profile"]>,
 * }} ImportedSubscription
 */

export class Repository {
  /**
   * @param {{
   *   fs: {exists(path: string): boolean, readFile(path: string): Uint8Array, writeFile(path: string, value: Uint8Array): void, rename(from: string, to: string): void, unlink(path: string): void},
   *   path: string,
   *   encoder: {encode(value: string): Uint8Array},
   *   decoder: {decode(value: Uint8Array): string},
   *   now?: () => number,
   * }} options
   */
  constructor({ fs, path, encoder, decoder, now = () => Date.now() }) {
    this.fs = fs;
    this.path = path;
    this.encoder = encoder;
    this.decoder = decoder;
    this.now = now;
    this.sequence = 1;
    this.state = this.#load();
  }

  profiles() {
    return [...this.state.profiles]
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
      .map(profileSummary);
  }

  profile(id, revision = null) {
    const profile = this.state.profiles.find((item) => item.id === id);
    if (!profile) return null;
    const selected = revision ?? profile.activeRevision;
    const storedRevision = profile.revisions.find(
      (item) => item.revision === selected,
    );
    return storedRevision ? profileDetail(profile, storedRevision) : null;
  }

  revisions(id) {
    const profile = this.state.profiles.find((item) => item.id === id);
    if (!profile) return [];
    return [...profile.revisions]
      .sort((a, b) => b.revision - a.revision)
      .map((revision) => ({
        revision: revision.revision,
        createdAt: revision.createdAt,
        contentBytes: utf8Bytes(revision.content),
      }));
  }

  /** @param {ProfileInput & {id?: string}} input */
  createProfile(input) {
    validateProfile(input, false);
    const id = input.id ?? this.#id("profile");
    if (this.state.profiles.some((profile) => profile.id === id))
      throw new Error("profile id already exists");
    const time = this.now();
    this.#mutate((state) => {
      const position =
        state.profiles.reduce(
          (maximum, profile) => Math.max(maximum, profile.position),
          -1,
        ) + 1;
      state.profiles.push({
        id,
        name: input.name.trim(),
        description: input.description ?? "",
        sourceUrl: input.sourceUrl ?? null,
        enhancement: clone(input.enhancement ?? {}),
        mixins: clone(input.mixins ?? []),
        position,
        activeRevision: 1,
        createdAt: time,
        updatedAt: time,
        revisions: [{ revision: 1, content: input.content, createdAt: time }],
      });
    });
    return this.profile(id);
  }

  updateProfile(id, input) {
    validateProfile(input, true);
    const current = this.profile(id);
    if (!current) return null;
    checkRevision(
      input.expectedRevision,
      current.revision,
      "profile_revision_conflict",
    );
    this.#mutate((state) => {
      const profile = state.profiles.find((item) => item.id === id);
      if (!profile || profile.activeRevision !== current.revision)
        throw new ConflictError(
          "profile_revision_conflict",
          profile?.activeRevision ?? current.revision,
        );
      const revision =
        profile.revisions.reduce(
          (maximum, item) => Math.max(maximum, item.revision),
          0,
        ) + 1;
      const time = this.now();
      profile.name = input.name ?? profile.name;
      profile.description = input.description ?? profile.description;
      profile.sourceUrl =
        input.sourceUrl === undefined ? profile.sourceUrl : input.sourceUrl;
      profile.enhancement = clone(input.enhancement ?? profile.enhancement);
      profile.mixins = clone(input.mixins ?? profile.mixins);
      profile.activeRevision = revision;
      profile.updatedAt = time;
      profile.revisions.push({
        revision,
        content: input.content ?? current.content,
        createdAt: time,
      });
    });
    return this.profile(id);
  }

  deleteProfile(id, expected) {
    const current = this.profile(id);
    if (!current) return false;
    checkRevision(expected, current.revision, "profile_revision_conflict");
    this.#mutate((state) => {
      const index = state.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) return;
      state.profiles.splice(index, 1);
      for (const subscription of state.subscriptions) {
        if (subscription.profileId === id) subscription.profileId = null;
      }
    });
    return true;
  }

  activate(id, revision) {
    if (!this.profile(id, revision)) return null;
    this.#mutate((state) => {
      const profile = state.profiles.find((item) => item.id === id);
      profile.activeRevision = revision;
      profile.updatedAt = this.now();
    });
    return this.profile(id);
  }

  reorder(ids) {
    const existing = this.profiles().map((profile) => profile.id);
    if (
      !Array.isArray(ids) ||
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.includes(id))
    )
      throw new Error("ids must contain every profile exactly once");
    this.#mutate((state) => {
      const time = this.now();
      ids.forEach((id, position) => {
        const profile = state.profiles.find((item) => item.id === id);
        profile.position = position;
        profile.updatedAt = time;
      });
    });
    return this.profiles();
  }

  /** @returns {Mixin[]} */
  mixins() {
    return [...this.state.mixins]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(mixinView);
  }

  /** @param {string} id @returns {Mixin | null} */
  mixin(id) {
    const mixin = this.state.mixins.find((item) => item.id === id);
    return mixin ? mixinView(mixin) : null;
  }

  /**
   * Resolve enabled reusable stages in the exact order stored by a profile.
   * Missing resources indicate corrupt state and must never be skipped silently.
   * @param {{mixins?: Array<{id: string, enabled: boolean}>}} profile
   * @returns {Mixin[]}
   */
  profileMixins(profile) {
    return (profile.mixins ?? [])
      .filter((reference) => reference.enabled)
      .map((reference) => {
        const mixin = this.mixin(reference.id);
        if (!mixin)
          throw new Error(`profile references missing mixin: ${reference.id}`);
        return mixin;
      });
  }

  createMixin(input) {
    validateMixin(input, false);
    const id = input.id ?? this.#id("mixin");
    if (this.state.mixins.some((item) => item.id === id))
      throw new Error("mixin id already exists");
    const time = this.now();
    this.#mutate((state) => {
      state.mixins.push({
        id,
        name: input.name.trim(),
        description: input.description ?? "",
        kind: input.kind,
        target: input.kind === "seq" ? input.target : null,
        content: input.content,
        revision: 1,
        createdAt: time,
        updatedAt: time,
      });
    });
    return this.mixin(id);
  }

  updateMixin(id, input) {
    validateMixin(input, true);
    const current = this.mixin(id);
    if (!current) return null;
    checkRevision(
      input.expectedRevision,
      current.revision,
      "mixin_revision_conflict",
    );
    this.#mutate((state) => {
      const mixin = state.mixins.find((item) => item.id === id);
      if (!mixin || mixin.revision !== current.revision)
        throw new ConflictError(
          "mixin_revision_conflict",
          mixin?.revision ?? current.revision,
        );
      mixin.name = input.name ?? mixin.name;
      mixin.description = input.description ?? mixin.description;
      mixin.kind = input.kind ?? mixin.kind;
      mixin.target =
        mixin.kind === "seq" ? (input.target ?? mixin.target) : null;
      mixin.content = input.content ?? mixin.content;
      const time = this.now();
      mixin.revision++;
      mixin.updatedAt = time;
      for (const profile of state.profiles) {
        if (profile.mixins.some((reference) => reference.id === id))
          bumpProfileRevision(profile, time);
      }
    });
    return this.mixin(id);
  }

  deleteMixin(id, expected) {
    const current = this.mixin(id);
    if (!current) return false;
    checkRevision(expected, current.revision, "mixin_revision_conflict");
    this.#mutate((state) => {
      const index = state.mixins.findIndex((item) => item.id === id);
      if (index < 0) return;
      state.mixins.splice(index, 1);
      const time = this.now();
      for (const profile of state.profiles) {
        const next = profile.mixins.filter((reference) => reference.id !== id);
        if (next.length !== profile.mixins.length) {
          profile.mixins = next;
          bumpProfileRevision(profile, time);
        }
      }
    });
    return true;
  }

  setting(key, fallback = {}) {
    const setting = this.state.settings[key];
    return setting
      ? { config: clone(setting.config), revision: setting.revision }
      : { config: clone(fallback), revision: 0 };
  }

  setSetting(
    key,
    config,
    expected,
    conflictCode = "setting_revision_conflict",
  ) {
    const current = this.setting(key);
    checkRevision(expected, current.revision, conflictCode);
    const result = { config: clone(config), revision: current.revision + 1 };
    this.#mutate((state) => {
      state.settings[key] = {
        config: clone(config),
        revision: result.revision,
        updatedAt: this.now(),
      };
    });
    return result;
  }

  /** @returns {Subscription[]} */
  subscriptions() {
    return [...this.state.subscriptions]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(subscriptionView);
  }

  /** @param {string} id @returns {Subscription | null} */
  subscription(id) {
    const subscription = this.state.subscriptions.find(
      (item) => item.id === id,
    );
    return subscription ? subscriptionView(subscription) : null;
  }

  /**
   * Return the single subscription linked to a profile. A profile has one
   * authoritative remote source at most; accepting two would make refresh
   * order decide which YAML wins.
   * @param {string} profileId
   * @returns {Subscription | null}
   */
  subscriptionForProfile(profileId) {
    const matches = this.state.subscriptions.filter(
      (item) => item.profileId === profileId,
    );
    if (matches.length > 1)
      throw new Error("profile has more than one linked subscription");
    return matches[0] ? subscriptionView(matches[0]) : null;
  }

  createSubscription(input) {
    validateSubscription(input, false);
    this.#assertProfileLinkAvailable(input.profileId ?? null);
    const id = input.id ?? this.#id("subscription");
    if (this.state.subscriptions.some((item) => item.id === id))
      throw new Error("subscription id already exists");
    const time = this.now();
    this.#mutate((state) => {
      state.subscriptions.push({
        id,
        name: input.name.trim(),
        url: input.url,
        infoUrl: input.infoUrl ?? "",
        userAgent: input.userAgent ?? "",
        prefer: input.prefer ?? "remote",
        updateIntervalMinutes: input.updateIntervalMinutes ?? 0,
        metadata: clone(input.metadata ?? {}),
        profileId: input.profileId ?? null,
        revision: 1,
        createdAt: time,
        updatedAt: time,
        lastRefreshAt: null,
        lastError: null,
      });
    });
    return this.subscription(id);
  }

  /**
   * Atomically create a profile from already fetched subscription YAML and
   * link a new subscription to it. The caller validates the YAML before this
   * method; persistence still happens as one rename, so no half-created pair
   * is visible after a write failure.
   *
   * @param {{name: string, url: string, userAgent?: string, profileName: string, description?: string, metadata?: Record<string, unknown>}} input
   * @param {string} content
   * @returns {ImportedSubscription}
   */
  importSubscription(input, content) {
    validateSubscription(input, false);
    validateProfile(
      {
        name: input.profileName,
        description: input.description ?? "",
        content,
        sourceUrl: input.url,
      },
      false,
    );
    const subscriptionId = this.#id("subscription");
    const profileId = this.#id("profile");
    const time = this.now();
    this.#mutate((state) => {
      const position =
        state.profiles.reduce(
          (maximum, profile) => Math.max(maximum, profile.position),
          -1,
        ) + 1;
      state.profiles.push({
        id: profileId,
        name: input.profileName.trim(),
        description: input.description ?? "",
        sourceUrl: input.url,
        enhancement: {},
        mixins: [],
        position,
        activeRevision: 1,
        createdAt: time,
        updatedAt: time,
        revisions: [{ revision: 1, content, createdAt: time }],
      });
      state.subscriptions.push({
        id: subscriptionId,
        name: input.name.trim(),
        url: input.url,
        infoUrl: input.infoUrl ?? "",
        userAgent: input.userAgent ?? "",
        prefer: input.prefer ?? "remote",
        updateIntervalMinutes: input.updateIntervalMinutes ?? 0,
        metadata: clone(input.metadata ?? {}),
        profileId,
        revision: 1,
        createdAt: time,
        updatedAt: time,
        lastRefreshAt: time,
        lastError: null,
      });
    });
    return {
      subscription: this.subscription(subscriptionId),
      profile: this.profile(profileId),
    };
  }

  updateSubscription(id, input) {
    validateSubscription(input, true);
    const current = this.subscription(id);
    if (!current) return null;
    checkRevision(
      input.expectedRevision,
      current.revision,
      "subscription_revision_conflict",
    );
    this.#assertProfileLinkAvailable(
      input.profileId === undefined ? current.profileId : input.profileId,
      id,
    );
    this.#mutate((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription || subscription.revision !== current.revision)
        throw new ConflictError(
          "subscription_revision_conflict",
          subscription?.revision ?? current.revision,
        );
      subscription.name = input.name ?? subscription.name;
      const sourceChanged =
        (input.url !== undefined && input.url !== subscription.url) ||
        (input.infoUrl !== undefined &&
          input.infoUrl !== (subscription.infoUrl ?? ""));
      subscription.url = input.url ?? subscription.url;
      subscription.infoUrl =
        input.infoUrl === undefined
          ? (subscription.infoUrl ?? "")
          : input.infoUrl;
      subscription.userAgent =
        input.userAgent === undefined
          ? (subscription.userAgent ?? "")
          : input.userAgent;
      subscription.prefer =
        input.prefer === undefined
          ? (subscription.prefer ?? "remote")
          : input.prefer;
      subscription.updateIntervalMinutes =
        input.updateIntervalMinutes === undefined
          ? (subscription.updateIntervalMinutes ?? 0)
          : input.updateIntervalMinutes;
      subscription.metadata = clone(
        input.metadata ?? (sourceChanged ? {} : subscription.metadata),
      );
      subscription.profileId =
        input.profileId === undefined
          ? subscription.profileId
          : input.profileId;
      subscription.revision++;
      subscription.updatedAt = this.now();
      if (sourceChanged) {
        subscription.lastRefreshAt = null;
        subscription.lastError = null;
      }
    });
    return this.subscription(id);
  }

  deleteSubscription(id, expected) {
    const current = this.subscription(id);
    if (!current) return false;
    checkRevision(expected, current.revision, "subscription_revision_conflict");
    this.#mutate((state) => {
      const index = state.subscriptions.findIndex((item) => item.id === id);
      if (index >= 0) state.subscriptions.splice(index, 1);
    });
    return true;
  }

  finishRefresh(id, expectedRevision, content, metadata, options = {}) {
    const current = this.subscription(id);
    if (!current) return null;
    checkRevision(
      expectedRevision,
      current.revision,
      "subscription_revision_conflict",
    );
    if (typeof content !== "string" || utf8Bytes(content) > MAX_YAML)
      throw new Error("content must be a string no larger than 5 MiB");
    this.#mutate((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      if (!subscription || subscription.revision !== current.revision)
        throw new ConflictError(
          "subscription_revision_conflict",
          subscription?.revision ?? current.revision,
        );
      const time = this.now();
      if (subscription.profileId && options.contentChanged !== false) {
        const profile = state.profiles.find(
          (item) => item.id === subscription.profileId,
        );
        if (profile) {
          const revision =
            profile.revisions.reduce(
              (maximum, item) => Math.max(maximum, item.revision),
              0,
            ) + 1;
          profile.revisions.push({ revision, content, createdAt: time });
          profile.activeRevision = revision;
          profile.updatedAt = time;
        }
      }
      subscription.metadata = {
        ...subscription.metadata,
        ...clone(metadata ?? {}),
        refreshStatus:
          options.contentChanged === false ? "not-modified" : "updated",
        checkedAt: time,
      };
      subscription.revision++;
      subscription.updatedAt = time;
      subscription.lastRefreshAt = time;
      subscription.lastError = null;
    });
    return this.subscription(id);
  }

  markRefreshError(id, expectedRevision, error) {
    const current = this.subscription(id);
    if (!current || current.revision !== expectedRevision) return null;
    this.#mutate((state) => {
      const subscription = state.subscriptions.find((item) => item.id === id);
      subscription.lastRefreshAt = this.now();
      subscription.lastError = String(error).slice(0, 4096);
    });
    return this.subscription(id);
  }

  close() {}

  #load() {
    if (!this.fs.exists(this.path)) return emptyStore();
    let parsed;
    try {
      parsed = JSON.parse(this.decoder.decode(this.fs.readFile(this.path)));
    } catch (error) {
      throw new Error(`profile store is unreadable: ${message(error)}`);
    }
    const migrated = migrateStore(parsed);
    validateStore(migrated);
    return migrated;
  }

  #mutate(change) {
    const next = clone(this.state);
    change(next);
    validateStore(next);
    this.#persist(next);
    this.state = next;
  }

  #persist(state) {
    const temporary = `${this.path}.tmp-${this.now().toString(36)}-${(this
      .sequence++).toString(36)}`;
    const body = this.encoder.encode(`${JSON.stringify(state)}\n`);
    try {
      this.fs.writeFile(temporary, body);
      this.fs.rename(temporary, this.path);
    } catch (error) {
      try {
        if (this.fs.exists(temporary)) this.fs.unlink(temporary);
      } catch (_) {}
      throw error;
    }
  }

  #id(prefix) {
    let id;
    do {
      id = `${prefix}-${this.now().toString(36)}-${(this.sequence++).toString(
        36,
      )}`;
    } while (
      this.state.profiles.some((item) => item.id === id) ||
      this.state.subscriptions.some((item) => item.id === id) ||
      this.state.mixins.some((item) => item.id === id)
    );
    return id;
  }

  #assertProfileLinkAvailable(profileId, exceptId = null) {
    if (profileId === null) return;
    if (!this.state.profiles.some((profile) => profile.id === profileId))
      throw new Error("profileId does not reference an existing profile");
    if (
      this.state.subscriptions.some(
        (subscription) =>
          subscription.id !== exceptId && subscription.profileId === profileId,
      )
    )
      throw new Error("profile is already linked to another subscription");
  }
}

export class ConflictError extends Error {
  constructor(code, currentRevision) {
    super("Revision conflict");
    this.name = "ConflictError";
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

function emptyStore() {
  return {
    schema: STORE_SCHEMA,
    profiles: [],
    subscriptions: [],
    mixins: [],
    settings: {},
  };
}

function migrateStore(store) {
  if (!store || typeof store !== "object") return store;
  let migrated = store;
  if (migrated.schema === 1)
    migrated = {
      ...migrated,
      schema: 2,
      profiles: Array.isArray(migrated.profiles)
        ? migrated.profiles.map((profile) => ({ ...profile, mixins: [] }))
        : migrated.profiles,
      mixins: [],
    };
  if (migrated.schema === 2)
    migrated = {
      ...migrated,
      schema: STORE_SCHEMA,
      subscriptions: Array.isArray(migrated.subscriptions)
        ? migrated.subscriptions.map((subscription) => ({
            ...subscription,
            prefer: subscription.prefer ?? "remote",
          }))
        : migrated.subscriptions,
    };
  return migrated;
}

function validateStore(store) {
  if (
    !store ||
    typeof store !== "object" ||
    store.schema !== STORE_SCHEMA ||
    !Array.isArray(store.profiles) ||
    !Array.isArray(store.subscriptions) ||
    !Array.isArray(store.mixins) ||
    !store.settings ||
    typeof store.settings !== "object" ||
    Array.isArray(store.settings)
  )
    throw new Error("profile store has an unsupported or invalid schema");
  const profileIds = new Set();
  for (const profile of store.profiles) {
    if (
      !profile ||
      typeof profile.id !== "string" ||
      profileIds.has(profile.id) ||
      typeof profile.name !== "string" ||
      !validMixinReferences(profile.mixins) ||
      !Array.isArray(profile.revisions) ||
      !profile.revisions.some(
        (revision) => revision.revision === profile.activeRevision,
      )
    )
      throw new Error("profile store contains an invalid profile");
    profileIds.add(profile.id);
    const revisionIds = new Set();
    for (const revision of profile.revisions) {
      if (
        !Number.isInteger(revision.revision) ||
        revision.revision < 1 ||
        revisionIds.has(revision.revision) ||
        typeof revision.content !== "string" ||
        utf8Bytes(revision.content) > MAX_YAML
      )
        throw new Error("profile store contains an invalid revision");
      revisionIds.add(revision.revision);
    }
  }
  const mixinIds = new Set();
  for (const mixin of store.mixins) {
    if (!validStoredMixin(mixin) || mixinIds.has(mixin.id))
      throw new Error("profile store contains an invalid mixin");
    mixinIds.add(mixin.id);
  }
  for (const profile of store.profiles) {
    if (profile.mixins.some((reference) => !mixinIds.has(reference.id)))
      throw new Error("profile store contains a missing mixin reference");
  }
  const subscriptionIds = new Set();
  const subscriptionProfileIds = new Set();
  for (const subscription of store.subscriptions) {
    if (
      !subscription ||
      typeof subscription.id !== "string" ||
      subscriptionIds.has(subscription.id) ||
      (subscription.userAgent !== undefined &&
        typeof subscription.userAgent !== "string") ||
      (subscription.infoUrl !== undefined &&
        typeof subscription.infoUrl !== "string") ||
      (subscription.prefer !== undefined &&
        !["remote", "local"].includes(subscription.prefer)) ||
      (subscription.updateIntervalMinutes !== undefined &&
        (!Number.isInteger(subscription.updateIntervalMinutes) ||
          subscription.updateIntervalMinutes < 0)) ||
      !Number.isInteger(subscription.revision) ||
      subscription.revision < 1
    )
      throw new Error("profile store contains an invalid subscription");
    if (
      subscription.profileId !== null &&
      (!profileIds.has(subscription.profileId) ||
        subscriptionProfileIds.has(subscription.profileId))
    )
      throw new Error("profile store contains an ambiguous subscription link");
    subscriptionIds.add(subscription.id);
    if (subscription.profileId !== null)
      subscriptionProfileIds.add(subscription.profileId);
  }
}

function checkRevision(expected, current, code) {
  if (!Number.isInteger(expected) || expected !== current)
    throw new ConflictError(code, current);
}

function validateProfile(value, update) {
  if (!value || typeof value !== "object")
    throw new Error("profile body is required");
  if (
    (!update || value.name !== undefined) &&
    (typeof value.name !== "string" || !value.name.trim())
  )
    throw new Error("name is required");
  if (
    (!update || value.content !== undefined) &&
    (typeof value.content !== "string" || utf8Bytes(value.content) > MAX_YAML)
  )
    throw new Error("content must be a string no larger than 5 MiB");
  if (update && !Number.isInteger(value.expectedRevision))
    throw new Error("expectedRevision is required");
  if (
    value.userAgent !== undefined &&
    (typeof value.userAgent !== "string" ||
      value.userAgent.length > 256 ||
      /[^\u0020-\u007e]/.test(value.userAgent))
  )
    throw new Error(
      "userAgent must contain at most 256 printable ASCII characters",
    );
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length > 4096)
  )
    throw new Error("invalid description");
  if (
    value.enhancement !== undefined &&
    (!value.enhancement ||
      typeof value.enhancement !== "object" ||
      Array.isArray(value.enhancement))
  )
    throw new Error("invalid enhancement");
  if (value.mixins !== undefined && !validMixinReferences(value.mixins))
    throw new Error(
      `mixins must contain at most ${MAX_PROFILE_MIXINS} unique references`,
    );
}

function validateMixin(value, update) {
  if (!value || typeof value !== "object")
    throw new Error("mixin body is required");
  if (
    (!update || value.name !== undefined) &&
    (typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 200)
  )
    throw new Error(
      "mixin name is required and must not exceed 200 characters",
    );
  if (
    (!update || value.kind !== undefined) &&
    !["merge", "seq", "script"].includes(value.kind)
  )
    throw new Error("mixin kind must be merge, seq or script");
  if (
    value.id !== undefined &&
    (typeof value.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id))
  )
    throw new Error("mixin id contains invalid characters");
  if (
    (value.kind === "seq" || value.target !== undefined) &&
    !["rules", "proxies", "groups"].includes(value.target)
  )
    throw new Error("seq mixin target must be rules, proxies or groups");
  if (
    (!update || value.content !== undefined) &&
    (typeof value.content !== "string" || utf8Bytes(value.content) > MAX_MIXIN)
  )
    throw new Error("mixin content must be a string no larger than 1 MiB");
  if (update && !Number.isInteger(value.expectedRevision))
    throw new Error("expectedRevision is required");
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length > 4096)
  )
    throw new Error("invalid mixin description");
}

function validMixinReferences(value) {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_MIXINS) return false;
  const ids = new Set();
  return value.every((reference) => {
    if (
      !reference ||
      typeof reference !== "object" ||
      typeof reference.id !== "string" ||
      !reference.id ||
      typeof reference.enabled !== "boolean" ||
      ids.has(reference.id)
    )
      return false;
    ids.add(reference.id);
    return true;
  });
}

function validStoredMixin(value) {
  return (
    value &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    ["merge", "seq", "script"].includes(value.kind) &&
    (value.kind === "seq"
      ? ["rules", "proxies", "groups"].includes(value.target)
      : value.target === null) &&
    typeof value.content === "string" &&
    utf8Bytes(value.content) <= MAX_MIXIN &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function validateSubscription(value, update) {
  if (!value || typeof value !== "object")
    throw new Error("subscription body is required");
  if (
    (!update || value.name !== undefined) &&
    (typeof value.name !== "string" || !value.name.trim())
  )
    throw new Error("name is required");
  if (
    (!update || value.url !== undefined) &&
    (typeof value.url !== "string" ||
      !/^https?:\/\//i.test(value.url) ||
      value.url.length > 4096)
  )
    throw new Error("url must use http or https");
  if (value.url !== undefined) validateSubscriptionUrl(value.url, "url");
  if (value.infoUrl !== undefined && value.infoUrl !== "")
    validateSubscriptionUrl(value.infoUrl, "infoUrl");
  if (
    value.userAgent !== undefined &&
    (typeof value.userAgent !== "string" ||
      value.userAgent.length > 256 ||
      /[^\u0020-\u007e]/.test(value.userAgent))
  )
    throw new Error(
      "userAgent must contain at most 256 printable ASCII characters",
    );
  if (
    value.updateIntervalMinutes !== undefined &&
    (!Number.isInteger(value.updateIntervalMinutes) ||
      (value.updateIntervalMinutes !== 0 &&
        (value.updateIntervalMinutes < 15 ||
          value.updateIntervalMinutes > 43_200)))
  )
    throw new Error("updateIntervalMinutes must be 0 or between 15 and 43200");
  if (value.prefer !== undefined && !["remote", "local"].includes(value.prefer))
    throw new Error("prefer must be remote or local");
  if (update && !Number.isInteger(value.expectedRevision))
    throw new Error("expectedRevision is required");
  if (
    value.profileId !== undefined &&
    value.profileId !== null &&
    (typeof value.profileId !== "string" || !value.profileId)
  )
    throw new Error("profileId must be a non-empty string or null");
}

function validateSubscriptionUrl(value, field) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f#]/.test(value) ||
    !/^https?:\/\/([^/?#]+)(?:[/?][^#]*)?$/i.test(value) ||
    value.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.includes("@")
  )
    throw new Error(
      `${field} must use HTTP(S) without credentials or a fragment`,
    );
}

function profileSummary(profile) {
  const active = profile.revisions.find(
    (revision) => revision.revision === profile.activeRevision,
  );
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    sourceUrl: profile.sourceUrl,
    enhancement: clone(profile.enhancement),
    mixins: clone(profile.mixins),
    position: profile.position,
    revision: profile.activeRevision,
    contentBytes: utf8Bytes(active.content),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function profileDetail(profile, revision) {
  return {
    ...profileSummary(profile),
    revision: revision.revision,
    activeRevision: profile.activeRevision,
    content: revision.content,
    revisionCreatedAt: revision.createdAt,
  };
}

function subscriptionView(subscription) {
  return {
    ...clone(subscription),
    userAgent: subscription.userAgent ?? "",
    infoUrl: subscription.infoUrl ?? "",
    prefer: subscription.prefer ?? "remote",
    updateIntervalMinutes: subscription.updateIntervalMinutes ?? 0,
  };
}

function mixinView(mixin) {
  return clone(mixin);
}

function bumpProfileRevision(profile, time) {
  const current = profile.revisions.find(
    (revision) => revision.revision === profile.activeRevision,
  );
  if (!current) throw new Error("profile active revision is missing");
  const revision =
    profile.revisions.reduce(
      (maximum, item) => Math.max(maximum, item.revision),
      0,
    ) + 1;
  profile.revisions.push({
    revision,
    content: current.content,
    createdAt: time,
  });
  profile.activeRevision = revision;
  profile.updatedAt = time;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}
