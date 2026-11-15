import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  Network,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Save,
  ServerCog,
  ShieldCheck,
  Square,
  Undo2,
} from "lucide-react";
import {
  defaultNetworkConfig,
  defaultRestartSchedule,
  managerClient,
  type ManagerCapabilities,
  type ManagedStatus,
  type NetworkConfig,
  type RevisionedNetworkConfig,
  type RestartSchedule,
  type RevisionedRestartSchedule,
} from "../lib/manager";
import { Badge, Modal, Spinner, Toggle } from "./ui";
import { usePoller } from "../hooks/use-poll";
import "./manager-settings.css";

type ServiceAction = "start" | "reload" | "restart" | "stop";
type NetworkAction = "enable" | "disable" | "reconcile";
type ConfirmableAction =
  "service-stop" | "network-disable" | "generation-rollback";

const serviceActions: Array<{
  action: ServiceAction;
  label: string;
  icon: typeof Play;
}> = [
  { action: "start", label: "启动", icon: Play },
  { action: "reload", label: "重载", icon: RefreshCw },
  { action: "restart", label: "重启", icon: RotateCw },
  { action: "stop", label: "停止", icon: Square },
];

const weekdays = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
] as const;

const confirmations: Record<
  ConfirmableAction,
  { title: string; description: string }
> = {
  "service-stop": {
    title: "停止 Mihomo 服务？",
    description:
      "停止后内核进程退出，所有经内核代理的连接立即中断；可随时重新启动服务。",
  },
  "network-disable": {
    title: "停用透明代理？",
    description:
      "将移除 fw4 接管规则，路由器与局域网流量恢复直连；内核保持运行，但不再接管流量。",
  },
  "generation-rollback": {
    title: "回滚上一代配置？",
    description:
      "内核将切回上一代运行配置，连接可能短暂中断；回滚不会改动配置库中的原文。",
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Manager 请求失败，请稍后重试。";
}

function serviceTone(state: ManagedStatus["service"]["state"]) {
  if (state === "running") return "green" as const;
  if (state === "failed") return "red" as const;
  if (state === "starting") return "orange" as const;
  return "neutral" as const;
}

function serviceLabel(state: ManagedStatus["service"]["state"]) {
  if (state === "running") return "运行中";
  if (state === "failed") return "启动失败";
  if (state === "starting") return "启动中";
  return "已停止";
}

function networkTone(state: ManagedStatus["network"]["state"]) {
  if (state === "active") return "green" as const;
  if (state === "degraded") return "red" as const;
  if (state === "applying") return "orange" as const;
  return "neutral" as const;
}

function networkLabel(state: ManagedStatus["network"]["state"]) {
  if (state === "active") return "已接管";
  if (state === "degraded") return "状态异常";
  if (state === "applying") return "应用中";
  return "未接管";
}

/** Normalize one CIDR or host address per line while preserving user order. */
function cidrLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** Normalize one whitespace/comma separated token per line for nft set input. */
function tokenLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

type InterceptionMode = "redirect" | "tproxy" | "tun";

function interceptionMode(config: NetworkConfig): InterceptionMode {
  if (config.tcpMode === "tun" && config.udpMode === "tun") return "tun";
  return config.tcpMode === "tproxy" ? "tproxy" : "redirect";
}

/** Fields that are compiled into the active Mihomo profile, not only nftables. */
function runtimeNetworkSignature(config: NetworkConfig): string {
  return JSON.stringify({
    tunMode: config.tcpMode === "tun" && config.udpMode === "tun",
    tun: config.tun,
    fakeIp: {
      ipv4Range: config.fakeIp.ipv4Range,
      ipv6Range: config.fakeIp.ipv6Range,
    },
  });
}

function cidrFamily(value: string): 4 | 6 | null {
  const text = value.trim();
  if (text.includes(":")) {
    const match = text.match(/^([0-9A-Fa-f:]+)(?:\/(\d{1,3}))?$/);
    const address = match?.[1];
    return match &&
      !!address &&
      address.includes(":") &&
      Number(match[2] ?? 128) <= 128 &&
      !address.includes(":::") &&
      address.split("::").length <= 2
      ? 6
      : null;
  }
  const match = text.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/,
  );
  return match &&
    match.slice(1, 5).every((part) => Number(part) <= 255) &&
    Number(match[5] ?? 32) <= 32
    ? 4
    : null;
}

