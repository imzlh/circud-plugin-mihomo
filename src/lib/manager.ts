import type {
  EnhancementLog,
  EnhancementStage,
  GlobalProfileEnhancement,
  ProfileEnhancement,
} from "./profile-enhancement";

const DEFAULT_TIMEOUT = 12_000;

export type ManagedServiceState = "running" | "stopped" | "starting" | "failed";
export type ManagedConfigState =
  "active" | "pending" | "applying" | "rollback" | "failed";
export type ManagedNetworkState =
  "active" | "inactive" | "applying" | "degraded";
export type TcpMode = "redirect" | "tproxy" | "tun";
export type UdpMode = "tproxy" | "tun";

export interface ManagedStatus {
  service: {
    enabled: boolean;
    state: ManagedServiceState;
    pid?: number;
    lastError?: string;
  };
  controller: {
    reachable: boolean;
    version?: string;
  };
  config: {
    state: ManagedConfigState;
    activeProfileId?: string;
    activeRevision?: number;
    generationId?: string;
    previousGenerationId?: string;
    sha256?: string;
    appliedAt?: number;
    lastTransactionId?: string;
  };
  network: {
    state: ManagedNetworkState;
    desired: boolean;
    tcpMode: TcpMode;
    udpMode: UdpMode;
    ipv4: boolean;
    ipv6: boolean;
    lastError?: string;
  };
}

export interface NetworkPolicy {
  proxy: boolean;
  dns: boolean;
}

export interface NetworkConfig {
  tcpMode: TcpMode;
  udpMode: UdpMode;
  ipv4: boolean;
  ipv6: boolean;
  router: NetworkPolicy;
  lan: NetworkPolicy;
  bypassReserved: boolean;
  bypassCn: boolean;
  routerAcl: string[];
  lanAcl: string[];
  lanInterfaces: string[];
  tcpPorts: string[];
  udpPorts: string[];
  bypassDscp: number[];
  bypassMarks: string[];
  reservedCidrs: string[];
  fakeIp: {
    pingHijack: boolean;
    ipv4Range: string;
    ipv6Range: string;
  };
  tun: {
    device: string;
    stack: "system" | "gvisor" | "mixed";
    mtu: number;
    gso: boolean;
  };
}

export interface RevisionedNetworkConfig {
  revision: number;
  config: NetworkConfig;
}

export interface RestartSchedule {
  enabled: boolean;
  time: string;
  days: number[];
}

export interface RevisionedRestartSchedule {
  revision: number;
  config: RestartSchedule;
}

const RESERVED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
] as const;

/** Build the API defaults used only when the Manager cannot provide a live draft. */
export function defaultNetworkConfig(): NetworkConfig {
  return {
    tcpMode: "redirect",
    udpMode: "tproxy",
    ipv4: true,
    ipv6: false,
    router: { proxy: false, dns: false },
    lan: { proxy: true, dns: false },
    bypassReserved: true,
    bypassCn: false,
    routerAcl: [],
    lanAcl: [],
    lanInterfaces: [],
    tcpPorts: ["0-65535"],
    udpPorts: ["0-65535"],
    bypassDscp: [],
    bypassMarks: [],
    reservedCidrs: [...RESERVED_CIDRS],
    fakeIp: { pingHijack: false, ipv4Range: "", ipv6Range: "" },
    tun: { device: "mihomo", stack: "mixed", mtu: 9000, gso: true },
  };
}

/** Build the device schedule shown by the read-only offline preview. */
export function defaultRestartSchedule(): RestartSchedule {
  return {
    enabled: false,
    time: "03:00",
    days: [0, 1, 2, 3, 4, 5, 6],
  };
}

export interface RevisionedGlobalEnhancement {
  revision: number;
  enhancement: GlobalProfileEnhancement;
}

export interface OperationAccepted {
  operationId: string;
}

export interface SubscriptionRefreshItemResult {
  id: string;
  ok: boolean;
  revision?: number;
  error?: string;
}

export interface SubscriptionRefreshBatchResult {
  total: number;
  succeeded: number;
  failed: number;
  results: SubscriptionRefreshItemResult[];
}

export interface ManagedOperation<T = unknown> {
  id: string;
  kind: string;
  state: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt: number | null;
  result: T | null;
  error: string | null;
}

