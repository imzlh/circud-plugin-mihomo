import {
  atomicWriteJson,
  atomicWriteText,
  ControlError,
  delay,
  optionalBoolean,
  optionalPositiveInteger,
  pathExists,
  readJsonIfPresent,
  readTextIfPresent,
  record,
  removeIfPresent,
  runCommand,
  type JsonObject,
  type RuntimePaths,
} from "./runtime.ts";

export interface NetworkConfig {
  tcpMode: "redirect" | "tproxy" | "tun";
  udpMode: "tproxy" | "tun";
  ipv4: boolean;
  ipv6: boolean;
  router: { proxy: boolean; dns: boolean };
  lan: { proxy: boolean; dns: boolean };
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

export interface NetworkCheckpoint {
  revision: number;
  desired: boolean;
  config: NetworkConfig;
  updatedAt: number;
  lastError?: string;
}

interface NetworkPorts {
  redirect: number;
  tproxy: number;
  dns: number;
  routeMark: number;
  bypassMark: number;
  routeTable: number;
  ipv4RulePriority: number;
  ipv6RulePriority: number;
}

const DEFAULT_CONFIG: NetworkConfig = Object.freeze({
  tcpMode: "redirect",
  udpMode: "tproxy",
  ipv4: true,
  ipv6: false,
  router: Object.freeze({ proxy: false, dns: false }),
  lan: Object.freeze({ proxy: true, dns: false }),
  bypassReserved: true,
  bypassCn: false,
  routerAcl: Object.freeze([]) as unknown as string[],
  lanAcl: Object.freeze([]) as unknown as string[],
  lanInterfaces: Object.freeze([]) as unknown as string[],
  tcpPorts: Object.freeze(["0-65535"]) as unknown as string[],
  udpPorts: Object.freeze(["0-65535"]) as unknown as string[],
  bypassDscp: Object.freeze([]) as unknown as number[],
  bypassMarks: Object.freeze([]) as unknown as string[],
  reservedCidrs: Object.freeze([
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
  ]) as unknown as string[],
  fakeIp: Object.freeze({ pingHijack: false, ipv4Range: "", ipv6Range: "" }),
  tun: Object.freeze({
    device: "mihomo",
    stack: "mixed",
    mtu: 9000,
    gso: true,
  }),
});

export class NetworkManager {
  private state: NetworkCheckpoint | undefined;
  private status: "active" | "inactive" | "applying" | "degraded" = "inactive";

  constructor(
    private readonly paths: RuntimePaths,
    private readonly dryRun: boolean,
    private readonly ports: NetworkPorts,
  ) {}

  async initialize(): Promise<void> {
    this.state = await readJsonIfPresent<NetworkCheckpoint>(this.paths.network);
    if (!this.state) {
      this.state = {
        revision: 1,
        desired: false,
        config: cloneDefault(),
        updatedAt: Date.now(),
      };
      await atomicWriteJson(this.paths.network, this.state);
    } else {
      this.state.config = validateNetworkConfig(this.state.config);
      this.state.desired = this.state.desired === true;
    }
    const ownership = await readJsonIfPresent<JsonObject>(this.paths.ownership);
    this.status =
      ownership?.state === "active" && this.state.desired
        ? "active"
        : "inactive";
  }

