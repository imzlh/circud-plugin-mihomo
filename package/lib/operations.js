/**
 * @typedef {"running" | "succeeded" | "failed"} OperationState
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   state: OperationState,
 *   startedAt: number,
 *   finishedAt: number | null,
 *   result: unknown,
 *   error: string | null,
 * }} OperationSnapshot
 * @typedef {{type: string, timestamp: number, data: unknown}} ManagerEvent
 */

export class OperationStore {
  /**
   * @param {{now?: () => number, maxEntries?: number}} [options]
   */
  constructor({ now = () => Date.now(), maxEntries = 64 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.nextId = 1;
    this.items = [];
    this.listeners = new Set();
  }
  /** @returns {OperationSnapshot[]} */
  list() {
    return this.items.map(clone);
  }
  /** @param {string} id @returns {OperationSnapshot | null} */
  get(id) {
    const item = this.items.find((value) => value.id === String(id));
    return item ? clone(item) : null;
  }
  /** @param {(event: ManagerEvent) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * @param {string} kind
   * @param {() => unknown | Promise<unknown>} task
   * @returns {{operationId: string}}
   */
  start(kind, task) {
    return this.#launch(kind, task).accepted;
  }
  /**
   * @param {string} kind
   * @param {() => unknown | Promise<unknown>} task
   * @returns {Promise<OperationSnapshot>}
   */
  async run(kind, task) {
    const launched = this.#launch(kind, task);
    await launched.completion;
    return clone(launched.operation);
  }
  #launch(kind, task) {
    const operation = {
      id: String(this.nextId++),
      kind,
      state: "running",
      startedAt: this.now(),
      finishedAt: null,
      result: null,
      error: null,
    };
    this.items.unshift(operation);
    if (this.items.length > this.maxEntries)
      this.items.length = this.maxEntries;
    this.#emit("operation.started", operation);
    const completion = Promise.resolve()
      .then(task)
      .then(
        (result) => {
          operation.result = safe(result);
          operation.state = "succeeded";
        },
        (error) => {
          operation.state = "failed";
          operation.error =
            error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        operation.finishedAt = this.now();
        this.#emit("operation.finished", operation);
      });
    return {
      accepted: { operationId: operation.id },
      completion,
      operation,
    };
  }
  emit(type, data) {
    this.#emit(type, data);
  }
  #emit(type, data) {
    const event = { type, timestamp: this.now(), data: safe(data) };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (_) {}
    }
  }
}
function clone(value) {
  return { ...value, result: safe(value.result) };
}
function safe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}