export interface ManagerCapabilities {
  protocolVersion: number;
  implementation: string;
  verbs: string[];
  atomicGenerations: boolean;
  generationRollback: boolean;
  networkOwnershipJournal: boolean;
  failOpen: boolean;
  mihomoSupervision: string;
  scriptIsolation: string;
  networkModes?: string[];
  tunOwnership?: string;
  dryRun: boolean;
}

export interface ManagedSubscription {
  id: string;
  name: string;
  url: string;
  infoUrl: string;
  userAgent: string;
  prefer: "remote" | "local";
  updateIntervalMinutes: number;
  metadata: Record<string, unknown>;
  profileId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastRefreshAt: number | null;
  lastError: string | null;
}

export interface SubscriptionInput {
  name: string;
  url: string;
  infoUrl: string;
  userAgent: string;
  prefer: "remote" | "local";
  updateIntervalMinutes: number;
  profileId: string | null;
}

export interface SubscriptionImportInput {
  name: string;
  url: string;
  infoUrl: string;
  userAgent: string;
  prefer: "remote" | "local";
  updateIntervalMinutes: number;
  profileName: string;
  description?: string;
}

export interface ImportedSubscription {
  subscription: ManagedSubscription;
  profile: ManagedProfile;
}

export type MixinKind = "merge" | "seq" | "script";
export type MixinTarget = "rules" | "proxies" | "groups";

export interface ProfileMixinReference {
  id: string;
  enabled: boolean;
}

export interface ManagedMixin {
  id: string;
  name: string;
  description: string;
  kind: MixinKind;
  target: MixinTarget | null;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface MixinInput {
  name: string;
  description: string;
  kind: MixinKind;
  target?: MixinTarget;
  content: string;
}

export interface ProfileInput {
  name: string;
  description: string;
  content: string;
  sourceUrl?: string;
  enhancement?: ProfileEnhancement;
  mixins?: ProfileMixinReference[];
}

export interface ManagedProfile extends ProfileInput {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ProfileSummary = Omit<ManagedProfile, "content">;

export interface ProfilePreview {
  profileId: string;
  profileRevision: number;
  compilerRevision: string;
  contentHash: string;
  content: string;
  logs: EnhancementLog[];
  stages: EnhancementStage[];
  subscriptionRefresh?: SubscriptionRefreshResult | null;
}

export interface SubscriptionRefreshResult {
  subscriptionId: string;
  subscriptionName: string;
  prefer: "remote" | "local";
  attempted: boolean;
  ok: boolean;
  changed: boolean;
  status: "local" | "updated" | "not-modified" | "fallback";
  message?: string;
}

export type ServiceAction = "start" | "reload" | "restart" | "stop";
export type NetworkAction = "enable" | "disable" | "reconcile";

export class ManagerApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ManagerApiError";
    this.status = status;
    this.code = code;
  }
}

interface ManagerSuccessEnvelope<T> {
  ok: true;
  result: T;
}

interface ManagerErrorEnvelope {
  ok: false;
  error: string | { code?: string; message?: string };
}

function managerBaseUrl(): string {
  if (typeof location === "undefined")
    throw new ManagerApiError("管理 API 只能在浏览器托管页面中使用");
  return new URL("/io.cno.mihomo/api/v1/", location.origin).toString();
}

function errorFromResponse(status: number, text: string): ManagerApiError {
  let message = "";
  let code: string | undefined;
  try {
    const envelope = JSON.parse(text) as ManagerErrorEnvelope;
    if (typeof envelope.error === "string") message = envelope.error;
    else if (envelope.error && typeof envelope.error === "object") {
      message =
        typeof envelope.error.message === "string"
          ? envelope.error.message
          : "";
      code =
        typeof envelope.error.code === "string"
          ? envelope.error.code
          : undefined;
    }
  } catch {
    if (!text.trim().startsWith("<")) message = text.trim().slice(0, 200);
  }
  if (!message) {
    message =
      status === 401 || status === 403
        ? "管理会话已失效，请重新登录"
        : status === 409 || status === 412
          ? "配置已被其他会话更新，请刷新后重试"
          : `管理请求失败（HTTP ${status}）`;
  }
  return new ManagerApiError(message, status, code);
}

function errorFromEnvelope(
  error: ManagerErrorEnvelope["error"],
  status?: number,
): ManagerApiError {
  if (typeof error === "string") return new ManagerApiError(error, status);
  return new ManagerApiError(
    typeof error.message === "string" && error.message
      ? error.message
      : status === undefined
        ? "管理请求失败"
        : `管理请求失败（HTTP ${status}）`,
    status,
    typeof error.code === "string" ? error.code : undefined,
  );
}

