import {
  COMPILER_PROTOCOL,
  SCRIPT_RUNNER_PROTOCOL,
  compileProfile,
} from "./profile-compiler.js";
import {
  defaultNetworkConfig,
  normalizeNetworkConfig,
} from "./network-config.js";

const DISABLED_GLOBAL = Object.freeze({
  version: 1,
  merge: Object.freeze({ enabled: false, content: "{}\n" }),
  script: Object.freeze({
    enabled: false,
    content: "function main(config, profileName) { return config; }\n",
  }),
});

export function defaultGlobalEnhancement() {
  return {
    version: 1,
    merge: { ...DISABLED_GLOBAL.merge },
    script: { ...DISABLED_GLOBAL.script },
  };
}

export class ProfileCompiler {
  constructor({ control, profiles, config, sha256 }) {
    this.control = control;
    this.profiles = profiles;
    this.config = config;
    this.sha256 = sha256;
  }

  async compile(
    profile,
    signal,
    network = normalizeNetworkConfig(
      this.profiles.setting("network", defaultNetworkConfig()).config,
    ),
  ) {
    const global = this.profiles.setting(
      "enhancement.global",
      defaultGlobalEnhancement(),
    ).config;
    const request = {
      protocol: COMPILER_PROTOCOL,
      profileName: profile.name,
      sourceYaml: profile.content,
      pipeline: pipeline(
        global,
        this.profiles.profileMixins?.(profile) ?? [],
        profile.enhancement,
        network,
      ),
    };
    const result = await compileProfile(request, {
      signal,
      sha256: this.sha256,
      runner: {
        run: async (input, options = {}) => {
          const value = await this.control.invoke(
            "script.run",
            {
              source: input.script,
              profileName: input.profileName,
              configJson: input.config,
            },
            options.signal ?? signal,
          );
          return {
            protocol: SCRIPT_RUNNER_PROTOCOL,
            requestId: input.requestId,
            ok: true,
            config: value.configJson,
            logs: Array.isArray(value.logs) ? value.logs : [],
          };
        },
      },
    });
    if (!result.ok) {
      const error = new Error(result.message);
      error.code = result.code.toLowerCase();
      error.details = {
        ...(result.stage ? { stage: result.stage } : {}),
        logs: result.logs,
        stages: result.stages,
      };
      throw error;
    }
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      compilerRevision: result.revision,
      contentHash: result.contentHash,
      content: result.content,
      logs: result.logs,
      stages: result.stages,
    };
  }

  async apply(profile, options, signal) {
    const network = normalizeNetworkConfig(
      this.profiles.setting("network", defaultNetworkConfig()).config,
    );
    const preview = await this.compile(profile, signal, network);
    const finalized = await compileProfile(
      {
        protocol: COMPILER_PROTOCOL,
        profileName: profile.name,
        sourceYaml: preview.content,
        pipeline: [
          {
            id: "manager-secret",
            kind: "merge",
            yaml: JSON.stringify({ secret: this.config.value.secret }),
          },
        ],
      },
      { signal, sha256: this.sha256 },
    );
    if (!finalized.ok) throw new Error(finalized.message);
    const result = await this.control.invoke(
      "profile.apply",
      {
        profile: {
          id: profile.id,
          revision: profile.revision,
          name: profile.name,
          content: finalized.content,
        },
        compilerRevision: finalized.revision,
        contentHash: finalized.contentHash,
        options,
        networkConfig: network,
      },
      signal,
    );
    return { ...result, preview };
  }
}

function pipeline(global, mixins, profile, network) {
  const stages = [];
  addSequence(stages, "rules", profile?.rules);
  addSequence(stages, "proxies", profile?.proxies);
  addSequence(stages, "groups", profile?.groups);
  addMerge(stages, "global-merge", global?.merge);
  addScript(stages, "global-script", global?.script);
  mixins.forEach((mixin, index) => addMixin(stages, mixin, index));
  addMerge(stages, "profile-merge", profile?.merge);
  addScript(stages, "profile-script", profile?.script);
  const tunMode = network?.tcpMode === "tun" && network?.udpMode === "tun";
  const tun = network?.tun ?? {};
  const fakeIp = network?.fakeIp ?? {};
  stages.push({
    id: "manager-runtime",
    kind: "merge",
    yaml: JSON.stringify({
      "external-controller": "127.0.0.1:9090",
      "redir-port": 7892,
      "tproxy-port": 7893,
      "routing-mark": 355,
      dns: {
        listen: "0.0.0.0:1053",
        ...(fakeIp.ipv4Range ? { "fake-ip-range": fakeIp.ipv4Range } : {}),
        ...(fakeIp.ipv6Range ? { "fake-ip-range6": fakeIp.ipv6Range } : {}),
      },
      tun: {
        enable: tunMode,
        ...(tunMode
          ? {
              device: tun.device ?? "mihomo",
              stack: tun.stack ?? "mixed",
              mtu: tun.mtu ?? 9000,
              gso: tun.gso !== false,
            }
          : {}),
        "auto-route": false,
        "auto-redirect": false,
        "auto-detect-interface": false,
        "disable-icmp-forwarding": true,
      },
      // The real device-only secret replaces this during apply and is never
      // returned by preview or operation snapshots.
      secret: "",
    }),
  });
  return stages;
}

function addMixin(stages, mixin, index) {
  const id = `mixin-${index + 1}-${mixin.id}`;
  if (mixin.kind === "seq") {
    stages.push({ id, kind: "seq", target: mixin.target, yaml: mixin.content });
    return;
  }
  if (mixin.kind === "merge") {
    stages.push({ id, kind: "merge", yaml: mixin.content });
    return;
  }
  if (mixin.kind === "script")
    stages.push({ id, kind: "script", script: mixin.content });
}

function addSequence(stages, target, source) {
  if (enabled(source))
    stages.push({ id: target, kind: "seq", target, yaml: source.content });
}

function addMerge(stages, id, source) {
  if (enabled(source)) stages.push({ id, kind: "merge", yaml: source.content });
}

function addScript(stages, id, source) {
  if (enabled(source))
    stages.push({ id, kind: "script", script: source.content });
}

function enabled(source) {
  return source?.enabled === true && typeof source.content === "string";
}
