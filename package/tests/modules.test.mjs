import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ControllerConfig } from "../lib/config.js";
import { ProfileCompiler } from "../lib/compiler.js";
import { failure, parseJsonBody, success } from "../lib/envelope.js";
import { OperationStore } from "../lib/operations.js";
import {
  defaultNetworkConfig,
  normalizeNetworkConfig,
} from "../lib/network-config.js";
import { ConflictError, Repository } from "../lib/profiles.js";
import { Router, safeAssetPath, validMutation } from "../lib/router.js";
import { RouteTable } from "../lib/route-table.js";
import {
  SubscriptionService,
  parseSubscriptionUserinfo,
  validateSubscriptionYaml,
} from "../lib/services/subscriptions.js";
import {
  RestartScheduler,
  nextRestartAt,
  normalizeRestartSchedule,
} from "../lib/services/restart-scheduler.js";
import { formatSse } from "../lib/sse.js";

const decoder = new TextDecoder();

test("API envelopes have one stable success or failure shape", () => {
  assert.deepEqual(success({ id: 1 }).body, { ok: true, result: { id: 1 } });
  assert.deepEqual(failure(409, "conflict", "changed").body, {
    ok: false,
    error: { code: "conflict", message: "changed" },
  });
});

test("JSON parser accepts objects and rejects arrays", () => {
  assert.deepEqual(
    parseJsonBody(new TextEncoder().encode('{"a":1}'), decoder),
    { a: 1 },
  );
  assert.throws(() => parseJsonBody(new TextEncoder().encode("[]"), decoder));
});

test("Controller is fixed to loopback and its backend secret is not exposed", () => {
  const config = new ControllerConfig({
    fs: {
      exists: () => true,
      readFile: () => new TextEncoder().encode("server-only-secret\n"),
    },
    decoder,
  });
  assert.deepEqual(config.status(), {
    controllerUrl: "http://127.0.0.1:9090",
    secretConfigured: true,
  });
  assert.equal(config.value.secret, "server-only-secret");
  assert.equal("secret" in config.status(), false);
});

test("network config validates TUN ownership and transparent policy fields", () => {
  const config = normalizeNetworkConfig({
    ...defaultNetworkConfig(),
    tcpMode: "tun",
    udpMode: "tun",
    ipv6: true,
    routerAcl: ["192.168.1.1", "192.168.1.1/32", "2001:db8::1"],
    lanAcl: ["192.168.0.0/16"],
    lanInterfaces: ["br-lan", "br-lan", "guest0"],
    tcpPorts: ["443", "8000-8999"],
    udpPorts: ["53", "443"],
    bypassDscp: [4, 46, 4],
    bypassMarks: ["0x80/0xff", "128/255"],
    reservedCidrs: ["10.0.0.0/8", "fc00::/7"],
    fakeIp: {
      pingHijack: true,
      ipv4Range: "198.18.0.1/16",
      ipv6Range: "fc00::/18",
    },
    tun: { device: "mihomo", stack: "system", mtu: 1500, gso: false },
  });
  assert.deepEqual(config.routerAcl, ["192.168.1.1/32", "2001:db8::1/128"]);
  assert.deepEqual(config.lanAcl, ["192.168.0.0/16"]);
  assert.deepEqual(config.lanInterfaces, ["br-lan", "guest0"]);
  assert.deepEqual(config.tcpPorts, ["443", "8000-8999"]);
  assert.deepEqual(config.udpPorts, ["53", "443"]);
  assert.deepEqual(config.bypassDscp, [4, 46]);
  assert.deepEqual(config.bypassMarks, ["0x80/0xff"]);
  assert.deepEqual(config.reservedCidrs, ["10.0.0.0/8", "fc00::/7"]);
  assert.deepEqual(config.fakeIp, {
    pingHijack: true,
    ipv4Range: "198.18.0.1/16",
    ipv6Range: "fc00::/18",
  });
  assert.deepEqual(config.tun, {
    device: "mihomo",
    stack: "system",
    mtu: 1500,
    gso: false,
  });
  assert.throws(
    () =>
      normalizeNetworkConfig({
        ...defaultNetworkConfig(),
        tcpMode: "tun",
        udpMode: "tproxy",
      }),
    /both TCP and UDP/,
  );
  assert.throws(
    () =>
      normalizeNetworkConfig({
        ...defaultNetworkConfig(),
        lanAcl: ["999.1.1.1"],
      }),
    /invalid IPv4 CIDR/,
  );
  assert.throws(
    () =>
      normalizeNetworkConfig({
        ...defaultNetworkConfig(),
        tcpPorts: ["65536"],
      }),
    /invalid port range/,
  );
  assert.throws(
    () =>
      normalizeNetworkConfig({
        ...defaultNetworkConfig(),
        bypassMarks: ["0x100/0xff"],
      }),
    /outside its mask/,
  );
});