export class ManagerClient {
  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeout?: number;
    } = {},
  ): Promise<T> {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort(options.signal?.reason);
    if (options.signal?.aborted)
      throw new DOMException("请求已取消", "AbortError");
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, options.timeout ?? DEFAULT_TIMEOUT);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined)
      headers["Content-Type"] = "application/json";
    if ((options.method ?? "GET") !== "GET")
      headers["X-CNO-Mihomo-Request"] = "1";
    try {
      const response = await fetch(new URL(path, managerBaseUrl()), {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        signal: abort.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
      const text = await response.text();
      if (!response.ok) throw errorFromResponse(response.status, text);
      if (!text.trim()) return undefined as T;
      let envelope: ManagerSuccessEnvelope<T> | ManagerErrorEnvelope;
      try {
        envelope = JSON.parse(text) as
          ManagerSuccessEnvelope<T> | ManagerErrorEnvelope;
      } catch {
        throw new ManagerApiError("管理 API 返回了无效 JSON", response.status);
      }
      if (
        envelope &&
        typeof envelope === "object" &&
        envelope.ok === false &&
        "error" in envelope
      )
        throw errorFromEnvelope(envelope.error, response.status);
      if (
        !envelope ||
        typeof envelope !== "object" ||
        envelope.ok !== true ||
        !("result" in envelope)
      )
        throw new ManagerApiError(
          "管理 API 返回了无效响应包络",
          response.status,
        );
      return envelope.result;
    } catch (error) {
      if (options.signal?.aborted)
        throw new DOMException("请求已取消", "AbortError");
      if (timedOut) throw new ManagerApiError("管理请求超时，请稍后重试");
      if (error instanceof ManagerApiError) throw error;
      throw new ManagerApiError(
        "无法连接管理服务，请确认 circud 与 Mihomo 管理包正在运行",
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  status(signal?: AbortSignal): Promise<ManagedStatus> {
    return this.request("status", { signal });
  }

  capabilities(signal?: AbortSignal): Promise<ManagerCapabilities> {
    return this.request("capabilities", { signal });
  }

  operation<T = unknown>(
    id: string,
    signal?: AbortSignal,
  ): Promise<ManagedOperation<T>> {
    return this.request(`operations/${encodeURIComponent(id)}`, { signal });
  }

  async waitForOperation<T = unknown>(
    accepted: OperationAccepted | string,
    options: { signal?: AbortSignal; timeout?: number; interval?: number } = {},
  ): Promise<ManagedOperation<T>> {
    const id = typeof accepted === "string" ? accepted : accepted.operationId;
    const started = Date.now();
    const timeout = options.timeout ?? 120_000;
    for (;;) {
      const operation = await this.operation<T>(id, options.signal);
      if (operation.state === "succeeded") return operation;
      if (operation.state === "failed")
        throw new ManagerApiError(
          operation.error || `操作 ${operation.kind} 执行失败`,
          undefined,
          "operation_failed",
        );
      if (Date.now() - started >= timeout)
        throw new ManagerApiError(
          "后台操作仍未完成，请刷新状态确认结果",
          undefined,
          "operation_timeout",
        );
      await wait(options.interval ?? 350, options.signal);
    }
  }

  networkConfig(signal?: AbortSignal): Promise<RevisionedNetworkConfig> {
    return this.request("network", { signal });
  }

  service(action: ServiceAction): Promise<OperationAccepted> {
    return this.request(`service/${action}`, { method: "POST" });
  }

  restartSchedule(signal?: AbortSignal): Promise<RevisionedRestartSchedule> {
    return this.request("service/schedule", { signal });
  }

  updateRestartSchedule(
    config: RestartSchedule,
    expectedRevision: number,
  ): Promise<RevisionedRestartSchedule> {
    return this.request("service/schedule", {
      method: "PUT",
      body: { config, expectedRevision },
    });
  }

  updateNetwork(
    config: NetworkConfig,
    expectedRevision: number,
  ): Promise<RevisionedNetworkConfig> {
    return this.request("network", {
      method: "PUT",
      body: { config, expectedRevision },
    });
  }

  networkAction(action: NetworkAction): Promise<OperationAccepted> {
    return this.request(`network/${action}`, { method: "POST" });
  }

  rollbackGeneration(): Promise<OperationAccepted> {
    return this.request("generation/rollback", { method: "POST" });
  }

  globalEnhancement(
    signal?: AbortSignal,
  ): Promise<RevisionedGlobalEnhancement> {
    return this.request("enhancement/global", { signal });
  }

  updateGlobalEnhancement(
    enhancement: GlobalProfileEnhancement,
    expectedRevision: number,
  ): Promise<RevisionedGlobalEnhancement> {
    return this.request("enhancement/global", {
      method: "PUT",
      body: { enhancement, expectedRevision },
    });
  }

  mixins(signal?: AbortSignal): Promise<ManagedMixin[]> {
    return this.request("mixins", { signal });
  }

  mixin(id: string, signal?: AbortSignal): Promise<ManagedMixin> {
    return this.request(`mixins/${encodeURIComponent(id)}`, { signal });
  }

  createMixin(input: MixinInput): Promise<ManagedMixin> {
    return this.request("mixins", { method: "POST", body: input });
  }

  updateMixin(
    id: string,
    input: MixinInput,
    expectedRevision: number,
  ): Promise<ManagedMixin> {
    return this.request(`mixins/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { ...input, expectedRevision },
    });
  }

  deleteMixin(id: string, expectedRevision: number): Promise<void> {
    return this.request(`mixins/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: { expectedRevision },
    });
  }

  profiles(signal?: AbortSignal): Promise<ProfileSummary[]> {
    return this.request("profiles", { signal });
  }

  profile(id: string, signal?: AbortSignal): Promise<ManagedProfile> {
    return this.request(`profiles/${encodeURIComponent(id)}`, { signal });
  }

  createProfile(input: ProfileInput): Promise<ManagedProfile> {
    return this.request("profiles", { method: "POST", body: input });
  }

  updateProfile(
    id: string,
    input: ProfileInput,
    expectedRevision: number,
  ): Promise<ManagedProfile> {
    return this.request(`profiles/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { ...input, expectedRevision },
    });
  }

  deleteProfile(id: string, expectedRevision: number): Promise<void> {
    return this.request(`profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: { expectedRevision },
    });
  }

  reorderProfiles(ids: string[]): Promise<ProfileSummary[]> {
    return this.request("profiles/reorder", { method: "POST", body: { ids } });
  }

  fetchProfile(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    return this.request("profiles/fetch", {
      method: "POST",
      body: { url },
      signal,
      timeout: 30_000,
    });
  }

  previewProfile(
    id: string,
    expectedRevision: number,
  ): Promise<ProfilePreview> {
    return this.request(`profiles/${encodeURIComponent(id)}/preview`, {
      method: "POST",
      body: { expectedRevision },
      timeout: 30_000,
    });
  }

  applyProfile(
    id: string,
    expectedRevision: number,
  ): Promise<OperationAccepted> {
    return this.request(`profiles/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: { expectedRevision },
      timeout: 30_000,
    });
  }

  subscriptions(signal?: AbortSignal): Promise<ManagedSubscription[]> {
    return this.request("subscriptions", { signal });
  }

  createSubscription(input: SubscriptionInput): Promise<ManagedSubscription> {
    return this.request("subscriptions", { method: "POST", body: input });
  }

  importSubscription(
    input: SubscriptionImportInput,
  ): Promise<ImportedSubscription> {
    return this.request("subscriptions/import", {
      method: "POST",
      body: input,
      timeout: 30_000,
    });
  }

  updateSubscription(
    id: string,
    input: SubscriptionInput,
    expectedRevision: number,
  ): Promise<ManagedSubscription> {
    return this.request(`subscriptions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { ...input, expectedRevision },
    });
  }

  deleteSubscription(id: string, expectedRevision: number): Promise<void> {
    return this.request(`subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: { expectedRevision },
    });
  }

  refreshSubscription(id: string): Promise<ManagedSubscription> {
    return this.request(`subscriptions/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
      timeout: 30_000,
    });
  }

  refreshSubscriptions(ids?: string[]): Promise<OperationAccepted> {
    return this.request("subscriptions/refresh", {
      method: "POST",
      body: ids ? { ids } : {},
    });
  }
}

export const managerClient = new ManagerClient();

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("请求已取消", "AbortError"));
      },
      { once: true },
    );
  });
}
