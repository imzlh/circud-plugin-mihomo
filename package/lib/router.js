import { errorResponse, failure, methodNotAllowed } from "./envelope.js";
import { controllerTarget } from "./controller.js";
import { createApiRouter } from "./api/index.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const STREAM_PATHS = new Set([
  "/controller/traffic",
  "/controller/memory",
  "/controller/connections",
  "/controller/logs",
]);

/**
 * @typedef {{
 *   isAuthorized: boolean,
 *   method: string,
 *   protocol: string,
 *   path: string,
 *   query: string,
 *   headers: Iterable<[string, string]>,
 *   body: Uint8Array,
 *   signal: AbortSignal,
 *   respondWith(response: unknown): void,
 *   acceptWebSocket(): any,
 *   serveStatic(path: string): void,
 * }} EndpointEvent
 */

/** Authentication, protocol dispatch and package mounts only. */
export class Router {
  constructor(services) {
    this.controller = services.controller;
    this.decoderFactory = services.decoderFactory;
    this.api = createApiRouter(services);
    this.mounts = [
      {
        prefix: "/api/v1",
        handle: (event, relative) => this.api.handle(event, relative),
      },
      {
        prefix: "/api",
        handle: (event) =>
          event.respondWith(failure(404, "not_found", "API endpoint not found")),
      },
      {
        prefix: "/controller",
        handle: (event) =>
          event.respondWith(
            this.controller
              .request(event, controllerTarget(event.path, event.query))
              .catch(errorResponse),
          ),
      },
    ];
  }

  /** @param {EndpointEvent} event */
  handle(event) {
    if (!event.isAuthorized) {
      event.respondWith(failure(401, "unauthorized", "Authentication is required"));
      return;
    }
    if (!READ_METHODS.has(event.method) && !validMutation(event)) {
      event.respondWith(
        failure(
          403,
          "request_verification_failed",
          "A same-origin mutation request is required",
        ),
      );
      return;
    }
    if (event.protocol === "websocket") {
      this.#websocket(event);
      return;
    }
    const mount = this.mounts.find(({ prefix }) => mounted(event.path, prefix));
    if (mount) {
      mount.handle(event, relativePath(event.path, mount.prefix));
      return;
    }
    this.#static(event);
  }

  #websocket(event) {
    if (!STREAM_PATHS.has(event.path)) {
      const socket = event.acceptWebSocket();
      if (socket) socket.close(1008, "Unknown Mihomo stream endpoint");
      return;
    }
    const socket = event.acceptWebSocket();
    if (!socket) return;
    this.controller.openJsonStream(
      event,
      controllerTarget(event.path, event.query),
      socket,
      this.decoderFactory,
    );
  }

  #static(event) {
    if (event.method !== "GET" && event.method !== "HEAD") {
      event.respondWith(methodNotAllowed(["GET", "HEAD"]));
      return;
    }
    if (event.path === "/favicon.svg") {
      event.serveStatic("static/favicon.svg");
      return;
    }
    if (event.path.startsWith("/assets/") && safeAssetPath(event.path)) {
      event.serveStatic(`static${event.path}`);
      return;
    }
    event.serveStatic("static/index.html");
  }
}

function mounted(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function relativePath(path, prefix) {
  return path.slice(prefix.length) || "/";
}

export function validMutation(event) {
  const headers = headerMap(event.headers);
  if (headers.get("x-cno-mihomo-request") !== "1") return false;
  const origin = headers.get("origin");
  const authority = headers.get("host") ?? headers.get(":authority");
  if (!origin || !authority) return false;
  return origin === `http://${authority}` || origin === `https://${authority}`;
}

function headerMap(entries) {
  const result = new Map();
  for (const [name, value] of entries ?? [])
    result.set(String(name).toLowerCase(), String(value));
  return result;
}

export function safeAssetPath(path) {
  return (
    /^\/assets\/[A-Za-z0-9._/-]+$/.test(path) &&
    !path
      .slice(1)
      .split("/")
      .some((part) => part === "." || part === ".." || part === "")
  );
}