test("profile compiler applies persisted enhancements before handing YAML to the helper", async () => {
  const calls = [];
  const compiler = new ProfileCompiler({
    config: { value: { secret: "device-only" } },
    profiles: {
      setting() {
        return {
          revision: 3,
          config: {
            version: 1,
            merge: { enabled: true, content: "mode: direct\n" },
            script: { enabled: false, content: "" },
          },
        };
      },
    },
    control: {
      async invoke(action, input) {
        calls.push({ action, input });
        return { generationId: "g-1" };
      },
    },
  });
  const profile = {
    id: "work",
    revision: 7,
    name: "Work",
    content: "mode: rule\n",
    enhancement: {},
  };
  const preview = await compiler.compile(profile, new AbortController().signal);
  assert.match(preview.content, /mode: direct/);
  assert.match(preview.content, /external-controller: 127\.0\.0\.1:9090/);
  assert.equal(preview.content.includes("device-only"), false);
  assert.match(preview.compilerRevision, /^[a-f0-9]{64}$/);
  await compiler.apply(profile, {}, new AbortController().signal);
  assert.equal(calls[0].action, "profile.apply");
  assert.match(calls[0].input.profile.content, /mode: direct/);
  assert.match(calls[0].input.profile.content, /secret: device-only/);
  assert.equal(calls[0].input.profile.content.includes("mode: rule"), false);
});

