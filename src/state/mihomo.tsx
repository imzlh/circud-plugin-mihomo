import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_TEST_URL,
  MihomoClient,
  managedControllerUrl,
} from "../lib/mihomo";
import { maintenanceStore } from "../lib/core-maintenance";
import { switchProxyWithCleanup } from "../lib/proxy-switch";
import { mergeProxyNodes } from "../lib/proxy-nodes";
import { withProxyDelayProgress } from "../lib/proxy-delay-progress";
import { PREFERENCES_CHANGED } from "../lib/preference-events";
import {
  createConnectionHistory,
  isConnectionsResponse,
  reduceConnectionHistory,
} from "../lib/connection-history";
import type {
  ConnectionsSnapshot,
  LogEntry,
  Memory,
  MihomoConfigPatch,
  ProxiesResponse,
  ProxyNode,
  ProxyProvider,
  Traffic,
} from "../lib/types";
import type { Toast } from "../components/ui";

const emptySnapshot: ConnectionsSnapshot = {
  connections: [],
  uploadTotal: 0,
  downloadTotal: 0,
};
function readCloseOnSwitch(scope: string): boolean {
  try {
    return (
      localStorage.getItem(`mihomo-verge.close-on-switch:${scope}`) === "true"
    );
  } catch {
    return false;
  }
}