function networkDraftError(config: NetworkConfig): string {
  if ((config.tcpMode === "tun") !== (config.udpMode === "tun"))
    return "TUN 必须同时接管 TCP 与 UDP。";
  if (
    config.tcpMode === "tun" &&
    (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(config.tun.device) ||
      !Number.isInteger(config.tun.mtu) ||
      config.tun.mtu < 576 ||
      config.tun.mtu > 65_535)
  )
    return "TUN 设备名或 MTU 无效；设备名最长 15 字符，MTU 范围 576–65535。";
  if (
    config.lanInterfaces.some(
      (value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(value),
    )
  )
    return "LAN 入站接口包含无效设备名；每项最长 15 字符。";
  for (const [label, values] of [
    ["路由器来源 ACL", config.routerAcl],
    ["局域网来源 ACL", config.lanAcl],
    ["保留地址", config.reservedCidrs],
  ] as const) {
    for (const [index, value] of values.entries()) {
      if (cidrFamily(value) !== null) continue;
      return `${label}第 ${index + 1} 行的“${value}”不是有效 IPv4/IPv6 CIDR。`;
    }
  }
  for (const [label, values] of [
    ["TCP", config.tcpPorts],
    ["UDP", config.udpPorts],
  ] as const) {
    if (values.length === 0) return `${label} 目标端口不能留空。`;
    for (const value of values) {
      const match = value.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
      const first = Number(match?.[1]);
      const last = Number(match?.[2] ?? match?.[1]);
      if (!match || first > 65_535 || last > 65_535 || first > last)
        return `${label} 目标端口“${value}”不是有效端口或范围。`;
    }
  }
  if (
    config.bypassDscp.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 63,
    )
  )
    return "绕过 DSCP 只能填写 0–63 的整数。";
  for (const value of config.bypassMarks) {
    const match = value.match(/^(0x[0-9a-f]+|\d+)(?:\/(0x[0-9a-f]+|\d+))?$/i);
    const mark = Number(match?.[1]);
    const mask = Number(match?.[2] ?? "0xffffffff");
    if (
      !match ||
      !Number.isSafeInteger(mark) ||
      !Number.isSafeInteger(mask) ||
      mark < 0 ||
      mask < 0 ||
      mark > 0xffff_ffff ||
      mask > 0xffff_ffff ||
      (mark & mask) >>> 0 !== mark
    )
      return `绕过 FWMark“${value}”不是有效的 32 位 mark/mask。`;
  }
  if (
    config.fakeIp.pingHijack &&
    !config.fakeIp.ipv4Range &&
    !config.fakeIp.ipv6Range
  )
    return "启用 Fake-IP Ping 接管前，请至少填写一个 Fake-IP 地址范围。";
  if (config.fakeIp.ipv4Range && cidrFamily(config.fakeIp.ipv4Range) !== 4)
    return "Fake-IP IPv4 范围必须是有效的 IPv4 CIDR。";
  if (config.fakeIp.ipv6Range && cidrFamily(config.fakeIp.ipv6Range) !== 6)
    return "Fake-IP IPv6 范围必须是有效的 IPv6 CIDR。";
  return "";
}