test("control client does not enter native spawn when the companion is absent", async () => {
  const { ControlClient } = await import("../lib/control.js");
  let spawned = false;
  const control = new ControlClient({
    processModule: {
      spawn() {
        spawned = true;
        throw new Error("native spawn must not run");
      },
    },
    fs: { exists: () => false },
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  await assert.rejects(
    control.invoke("status", {}, new AbortController().signal),
    /companion is not installed/,
  );
  assert.equal(spawned, false);
});

test("profile repository persists and reloads profiles, settings, and subscriptions", () => {
  const files = new Map();
  const fs = memoryFs(files);
  let now = 100;
  const options = {
    fs,
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: () => now++,
  };
  const first = new Repository(options);
  const profile = first.createProfile({
    id: "main",
    name: "Main",
    content: "mode: rule\n",
  });
  assert.equal(profile.revision, 1);
  first.setSetting("network", { enabled: false }, 0);
  first.createSubscription({
    id: "remote",
    name: "Remote",
    url: "https://example.test/profile.yaml",
    profileId: "main",
  });

  const second = new Repository(options);
  assert.equal(second.profile("main").content, "mode: rule\n");
  assert.deepEqual(second.setting("network"), {
    config: { enabled: false },
    revision: 1,
  });
  assert.equal(second.subscription("remote").profileId, "main");
  assert.ok(files.has("/data/profiles.json"));
  assert.equal(
    [...files.keys()].some((path) => path.includes(".tmp-")),
    false,
  );
});

test("schema 1 stores migrate in memory without losing existing profile data", () => {
  const files = new Map();
  files.set(
    "/data/profiles.json",
    new TextEncoder().encode(
      JSON.stringify({
        schema: 1,
        profiles: [
          {
            id: "legacy",
            name: "Legacy",
            description: "",
            sourceUrl: null,
            enhancement: {},
            position: 0,
            activeRevision: 1,
            createdAt: 1,
            updatedAt: 1,
            revisions: [{ revision: 1, content: "mode: rule\n", createdAt: 1 }],
          },
        ],
        subscriptions: [],
        settings: {},
      }),
    ),
  );
  const repository = new Repository({
    fs: memoryFs(files),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  assert.equal(repository.profile("legacy").content, "mode: rule\n");
  assert.deepEqual(repository.profile("legacy").mixins, []);
  assert.deepEqual(repository.mixins(), []);
});

test("schema 2 subscriptions migrate to explicit remote preference", () => {
  const files = new Map();
  files.set(
    "/data/profiles.json",
    new TextEncoder().encode(
      JSON.stringify({
        schema: 2,
        profiles: [
          {
            id: "profile",
            name: "Profile",
            description: "",
            sourceUrl: null,
            enhancement: {},
            mixins: [],
            position: 0,
            activeRevision: 1,
            createdAt: 1,
            updatedAt: 1,
            revisions: [{ revision: 1, content: "mode: rule\n", createdAt: 1 }],
          },
        ],
        subscriptions: [
          {
            id: "subscription",
            name: "Subscription",
            url: "https://example.test/profile.yaml",
            infoUrl: "",
            userAgent: "clash",
            updateIntervalMinutes: 0,
            profileId: "profile",
            metadata: {},
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            lastRefreshAt: null,
            lastError: null,
          },
        ],
        mixins: [],
        settings: {},
      }),
    ),
  );
  const repository = new Repository({
    fs: memoryFs(files),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  assert.equal(repository.subscription("subscription").prefer, "remote");
});

test("reusable mixins use CAS and edits invalidate every referencing profile revision", () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: (() => {
      let value = 175;
      return () => value++;
    })(),
  });
  const mixin = repository.createMixin({
    id: "dns",
    name: "Shared DNS",
    kind: "merge",
    content: "dns:\n  enable: true\n",
  });
  repository.createProfile({
    id: "main",
    name: "Main",
    content: "mode: rule\n",
    mixins: [{ id: mixin.id, enabled: true }],
  });
  const updated = repository.updateMixin("dns", {
    name: "Shared DNS",
    description: "router defaults",
    kind: "merge",
    content: "dns:\n  enable: false\n",
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal(repository.profile("main").revision, 2);
  assert.equal(
    repository.profileMixins(repository.profile("main"))[0].id,
    "dns",
  );
  assert.throws(
    () => repository.deleteMixin("dns", 1),
    (error) =>
      error instanceof ConflictError &&
      error.code === "mixin_revision_conflict" &&
      error.currentRevision === 2,
  );
  assert.equal(repository.deleteMixin("dns", 2), true);
  assert.deepEqual(repository.profile("main").mixins, []);
  assert.equal(repository.profile("main").revision, 3);
});

test("profile compiler executes ordered reusable stages between global and profile stages", async () => {
  const compiler = new ProfileCompiler({
    config: { value: { secret: "" } },
    profiles: {
      setting() {
        return {
          revision: 0,
          config: {
            version: 1,
            merge: { enabled: true, content: "x-order: [global]\n" },
            script: { enabled: false, content: "" },
          },
        };
      },
      profileMixins() {
        return [
          {
            id: "one",
            kind: "merge",
            target: null,
            content: "x-order: [mixin]\n",
          },
        ];
      },
    },
    control: { invoke: async () => ({}) },
  });
  const preview = await compiler.compile(
    {
      id: "work",
      revision: 1,
      name: "Work",
      content: "x-order: [source]\n",
      enhancement: {
        merge: { enabled: true, content: "x-order: [profile]\n" },
      },
    },
    new AbortController().signal,
  );
  assert.match(preview.content, /x-order:\n\s+- profile/);
  assert.deepEqual(preview.stages.map((stage) => stage.id).slice(0, 3), [
    "global-merge",
    "mixin-1-one",
    "profile-merge",
  ]);
});

test("subscription import atomically creates and links a fetched profile", () => {
  const files = new Map();
  const fs = memoryFs(files);
  let now = 150;
  const repository = new Repository({
    fs,
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: () => now++,
  });
  const imported = repository.importSubscription(
    {
      name: "Remote",
      url: "https://example.test/config.yaml",
      profileName: "Remote profile",
      metadata: { etag: "v1" },
    },
    "mode: rule\n",
  );
  assert.equal(imported.profile.content, "mode: rule\n");
  assert.equal(imported.profile.sourceUrl, "https://example.test/config.yaml");
  assert.equal(imported.subscription.profileId, imported.profile.id);
  assert.equal(imported.subscription.lastRefreshAt, imported.profile.createdAt);
  assert.equal(imported.subscription.metadata.etag, "v1");

  fs.failRename = true;
  assert.throws(() =>
    repository.importSubscription(
      {
        name: "Broken",
        url: "https://example.test/broken.yaml",
        profileName: "Must not exist",
      },
      "mode: direct\n",
    ),
  );
  assert.equal(repository.profiles().length, 1);
  assert.equal(repository.subscriptions().length, 1);
});

test("subscription validation requires usable Mihomo proxy content", () => {
  assert.doesNotThrow(() =>
    validateSubscriptionYaml("proxies:\n  - name: direct\n    type: direct\n"),
  );
  assert.doesNotThrow(() =>
    validateSubscriptionYaml(
      "proxy-providers:\n  provider:\n    type: http\n    url: https://example.test/nodes\n",
    ),
  );
  assert.throws(
    () => validateSubscriptionYaml("mode: rule\n"),
    (error) =>
      error.code === "invalid_subscription_content" && error.status === 422,
  );
});

test("subscription userinfo is normalized into byte and expiry metadata", () => {
  assert.deepEqual(
    parseSubscriptionUserinfo(
      "upload=100; download=250; total=1000; expire=2000000000",
    ),
    {
      upload: 100,
      download: 250,
      used: 350,
      total: 1000,
      remaining: 650,
      expireAt: 2_000_000_000_000,
    },
  );
  assert.equal(parseSubscriptionUserinfo("hello=world"), null);
});

test("subscription refresh keeps profile revision stable for 304 and identical content", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: (() => {
      let value = 400;
      return () => value++;
    })(),
  });
  const imported = repository.importSubscription(
    {
      name: "Remote",
      url: "https://example.test/profile.yaml",
      infoUrl: "",
      updateIntervalMinutes: 0,
      profileName: "Remote",
      metadata: { etag: '"v1"', lastModified: "yesterday" },
    },
    "proxies:\n  - name: one\n    type: direct\n",
  );
  const responses = [
    {
      content: null,
      notModified: true,
      metadata: { status: 304 },
    },
    {
      content: "proxies:\n  - name: one\n    type: direct\n",
      metadata: { status: 200, etag: '"v1"' },
    },
  ];
  const calls = [];
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    controller: {
      async fetchSubscription(url, _signal, options) {
        calls.push({ url, options });
        return responses.shift();
      },
    },
  });
  const first = await service.refresh(
    imported.subscription.id,
    new AbortController().signal,
  );
  const second = await service.refresh(
    imported.subscription.id,
    new AbortController().signal,
  );
  assert.equal(repository.profile(imported.profile.id).revision, 1);
  assert.equal(first.revision, 2);
  assert.equal(second.revision, 3);
  assert.equal(calls[0].options.etag, '"v1"');
  assert.equal(calls[0].options.lastModified, "yesterday");
  service.close();
});