function useMihomoState() {
  const queryCache = useQueryClient();
  const profile = useMemo(() => ({ url: managedControllerUrl() }), []);
  const [sessionId] = useState(0);
  const preferenceScope = profile.url;
  const storedCloseOnSwitch = useMemo(
    () => readCloseOnSwitch(preferenceScope),
    [preferenceScope],
  );
  const [closePreference, setClosePreference] = useState({
    scope: "",
    enabled: false,
  });
  const closeOnSwitch =
    closePreference.scope === preferenceScope
      ? closePreference.enabled
      : storedCloseOnSwitch;
  useEffect(() => {
    const sync = () =>
      setClosePreference({
        scope: preferenceScope,
        enabled: readCloseOnSwitch(preferenceScope),
      });
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [preferenceScope]);
  const [traffic, setTraffic] = useState<Traffic>({ up: 0, down: 0 });
  const [history, setHistory] = useState<Traffic[]>([]);
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [connectionHistoryState, dispatchConnectionHistory] = useReducer(
    reduceConnectionHistory,
    undefined,
    createConnectionHistory,
  );
  const [connectionsStream, setConnectionsStream] = useState<{
    status: "idle" | "connecting" | "open" | "closed" | "error";
    lastSnapshotAt: number | null;
  }>({ status: "idle", lastSnapshotAt: null });
  const [memory, setMemory] = useState(0);
  const [logs, setLogs] = useState<
    Array<LogEntry & { id: number; time: string }>
  >([]);
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const activeSelections = useRef(new Set<string>());
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
  const notify = useCallback(
    (text: string, type: Toast["type"] = "success") => {
      const id = ++counter.current;
      setToasts((items) => [...items.slice(-3), { id, text, type }]);
      const timer = setTimeout(
        () => {
          setToasts((items) => items.filter((item) => item.id !== id));
          toastTimers.current.delete(timer);
        },
        type === "error" ? 7000 : 3500,
      );
      toastTimers.current.add(timer);
    },
    [],
  );
  const dismissToast = (id: number) =>
    setToasts((items) => items.filter((item) => item.id !== id));
  const client = useMemo(() => new MihomoClient(), [sessionId]);
  const actionSession = useMemo(() => ({ client }), [client]);
  const currentActionSession = useRef<typeof actionSession | null>(
    actionSession,
  );
  useEffect(() => {
    currentActionSession.current = actionSession;
    return () => {
      currentActionSession.current = null;
    };
  }, [actionSession]);
  const key = ["mihomo", sessionId];
  const versionQuery = useQuery({
    queryKey: [...key, "version"],
    queryFn: ({ signal }) => client.version(signal),
    refetchInterval: 15_000,
    retry: false,
  });
  const connected = versionQuery.isSuccess;
  const enabled = connected;
  const configQuery = useQuery({
    queryKey: [...key, "config"],
    queryFn: ({ signal }) => client.configs(signal),
    enabled,
    refetchInterval: 15_000,
  });
  const proxiesQuery = useQuery({
    queryKey: [...key, "proxies"],
    queryFn: ({ signal }) => client.proxies(signal),
    enabled,
    refetchInterval: 15_000,
  });
  const providersQuery = useQuery({
    queryKey: [...key, "providers"],
    queryFn: ({ signal }) => client.providers(signal),
    enabled,
    refetchInterval: 60_000,
  });
  const ruleProvidersQuery = useQuery({
    queryKey: [...key, "rule-providers"],
    queryFn: ({ signal }) => client.ruleProviders(signal),
    enabled,
    refetchInterval: 60_000,
  });
  const rulesQuery = useQuery({
    queryKey: [...key, "rules"],
    queryFn: ({ signal }) => client.rules(signal),
    staleTime: 60_000,
  });
  const proxies = useMemo<Record<string, ProxyNode>>(
    () =>
      mergeProxyNodes(
        proxiesQuery.data?.proxies ?? {},
        providersQuery.data ?? {},
      ),
    [providersQuery.data, proxiesQuery.data],
  );

  useEffect(() => {
    setTraffic({ up: 0, down: 0 });
    setHistory([]);
    setMemory(0);
    setLive(false);
    if (!connected) return;
    const dispose = [
      client.subscribe<Traffic>(
        "traffic",
        (data) => {
          setTraffic(data);
          setHistory((items) => [...items.slice(-59), data]);
          if (data.upTotal !== undefined || data.downTotal !== undefined)
            setSnapshot((current) => ({
              ...current,
              uploadTotal: data.upTotal ?? current.uploadTotal,
              downloadTotal: data.downTotal ?? current.downloadTotal,
            }));
        },
        (status) => {
          setLive(status === "open");
          if (status !== "open") setTraffic({ up: 0, down: 0 });
        },
      ),
      client.subscribe<Memory>("memory", (data) => setMemory(data.inuse)),
      client.subscribe<LogEntry>(
        "logs",
        (data) =>
          setLogs((items) => [
            ...items.slice(-999),
            { ...data, id: ++counter.current, time: new Date().toISOString() },
          ]),
        undefined,
        { level: "debug" },
      ),
    ];
    return () => dispose.forEach((unsubscribe) => unsubscribe());
  }, [client, connected]);

  // A controller change starts a new local observation session. Transient disconnects do not.
  useEffect(() => {
    setSnapshot(emptySnapshot);
    setLogs([]);
    dispatchConnectionHistory({ type: "reset" });
    setConnectionsStream({ status: "idle", lastSnapshotAt: null });
  }, [client]);

  useEffect(() => {
    if (!connected) {
      dispatchConnectionHistory({ type: "interrupt" });
      setConnectionsStream((current) => ({
        ...current,
        status: "closed",
      }));
      return;
    }
    const interruptInvalidFrame = () => {
      dispatchConnectionHistory({ type: "interrupt" });
      setConnectionsStream((current) => ({ ...current, status: "error" }));
    };
    return client.subscribe<unknown>(
      "connections",
      (data) => {
        if (!isConnectionsResponse(data)) {
          interruptInvalidFrame();
          return;
        }
        const observedAt = Date.now();
        const connections = data.connections ?? [];
        setSnapshot({ ...data, connections });
        dispatchConnectionHistory({
          type: "snapshot",
          connections,
          observedAt,
        });
        setConnectionsStream({ status: "open", lastSnapshotAt: observedAt });
        if (data.memory !== undefined) setMemory(data.memory);
      },
      (status) => {
        dispatchConnectionHistory({ type: "interrupt" });
        setConnectionsStream((current) => ({
          ...current,
          // The list becomes live only after the new socket delivers a valid snapshot.
          status: status === "open" ? "connecting" : status,
        }));
      },
      {},
      interruptInvalidFrame,
    );
  }, [client, connected]);

  const refresh = async () => {
    await queryCache.invalidateQueries({ queryKey: key });
  };
  const runAction = async (
    action: () => Promise<unknown>,
    success?: string,
  ): Promise<boolean> => {
    try {
      await action();
      if (currentActionSession.current !== actionSession) return false;
      await refresh();
      if (currentActionSession.current !== actionSession) return false;
      if (success) notify(success);
      return true;
    } catch (error) {
      if (currentActionSession.current === actionSession)
        notify(
          error instanceof Error ? error.message : "操作失败，请重试",
          "error",
        );
      return false;
    }
  };
  const patchConfig = async (patch: MihomoConfigPatch): Promise<boolean> => {
    const maintenance = maintenanceStore(client);
    if (!maintenance.beginConfigWrite()) {
      notify("内核正在应用配置或执行维护，请稍后重试", "info");
      return false;
    }
    try {
      return await runAction(async () => {
        await client.patchConfigs(patch);
        const actual = await client.configs();
        queryCache.setQueryData([...key, "config"], actual);
        const compare = (
          expected: Record<string, unknown>,
          received: object,
        ): string[] =>
          Object.entries(expected).flatMap(([field, value]) => {
            const real = (received as Record<string, unknown>)[field];
            if (value && typeof value === "object" && !Array.isArray(value))
              return real && typeof real === "object"
                ? compare(value as Record<string, unknown>, real).map(
                    (child) => `${field}.${child}`,
                  )
                : [field];
            return JSON.stringify(value) === JSON.stringify(real)
              ? []
              : [field];
          });
        const mismatches = compare(patch as Record<string, unknown>, actual);
        if (mismatches.length)
          throw new Error(
            `配置未生效：${mismatches.join("、")}。请检查内核日志中的端口占用或权限错误。`,
          );
      }, "内核配置已应用");
    } finally {
      maintenance.endConfigWrite();
    }
  };
  const setCloseOnSwitch = (enabled: boolean) => {
    setClosePreference({ scope: preferenceScope, enabled });
    try {
      localStorage.setItem(
        `mihomo-verge.close-on-switch:${preferenceScope}`,
        String(enabled),
      );
    } catch {
      notify("此偏好仅在当前页面会话中生效，浏览器未允许保存", "info");
    }
  };
  const selectProxy = async (group: string, name: string) => {
    const actionKey = JSON.stringify([sessionId, group]);
    if (!connected || activeSelections.current.has(actionKey)) return;
    activeSelections.current.add(actionKey);
    try {
      if (!closeOnSwitch) {
        await runAction(
          () => client.selectProxy(group, name),
          `已切换到 ${name}`,
        );
        return;
      }
      const result = await switchProxyWithCleanup(client, group, name);
      if (currentActionSession.current !== actionSession) return;
      if (result.error || result.failed) {
        notify(
          `已切换到 ${name}，旧连接清理未完成：${result.error ?? `${result.failed} 条关闭失败`}。已关闭 ${result.closed} 条`,
          "error",
        );
      } else {
        notify(
          `已切换到 ${name}${result.closed ? `，已关闭 ${result.closed} 条旧连接` : ""}`,
        );
      }
      await refresh();
    } catch (error) {
      if (currentActionSession.current === actionSession)
        notify(
          error instanceof Error ? error.message : "切换失败，请重试",
          "error",
        );
    } finally {
      activeSelections.current.delete(actionKey);
    }
  };
  const testDelay = async (
    group: string,
    onResult?: (name: string, delay: number, historyKey: string) => void,
  ): Promise<Record<string, number> | undefined> => {
    let measured: Record<string, number> | undefined;
    const success = await runAction(async () => {
      const node = proxies[group];
      const members = node?.all ?? [];
      const publish = (name: string, delay: number) => {
        if (currentActionSession.current !== actionSession) return;
        const currentNodes = mergeProxyNodes(
          queryCache.getQueryData<ProxiesResponse>([...key, "proxies"])
            ?.proxies ?? {},
          queryCache.getQueryData<Record<string, ProxyProvider>>([
            ...key,
            "providers",
          ]) ?? {},
        );
        const last = currentNodes[name]?.history.at(-1);
        onResult?.(name, delay, last ? `${last.time}:${last.delay}` : "");
      };
      const measure = () =>
        client.groupDelay(
          group,
          node?.testUrl || undefined,
          5_000,
          node?.expectedStatus || undefined,
        );
      const needsProviders = members.some(
        (name) => !proxiesQuery.data?.proxies[name],
      );
      measured = onResult
        ? await withProxyDelayProgress({
            members,
            url: node?.testUrl || DEFAULT_TEST_URL,
            readNodes: async (signal) => {
              const [core, providers] = await Promise.all([
                client.proxies(signal),
                needsProviders
                  ? client.providers(signal)
                  : Promise.resolve({}),
              ]);
              if (
                !signal.aborted &&
                currentActionSession.current === actionSession
              ) {
                queryCache.setQueryData([...key, "proxies"], core);
                if (needsProviders)
                  queryCache.setQueryData([...key, "providers"], providers);
              }
              return mergeProxyNodes(core.proxies, providers);
            },
            measure,
            onResult: publish,
            isCurrent: () => currentActionSession.current === actionSession,
          })
        : await measure();
      if (currentActionSession.current === actionSession)
        for (const [name, delay] of Object.entries(measured))
          publish(name, delay);
    }, "延迟测试完成");
    return success ? measured : undefined;
  };
  const clearProxySelection = async (group: string) => {
    await runAction(
      () => client.clearProxySelection(group),
      "已恢复自动选择",
    );
  };
  const testNodeDelay = async (
    name: string,
    group?: string,
  ): Promise<number | undefined> => {
    let measured: number | undefined;
    const candidates = Object.entries(providersQuery.data ?? {}).filter(
      ([, item]) => item.proxies.some((node) => node.name === name),
    );
    const coreNode = proxiesQuery.data?.proxies[name];
    const declaredProvider = proxies[name]?.["provider-name"];
    const provider = declaredProvider
      ? candidates.find(([providerName]) => providerName === declaredProvider)
      : !coreNode && candidates.length === 1
        ? candidates[0]
        : undefined;
    if (declaredProvider && !provider) {
      notify("暂未确认节点所属代理集，请刷新资源后重试", "info");
      return;
    }
    if (!coreNode && candidates.length > 1 && !provider) {
      notify("多个代理集包含同名节点，请在资源页选择具体代理集后测速", "info");
      return;
    }
    const targetGroup = group ? proxies[group] : undefined;
    await runAction(async () => {
      const result =
        provider && provider[1].vehicleType !== "Compatible"
          ? await client.providerProxyDelay(
              provider[0],
              name,
              targetGroup?.testUrl || undefined,
            )
          : await client.delay(
              name,
              targetGroup?.testUrl || undefined,
              5000,
              targetGroup?.expectedStatus,
            );
      measured = result.delay;
    }, "节点延迟测试完成");
    return measured;
  };
  // Pages show loading placeholders instead of "no data" empty states while
  // the first fetch after connecting is still in flight.
  const proxiesPending =
    connected && proxiesQuery.isPending && proxiesQuery.data === undefined;
  const providersPending =
    connected && providersQuery.isPending && providersQuery.data === undefined;
  const ruleProvidersPending =
    connected &&
    ruleProvidersQuery.isPending &&
    ruleProvidersQuery.data === undefined;
  const rulesPending =
    connected && rulesQuery.isPending && rulesQuery.data === undefined;
  const resourceError = [
    configQuery.error,
    proxiesQuery.error,
    providersQuery.error,
    ruleProvidersQuery.error,
    rulesQuery.error,
  ].find(Boolean)?.message;
  return {
    client,
    profile,
    connected,
    live,
    status: (connected
      ? "connected"
      : versionQuery.isError
        ? "error"
        : "connecting") as "connected" | "error" | "connecting",
    error: versionQuery.error?.message ?? null,
    resourceError,
    config: configQuery.data,
    proxies,
    coreProxies: proxiesQuery.data?.proxies ?? {},
    providers: providersQuery.data ?? {},
    ruleProviders: ruleProvidersQuery.data ?? {},
    rules: rulesQuery.data ?? [],
    proxiesPending,
    providersPending,
    ruleProvidersPending,
    rulesPending,
    version: versionQuery.data?.version ?? "—",
    traffic,
    history,
    snapshot,
    connectionHistory: connectionHistoryState.closed,
    connectionsStream,
    clearConnectionHistory: () => dispatchConnectionHistory({ type: "clear" }),
    memory,
    logs,
    toasts,
    dismissToast,
    notify,
    refresh,
    runAction,
    patchConfig,
    selectProxy,
    closeOnSwitch,
    setCloseOnSwitch,
    clearProxySelection,
    testDelay,
    testNodeDelay,
    clearLogs: () => setLogs([]),
  };
}

const MihomoContext = createContext<ReturnType<typeof useMihomoState> | null>(
  null,
);
export function MihomoProvider({ children }: { children: ReactNode }) {
  const state = useMihomoState();
  return (
    <MihomoContext.Provider value={state}>{children}</MihomoContext.Provider>
  );
}
export function useMihomo() {
  const context = useContext(MihomoContext);
  if (!context) throw new Error("MihomoProvider is missing");
  return context;
}
