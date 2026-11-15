import {
  atomicWriteJson,
  ControlError,
  delay,
  pathExists,
  readJsonIfPresent,
  runCommand,
  type JsonObject,
  type RuntimePaths,
} from './runtime.ts';

export interface DaemonConfig {
  dryRun: boolean;
  controllerUrl: string;
  controllerSecret?: string;
  requireControllerHealth: boolean;
  healthTimeoutMs: number;
  shutdownTimeoutMs: number;
  restartDelayMs: number;
}

interface StoredService {
  enabled: boolean;
  dryRunRunning?: boolean;
  updatedAt: number;
  lastError?: string;
}

interface ProcdState {
  running: boolean;
  pid?: number;
}

export class ServiceManager {
  private stored: StoredService | undefined;
  private controllerReachable = false;
  private controllerVersion: string | undefined;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly config: DaemonConfig,
  ) {}

  async initialize(): Promise<void> {
    this.stored = await readJsonIfPresent<StoredService>(this.paths.service) ?? {
      enabled: false,
      dryRunRunning: false,
      updatedAt: Date.now(),
    };
    if (this.config.dryRun && this.stored.dryRunRunning) {
      this.controllerReachable = true;
      this.controllerVersion = 'dry-run';
    }
  }

  async status(): Promise<JsonObject> {
    const procd = await this.procdState();
    return {
      enabled: this.requiredStored().enabled,
      state: procd.running ? 'running' : this.requiredStored().lastError ? 'failed' : 'stopped',
      ...(procd.pid !== undefined ? { pid: procd.pid } : {}),
      ...(this.requiredStored().lastError ? { lastError: this.requiredStored().lastError } : {}),
    };
  }

  controllerStatus(): JsonObject {
    return {
      reachable: this.controllerReachable,
      ...(this.controllerVersion ? { version: this.controllerVersion } : {}),
    };
  }

  async start(): Promise<JsonObject> {
    await this.requireActiveConfig();
    await this.initAction('enable');
    await this.initAction('start');
    await this.updateStored({ enabled: true, dryRunRunning: true, lastError: undefined });
    await this.waitForHealthyService();
    return { service: await this.status(), controller: this.controllerStatus() };
  }

  async reload(): Promise<JsonObject> {
    await this.requireActiveConfig();
    const state = await this.procdState();
    await this.initAction(state.running ? 'reload' : 'start');
    await this.updateStored({ enabled: true, dryRunRunning: true, lastError: undefined });
    await this.waitForHealthyService();
    return { service: await this.status(), controller: this.controllerStatus() };
  }

  async restart(): Promise<JsonObject> {
    await this.requireActiveConfig();
    await this.initAction('restart');
    await this.updateStored({ enabled: true, dryRunRunning: true, lastError: undefined });
    await this.waitForHealthyService();
    return { service: await this.status(), controller: this.controllerStatus() };
  }

  async restartGeneration(): Promise<JsonObject> {
    return await this.restart();
  }

  async stop(): Promise<JsonObject> {
    await this.initAction('stop');
    await this.initAction('disable');
    await this.updateStored({ enabled: false, dryRunRunning: false, lastError: undefined });
    this.controllerReachable = false;
    this.controllerVersion = undefined;
    return { service: await this.status(), controller: this.controllerStatus() };
  }

  async stopForRollback(disable = false): Promise<void> {
    await this.initAction('stop');
    if (disable) await this.initAction('disable');
    await this.updateStored({
      ...(disable ? { enabled: false } : {}),
      dryRunRunning: false,
      lastError: undefined,
    });
    this.controllerReachable = false;
    this.controllerVersion = undefined;
  }

  async shutdown(): Promise<void> {
    // Intentionally do nothing. This daemon and Mihomo are independent procd
    // services; management reload/exit must not interrupt a healthy data plane.
  }

  private async initAction(action: 'enable' | 'disable' | 'start' | 'stop' | 'reload' | 'restart'): Promise<void> {
    if (this.config.dryRun) return;
    if (!await pathExists(this.paths.coreInit)) throw new ControlError('dependency_missing', 'cno-mihomo-core procd service is unavailable');
    const timeoutMs = action === 'stop' || action === 'restart'
      ? this.config.shutdownTimeoutMs + 10_000
      : 30_000;
    const result = await runCommand(this.paths.coreInit, [action], { timeoutMs });
    if (!result.success) throw new ControlError('service_action_failed', result.stderr.trim() || result.stdout.trim() || `procd ${action} failed`);
  }

  private async procdState(): Promise<ProcdState> {
    if (this.config.dryRun) return {
      running: this.requiredStored().dryRunRunning === true,
      ...(this.requiredStored().dryRunRunning ? { pid: 4242 } : {}),
    };
    if (!await pathExists(this.paths.ubus)) throw new ControlError('dependency_missing', 'ubus is unavailable');
    const result = await runCommand(this.paths.ubus, ['call', 'service', 'list', '{"name":"cno-mihomo-core"}'], { timeoutMs: 5_000 });
    if (!result.success) throw new ControlError('service_status_failed', result.stderr.trim() || 'Cannot query procd service state');
    let payload: JsonObject;
    try { payload = JSON.parse(result.stdout) as JsonObject; } catch { throw new ControlError('service_status_failed', 'ubus returned invalid JSON'); }
    const service = payload['cno-mihomo-core'];
    if (!service || typeof service !== 'object') return { running: false };
    const instances = (service as JsonObject).instances;
    if (!instances || typeof instances !== 'object') return { running: false };
    for (const instance of Object.values(instances as JsonObject)) {
      if (!instance || typeof instance !== 'object') continue;
      const value = instance as JsonObject;
      if (value.running === true) return {
        running: true,
        ...(Number.isSafeInteger(value.pid) ? { pid: value.pid as number } : {}),
      };
    }
    return { running: false };
  }

  private async waitForHealthyService(): Promise<void> {
    const deadline = Date.now() + this.config.healthTimeoutMs;
    let lastError = 'Mihomo did not become ready';
    while (Date.now() < deadline) {
      const procd = await this.procdState();
      if (!procd.running) {
        lastError = 'procd reports that Mihomo is not running';
        await delay(150);
        continue;
      }
      if (!this.config.requireControllerHealth || this.config.dryRun) {
        this.controllerReachable = this.config.dryRun;
        this.controllerVersion = this.config.dryRun ? 'dry-run' : undefined;
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(2_000, Math.max(100, deadline - Date.now())));
      try {
        const url = new URL('/version', normalizedControllerUrl(this.config.controllerUrl));
        const response = await fetch(url, {
          headers: this.config.controllerSecret ? { Authorization: `Bearer ${this.config.controllerSecret}` } : {},
          signal: controller.signal,
          redirect: 'error',
        });
        if (response.ok) {
          const value = await response.json().catch(() => ({})) as JsonObject;
          this.controllerReachable = true;
          this.controllerVersion = typeof value.version === 'string' ? value.version : undefined;
          return;
        }
        lastError = `Controller returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      } finally {
        clearTimeout(timer);
      }
      await delay(150);
    }
    this.controllerReachable = false;
    this.controllerVersion = undefined;
    await this.updateStored({ lastError });
    throw new ControlError('controller_unhealthy', lastError);
  }

  private async requireActiveConfig(): Promise<void> {
    if (!await pathExists(this.paths.activeConfig)) throw new ControlError('no_active_generation', 'No active Mihomo generation is available');
  }

  private requiredStored(): StoredService {
    if (!this.stored) throw new ControlError('not_ready', 'Service manager is not initialized');
    return this.stored;
  }

  private async updateStored(patch: Partial<StoredService>): Promise<void> {
    this.stored = { ...this.requiredStored(), ...patch, updatedAt: Date.now() };
    if (patch.lastError === undefined) delete this.stored.lastError;
    await atomicWriteJson(this.paths.service, this.stored);
  }
}

function normalizedControllerUrl(raw: string): URL {
  let value: URL;
  try { value = new URL(raw); } catch { throw new ControlError('config_invalid', 'controllerUrl is invalid'); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.hash) {
    throw new ControlError('config_invalid', 'controllerUrl must be HTTP(S) without credentials or fragment');
  }
  value.pathname = value.pathname.replace(/\/+$/, '') || '/';
  return value;
}