test("optional subscription info URL overrides usage without blocking valid YAML", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    controller: {
      async fetchSubscription(url) {
        if (url.includes("info-fails")) throw new Error("info unavailable");
        return {
          content: "proxies:\n  - name: one\n    type: direct\n",
          metadata: {
            subscriptionUserinfo: "upload=10; download=20; total=100",
          },
        };
      },
    },
  });
  const imported = await service.import(
    {
      name: "Remote",
      url: "https://example.test/profile.yaml",
      infoUrl: "https://example.test/info-fails",
      updateIntervalMinutes: 0,
      userAgent: "clash",
      profileName: "Remote",
    },
    new AbortController().signal,
  );
  assert.equal(imported.profile.revision, 1);
  assert.equal(imported.subscription.metadata.usage.used, 30);
  assert.match(imported.subscription.metadata.infoError, /info unavailable/);
  service.close();
});

test("unlinked subscriptions never fetch manually or through the scheduler", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: () => 1_000,
  });
  const profile = repository.createProfile({
    id: "linked-profile",
    name: "Linked",
    content: "proxies:\n  - name: old\n    type: direct\n",
  });
  repository.createSubscription({
    id: "due",
    name: "Due",
    url: "https://example.test/due.yaml",
    updateIntervalMinutes: 60,
    profileId: profile.id,
  });
  repository.createSubscription({
    id: "unlinked",
    name: "Unlinked",
    url: "https://example.test/unlinked.yaml",
    updateIntervalMinutes: 60,
    profileId: null,
  });
  repository.createSubscription({
    id: "manual",
    name: "Manual",
    url: "https://example.test/manual.yaml",
    updateIntervalMinutes: 0,
    profileId: null,
  });
  let callback;
  let nextId = 0;
  const activeTimers = new Set();
  const calls = [];
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    now: () => 3_601_000,
    setTimer(fn) {
      const id = ++nextId;
      activeTimers.add(id);
      callback = () => {
        activeTimers.delete(id);
        fn();
      };
      return id;
    },
    clearTimer(id) {
      activeTimers.delete(id);
    },
    controller: {
      async fetchSubscription(url) {
        calls.push(url);
        return {
          content: "proxies:\n  - name: one\n    type: direct\n",
          metadata: {},
        };
      },
    },
  });
  service.start();
  assert.equal(activeTimers.size, 1);
  await assert.rejects(
    service.refresh("unlinked", new AbortController().signal),
    (error) =>
      error.code === "subscription_profile_unlinked" && error.status === 409,
  );
  assert.deepEqual(calls, []);
  const batch = await service.refreshMany(
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual(
    { total: batch.total, succeeded: batch.succeeded, failed: batch.failed },
    { total: 1, succeeded: 1, failed: 0 },
  );
  assert.deepEqual(calls, ["https://example.test/due.yaml"]);
  calls.length = 0;
  callback();
  await settle();
  await settle();
  assert.deepEqual(calls, ["https://example.test/due.yaml"]);
  assert.equal(activeTimers.size, 1);
  service.close();
  assert.equal(activeTimers.size, 0);
});

