import { ApiError } from "../api-error.js";

/** @typedef {{enabled: boolean, time: string, days: number[]}} RestartSchedule */

export const DEFAULT_RESTART_SCHEDULE = Object.freeze({
  enabled: false,
  time: "03:00",
  days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
});

/**
 * Validate and canonicalize the device-local restart schedule.
 * @param {unknown} value
 * @returns {RestartSchedule}
 */
export function normalizeRestartSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidSchedule("schedule must be an object");
  const input = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(input);
  if (
    keys.some((key) => !["enabled", "time", "days"].includes(key)) ||
    keys.length !== 3
  )
    throw invalidSchedule("schedule must contain enabled, time and days only");
  if (typeof input.enabled !== "boolean")
    throw invalidSchedule("enabled must be a boolean");
  if (
    typeof input.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
  )
    throw invalidSchedule("time must use 24-hour HH:MM format");
  if (
    !Array.isArray(input.days) ||
    input.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw invalidSchedule(
      "days must contain weekday integers from 0 through 6",
    );
  const days = [...new Set(input.days)].sort((left, right) => left - right);
  if (input.enabled && days.length === 0)
    throw invalidSchedule(
      "an enabled schedule must select at least one weekday",
    );
  return { enabled: input.enabled, time: input.time, days };
}

/**
 * Find the first matching local wall-clock time strictly after `now`.
 * @param {RestartSchedule} schedule
 * @param {number} now
 * @returns {number | null}
 */
export function nextRestartAt(schedule, now) {
  if (!schedule.enabled || schedule.days.length === 0) return null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const selected = new Set(schedule.days);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() > now && selected.has(candidate.getDay()))
      return candidate.getTime();
  }
  return null;
}

/** A single-timer scheduler for recurring Mihomo service restarts. */
export class RestartScheduler {
  /**
   * @param {{
   *   profiles: import('../profiles.js').Repository,
   *   operations: import('../operations.js').OperationStore,
   *   control: {invoke(action: string, input: unknown, signal: unknown): Promise<unknown>},
   *   now?: () => number,
   *   setTimer?: (callback: () => void, delay: number) => unknown,
   *   clearTimer?: (timer: unknown) => void,
   * }} services
   */
  constructor({
    profiles,
    operations,
    control,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.profiles = profiles;
    this.operations = operations;
    this.control = control;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.closed = false;
  }

  start() {
    this.reschedule();
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  schedule() {
    const stored = this.profiles.setting(
      "service.schedule",
      DEFAULT_RESTART_SCHEDULE,
    );
    return {
      revision: stored.revision,
      config: normalizeRestartSchedule(stored.config),
    };
  }

  reschedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.closed) return;
    const dueAt = nextRestartAt(this.schedule().config, this.now());
    if (dueAt === null) return;
    const delay = Math.max(0, Math.min(dueAt - this.now(), 2_147_000_000));
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#run();
    }, delay);
  }

  async #run() {
    if (this.closed) return;
    try {
      await this.operations.run("service.scheduled-restart", () =>
        this.control.invoke("service.restart", {}, SCHEDULER_SIGNAL),
      );
    } finally {
      this.reschedule();
    }
  }
}

const SCHEDULER_SIGNAL = Object.freeze({
  aborted: false,
  addEventListener() {},
  removeEventListener() {},
});

function invalidSchedule(message) {
  return new ApiError(400, "invalid_restart_schedule", message);
}
