const RESERVED_CIDRS = Object.freeze([
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
]);

/** One authoritative default for package compilation and network APIs. */
export function defaultNetworkConfig() {
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

/**
 * Fill fields added by newer releases and reject invalid policy before it is
 * persisted. The companion validates the same contract again at the privilege
 * boundary; this copy keeps API errors synchronous and actionable.
 */
export function normalizeNetworkConfig(value) {
  const defaults = defaultNetworkConfig();
  const input = mapping(value ?? {}, "network config");
  const tcpMode = input.tcpMode ?? defaults.tcpMode;
  const udpMode = input.udpMode ?? defaults.udpMode;
  if (!["redirect", "tproxy", "tun"].includes(tcpMode))
    throw new Error("tcpMode must be redirect, tproxy or tun");
  if (!["tproxy", "tun"].includes(udpMode))
    throw new Error("udpMode must be tproxy or tun");
  if ((tcpMode === "tun") !== (udpMode === "tun"))
    throw new Error("TUN mode must handle both TCP and UDP");
  const scope = (value, fallback, field) => {
    const item = mapping(value ?? fallback, field);
    return {
      proxy: boolean(item.proxy, fallback.proxy, `${field}.proxy`),
      dns: boolean(item.dns, fallback.dns, `${field}.dns`),
    };
  };
  const tun = mapping(input.tun ?? defaults.tun, "tun");
  const fakeIp = mapping(input.fakeIp ?? defaults.fakeIp, "fakeIp");
  const device = tun.device ?? defaults.tun.device;
  const stack = tun.stack ?? defaults.tun.stack;
  const mtu = tun.mtu ?? defaults.tun.mtu;
  if (
    typeof device !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(device)
  )
    throw new Error(
      "tun.device must be a valid interface name up to 15 characters",
    );
  if (!["system", "gvisor", "mixed"].includes(stack))
    throw new Error("tun.stack must be system, gvisor or mixed");
  if (!Number.isSafeInteger(mtu) || mtu < 576 || mtu > 65_535)
    throw new Error("tun.mtu must be between 576 and 65535");
  const output = {
    tcpMode,
    udpMode,
    ipv4: boolean(input.ipv4, defaults.ipv4, "ipv4"),
    ipv6: boolean(input.ipv6, defaults.ipv6, "ipv6"),
    router: scope(input.router, defaults.router, "router"),
    lan: scope(input.lan, defaults.lan, "lan"),
    bypassReserved: boolean(
      input.bypassReserved,
      defaults.bypassReserved,
      "bypassReserved",
    ),
    bypassCn: boolean(input.bypassCn, defaults.bypassCn, "bypassCn"),
    routerAcl: cidrList(input.routerAcl, "routerAcl"),
    lanAcl: cidrList(input.lanAcl, "lanAcl"),
    lanInterfaces: interfaceList(input.lanInterfaces),
    tcpPorts: portList(input.tcpPorts, defaults.tcpPorts, "tcpPorts"),
    udpPorts: portList(input.udpPorts, defaults.udpPorts, "udpPorts"),
    bypassDscp: dscpList(input.bypassDscp),
    bypassMarks: markList(input.bypassMarks),
    reservedCidrs:
      input.reservedCidrs === undefined
        ? [...defaults.reservedCidrs]
        : cidrList(input.reservedCidrs, "reservedCidrs"),
    fakeIp: {
      pingHijack: boolean(
        fakeIp.pingHijack,
        defaults.fakeIp.pingHijack,
        "fakeIp.pingHijack",
      ),
      ipv4Range: optionalCidr(fakeIp.ipv4Range, 4, "fakeIp.ipv4Range"),
      ipv6Range: optionalCidr(fakeIp.ipv6Range, 6, "fakeIp.ipv6Range"),
    },
    tun: {
      device,
      stack,
      mtu,
      gso: boolean(tun.gso, defaults.tun.gso, "tun.gso"),
    },
  };
  if (
    output.fakeIp.pingHijack &&
    !output.fakeIp.ipv4Range &&
    !output.fakeIp.ipv6Range
  )
    throw new Error("fakeIp ping hijack requires an IPv4 or IPv6 range");
  return output;
}

function mapping(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value;
}

function boolean(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function cidrList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error(`${field} must be an array of CIDRs`);
  return [...new Set(value.map((item) => cidr(item, field)))];
}

function interfaceList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("lanInterfaces must be an array of interface names");
  return [
    ...new Set(
      value.map((item) => {
        if (
          typeof item !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(item)
        )
          throw new Error("lanInterfaces contains an invalid interface name");
        return item;
      }),
    ),
  ];
}