test("restart schedule is canonical and a single timer invokes service.restart", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  let currentTime = new Date(2026, 0, 5, 2, 0, 0, 0).getTime();
  const monday = new Date(2026, 0, 5, 3, 30, 0, 0).getTime();
  const config = normalizeRestartSchedule({
    enabled: true,
    time: "03:30",
    days: [1, 1],
  });
  assert.deepEqual(config.days, [1]);
  assert.equal(nextRestartAt(config, currentTime), monday);
  assert.throws(
    () => normalizeRestartSchedule({ enabled: true, time: "25:00", days: [1] }),
    (error) => error.code === "invalid_restart_schedule",
  );
  repository.setSetting("service.schedule", config, 0);

  let callback;
  let timerId = 0;
  const activeTimers = new Set();
  const delays = [];
  const calls = [];
  const operations = new OperationStore();
  const scheduler = new RestartScheduler({
    profiles: repository,
    operations,
    now: () => currentTime,
    setTimer(fn, delay) {
      const id = ++timerId;
      activeTimers.add(id);
      callback = () => {
        activeTimers.delete(id);
        fn();
      };
      delays.push(delay);
      return id;
    },
    clearTimer(id) {
      activeTimers.delete(id);
    },
    control: {
      async invoke(action, input) {
        calls.push({ action, input });
        return { restarted: true };
      },
    },
  });
  scheduler.start();
  assert.equal(activeTimers.size, 1);
  assert.deepEqual(delays, [90 * 60_000]);
  currentTime = monday;
  callback();
  await settle();
  await settle();
  await settle();
  assert.deepEqual(calls, [{ action: "service.restart", input: {} }]);
  assert.equal(operations.list()[0].kind, "service.scheduled-restart");
  assert.equal(operations.list()[0].state, "succeeded");
  assert.equal(activeTimers.size, 1);
  assert.deepEqual(delays, [90 * 60_000, 7 * 24 * 60 * 60_000]);
  scheduler.close();
  assert.equal(activeTimers.size, 0);
});

