import { failure, methodNotAllowed } from "./envelope.js";

/** A handler may return this after taking ownership of the response itself. */
export const RESPONSE_HANDLED = Symbol("response-handled");

/**
 * Small, runtime-independent HTTP route table. Static segments outrank named
 * parameters, so `/profiles/reorder` can never be consumed as `:id`.
 */
export class RouteTable {
  /** @param {{onError: (error: unknown) => unknown, notFound?: () => unknown}} options */
  constructor({ onError, notFound = defaultNotFound }) {
    this.onError = onError;
    this.notFound = notFound;
    this.routes = [];
    this.sequence = 0;
  }

  /**
   * @param {string | string[]} methods
   * @param {string} template
   * @param {(event: any, params: Record<string, string>) => unknown} handler
   */
  on(methods, template, handler) {
    const normalized = Array.isArray(methods) ? methods : [methods];
    if (!normalized.length || normalized.some((method) => !/^[A-Z]+$/.test(method)))
      throw new TypeError("route methods must be uppercase HTTP methods");
    if (typeof handler !== "function") throw new TypeError("route handler is required");
    const compiled = compileTemplate(template);
    this.routes.push({
      ...compiled,
      methods: new Set(normalized),
      handler,
      sequence: this.sequence++,
    });
    return this;
  }

  /** @param {any} event @param {string} path */
  handle(event, path) {
    let candidates;
    try {
      candidates = this.routes
        .map((route) => ({ route, params: matchRoute(route, path) }))
        .filter((candidate) => candidate.params !== null);
    } catch (error) {
      event.respondWith(this.onError(error));
      return;
    }
    if (!candidates.length) {
      event.respondWith(this.notFound());
      return;
    }

    const bestScore = Math.max(...candidates.map(({ route }) => route.score));
    const best = candidates.filter(({ route }) => route.score === bestScore);
    const selected = best
      .filter(({ route }) => route.methods.has(event.method))
      .sort((left, right) => left.route.sequence - right.route.sequence)[0];
    if (!selected) {
      const allowed = [...new Set(best.flatMap(({ route }) => [...route.methods]))].sort();
      event.respondWith(methodNotAllowed(allowed));
      return;
    }

    try {
      const response = selected.route.handler(event, selected.params);
      if (response === RESPONSE_HANDLED) return;
      if (response && typeof response.then === "function")
        event.respondWith(response.catch(this.onError));
      else event.respondWith(response);
    } catch (error) {
      event.respondWith(this.onError(error));
    }
  }
}

function compileTemplate(template) {
  if (typeof template !== "string" || !template.startsWith("/"))
    throw new TypeError("route template must start with /");
  const raw = segments(template);
  const names = new Set();
  const parts = raw.map((segment) => {
    if (!segment.startsWith(":")) return { literal: segment };
    const name = segment.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name))
      throw new TypeError(`invalid route parameter: ${segment}`);
    names.add(name);
    return { name };
  });
  return {
    template,
    parts,
    score: parts.length * 100 + parts.filter((part) => "literal" in part).length,
  };
}

function matchRoute(route, path) {
  const input = segments(path);
  if (input.length !== route.parts.length) return null;
  const params = Object.create(null);
  for (let index = 0; index < route.parts.length; index++) {
    const expected = route.parts[index];
    const actual = input[index];
    if ("literal" in expected) {
      if (actual !== expected.literal) return null;
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(actual);
    } catch {
      throw new RouteInputError("Path parameter contains invalid percent encoding");
    }
    if (!decoded || decoded.includes("/") || decoded.includes("\0"))
      throw new RouteInputError("Path parameter contains an invalid value");
    params[expected.name] = decoded;
  }
  return params;
}

function segments(path) {
  if (path === "/" || path === "") return [];
  if (typeof path !== "string" || !path.startsWith("/") || path.endsWith("/"))
    return ["__route_not_canonical__"];
  return path.slice(1).split("/");
}

function defaultNotFound() {
  return failure(404, "not_found", "API endpoint not found");
}

export class RouteInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteInputError";
  }
}