export function ManagerSettings({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const [status, setStatus] = useState<ManagedStatus | null>(null);
  const [revisioned, setRevisioned] = useState<RevisionedNetworkConfig | null>(
    null,
  );
  const [draft, setDraft] = useState<NetworkConfig | null>(null);
  const [schedule, setSchedule] = useState<RevisionedRestartSchedule | null>(
    null,
  );
  const [scheduleDraft, setScheduleDraft] = useState<RestartSchedule | null>(
    null,
  );
  const [capabilities, setCapabilities] = useState<ManagerCapabilities | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmableAction | null>(
    null,
  );
  const mounted = useRef(false);
  const receivedNetworkConfig = useRef(false);
  const receivedRestartSchedule = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  const networkSnapshot = useRef<RevisionedNetworkConfig | null>(null);
  const scheduleSnapshot = useRef<RevisionedRestartSchedule | null>(null);
  const networkDraft = useRef<NetworkConfig | null>(null);
  const restartDraft = useRef<RestartSchedule | null>(null);
  networkDraft.current = draft;
  restartDraft.current = scheduleDraft;

  const refresh = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setLoading(true);
    const [statusResult, configResult, capabilitiesResult, scheduleResult] =
      await Promise.allSettled([
        managerClient.status(signal),
        managerClient.networkConfig(signal),
        managerClient.capabilities(signal),
        managerClient.restartSchedule(signal),
      ]);
    if (!signal?.aborted) {
      if (statusResult.status === "fulfilled") setStatus(statusResult.value);
      if (configResult.status === "fulfilled") {
        const previous = networkSnapshot.current;
        const dirty =
          previous !== null &&
          networkDraft.current !== null &&
          JSON.stringify(networkDraft.current) !==
            JSON.stringify(previous.config);
        if (!dirty) {
          setDraft(configResult.value.config);
          setRevisioned(configResult.value);
          networkSnapshot.current = configResult.value;
        }
        receivedNetworkConfig.current = true;
      } else if (!receivedNetworkConfig.current) {
        setDraft((current) => current ?? defaultNetworkConfig());
      }
      if (capabilitiesResult.status === "fulfilled")
        setCapabilities(capabilitiesResult.value);
      if (scheduleResult.status === "fulfilled") {
        const previous = scheduleSnapshot.current;
        const dirty =
          previous !== null &&
          restartDraft.current !== null &&
          JSON.stringify(restartDraft.current) !==
            JSON.stringify(previous.config);
        if (!dirty) {
          setScheduleDraft(scheduleResult.value.config);
          setSchedule(scheduleResult.value);
          scheduleSnapshot.current = scheduleResult.value;
        }
        receivedRestartSchedule.current = true;
      } else if (!receivedRestartSchedule.current) {
        setScheduleDraft((current) => current ?? defaultRestartSchedule());
      }
      const failure = [
        statusResult,
        configResult,
        capabilitiesResult,
        scheduleResult,
      ].find((result) => result.status === "rejected");
      setError(
        failure?.status === "rejected" ? errorMessage(failure.reason) : "",
      );
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    lifecycle.current = controller;
    void refresh(false, controller.signal);
    return () => {
      mounted.current = false;
      lifecycle.current = null;
      controller.abort();
    };
  }, [refresh]);
  usePoller(() => {
    void managerClient
      .status(lifecycle.current?.signal)
      .then((next: ManagedStatus) => {
        if (lifecycle.current) setStatus(next);
      })
      .catch(() => {
        /* A manual refresh reports transport errors without noisy polling alerts. */
      });
  }, 5_000);

  async function runService(action: ServiceAction) {
    if (pending) return;
    setPending(`service:${action}`);
    setError("");
    setNotice("");
    try {
      const accepted = await managerClient.service(action);
      await managerClient.waitForOperation(accepted);
      if (!mounted.current) return;
      setNotice(`服务操作已完成 · ${accepted.operationId}`);
      await refresh(true);
    } catch (requestError) {
      if (mounted.current) setError(errorMessage(requestError));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function runNetwork(action: NetworkAction) {
    if (pending) return;
    setPending(`network:${action}`);
    setError("");
    setNotice("");
    try {
      const accepted = await managerClient.networkAction(action);
      await managerClient.waitForOperation(accepted);
      if (!mounted.current) return;
      setNotice(`网络操作已完成 · ${accepted.operationId}`);
      await refresh(true);
    } catch (requestError) {
      if (mounted.current) setError(errorMessage(requestError));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function rollbackGeneration() {
    if (pending) return;
    setPending("generation:rollback");
    setError("");
    setNotice("");
    try {
      const accepted = await managerClient.rollbackGeneration();
      await managerClient.waitForOperation(accepted);
      if (!mounted.current) return;
      setNotice(`已回滚到上一代配置 · ${accepted.operationId}`);
      await refresh(true);
    } catch (requestError) {
      if (mounted.current) setError(errorMessage(requestError));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  function executeConfirm() {
    if (!confirmAction || busy) return;
    const action = confirmAction;
    if (action === "service-stop")
      void runService("stop").finally(() => setConfirmAction(null));
    else if (action === "network-disable")
      void runNetwork("disable").finally(() => setConfirmAction(null));
    else void rollbackGeneration().finally(() => setConfirmAction(null));
  }

  async function saveNetwork() {
    if (!draft || !revisioned || pending) return;
    const validationError = networkDraftError(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPending("network:save");
    setError("");
    setNotice("");
    try {
      const runtimeChanged =
        runtimeNetworkSignature(draft) !==
        runtimeNetworkSignature(revisioned.config);
      const saved = await managerClient.updateNetwork(
        draft,
        revisioned.revision,
      );
      if (!mounted.current) return;
      setRevisioned(saved);
      setDraft(saved.config);
      networkSnapshot.current = saved;
      receivedNetworkConfig.current = true;

      let nextNotice = `网络配置已保存 · revision ${saved.revision}`;
      let nextError = "";
      const activeProfileId = status?.config.activeProfileId;
      const activeRevision = status?.config.activeRevision;
      if (runtimeChanged && activeProfileId && activeRevision !== undefined) {
        setPending("network:save:apply");
        try {
          const accepted = await managerClient.applyProfile(
            activeProfileId,
            activeRevision,
          );
          await managerClient.waitForOperation(accepted);
          if (!mounted.current) return;
          nextNotice = `网络配置已保存并重新应用当前配置 · revision ${saved.revision}`;
        } catch (applyError) {
          if (!mounted.current) return;
          nextNotice = "";
          nextError = `网络配置已保存为 revision ${saved.revision}，但运行态更新失败：${errorMessage(applyError)}`;
        }
      } else if (runtimeChanged) {
        nextNotice = `网络配置已保存为 revision ${saved.revision}；尚无活动 profile，请到“配置”页预览并应用后再启用透明代理。`;
      } else if (status?.network.desired) {
        setPending("network:save:reconcile");
        try {
          const accepted = await managerClient.networkAction("reconcile");
          await managerClient.waitForOperation(accepted);
          if (!mounted.current) return;
          nextNotice = `网络配置已保存并重新协调 · revision ${saved.revision}`;
        } catch (reconcileError) {
          if (!mounted.current) return;
          nextNotice = "";
          nextError = `网络配置已保存为 revision ${saved.revision}，但重新协调失败：${errorMessage(reconcileError)}`;
        }
      }
      await refresh(true);
      if (!mounted.current) return;
      setNotice(nextNotice);
      setError(nextError);
    } catch (requestError) {
      if (mounted.current) setError(errorMessage(requestError));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function saveRestartSchedule() {
    if (!scheduleDraft || !schedule || pending) return;
    if (scheduleDraft.enabled && scheduleDraft.days.length === 0) {
      setError("启用定时重启时，请至少选择一个星期。");
      return;
    }
    setPending("schedule:save");
    setError("");
    setNotice("");
    try {
      const saved = await managerClient.updateRestartSchedule(
        scheduleDraft,
        schedule.revision,
      );
      if (!mounted.current) return;
      setSchedule(saved);
      setScheduleDraft(saved.config);
      scheduleSnapshot.current = saved;
      receivedRestartSchedule.current = true;
      setNotice(`定时重启已保存 · revision ${saved.revision}`);
    } catch (requestError) {
      if (mounted.current) setError(errorMessage(requestError));
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  const changed =
    !!draft &&
    !!revisioned &&
    JSON.stringify(draft) !== JSON.stringify(revisioned.config);
  const scheduleChanged =
    !!scheduleDraft &&
    !!schedule &&
    JSON.stringify(scheduleDraft) !== JSON.stringify(schedule.config);
  const busy = pending !== null;
  const activeProfileReady =
    !!status?.config.activeProfileId &&
    status.config.activeRevision !== undefined;
  const networkSavePending = pending?.startsWith("network:save") === true;

  useEffect(() => {
    onDirtyChange?.(changed || scheduleChanged);
    return () => onDirtyChange?.(false);
  }, [changed, onDirtyChange, scheduleChanged]);

  function setBoolean(
    key: "ipv4" | "ipv6" | "bypassReserved" | "bypassCn",
    value: boolean,
  ) {
    setDraft((current: NetworkConfig | null) =>
      current ? { ...current, [key]: value } : current,
    );
  }

  function setFakeIp(
    key: keyof NetworkConfig["fakeIp"],
    value: boolean | string,
  ) {
    setDraft((current: NetworkConfig | null) =>
      current
        ? { ...current, fakeIp: { ...current.fakeIp, [key]: value } }
        : current,
    );
  }

  function setScope(
    scope: "router" | "lan",
    key: "proxy" | "dns",
    value: boolean,
  ) {
    setDraft((current: NetworkConfig | null) =>
      current
        ? { ...current, [scope]: { ...current[scope], [key]: value } }
        : current,
    );
  }

  function setInterceptionMode(mode: InterceptionMode) {
    setDraft((current: NetworkConfig | null) =>
      current
        ? {
            ...current,
            tcpMode:
              mode === "tun"
                ? "tun"
                : mode === "tproxy"
                  ? "tproxy"
                  : "redirect",
            udpMode: mode === "tun" ? "tun" : "tproxy",
          }
        : current,
    );
  }

  return (
    <section
      className="panel settings-section manager-settings"
      aria-labelledby="manager-heading"
      aria-busy={loading || busy}
    >
      <div className="settings-section-heading">
        <ServerCog size={19} />
        <h2 id="manager-heading">路由器服务</h2>
      </div>

      <div className="manager-settings-content">
        <div className="manager-status-line">
          <div>
            <span className="manager-status-title">Mihomo 服务</span>
            <Badge
              tone={status ? serviceTone(status.service.state) : "neutral"}
            >
              {status
                ? serviceLabel(status.service.state)
                : loading
                  ? "读取中"
                  : "未知"}
            </Badge>
            {status?.service.pid !== undefined && (
              <span>PID {status.service.pid}</span>
            )}
          </div>
          <div>
            <span className="manager-status-title">透明代理</span>
            <Badge
              tone={status ? networkTone(status.network.state) : "neutral"}
            >
              {status
                ? networkLabel(status.network.state)
                : loading
                  ? "读取中"
                  : "未知"}
            </Badge>
            {status?.controller.reachable && status.controller.version && (
              <span>内核 {status.controller.version}</span>
            )}
          </div>
          <button
            className="button small manager-refresh"
            disabled={busy || loading || changed || scheduleChanged}
            title={
              changed || scheduleChanged ? "请先保存或放弃当前修改" : undefined
            }
            onClick={() => void refresh()}
          >
            {loading ? <Spinner /> : <RefreshCw size={14} />}
            刷新
          </button>
        </div>

        {(error || status?.service.lastError || status?.network.lastError) && (
          <p className="manager-message error" role="alert">
            {error || status?.network.lastError || status?.service.lastError}
          </p>
        )}
        {notice && (
          <p className="manager-message success" role="status">
            <Check size={14} />
            {notice}
          </p>
        )}
        {!loading && (!status || !revisioned || !schedule) && (
          <p className="manager-message preview" role="status">
            未连接管理服务，未读取到的设置当前仅以默认值预览；连接后才能修改和保存。
          </p>
        )}

        <div className="manager-block">
          <div className="manager-block-heading">
            <div>
              <strong>服务生命周期</strong>
              <p>由 OpenWrt procd 监督 Mihomo 进程。</p>
            </div>
          </div>
          <div
            className="manager-actions"
            role="group"
            aria-label="Mihomo 服务操作"
          >
            {serviceActions.map(({ action, label, icon: Icon }) => (
              <button
                key={action}
                className={`button small${action === "stop" ? " manager-danger" : ""}`}
                disabled={busy || loading || !status}
                onClick={() =>
                  action === "stop"
                    ? setConfirmAction("service-stop")
                    : void runService(action)
                }
              >
                {pending === `service:${action}` ? (
                  <Spinner />
                ) : (
                  <Icon size={14} />
                )}
                {pending === `service:${action}` ? "提交中…" : label}
              </button>
            ))}
          </div>
        </div>

        <div className="manager-block manager-schedule-block">
          <div className="manager-block-heading">
            <div>
              <strong>定时重启</strong>
              <p>由管理包的单个设备端定时器调度，浏览器关闭后仍会执行。</p>
            </div>
            <CalendarClock size={17} />
          </div>
          {scheduleDraft ? (
            <>
              <div className="manager-schedule-controls">
                <ManagerToggle
                  label="启用定时重启"
                  description="到达所选本地时间后调用 Mihomo 服务重启"
                  checked={scheduleDraft.enabled}
                  disabled={busy || !schedule}
                  onChange={(enabled) =>
                    setScheduleDraft({ ...scheduleDraft, enabled })
                  }
                />
                <label className="form-field manager-schedule-time">
                  <span>重启时间</span>
                  <input
                    className="field"
                    type="time"
                    aria-label="重启时间"
                    value={scheduleDraft.time}
                    disabled={busy || !schedule || !scheduleDraft.enabled}
                    onChange={(event) =>
                      setScheduleDraft({
                        ...scheduleDraft,
                        time: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <fieldset
                className="manager-weekdays"
                disabled={busy || !schedule || !scheduleDraft.enabled}
              >
                <legend>执行星期</legend>
                {weekdays.map((day) => (
                  <label key={day.value}>
                    <input
                      type="checkbox"
                      aria-label={`星期${day.label}`}
                      checked={scheduleDraft.days.includes(day.value)}
                      onChange={(event) => {
                        const days = event.target.checked
                          ? [...scheduleDraft.days, day.value]
                          : scheduleDraft.days.filter(
                              (value) => value !== day.value,
                            );
                        setScheduleDraft({
                          ...scheduleDraft,
                          days: [...new Set(days)].sort(
                            (left, right) => left - right,
                          ),
                        });
                      }}
                    />
                    {day.label}
                  </label>
                ))}
              </fieldset>
              <div className="manager-schedule-footer">
                <span className="manager-revision">
                  {schedule ? `revision ${schedule.revision}` : "只读预览"}
                </span>
                <div className="manager-save-actions">
                  <button
                    className="button small"
                    disabled={busy || !schedule || !scheduleChanged}
                    onClick={() => {
                      if (schedule) setScheduleDraft(schedule.config);
                      setError("");
                      setNotice("");
                    }}
                  >
                    <Undo2 size={14} />
                    放弃修改
                  </button>
                  <button
                    className="button small"
                    disabled={busy || !schedule || !scheduleChanged}
                    onClick={() => void saveRestartSchedule()}
                  >
                    {pending === "schedule:save" ? (
                      <Spinner />
                    ) : (
                      <Save size={14} />
                    )}
                    保存定时重启
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="muted manager-empty">
              {loading
                ? "正在读取定时重启配置…"
                : "未能读取定时重启配置，请刷新后重试。"}
            </p>
          )}
        </div>

        <div className="manager-block">
          <div className="manager-block-heading">
            <div>
              <strong>活动配置代际</strong>
              <p>
                {status?.config.generationId
                  ? `当前 ${status.config.generationId}`
                  : "尚未应用配置。请先到“配置”页预览并应用第一份 YAML。"}
              </p>
              {status?.config.previousGenerationId && (
                <p>上一代 {status.config.previousGenerationId}</p>
              )}
            </div>
            <button
              className="button small manager-danger"
              disabled={
                busy ||
                !status?.config.previousGenerationId ||
                capabilities?.generationRollback !== true
              }
              onClick={() => setConfirmAction("generation-rollback")}
            >
              {pending === "generation:rollback" ? (
                <Spinner />
              ) : (
                <Undo2 size={14} />
              )}
              回滚上一代
            </button>
          </div>
        </div>

        <div className="manager-block manager-network-block">
          <div className="manager-block-heading">
            <div>
              <strong>透明代理</strong>
              <p>配置路由器自身与局域网设备的流量接管方式。</p>
            </div>
            {revisioned && (
              <span className="manager-revision">
                revision {revisioned.revision}
              </span>
            )}
          </div>

          {draft ? (
            <fieldset
              className="manager-preview-fields"
              disabled={busy || !revisioned}
            >
              <div className="manager-mode-grid manager-interception-mode">
                <label className="form-field">
                  <span>接管模式</span>
                  <select
                    className="field"
                    aria-label="接管模式"
                    value={interceptionMode(draft)}
                    disabled={busy}
                    onChange={(event) =>
                      setInterceptionMode(
                        event.target.value as InterceptionMode,
                      )
                    }
                  >
                    <option value="redirect">Redirect TCP + TPROXY UDP</option>
                    <option value="tproxy">TPROXY TCP + UDP</option>
                    <option value="tun">TUN TCP + UDP</option>
                  </select>
                  <small>
                    只提供 companion 支持的合法组合，不会产生半 TUN 状态。
                  </small>
                </label>
              </div>

              {draft.tcpMode === "tun" && draft.udpMode === "tun" && (
                <div className="manager-mode-grid manager-tun-grid">
                  <label className="form-field">
                    <span>TUN 设备</span>
                    <input
                      className="field"
                      aria-label="TUN 设备"
                      value={draft.tun.device}
                      maxLength={15}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          tun: { ...draft.tun, device: event.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>TUN Stack</span>
                    <select
                      className="field"
                      aria-label="TUN Stack"
                      value={draft.tun.stack}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          tun: {
                            ...draft.tun,
                            stack: event.target
                              .value as NetworkConfig["tun"]["stack"],
                          },
                        })
                      }
                    >
                      <option value="mixed">Mixed</option>
                      <option value="system">System</option>
                      <option value="gvisor">gVisor</option>
                    </select>
                  </label>
                  <label className="form-field">
                    <span>MTU</span>
                    <input
                      className="field"
                      type="number"
                      aria-label="TUN MTU"
                      min={576}
                      max={65535}
                      value={draft.tun.mtu}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          tun: {
                            ...draft.tun,
                            mtu: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <ManagerToggle
                    label="GSO"
                    description="启用通用分段卸载"
                    checked={draft.tun.gso}
                    disabled={busy}
                    onChange={(value) =>
                      setDraft({ ...draft, tun: { ...draft.tun, gso: value } })
                    }
                  />
                </div>
              )}

              <div className="manager-toggle-grid">
                <ManagerToggle
                  label="IPv4"
                  description="接管 IPv4 流量"
                  checked={draft.ipv4}
                  disabled={busy}
                  onChange={(value) => setBoolean("ipv4", value)}
                />
                <ManagerToggle
                  label="IPv6"
                  description="接管 IPv6 流量"
                  checked={draft.ipv6}
                  disabled={busy}
                  onChange={(value) => setBoolean("ipv6", value)}
                />
                <ManagerToggle
                  label="路由器代理"
                  description="接管路由器自身流量"
                  checked={draft.router.proxy}
                  disabled={busy}
                  onChange={(value) => setScope("router", "proxy", value)}
                />
                <ManagerToggle
                  label="路由器 DNS"
                  description="劫持路由器 DNS 查询"
                  checked={draft.router.dns}
                  disabled={busy}
                  onChange={(value) => setScope("router", "dns", value)}
                />
                <ManagerToggle
                  label="局域网代理"
                  description="接管所选 LAN 流量"
                  checked={draft.lan.proxy}
                  disabled={busy}
                  onChange={(value) => setScope("lan", "proxy", value)}
                />
                <ManagerToggle
                  label="局域网 DNS"
                  description="劫持 LAN DNS 查询"
                  checked={draft.lan.dns}
                  disabled={busy}
                  onChange={(value) => setScope("lan", "dns", value)}
                />
                <ManagerToggle
                  label="绕过保留地址"
                  description="不代理私网与特殊地址"
                  checked={draft.bypassReserved}
                  disabled={busy}
                  onChange={(value) => setBoolean("bypassReserved", value)}
                />
                <ManagerToggle
                  label="绕过中国大陆"
                  description="直连中国大陆 IP"
                  checked={draft.bypassCn}
                  disabled={busy}
                  onChange={(value) => setBoolean("bypassCn", value)}
                />
                <ManagerToggle
                  label="Fake-IP Ping 接管"
                  description="让 Fake-IP 的 ICMP 回显由路由器应答"
                  checked={draft.fakeIp.pingHijack}
                  disabled={busy}
                  onChange={(value) => setFakeIp("pingHijack", value)}
                />
              </div>

              <div className="manager-acl-grid">
                <label className="form-field">
                  <span>路由器来源 ACL</span>
                  <textarea
                    className="field"
                    aria-label="路由器来源 ACL"
                    placeholder={
                      "每行一个 IPv4/IPv6 CIDR；留空匹配全部\n例如 192.168.1.1/32"
                    }
                    value={draft.routerAcl.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        routerAcl: cidrLines(event.target.value),
                      })
                    }
                  />
                  <small>仅匹配这些源地址；留空时覆盖所有路由器流量。</small>
                </label>
                <label className="form-field">
                  <span>局域网来源 ACL</span>
                  <textarea
                    className="field"
                    aria-label="局域网来源 ACL"
                    placeholder={
                      "每行一个 IPv4/IPv6 CIDR；留空匹配全部\n例如 192.168.1.0/24"
                    }
                    value={draft.lanAcl.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        lanAcl: cidrLines(event.target.value),
                      })
                    }
                  />
                  <small>用于按设备或网段限制 LAN 代理与 DNS 接管范围。</small>
                </label>
                <label className="form-field">
                  <span>LAN 入站接口</span>
                  <textarea
                    className="field"
                    aria-label="LAN 入站接口"
                    placeholder={
                      "每行一个 Linux 设备名；留空匹配全部\n例如 br-lan"
                    }
                    value={draft.lanInterfaces.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        lanInterfaces: tokenLines(event.target.value),
                      })
                    }
                  />
                  <small>同时约束 LAN 代理、DNS 劫持与 Fake-IP Ping。</small>
                </label>
                <label className="form-field">
                  <span>TCP 目标端口</span>
                  <textarea
                    className="field"
                    aria-label="TCP 目标端口"
                    placeholder={"每行一个端口或范围\n例如 80\n443\n8000-8999"}
                    value={draft.tcpPorts.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        tcpPorts: tokenLines(event.target.value),
                      })
                    }
                  />
                  <small>只有匹配端口进入 Redirect、TPROXY 或 TUN。</small>
                </label>
                <label className="form-field">
                  <span>UDP 目标端口</span>
                  <textarea
                    className="field"
                    aria-label="UDP 目标端口"
                    placeholder={"每行一个端口或范围\n例如 53\n123\n443"}
                    value={draft.udpPorts.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        udpPorts: tokenLines(event.target.value),
                      })
                    }
                  />
                  <small>默认 0-65535，表示接管全部 UDP 目标端口。</small>
                </label>
                <label className="form-field">
                  <span>绕过 DSCP</span>
                  <textarea
                    className="field"
                    aria-label="绕过 DSCP"
                    placeholder={"每行一个 0–63 的整数\n例如 4"}
                    value={draft.bypassDscp.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        bypassDscp: tokenLines(event.target.value).map(Number),
                      })
                    }
                  />
                  <small>匹配 DSCP 的 TCP/UDP 流量不会进入透明代理。</small>
                </label>
                <label className="form-field">
                  <span>绕过 FWMark</span>
                  <textarea
                    className="field"
                    aria-label="绕过 FWMark"
                    placeholder={"mark/mask，每行一个\n例如 0x80/0xff"}
                    value={draft.bypassMarks.join("\n")}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        bypassMarks: tokenLines(event.target.value),
                      })
                    }
                  />
                  <small>按 mark/mask 提前放行，避免与其他策略路由冲突。</small>
                </label>
                <label className="form-field manager-acl-wide">
                  <span>保留地址</span>
                  <textarea
                    className="field"
                    aria-label="保留地址"
                    placeholder="每行一个 IPv4/IPv6 CIDR"
                    value={draft.reservedCidrs.join("\n")}
                    disabled={busy || !draft.bypassReserved}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        reservedCidrs: cidrLines(event.target.value),
                      })
                    }
                  />
                  <small>“绕过保留地址”启用时使用；可增删默认特殊网段。</small>
                </label>
                <label className="form-field">
                  <span>Fake-IP IPv4 范围</span>
                  <input
                    className="field"
                    aria-label="Fake-IP IPv4 范围"
                    placeholder="198.18.0.1/16"
                    value={draft.fakeIp.ipv4Range}
                    disabled={busy}
                    onChange={(event) =>
                      setFakeIp("ipv4Range", event.target.value.trim())
                    }
                  />
                  <small>该范围不会被保留地址、端口或 DSCP 绕过。</small>
                </label>
                <label className="form-field">
                  <span>Fake-IP IPv6 范围</span>
                  <input
                    className="field"
                    aria-label="Fake-IP IPv6 范围"
                    placeholder="fc00::/18"
                    value={draft.fakeIp.ipv6Range}
                    disabled={busy}
                    onChange={(event) =>
                      setFakeIp("ipv6Range", event.target.value.trim())
                    }
                  />
                  <small>启用 Ping 接管前至少配置一个 Fake-IP 范围。</small>
                </label>
              </div>

              <div className="manager-network-footer">
                <div
                  className="manager-actions"
                  role="group"
                  aria-label="透明代理操作"
                >
                  <button
                    className="button small"
                    disabled={
                      busy ||
                      changed ||
                      !activeProfileReady ||
                      status?.network.desired === true
                    }
                    title={
                      changed
                        ? "请先保存网络配置"
                        : !activeProfileReady
                          ? "请先到“配置”页预览并应用一个 profile"
                          : undefined
                    }
                    onClick={() => void runNetwork("enable")}
                  >
                    {pending === "network:enable" ? (
                      <Spinner />
                    ) : (
                      <Power size={14} />
                    )}
                    启用
                  </button>
                  <button
                    className="button small manager-danger"
                    disabled={busy || status?.network.desired === false}
                    onClick={() => setConfirmAction("network-disable")}
                  >
                    {pending === "network:disable" ? (
                      <Spinner />
                    ) : (
                      <Square size={14} />
                    )}
                    停用
                  </button>
                  <button
                    className="button small"
                    disabled={busy || changed}
                    title={
                      changed
                        ? "请先保存；TUN/Fake-IP 变更会重新应用当前配置，其余策略会重新协调"
                        : undefined
                    }
                    onClick={() => void runNetwork("reconcile")}
                  >
                    {pending === "network:reconcile" ? (
                      <Spinner />
                    ) : (
                      <Network size={14} />
                    )}
                    重新协调
                  </button>
                </div>
                <div className="manager-save-actions">
                  <button
                    className="button small"
                    disabled={busy || !changed}
                    onClick={() => {
                      if (revisioned) setDraft(revisioned.config);
                      setError("");
                      setNotice("");
                    }}
                  >
                    <Undo2 size={14} />
                    放弃修改
                  </button>
                  <button
                    className="button primary manager-save"
                    disabled={busy || !changed}
                    onClick={() => void saveNetwork()}
                  >
                    {networkSavePending ? <Spinner /> : <Save size={15} />}
                    {pending === "network:save:apply"
                      ? "正在重新应用…"
                      : pending === "network:save:reconcile"
                        ? "正在重新协调…"
                        : pending === "network:save"
                          ? "保存中…"
                          : "保存网络配置"}
                  </button>
                </div>
              </div>
            </fieldset>
          ) : (
            <p className="muted manager-empty">
              {loading
                ? "正在读取网络配置…"
                : "未能读取网络配置，请刷新后重试。"}
            </p>
          )}
        </div>

        <div className="manager-block manager-capabilities">
          <div className="manager-block-heading">
            <div>
              <strong>Companion 能力</strong>
              <p>
                {capabilities
                  ? `${capabilities.implementation} · protocol ${capabilities.protocolVersion}`
                  : "暂未读取到 companion 能力。"}
              </p>
            </div>
            <ShieldCheck size={17} />
          </div>
          {capabilities && (
            <div className="manager-capability-list">
              <Badge tone={capabilities.atomicGenerations ? "green" : "red"}>
                原子代际
              </Badge>
              <Badge tone={capabilities.failOpen ? "green" : "red"}>
                Fail-open
              </Badge>
              <Badge
                tone={capabilities.networkOwnershipJournal ? "green" : "red"}
              >
                网络所有权
              </Badge>
              <Badge tone={capabilities.dryRun ? "orange" : "neutral"}>
                {capabilities.dryRun
                  ? "Dry-run"
                  : capabilities.mihomoSupervision}
              </Badge>
            </div>
          )}
        </div>

        {confirmAction && (
          <Modal
            title={confirmations[confirmAction].title}
            description={confirmations[confirmAction].description}
            onClose={() => setConfirmAction(null)}
          >
            <div className="form-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirmAction(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={executeConfirm}
              >
                {busy ? <Spinner /> : null}
                确认执行
              </button>
            </div>
          </Modal>
        )}
      </div>
    </section>
  );
}

function ManagerToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="manager-toggle-row">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <Toggle
        label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}