test("subscription prefer local never fetches while remote updates the prepared profile", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: (() => {
      let value = 10_000;
      return () => value++;
    })(),
  });
  const localProfile = repository.createProfile({
    id: "local-profile",
    name: "Local",
    content: "proxies:\n  - name: local\n    type: direct\n",
  });
  repository.createSubscription({
    id: "local-subscription",
    name: "Local subscription",
    url: "https://example.test/local.yaml",
    prefer: "local",
    profileId: localProfile.id,
  });
  const remote = repository.importSubscription(
    {
      name: "Remote subscription",
      url: "https://example.test/remote.yaml",
      prefer: "remote",
      profileName: "Remote",
    },
    "proxies:\n  - name: old\n    type: direct\n",
  );
  const calls = [];
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    controller: {
      async fetchSubscription(url) {
        calls.push(url);
        return {
          content: "proxies:\n  - name: new\n    type: direct\n",
          metadata: { etag: '"v2"' },
        };
      },
    },
  });

  const local = await service.prepareProfile(
    localProfile,
    new AbortController().signal,
  );
  assert.equal(local.profile.revision, 1);
  assert.equal(local.subscriptionRefresh.status, "local");
  assert.deepEqual(calls, []);

  const prepared = await service.prepareProfile(
    remote.profile,
    new AbortController().signal,
  );
  assert.equal(prepared.profile.revision, 2);
  assert.match(prepared.profile.content, /name: new/);
  assert.equal(prepared.subscriptionRefresh.changed, true);
  assert.deepEqual(calls, ["https://example.test/remote.yaml"]);
  service.close();
});

test("remote-preferred preparation falls back to the last successful revision", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  const imported = repository.importSubscription(
    {
      name: "Remote",
      url: "https://example.test/unavailable.yaml",
      prefer: "remote",
      profileName: "Fallback",
    },
    "proxies:\n  - name: saved\n    type: direct\n",
  );
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    controller: {
      async fetchSubscription() {
        throw new Error("network unavailable");
      },
    },
  });
  const prepared = await service.prepareProfile(
    imported.profile,
    new AbortController().signal,
  );
  assert.equal(prepared.profile.revision, 1);
  assert.match(prepared.profile.content, /name: saved/);
  assert.equal(prepared.subscriptionRefresh.status, "fallback");
  assert.equal(prepared.subscriptionRefresh.ok, false);
  assert.match(prepared.subscriptionRefresh.message, /network unavailable/);
  assert.match(
    repository.subscription(imported.subscription.id).lastError,
    /network unavailable/,
  );
  service.close();
});

test("an in-flight refresh cannot overwrite an edited subscription source", async () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  const imported = repository.importSubscription(
    {
      name: "Remote",
      url: "https://old.example.test/profile.yaml",
      prefer: "remote",
      profileName: "Remote",
      metadata: { etag: '"old"' },
    },
    "proxies:\n  - name: saved\n    type: direct\n",
  );
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const service = new SubscriptionService({
    profiles: repository,
    operations: new OperationStore(),
    controller: {
      async fetchSubscription() {
        await pending;
        return {
          content: "proxies:\n  - name: stale\n    type: direct\n",
          metadata: { etag: '"stale"' },
        };
      },
    },
  });
  const refresh = service.refresh(
    imported.subscription.id,
    new AbortController().signal,
  );
  const edited = repository.updateSubscription(imported.subscription.id, {
    expectedRevision: imported.subscription.revision,
    url: "https://new.example.test/profile.yaml",
  });
  assert.equal(edited.metadata.etag, undefined);
  assert.equal(edited.lastRefreshAt, null);
  release();
  await assert.rejects(
    refresh,
    (error) =>
      error instanceof ConflictError &&
      error.code === "subscription_revision_conflict",
  );
  const current = repository.subscription(imported.subscription.id);
  assert.equal(current.url, "https://new.example.test/profile.yaml");
  assert.equal(current.lastError, null);
  assert.equal(repository.profile(imported.profile.id).revision, 1);
  assert.match(repository.profile(imported.profile.id).content, /name: saved/);
  service.close();
});

test("only one subscription may own a profile refresh target", () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
  });
  const profile = repository.createProfile({
    id: "main",
    name: "Main",
    content: "mode: rule\n",
  });
  repository.createSubscription({
    id: "first",
    name: "First",
    url: "https://example.test/first.yaml",
    profileId: profile.id,
  });
  assert.throws(
    () =>
      repository.createSubscription({
        id: "second",
        name: "Second",
        url: "https://example.test/second.yaml",
        profileId: profile.id,
      }),
    /already linked/,
  );
});