function portList(value, fallback, field) {
  const input = value === undefined ? fallback : value;
  if (!Array.isArray(input) || input.length < 1 || input.length > 256)
    throw new Error(`${field} must contain 1..256 ports or port ranges`);
  return [
    ...new Set(
      input.map((item) => {
        if (typeof item !== "string")
          throw new Error(`${field} contains an invalid port range`);
        const match = item.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
        const first = Number(match?.[1]);
        const last = Number(match?.[2] ?? match?.[1]);
        if (!match || first > 65_535 || last > 65_535 || first > last)
          throw new Error(`${field} contains an invalid port range`);
        return first === last ? String(first) : `${first}-${last}`;
      }),
    ),
  ];
}

function dscpList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("bypassDscp must be an array of DSCP values");
  return [
    ...new Set(
      value.map((item) => {
        if (!Number.isSafeInteger(item) || item < 0 || item > 63)
          throw new Error("bypassDscp values must be integers from 0 to 63");
        return item;
      }),
    ),
  ];
}

function markList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128)
    throw new Error("bypassMarks must be an array of mark/mask values");
  return [...new Set(value.map((item) => normalizeMark(item)))];
}

function normalizeMark(value) {
  if (typeof value !== "string")
    throw new Error("bypassMarks contains an invalid mark/mask");
  const match = value
    .trim()
    .match(/^(0x[0-9a-f]+|\d+)(?:\/(0x[0-9a-f]+|\d+))?$/i);
  if (!match) throw new Error("bypassMarks contains an invalid mark/mask");
  const mark = numeric32(match[1]);
  const mask = numeric32(match[2] ?? "0xffffffff");
  if ((mark & mask) >>> 0 !== mark)
    throw new Error("bypassMarks mark must not contain bits outside its mask");
  return `0x${mark.toString(16)}/0x${mask.toString(16)}`;
}

function numeric32(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
    throw new Error(
      "bypassMarks values must fit in an unsigned 32-bit integer",
    );
  return parsed;
}

function optionalCidr(value, family, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = cidr(value, field);
  if ((family === 6) !== normalized.includes(":"))
    throw new Error(`${field} must be an IPv${family} CIDR`);
  return normalized;
}

function cidr(value, field) {
  if (typeof value !== "string" || value.length > 64)
    throw new Error(`${field} contains an invalid CIDR`);
  const text = value.trim();
  if (text.includes(":")) {
    const match = text.match(/^([0-9A-Fa-f:]+)(?:\/(\d{1,3}))?$/);
    if (!match || !match[1].includes(":") || Number(match[2] ?? 128) > 128)
      throw new Error(`${field} contains an invalid IPv6 CIDR`);
    return `${match[1]}/${match[2] ?? "128"}`;
  }
  const match = text.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/,
  );
  if (
    !match ||
    match.slice(1, 5).some((part) => Number(part) > 255) ||
    Number(match[5] ?? 32) > 32
  )
    throw new Error(`${field} contains an invalid IPv4 CIDR`);
  return `${match[1]}.${match[2]}.${match[3]}.${match[4]}/${match[5] ?? "32"}`;
}