  publicValue(): {
    revision: number;
    config: NetworkConfig;
    desired: boolean;
    state: string;
    lastError?: string;
  } {
    const state = this.requiredState();
    return {
      revision: state.revision,
      config: state.config,
      desired: state.desired,
      state: this.status,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  managedStatus(): JsonObject {
    const state = this.requiredState();
    return {
      state: this.status,
      desired: state.desired,
      tcpMode: state.config.tcpMode,
      udpMode: state.config.udpMode,
      ipv4: state.config.ipv4,
      ipv6: state.config.ipv6,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  checkpoint(): NetworkCheckpoint {
    return JSON.parse(
      JSON.stringify(this.requiredState()),
    ) as NetworkCheckpoint;
  }

  async restore(checkpoint: NetworkCheckpoint): Promise<JsonObject> {
    this.state = {
      ...checkpoint,
      config: validateNetworkConfig(checkpoint.config),
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.paths.network, this.state);
    return await this.reconcile();
  }

  async enable(input: JsonObject): Promise<JsonObject> {
    const previous = this.requiredState();
    this.assertRevision(input.expectedRevision, previous.revision);
    const candidate =
      input.config === undefined && hasNetworkFields(input)
        ? input
        : (input.config ?? previous.config);
    const config = validateNetworkConfig(candidate);
    this.state = {
      revision: previous.revision + 1,
      desired: true,
      config,
      updatedAt: Date.now(),
    };
    try {
      await this.reconcile();
      return this.publicValue();
    } catch (error) {
      if (
        error instanceof ControlError &&
        error.code === "network_preflight_failed"
      ) {
        this.state = previous;
        await atomicWriteJson(this.paths.network, previous);
      }
      throw error;
    }
  }

  async disable(input: JsonObject): Promise<JsonObject> {
    const state = this.requiredState();
    this.assertRevision(input.expectedRevision, state.revision);
    this.state = {
      ...state,
      revision: state.revision + 1,
      desired: false,
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.paths.network, this.state);
    try {
      await this.failOpenCleanup(true);
      this.status = "inactive";
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Cannot withdraw network interception";
      this.state = {
        ...this.requiredState(),
        lastError: message,
        updatedAt: Date.now(),
      };
      await atomicWriteJson(this.paths.network, this.state);
      this.status = "degraded";
      throw error;
    }
    return this.publicValue();
  }

  async withdraw(): Promise<JsonObject> {
    try {
      await this.failOpenCleanup(true);
      this.status = "inactive";
      if (this.state?.lastError) {
        this.state = {
          ...this.state,
          lastError: undefined,
          updatedAt: Date.now(),
        };
        await atomicWriteJson(this.paths.network, this.state);
      }
      return this.publicValue();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Cannot withdraw network interception";
      this.state = {
        ...this.requiredState(),
        lastError: message,
        updatedAt: Date.now(),
      };
      await atomicWriteJson(this.paths.network, this.state);
      this.status = "degraded";
      throw error;
    }
  }

  async reconcile(input: JsonObject = {}): Promise<JsonObject> {
    let state = this.requiredState();
    this.assertRevision(input.expectedRevision, state.revision);
    if (input.config !== undefined || hasNetworkFields(input)) {
      const candidate = input.config === undefined ? input : input.config;
      const config = validateNetworkConfig(candidate);
      if (JSON.stringify(config) !== JSON.stringify(state.config)) {
        this.state = {
          ...state,
          revision: state.revision + 1,
          config,
          updatedAt: Date.now(),
        };
        state = this.requiredState();
        await atomicWriteJson(this.paths.network, state);
      }
    }
    if (!state.desired) {
      await this.failOpenCleanup(true);
      this.status = "inactive";
      return this.publicValue();
    }

    this.status = "applying";
    const resources = this.ownedResources(state.config);
    const priorOwnership = await readJsonIfPresent<JsonObject>(
      this.paths.ownership,
    );
    const previousResources = ownedResources(priorOwnership);
    const cleanupResources = unionResources(previousResources, resources);
    const journal: JsonObject = {
      version: 1,
      owner: "cno-mihomo",
      state: "applying",
      revision: state.revision,
      resources: cleanupResources,
      updatedAt: Date.now(),
    };
    let mutated = false;
    try {
      const rules = await this.renderRules(state.config);
      await atomicWriteText(this.paths.runtimeRules, rules, 0o600);
      if (!this.dryRun) {
        this.requireExecutable(this.paths.nft, "nft");
        if (resources.some((resource) => resource.kind === "ip_rule"))
          this.requireExecutable(this.paths.ip, "ip-full");
        const check = await runCommand(
          this.paths.nft,
          ["-c", "-f", this.paths.runtimeRules],
          { timeoutMs: 10_000 },
        );
        if (!check.success)
          throw new ControlError(
            "network_rules_invalid",
            check.stderr.trim() || "nft rejected the generated ruleset",
          );
        await this.checkPolicyCollisions(resources, previousResources);
      }
      await atomicWriteJson(this.paths.ownership, journal);
      mutated = true;
      if (!this.dryRun) {
        if (isTunMode(state.config))
          await this.waitForTunDevice(state.config.tun.device);
        await this.installPolicyRouting(state.config, previousResources);
        const nft = await runCommand(
          this.paths.nft,
          ["-f", this.paths.runtimeRules],
          { timeoutMs: 10_000 },
        );
        if (!nft.success)
          throw new ControlError(
            "network_apply_failed",
            nft.stderr.trim() || "nft rejected the generated ruleset",
          );
        await this.removeKernelResources(
          previousResources.filter(
            (resource) => !hasResource(resources, resource),
          ),
          false,
        );
      }
      await atomicWriteText(this.paths.persistentRules, rules, 0o600);
      await atomicWriteJson(this.paths.ownership, {
        ...journal,
        state: "active",
        resources,
        updatedAt: Date.now(),
      });
      this.state = { ...state, lastError: undefined };
      await atomicWriteJson(this.paths.network, this.state);
      this.status = "active";
      return this.publicValue();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Network apply failed";
      if (mutated) {
        await this.failOpen(message);
        throw new ControlError("network_apply_failed", message, {
          failOpen: true,
          revision: state.revision,
        });
      }
      this.state = {
        ...this.requiredState(),
        lastError: message,
        updatedAt: Date.now(),
      };
      await atomicWriteJson(this.paths.network, this.state);
      this.status = priorOwnership?.state === "active" ? "active" : "degraded";
      throw new ControlError("network_preflight_failed", message, {
        failOpen: false,
        preserved: priorOwnership?.state === "active",
        revision: state.revision,
      });
    }
  }

  async failOpen(message: string): Promise<void> {
    let cleanupError: unknown;
    try {
      await this.failOpenCleanup(true);
    } catch (error) {
      cleanupError = error;
    }
    const fullMessage = cleanupError
      ? `${message}; fail-open cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      : message;
    this.state = {
      ...this.requiredState(),
      lastError: fullMessage,
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.paths.network, this.state);
    this.status = "degraded";
    if (cleanupError)
      throw new ControlError("fail_open_failed", fullMessage, {
        originalError: message,
      });
  }

  async failOpenCleanup(writePersistentEmpty: boolean): Promise<void> {
    const ownership = await readJsonIfPresent<JsonObject>(this.paths.ownership);
    const resources = ownedResources(ownership).length
      ? ownedResources(ownership)
      : this.ownedResources(this.requiredState().config);
    await this.removeKernelResources(resources);
    if (writePersistentEmpty) {
      await atomicWriteText(
        this.paths.persistentRules,
        "# cno-mihomo disabled; this file is managed atomically\n",
        0o600,
      );
    }
    await atomicWriteText(
      this.paths.runtimeRules,
      "# cno-mihomo disabled\n",
      0o600,
    );
    await removeIfPresent(this.paths.ownership);
  }

  private async renderRules(config: NetworkConfig): Promise<string> {
    const cn = config.bypassCn
      ? await this.readCnCidrs()
      : { ipv4: [], ipv6: [] };
    const reserved = splitCidrs(config.reservedCidrs);
    const bypass4 = config.bypassReserved
      ? [...reserved.ipv4, ...cn.ipv4]
      : cn.ipv4;
    const bypass6 = config.bypassReserved
      ? [...reserved.ipv6, ...cn.ipv6]
      : cn.ipv6;
    const lanAcl = splitCidrs(config.lanAcl);
    const routerAcl = splitCidrs(config.routerAcl);
    const p = this.ports;
    const lines = [
      "# Generated by cno-mihomo. Manual changes are overwritten.",
      "destroy table inet cno_mihomo",
      "table inet cno_mihomo {",
      setDeclaration("bypass4", "ipv4_addr", bypass4),
      setDeclaration("bypass6", "ipv6_addr", bypass6),
      setDeclaration("lan_acl4", "ipv4_addr", lanAcl.ipv4),
      setDeclaration("lan_acl6", "ipv6_addr", lanAcl.ipv6),
      setDeclaration("router_acl4", "ipv4_addr", routerAcl.ipv4),
      setDeclaration("router_acl6", "ipv6_addr", routerAcl.ipv6),
      stringSetDeclaration("lan_interfaces", "ifname", config.lanInterfaces),
      setDeclaration("proxy_tcp_ports", "inet_service", config.tcpPorts),
      setDeclaration("proxy_udp_ports", "inet_service", config.udpPorts),
      setDeclaration("bypass_dscp", "dscp", config.bypassDscp.map(String)),
    ];

    if (config.lan.dns) {
      lines.push(
        "  chain dns_prerouting {",
        "    type nat hook prerouting priority dstnat - 5; policy accept;",
        `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
      );
      for (const expression of scopeExpressions("lan", lanAcl, config))
        lines.push(
          `    ${expression} meta l4proto { tcp, udp } th dport 53 redirect to :${p.dns}`,
        );
      lines.push("  }");
    }
    if (config.router.dns) {
      lines.push(
        "  chain dns_output {",
        "    type nat hook output priority dstnat - 5; policy accept;",
        `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
      );
      for (const expression of scopeExpressions("router", routerAcl, config))
        lines.push(
          `    ${expression} meta l4proto { tcp, udp } th dport 53 redirect to :${p.dns}`,
        );
      lines.push("  }");
    }
    if (config.tcpMode === "redirect" && config.lan.proxy) {
      lines.push(
        "  chain redirect_prerouting {",
        "    type nat hook prerouting priority dstnat; policy accept;",
        `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
      );
      addBypass(lines, config, bypass4, bypass6);
      addPolicyBypass(lines, config);
      for (const expression of scopeExpressions("lan", lanAcl, config)) {
        const fakeRange = fakeRangeForExpression(expression, config);
        if (fakeRange)
          lines.push(
            `    ${expression} meta l4proto tcp ${fakeRange} redirect to :${p.redirect}`,
          );
        lines.push(
          `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports redirect to :${p.redirect}`,
        );
      }
      lines.push("  }");
    }
    if (config.tcpMode === "redirect" && config.router.proxy) {
      lines.push(
        "  chain redirect_output {",
        "    type nat hook output priority dstnat; policy accept;",
        `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
      );
      addBypass(lines, config, bypass4, bypass6);
      addPolicyBypass(lines, config);
      for (const expression of scopeExpressions("router", routerAcl, config)) {
        const fakeRange = fakeRangeForExpression(expression, config);
        if (fakeRange)
          lines.push(
            `    ${expression} meta l4proto tcp ${fakeRange} redirect to :${p.redirect}`,
          );
        lines.push(
          `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports redirect to :${p.redirect}`,
        );
      }
      lines.push("  }");
    }
    const tproxyTcp = config.tcpMode === "tproxy";
    const tproxyUdp = config.udpMode === "tproxy";
    if ((tproxyTcp || tproxyUdp) && (config.lan.proxy || config.router.proxy)) {
      lines.push(
        "  chain tproxy_prerouting {",
        "    type filter hook prerouting priority mangle; policy accept;",
        `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
      );
      if (tproxyTcp)
        lines.push(
          `    meta mark & 0x0000ffff == ${hex(p.routeMark)} meta l4proto tcp tproxy to :${p.tproxy} accept`,
        );
      if (tproxyUdp)
        lines.push(
          `    meta mark & 0x0000ffff == ${hex(p.routeMark)} meta l4proto udp tproxy to :${p.tproxy} accept`,
        );
      addBypass(lines, config, bypass4, bypass6);
      addPolicyBypass(lines, config);
      if (config.lan.proxy)
        for (const expression of scopeExpressions("lan", lanAcl, config)) {
          const fakeRange = fakeRangeForExpression(expression, config);
          if (fakeRange && tproxyTcp)
            lines.push(
              `    ${expression} meta l4proto tcp ${fakeRange} meta mark set ${hex(p.routeMark)} tproxy to :${p.tproxy} accept`,
            );
          if (fakeRange && tproxyUdp)
            lines.push(
              `    ${expression} meta l4proto udp ${fakeRange} meta mark set ${hex(p.routeMark)} tproxy to :${p.tproxy} accept`,
            );
          if (tproxyTcp)
            lines.push(
              `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports meta mark set ${hex(p.routeMark)} tproxy to :${p.tproxy} accept`,
            );
          if (tproxyUdp)
            lines.push(
              `    ${expression} meta l4proto udp udp dport @proxy_udp_ports meta mark set ${hex(p.routeMark)} tproxy to :${p.tproxy} accept`,
            );
        }
      lines.push("  }");
      if (config.router.proxy) {
        lines.push(
          "  chain tproxy_output {",
          "    type route hook output priority mangle; policy accept;",
          `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
        );
        addBypass(lines, config, bypass4, bypass6);
        addPolicyBypass(lines, config);
        for (const expression of scopeExpressions(
          "router",
          routerAcl,
          config,
        )) {
          const fakeRange = fakeRangeForExpression(expression, config);
          if (fakeRange && tproxyTcp)
            lines.push(
              `    ${expression} meta l4proto tcp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
          if (fakeRange && tproxyUdp)
            lines.push(
              `    ${expression} meta l4proto udp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
          if (tproxyTcp)
            lines.push(
              `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports meta mark set ${hex(p.routeMark)} accept`,
            );
          if (tproxyUdp)
            lines.push(
              `    ${expression} meta l4proto udp udp dport @proxy_udp_ports meta mark set ${hex(p.routeMark)} accept`,
            );
        }
        lines.push("  }");
      }
    }
    if (isTunMode(config) && (config.lan.proxy || config.router.proxy)) {
      if (config.lan.proxy) {
        lines.push(
          "  chain tun_prerouting {",
          "    type filter hook prerouting priority mangle; policy accept;",
          `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
        );
        lines.push(`    iifname "${config.tun.device}" return`);
        addBypass(lines, config, bypass4, bypass6);
        addPolicyBypass(lines, config);
        for (const expression of scopeExpressions("lan", lanAcl, config)) {
          const fakeRange = fakeRangeForExpression(expression, config);
          if (fakeRange) {
            lines.push(
              `    ${expression} meta l4proto tcp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
            lines.push(
              `    ${expression} meta l4proto udp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
          }
          lines.push(
            `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports meta mark set ${hex(p.routeMark)} accept`,
          );
          lines.push(
            `    ${expression} meta l4proto udp udp dport @proxy_udp_ports meta mark set ${hex(p.routeMark)} accept`,
          );
        }
        lines.push("  }");
      }
      if (config.router.proxy) {
        lines.push(
          "  chain tun_output {",
          "    type route hook output priority mangle; policy accept;",
          `    meta mark & 0x0000ffff == ${hex(p.bypassMark)} return`,
        );
        addBypass(lines, config, bypass4, bypass6);
        addPolicyBypass(lines, config);
        for (const expression of scopeExpressions(
          "router",
          routerAcl,
          config,
        )) {
          const fakeRange = fakeRangeForExpression(expression, config);
          if (fakeRange) {
            lines.push(
              `    ${expression} meta l4proto tcp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
            lines.push(
              `    ${expression} meta l4proto udp ${fakeRange} meta mark set ${hex(p.routeMark)} accept`,
            );
          }
          lines.push(
            `    ${expression} meta l4proto tcp tcp dport @proxy_tcp_ports meta mark set ${hex(p.routeMark)} accept`,
          );
          lines.push(
            `    ${expression} meta l4proto udp udp dport @proxy_udp_ports meta mark set ${hex(p.routeMark)} accept`,
          );
        }
        lines.push("  }");
      }
    }
    addPingHijack(lines, config, lanAcl, routerAcl);
    lines.push("}", "");
    return lines.filter((line) => line !== "").join("\n") + "\n";
  }

  private ownedResources(config: NetworkConfig): JsonObject[] {
    const resources: JsonObject[] = [
      { kind: "nft_table", family: "inet", name: "cno_mihomo" },
    ];
    const needsPolicyRoute =
      config.tcpMode !== "redirect" || config.udpMode === "tproxy";
    const route = (family: 4 | 6): JsonObject =>
      isTunMode(config)
        ? {
            kind: "ip_route",
            family,
            table: this.ports.routeTable,
            mode: "tun",
            device: config.tun.device,
          }
        : {
            kind: "ip_route",
            family,
            table: this.ports.routeTable,
            mode: "local",
            device: "lo",
          };
    if (needsPolicyRoute && config.ipv4)
      resources.push(
        {
          kind: "ip_rule",
          family: 4,
          priority: this.ports.ipv4RulePriority,
          mark: this.ports.routeMark,
          table: this.ports.routeTable,
        },
        route(4),
      );
    if (needsPolicyRoute && config.ipv6)
      resources.push(
        {
          kind: "ip_rule",
          family: 6,
          priority: this.ports.ipv6RulePriority,
          mark: this.ports.routeMark,
          table: this.ports.routeTable,
        },
        route(6),
      );
    return resources;
  }

  private async installPolicyRouting(
    config: NetworkConfig,
    previous: JsonObject[],
  ): Promise<void> {
    if (config.tcpMode === "redirect" && config.udpMode !== "tproxy") return;
    const p = this.ports;
    if (config.ipv4) {
      await this.installRoute(4, config, previous);
      if (
        !hasResource(previous, {
          kind: "ip_rule",
          family: 4,
          priority: p.ipv4RulePriority,
          mark: p.routeMark,
          table: p.routeTable,
        })
      )
        await this.requireIpSuccess([
          "-4",
          "rule",
          "add",
          "pref",
          String(p.ipv4RulePriority),
          "fwmark",
          `${hex(p.routeMark)}/0xffff`,
          "lookup",
          String(p.routeTable),
        ]);
    }
    if (config.ipv6) {
      await this.installRoute(6, config, previous);
      if (
        !hasResource(previous, {
          kind: "ip_rule",
          family: 6,
          priority: p.ipv6RulePriority,
          mark: p.routeMark,
          table: p.routeTable,
        })
      )
        await this.requireIpSuccess([
          "-6",
          "rule",
          "add",
          "pref",
          String(p.ipv6RulePriority),
          "fwmark",
          `${hex(p.routeMark)}/0xffff`,
          "lookup",
          String(p.routeTable),
        ]);
    }
  }

  private async installRoute(
    family: 4 | 6,
    config: NetworkConfig,
    previous: JsonObject[],
  ): Promise<void> {
    const desired = this.ownedResources(config).find(
      (resource) => resource.kind === "ip_route" && resource.family === family,
    );
    if (!desired || hasResource(previous, desired)) return;
    const prior = previous.find(
      (resource) =>
        resource.kind === "ip_route" &&
        resource.family === family &&
        resource.table === this.ports.routeTable,
    );
    if (prior) await this.removeKernelResources([prior], false);
    const prefix = family === 6 ? "-6" : "-4";
    const args = isTunMode(config)
      ? [
          prefix,
          "route",
          "add",
          "default",
          "dev",
          config.tun.device,
          "table",
          String(this.ports.routeTable),
        ]
      : [
          prefix,
          "route",
          "add",
          "local",
          "default",
          "dev",
          "lo",
          "table",
          String(this.ports.routeTable),
        ];
    await this.requireIpSuccess(args);
  }

  private async waitForTunDevice(device: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError = "";
    while (Date.now() < deadline) {
      const result = await runCommand(
        this.paths.ip,
        ["link", "show", "dev", device],
        { timeoutMs: 2_000 },
      );
      if (result.success && /(?:^|[<,])UP(?:[,>]|$)/m.test(result.stdout))
        return;
      lastError = result.stderr.trim() || `TUN device ${device} is not UP`;
      await delay(150);
    }
    throw new ControlError(
      "tun_device_unavailable",
      `${lastError || `TUN device ${device} is unavailable`}; reapply a profile with TUN enabled`,
    );
  }

  private async checkPolicyCollisions(
    resources: JsonObject[],
    previous: JsonObject[],
  ): Promise<void> {
    for (const resource of resources) {
      if (
        hasResource(previous, resource) ||
        (resource.kind !== "ip_rule" && resource.kind !== "ip_route")
      )
        continue;
      const family = resource.family === 6 ? "-6" : "-4";
      if (resource.kind === "ip_rule") {
        const priority = String(resource.priority);
        const atPriority = await runCommand(
          this.paths.ip,
          [family, "rule", "show", "pref", priority],
          { timeoutMs: 5_000 },
        );
        if (!atPriority.success)
          throw new ControlError(
            "network_collision_check_failed",
            atPriority.stderr.trim() || "Cannot inspect policy rules",
          );
        const allRules = await runCommand(
          this.paths.ip,
          [family, "rule", "show"],
          { timeoutMs: 5_000 },
        );
        if (!allRules.success)
          throw new ControlError(
            "network_collision_check_failed",
            allRules.stderr.trim() || "Cannot inspect policy marks",
          );
        const mark =
          Number(resource.mark).toString(16).replace(/^0+/, "") || "0";
        if (
          atPriority.stdout.trim() ||
          new RegExp(`fwmark\\s+(?:0x)?0*${mark}(?:/|\\s)`, "i").test(
            allRules.stdout,
          )
        ) {
          throw new ControlError(
            "network_resource_conflict",
            `Policy rule priority ${priority} or mark ${hex(Number(resource.mark))} is already in use`,
          );
        }
      } else if (resource.kind === "ip_route") {
        if (
          previous.some(
            (item) =>
              item.kind === "ip_route" &&
              item.family === resource.family &&
              item.table === resource.table,
          )
        )
          continue;
        const routes = await runCommand(
          this.paths.ip,
          [family, "route", "show", "table", String(resource.table)],
          { timeoutMs: 5_000 },
        );
        if (!routes.success)
          throw new ControlError(
            "network_collision_check_failed",
            routes.stderr.trim() || "Cannot inspect policy route table",
          );
        if (routes.stdout.trim())
          throw new ControlError(
            "network_resource_conflict",
            `Policy route table ${String(resource.table)} is already in use`,
          );
      }
    }
  }

  private async removeKernelResources(
    resources: JsonObject[],
    removeTable = true,
  ): Promise<void> {
    if (this.dryRun) return;
    const failures: string[] = [];
    if (removeTable && (await pathExists(this.paths.nft))) {
      try {
        const result = await runCommand(
          this.paths.nft,
          ["delete", "table", "inet", "cno_mihomo"],
          { timeoutMs: 5_000 },
        );
        if (!result.success && !missingResource(result.stderr))
          failures.push(result.stderr.trim() || "Cannot delete nft table");
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (await pathExists(this.paths.ip)) {
      for (const resource of [...resources].reverse()) {
        const family = resource.family === 6 ? "-6" : "-4";
        let args: string[] | undefined;
        if (
          resource.kind === "ip_rule" &&
          typeof resource.priority === "number" &&
          typeof resource.table === "number" &&
          typeof resource.mark === "number"
        ) {
          args = [
            family,
            "rule",
            "del",
            "pref",
            String(resource.priority),
            "fwmark",
            `${hex(resource.mark)}/0xffff`,
            "lookup",
            String(resource.table),
          ];
        } else if (
          resource.kind === "ip_route" &&
          typeof resource.table === "number"
        ) {
          const device =
            typeof resource.device === "string" ? resource.device : "lo";
          args =
            resource.mode === "tun"
              ? [
                  family,
                  "route",
                  "del",
                  "default",
                  "dev",
                  device,
                  "table",
                  String(resource.table),
                ]
              : [
                  family,
                  "route",
                  "del",
                  "local",
                  "default",
                  "dev",
                  "lo",
                  "table",
                  String(resource.table),
                ];
        }
        if (!args) continue;
        try {
          const result = await runCommand(this.paths.ip, args, {
            timeoutMs: 5_000,
          });
          if (!result.success && !missingResource(result.stderr))
            failures.push(
              result.stderr.trim() || `ip ${args.join(" ")} failed`,
            );
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length)
      throw new ControlError(
        "network_cleanup_failed",
        failures.slice(0, 8).join("; "),
      );
  }

  private async requireIpSuccess(args: string[]): Promise<void> {
    const result = await runCommand(this.paths.ip, args, { timeoutMs: 5_000 });
    if (!result.success)
      throw new ControlError(
        "network_apply_failed",
        result.stderr.trim() || `ip ${args.join(" ")} failed`,
      );
  }

  private requireExecutable(path: string, packageName: string): void {
    try {
      const stat = Deno.statSync(path);
      if (stat.isFile || stat.isSymlink) return;
    } catch {
      /* handled below */
    }
    throw new ControlError(
      "dependency_missing",
      `${packageName} executable is unavailable`,
    );
  }

  private async readCnCidrs(): Promise<{ ipv4: string[]; ipv6: string[] }> {
    const path =
      this.paths.root === "/"
        ? "/etc/io.cno.mihomo/cn.cidrs"
        : `${this.paths.root}/etc/io.cno.mihomo/cn.cidrs`;
    const text = await readTextIfPresent(path);
    if (text === undefined) {
      throw new ControlError(
        "network_config_invalid",
        "bypassCn requires /etc/io.cno.mihomo/cn.cidrs",
      );
    }
    const values = text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
    return splitCidrs(values);
  }

  private requiredState(): NetworkCheckpoint {
    if (!this.state)
      throw new ControlError("not_ready", "Network manager is not initialized");
    return this.state;
  }

  private assertRevision(value: unknown, current: number): void {
    const expected = optionalPositiveInteger(value, "expectedRevision");
    if (expected !== undefined && expected !== current) {
      throw new ControlError(
        "network_revision_conflict",
        "Network configuration changed",
        { expected, current },
      );
    }
  }
}

export function validateNetworkConfig(value: unknown): NetworkConfig {
  const input = record(value, "network config");
  const tcpMode = input.tcpMode ?? DEFAULT_CONFIG.tcpMode;
  const udpMode = input.udpMode ?? DEFAULT_CONFIG.udpMode;
  if (!["redirect", "tproxy", "tun"].includes(String(tcpMode)))
    throw new ControlError(
      "network_config_invalid",
      "tcpMode must be redirect, tproxy or tun",
    );
  if (!["tproxy", "tun"].includes(String(udpMode)))
    throw new ControlError(
      "network_config_invalid",
      "udpMode must be tproxy or tun",
    );
  if ((tcpMode === "tun") !== (udpMode === "tun"))
    throw new ControlError(
      "network_config_invalid",
      "TUN mode must handle both TCP and UDP",
    );
  const endpoint = (
    value: unknown,
    fallback: { proxy: boolean; dns: boolean },
  ) => {
    const item =
      value === undefined ? fallback : record(value, "network scope");
    return {
      proxy: optionalBoolean(item.proxy, fallback.proxy),
      dns: optionalBoolean(item.dns, fallback.dns),
    };
  };
  const list = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4096)
      throw new ControlError(
        "network_config_invalid",
        `${field} must be an array of CIDRs`,
      );
    const output = value.map((entry) => validateCidr(entry, field));
    return [...new Set(output)];
  };
  return {
    tcpMode: tcpMode as NetworkConfig["tcpMode"],
    udpMode: udpMode as NetworkConfig["udpMode"],
    ipv4: optionalBoolean(input.ipv4, DEFAULT_CONFIG.ipv4),
    ipv6: optionalBoolean(input.ipv6, DEFAULT_CONFIG.ipv6),
    router: endpoint(input.router, DEFAULT_CONFIG.router),
    lan: endpoint(input.lan, DEFAULT_CONFIG.lan),
    bypassReserved: optionalBoolean(
      input.bypassReserved,
      DEFAULT_CONFIG.bypassReserved,
    ),
    bypassCn: optionalBoolean(input.bypassCn, DEFAULT_CONFIG.bypassCn),
    routerAcl: list(input.routerAcl, "routerAcl"),
    lanAcl: list(input.lanAcl, "lanAcl"),
    lanInterfaces: interfaceList(input.lanInterfaces),
    tcpPorts: portList(input.tcpPorts, DEFAULT_CONFIG.tcpPorts, "tcpPorts"),
    udpPorts: portList(input.udpPorts, DEFAULT_CONFIG.udpPorts, "udpPorts"),
    bypassDscp: dscpList(input.bypassDscp),
    bypassMarks: markList(input.bypassMarks),
    reservedCidrs:
      input.reservedCidrs === undefined
        ? [...DEFAULT_CONFIG.reservedCidrs]
        : list(input.reservedCidrs, "reservedCidrs"),
    fakeIp: validateFakeIp(input.fakeIp),
    tun: validateTunConfig(input.tun),
  };
}

function cloneDefault(): NetworkConfig {
  return {
    ...DEFAULT_CONFIG,
    router: { ...DEFAULT_CONFIG.router },
    lan: { ...DEFAULT_CONFIG.lan },
    routerAcl: [],
    lanAcl: [],
    lanInterfaces: [],
    tcpPorts: [...DEFAULT_CONFIG.tcpPorts],
    udpPorts: [...DEFAULT_CONFIG.udpPorts],
    bypassDscp: [],
    bypassMarks: [],
    reservedCidrs: [...DEFAULT_CONFIG.reservedCidrs],
    fakeIp: { ...DEFAULT_CONFIG.fakeIp },
    tun: { ...DEFAULT_CONFIG.tun },
  };
}

function hasNetworkFields(input: JsonObject): boolean {
  return [
    "tcpMode",
    "udpMode",
    "ipv4",
    "ipv6",
    "router",
    "lan",
    "bypassReserved",
    "bypassCn",
    "routerAcl",
    "lanAcl",
    "lanInterfaces",
    "tcpPorts",
    "udpPorts",
    "bypassDscp",
    "bypassMarks",
    "reservedCidrs",
    "fakeIp",
    "tun",
  ].some((key) => key in input);
}

function interfaceList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128)
    throw new ControlError(
      "network_config_invalid",
      "lanInterfaces must be an array of interface names",
    );
  return [
    ...new Set(
      value.map((entry) => {
        if (
          typeof entry !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(entry)
        )
          throw new ControlError(
            "network_config_invalid",
            "lanInterfaces contains an invalid interface name",
          );
        return entry;
      }),
    ),
  ];
}

function portList(value: unknown, fallback: string[], field: string): string[] {
  const input = value === undefined ? fallback : value;
  if (!Array.isArray(input) || input.length < 1 || input.length > 256)
    throw new ControlError(
      "network_config_invalid",
      `${field} must contain 1..256 ports or port ranges`,
    );
  return [
    ...new Set(
      input.map((entry) => {
        if (typeof entry !== "string")
          throw new ControlError(
            "network_config_invalid",
            `${field} contains an invalid port range`,
          );
        const match = entry.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
        const first = Number(match?.[1]);
        const last = Number(match?.[2] ?? match?.[1]);
        if (!match || first > 65_535 || last > 65_535 || first > last)
          throw new ControlError(
            "network_config_invalid",
            `${field} contains an invalid port range`,
          );
        return first === last ? String(first) : `${first}-${last}`;
      }),
    ),
  ];
}

function dscpList(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new ControlError(
      "network_config_invalid",
      "bypassDscp must be an array of DSCP values",
    );
  return [
    ...new Set(
      value.map((entry) => {
        if (
          !Number.isSafeInteger(entry) ||
          Number(entry) < 0 ||
          Number(entry) > 63
        )
          throw new ControlError(
            "network_config_invalid",
            "bypassDscp values must be integers from 0 to 63",
          );
        return Number(entry);
      }),
    ),
  ];
}

function markList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128)
    throw new ControlError(
      "network_config_invalid",
      "bypassMarks must be an array of mark/mask values",
    );
  return [...new Set(value.map(normalizeMark))];
}

function normalizeMark(value: unknown): string {
  if (typeof value !== "string")
    throw new ControlError(
      "network_config_invalid",
      "bypassMarks contains an invalid mark/mask",
    );
  const match = value
    .trim()
    .match(/^(0x[0-9a-f]+|\d+)(?:\/(0x[0-9a-f]+|\d+))?$/i);
  if (!match)
    throw new ControlError(
      "network_config_invalid",
      "bypassMarks contains an invalid mark/mask",
    );
  const mark = uint32(match[1]!);
  const mask = uint32(match[2] ?? "0xffffffff");
  if ((mark & mask) >>> 0 !== mark)
    throw new ControlError(
      "network_config_invalid",
      "bypassMarks mark must not contain bits outside its mask",
    );
  return `0x${mark.toString(16)}/0x${mask.toString(16)}`;
}

function uint32(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
    throw new ControlError(
      "network_config_invalid",
      "bypassMarks values must fit in an unsigned 32-bit integer",
    );
  return parsed;
}

function validateFakeIp(value: unknown): NetworkConfig["fakeIp"] {
  const input =
    value === undefined
      ? DEFAULT_CONFIG.fakeIp
      : record(value, "fakeIp config");
  const output = {
    pingHijack: optionalBoolean(
      input.pingHijack,
      DEFAULT_CONFIG.fakeIp.pingHijack,
    ),
    ipv4Range: optionalFamilyCidr(input.ipv4Range, 4, "fakeIp.ipv4Range"),
    ipv6Range: optionalFamilyCidr(input.ipv6Range, 6, "fakeIp.ipv6Range"),
  };
  if (output.pingHijack && !output.ipv4Range && !output.ipv6Range)
    throw new ControlError(
      "network_config_invalid",
      "fakeIp ping hijack requires an IPv4 or IPv6 range",
    );
  return output;
}

function optionalFamilyCidr(
  value: unknown,
  family: 4 | 6,
  field: string,
): string {
  if (value === undefined || value === null || value === "") return "";
  const normalized = validateCidr(value, field);
  if ((family === 6) !== normalized.includes(":"))
    throw new ControlError(
      "network_config_invalid",
      `${field} must be an IPv${family} CIDR`,
    );
  return normalized;
}

function validateTunConfig(value: unknown): NetworkConfig["tun"] {
  const input =
    value === undefined ? DEFAULT_CONFIG.tun : record(value, "tun config");
  const device = input.device ?? DEFAULT_CONFIG.tun.device;
  const stack = input.stack ?? DEFAULT_CONFIG.tun.stack;
  const mtu = input.mtu ?? DEFAULT_CONFIG.tun.mtu;
  if (
    typeof device !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(device)
  )
    throw new ControlError(
      "network_config_invalid",
      "tun.device must be a valid interface name up to 15 characters",
    );
  if (!["system", "gvisor", "mixed"].includes(String(stack)))
    throw new ControlError(
      "network_config_invalid",
      "tun.stack must be system, gvisor or mixed",
    );
  if (!Number.isSafeInteger(mtu) || Number(mtu) < 576 || Number(mtu) > 65_535)
    throw new ControlError(
      "network_config_invalid",
      "tun.mtu must be between 576 and 65535",
    );
  return {
    device,
    stack: stack as NetworkConfig["tun"]["stack"],
    mtu: Number(mtu),
    gso: optionalBoolean(input.gso, DEFAULT_CONFIG.tun.gso),
  };
}

function isTunMode(config: NetworkConfig): boolean {
  return config.tcpMode === "tun" && config.udpMode === "tun";
}

function validateCidr(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64)
    throw new ControlError(
      "network_config_invalid",
      `${field} contains an invalid CIDR`,
    );
  const text = value.trim();
  if (text.includes(":")) {
    const match = text.match(/^([0-9A-Fa-f:]+)(?:\/(\d{1,3}))?$/);
    if (!match || !match[1]!.includes(":") || Number(match[2] ?? 128) > 128)
      throw new ControlError(
        "network_config_invalid",
        `${field} contains an invalid IPv6 CIDR`,
      );
    return `${match[1]}/${match[2] ?? "128"}`;
  }
  const match = text.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/,
  );
  if (
    !match ||
    match.slice(1, 5).some((part) => Number(part) > 255) ||
    Number(match[5] ?? 32) > 32
  ) {
    throw new ControlError(
      "network_config_invalid",
      `${field} contains an invalid IPv4 CIDR`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}.${match[4]}/${match[5] ?? "32"}`;
}

function splitCidrs(values: string[]): { ipv4: string[]; ipv6: string[] } {
  const result = { ipv4: [] as string[], ipv6: [] as string[] };
  for (const value of values)
    result[value.includes(":") ? "ipv6" : "ipv4"].push(
      validateCidr(value, "CIDR list"),
    );
  return result;
}

function setDeclaration(name: string, type: string, values: string[]): string {
  const elements = values.length ? ` elements = { ${values.join(", ")} };` : "";
  return `  set ${name} { type ${type}; flags interval; auto-merge;${elements} }`;
}

function stringSetDeclaration(
  name: string,
  type: string,
  values: string[],
): string {
  return setDeclaration(
    name,
    type,
    values.map((value) => JSON.stringify(value)),
  );
}

function addBypass(
  lines: string[],
  config: NetworkConfig,
  ipv4: string[],
  ipv6: string[],
): void {
  if (config.ipv4 && ipv4.length)
    lines.push(
      `    ip daddr @bypass4${config.fakeIp.ipv4Range ? ` ip daddr != ${config.fakeIp.ipv4Range}` : ""} return`,
    );
  if (config.ipv6 && ipv6.length)
    lines.push(
      `    ip6 daddr @bypass6${config.fakeIp.ipv6Range ? ` ip6 daddr != ${config.fakeIp.ipv6Range}` : ""} return`,
    );
}

function addPolicyBypass(lines: string[], config: NetworkConfig): void {
  if (config.bypassDscp.length) {
    if (config.ipv4)
      lines.push(
        `    meta l4proto { tcp, udp } ip dscp @bypass_dscp${config.fakeIp.ipv4Range ? ` ip daddr != ${config.fakeIp.ipv4Range}` : ""} return`,
      );
    if (config.ipv6)
      lines.push(
        `    meta l4proto { tcp, udp } ip6 dscp @bypass_dscp${config.fakeIp.ipv6Range ? ` ip6 daddr != ${config.fakeIp.ipv6Range}` : ""} return`,
      );
  }
  for (const value of config.bypassMarks) {
    const [mark, mask] = value.split("/");
    lines.push(`    meta mark & ${mask} == ${mark} return`);
  }
}

function addPingHijack(
  lines: string[],
  config: NetworkConfig,
  lanAcl: { ipv4: string[]; ipv6: string[] },
  routerAcl: { ipv4: string[]; ipv6: string[] },
): void {
  if (!config.fakeIp.pingHijack) return;
  const append = (
    scope: "lan" | "router",
    cidrs: { ipv4: string[]; ipv6: string[] },
  ) => {
    const body: string[] = [];
    for (const expression of scopeExpressions(scope, cidrs, config)) {
      if (
        expression.includes("nfproto ipv4") ||
        expression.includes("ip saddr")
      ) {
        if (config.fakeIp.ipv4Range)
          body.push(
            `    ${expression} icmp type echo-request ip daddr ${config.fakeIp.ipv4Range} redirect`,
          );
      } else if (config.fakeIp.ipv6Range)
        body.push(
          `    ${expression} icmpv6 type echo-request ip6 daddr ${config.fakeIp.ipv6Range} redirect`,
        );
    }
    if (!body.length) return;
    const hook = scope === "lan" ? "prerouting" : "output";
    lines.push(
      `  chain fake_ip_ping_${scope} {`,
      `    type nat hook ${hook} priority dstnat + 1; policy accept;`,
      ...body,
      "  }",
    );
  };
  if (config.lan.proxy) append("lan", lanAcl);
  if (config.router.proxy) append("router", routerAcl);
}

function fakeRangeForExpression(
  expression: string,
  config: NetworkConfig,
): string {
  const ipv4 =
    expression.includes("nfproto ipv4") || expression.includes("ip saddr");
  if (ipv4 && config.fakeIp.ipv4Range)
    return `ip daddr ${config.fakeIp.ipv4Range}`;
  if (!ipv4 && config.fakeIp.ipv6Range)
    return `ip6 daddr ${config.fakeIp.ipv6Range}`;
  return "";
}

function scopeExpressions(
  scope: "lan" | "router",
  cidrs: { ipv4: string[]; ipv6: string[] },
  config: NetworkConfig,
): string[] {
  const output: string[] = [];
  const inbound =
    scope === "lan" && config.lanInterfaces.length
      ? "iifname @lan_interfaces "
      : "";
  if (config.ipv4 && cidrs.ipv4.length)
    output.push(`${inbound}ip saddr @${scope}_acl4`);
  else if (config.ipv4) output.push(`${inbound}meta nfproto ipv4`);
  if (config.ipv6 && cidrs.ipv6.length)
    output.push(`${inbound}ip6 saddr @${scope}_acl6`);
  else if (config.ipv6) output.push(`${inbound}meta nfproto ipv6`);
  return output;
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function ownedResources(journal: JsonObject | undefined): JsonObject[] {
  return Array.isArray(journal?.resources)
    ? (journal.resources.filter(
        (item) => item && typeof item === "object",
      ) as JsonObject[])
    : [];
}

function resourceKey(resource: JsonObject): string {
  if (resource.kind === "nft_table")
    return `nft:${String(resource.family)}:${String(resource.name)}`;
  if (resource.kind === "ip_rule")
    return `rule:${String(resource.family)}:${String(resource.priority)}:${String(resource.mark)}:${String(resource.table)}`;
  if (resource.kind === "ip_route")
    return `route:${String(resource.family)}:${String(resource.table)}:${String(resource.mode ?? "local")}:${String(resource.device ?? "lo")}`;
  return JSON.stringify(resource);
}

function hasResource(resources: JsonObject[], candidate: JsonObject): boolean {
  const key = resourceKey(candidate);
  return resources.some((resource) => resourceKey(resource) === key);
}

function unionResources(left: JsonObject[], right: JsonObject[]): JsonObject[] {
  const output: JsonObject[] = [];
  const keys = new Set<string>();
  for (const resource of [...left, ...right]) {
    const key = resourceKey(resource);
    if (keys.has(key)) continue;
    keys.add(key);
    output.push(resource);
  }
  return output;
}

function missingResource(message: string): boolean {
  return /(?:no such file|no such process|does not exist|not found)/i.test(
    message,
  );
}