test("profile repository enforces revision CAS and preserves state on write failure", () => {
  const files = new Map();
  const fs = memoryFs(files);
  let now = 200;
  const repository = new Repository({
    fs,
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: () => now++,
  });
  repository.createProfile({ id: "main", name: "Main", content: "one\n" });
  assert.throws(
    () =>
      repository.updateProfile("main", {
        content: "stale\n",
        expectedRevision: 0,
      }),
    (error) =>
      error instanceof ConflictError &&
      error.code === "profile_revision_conflict" &&
      error.currentRevision === 1,
  );
  fs.failRename = true;
  assert.throws(() =>
    repository.updateProfile("main", {
      content: "not committed\n",
      expectedRevision: 1,
    }),
  );
  assert.equal(repository.profile("main").content, "one\n");
  fs.failRename = false;
  const reloaded = new Repository({
    fs,
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: () => now++,
  });
  assert.equal(reloaded.profile("main").content, "one\n");
});

test("editing an activated historical revision allocates a fresh revision", () => {
  const repository = new Repository({
    fs: memoryFs(new Map()),
    path: "/data/profiles.json",
    encoder: new TextEncoder(),
    decoder: new TextDecoder(),
    now: (() => {
      let value = 300;
      return () => value++;
    })(),
  });
  repository.createProfile({ id: "main", name: "Main", content: "one\n" });
  repository.updateProfile("main", { content: "two\n", expectedRevision: 1 });
  repository.activate("main", 1);
  const updated = repository.updateProfile("main", {
    content: "three\n",
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 3);
  assert.deepEqual(
    repository.revisions("main").map((revision) => revision.revision),
    [3, 2, 1],
  );
});

test("operations publish transitions and retain bounded snapshots", async () => {
  let now = 10;
  const store = new OperationStore({ now: () => now++, maxEntries: 1 });
  const events = [];
  store.subscribe((event) => events.push(event.type));
  const first = await store.run("test.first", async () => ({ value: 1 }));
  assert.equal(first.state, "succeeded");
  await store.run("test.second", async () => ({ value: 2 }));
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].kind, "test.second");
  assert.deepEqual(events, [
    "operation.started",
    "operation.finished",
    "operation.started",
    "operation.finished",
  ]);
});

test("management entry relative imports resolve with their named exports", async () => {
  const entryUrl = new URL("../management.js", import.meta.url);
  const source = await readFile(entryUrl, "utf8");
  const imports = [
    ...source.matchAll(/import\s*{([^}]+)}\s*from\s*["'](\.\/[^"']+)["']/g),
  ];
  assert.ok(imports.length > 0);
  for (const match of imports) {
    const module = await import(new URL(match[2], entryUrl));
    for (const binding of match[1].split(",")) {
      const exported = binding.trim().split(/\s+as\s+/)[0];
      assert.ok(exported in module, `${match[2]} does not export ${exported}`);
    }
  }
});

test("release entry is a minified ESM bundle with only the circud host import", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../meta.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.entry, "management.bundle.min.js");
  const source = await readFile(
    new URL(`../${manifest.entry}`, import.meta.url),
    "utf8",
  );
  const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports, ["circud"]);
  assert.equal(source.includes("./lib/"), false);
  assert.ok(
    source.length < 300_000,
    "production backend bundle should stay minified",
  );
});

test("management entry loads and wires its native modules", () => {
  execFileSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      fileURLToPath(new URL("./management-load-smoke.mjs", import.meta.url)),
    ],
    { stdio: "pipe" },
  );
});

test("mutation verification requires marker and a same-origin Origin", () => {
  assert.equal(
    validMutation({
      headers: [
        ["host", "router.example"],
        ["origin", "https://router.example"],
        ["x-cno-mihomo-request", "1"],
      ],
    }),
    true,
  );
  assert.equal(
    validMutation({
      headers: [
        ["host", "router.example"],
        ["origin", "https://evil.example"],
        ["x-cno-mihomo-request", "1"],
      ],
    }),
    false,
  );
  assert.equal(
    validMutation({
      headers: [
        ["host", "router.example"],
        ["origin", "https://router.example"],
      ],
    }),
    false,
  );
});

test("route table prefers static paths, decodes params, and centralizes 405", () => {
  const routes = new RouteTable({
    onError: (error) => failure(400, "bad_route", error.message),
  });
  routes.on("GET", "/profiles/:id", (_event, params) => success(params));
  routes.on("POST", "/profiles/reorder", () => success({ reordered: true }));

  const reorder = endpoint("POST", "/unused", {});
  routes.handle(reorder, "/profiles/reorder");
  assert.deepEqual(reorder.response.body.result, { reordered: true });

  const profile = endpoint("GET", "/unused");
  routes.handle(profile, "/profiles/hello%20world");
  assert.equal(profile.response.body.result.id, "hello world");

  const wrongMethod = endpoint("DELETE", "/unused", {});
  routes.handle(wrongMethod, "/profiles/reorder");
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.allow, "POST");
});

test("router exposes only API v1 and immediately accepts asynchronous actions", async () => {
  let resolveAction;
  const calls = [];
  const operations = new OperationStore();
  const router = new Router({
    config: {},
    controller: {},
    control: {
      invoke(kind) {
        calls.push(kind);
        return new Promise((resolve) => {
          resolveAction = resolve;
        });
      },
    },
    profiles: {},
    operations,
    sse: {},
    decoder,
    decoderFactory: () => new TextDecoder(),
  });
  const legacy = endpoint("GET", "/api/status");
  router.handle(legacy);
  assert.equal(legacy.response.status, 404);

  const action = endpoint("POST", "/api/v1/service/restart", {});
  router.handle(action);
  assert.equal(action.response.status, 202);
  assert.deepEqual(action.response.body.result, { operationId: "1" });
  assert.equal(operations.get("1").state, "running");
  await Promise.resolve();
  assert.deepEqual(calls, ["service.restart"]);
  resolveAction({ restarted: true });
  await settle();
  assert.equal(operations.get("1").state, "succeeded");
});

test("status combines companion state with a Controller probe", async () => {
  const calls = [];
  const router = new Router({
    config: {},
    controller: {
      async probe() {
        calls.push("probe");
        return { reachable: true, version: "1.2.3" };
      },
    },
    control: {
      async invoke(kind) {
        calls.push(kind);
        return { service: { state: "running" }, network: { state: "active" } };
      },
    },
    profiles: {},
    operations: new OperationStore(),
    sse: {},
    decoder,
    decoderFactory: () => new TextDecoder(),
  });
  const event = endpoint("GET", "/api/v1/status");
  router.handle(event);
  const response = await event.response;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.result, {
    service: { state: "running" },
    network: { state: "active" },
    controller: { reachable: true, version: "1.2.3" },
  });
  assert.deepEqual(calls.sort(), ["probe", "status"]);
});

test("static delegation rejects traversal and accepts hashed assets", () => {
  assert.equal(safeAssetPath("/assets/index-Ab_C-12.js"), true);
  assert.equal(safeAssetPath("/assets/../config.json"), false);
  assert.equal(safeAssetPath("/assets//hidden.js"), false);
});

test("SSE records are fully framed", () => {
  assert.equal(
    formatSse("profile.updated", { id: "a" }),
    'event: profile.updated\ndata: {"id":"a"}\n\n',
  );
});

function endpoint(method, path, body) {
  return {
    method,
    path,
    query: "",
    protocol: "http",
    isAuthorized: true,
    headers: [
      ["host", "router.example"],
      ["origin", "https://router.example"],
      ["x-cno-mihomo-request", "1"],
    ],
    body:
      body === undefined
        ? new Uint8Array()
        : new TextEncoder().encode(JSON.stringify(body)),
    signal: new AbortController().signal,
    respondWith(response) {
      this.response = response;
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function memoryFs(files) {
  return {
    failRename: false,
    exists(path) {
      return files.has(path);
    },
    readFile(path) {
      const value = files.get(path);
      if (!value) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile(path, data) {
      files.set(path, new Uint8Array(data));
    },
    rename(from, to) {
      if (this.failRename) throw new Error("rename failed");
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink(path) {
      files.delete(path);
    },
  };
}
