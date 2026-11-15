const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;

export class ControllerClient {
  constructor({ curlModule, configStore, decoderFactory }) {
    this.CURL = curlModule.CURL;
    this.pool = new curlModule.ConnPool({
      maxConnections: 16,
      maxConnectionsPerHost: 16,
      pipelining: true,
    });
    this.configStore = configStore;
    this.decoderFactory = decoderFactory;
    this.active = new Set();
    this.closed = false;
  }

  async request(event, relativeTarget) {
    this.#assertOpen();
    const config = this.configStore.value;
    const curl = new this.CURL(this.pool);
    this.active.add(curl);
    const detach = abortWithSignal(event.signal, curl);
    try {
      curl
        .setUrl(`${config.controllerUrl}${relativeTarget}`)
        .setMethod(event.method)
        .setHeaders(forwardRequestHeaders(event.headers, config.secret))
        .setTimeout(config.requestTimeoutMs)
        .setConnectTimeout(Math.min(config.requestTimeoutMs, 10000))
        .setFollowRedirects(false);
      if (event.body && event.body.byteLength > 0) curl.setBody(event.body);
      const response = await curl.perform();
      return {
        status: response.status,
        headers: parseResponseHeaders(response.headers),
        body: response.body ?? new ArrayBuffer(0),
      };
    } finally {
      detach();
      this.active.delete(curl);
    }
  }

  openJsonStream(event, relativeTarget, socket, decoderFactory) {
    this.#assertOpen();
    const config = this.configStore.value;
    const curl = new this.CURL(this.pool);
    const decoder = decoderFactory();
    let pending = "";
    let ended = false;

    const stop = () => {
      if (ended) return;
      ended = true;
      try {
        curl.abort();
      } catch (_) {
        // The transfer may already have completed.
      }
    };
    const detachSignal = listenAbort(event.signal, stop);
    socket.onclose = stop;
    this.active.add(curl);

    curl
      .setUrl(`${config.controllerUrl}${relativeTarget}`)
      .setMethod("GET")
      .setHeaders(controllerHeaders(config.secret))
      .setConnectTimeout(config.streamConnectTimeoutMs)
      .setFollowRedirects(false)
      .setKeepAlive(true, 30, 15)
      .setLowSpeedLimit(1, 90)
      .setStreamMode(true)
      .onHeadersComplete((status) => {
        if (status < 200 || status >= 300) {
          socket.close(1011, `Mihomo stream returned HTTP ${status}`);
          stop();
        }
      })
      .onData((buffer) => {
        if (ended || event.signal.aborted) return true;
        pending += decoder.decode(buffer, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line && !socket.send(line)) return true;
        }
        return false;
      });

    const completion = curl.perform();
    completion
      .then(
        () => {
          if (ended) return;
          pending += decoder.decode();
          if (pending && !socket.send(pending)) {
            ended = true;
            return;
          }
          ended = true;
          socket.close(1000, "Mihomo stream ended");
        },
        (error) => {
          if (ended || event.signal.aborted) return;
          ended = true;
          socket.close(1011, shortReason(error));
        },
      )
      .finally(() => {
        detachSignal();
        this.active.delete(curl);
      });
    return completion;
  }

  async probe(signal) {
    const fakeEvent = {
      method: "GET",
      headers: [],
      body: new Uint8Array(),
      signal,
    };
    const response = await this.request(fakeEvent, "/version");
    let version = null;
    try {
      version = JSON.parse(this.decoderFactory().decode(response.body));
    } catch (_) {
      // A reachable non-JSON controller is still reported with its status.
    }
    return {
      reachable: response.status >= 200 && response.status < 500,
      status: response.status,
      ...(version && typeof version === "object"
        ? { version: version.version ?? version.meta ?? undefined }
        : {}),
    };
  }

  async fetchSubscription(url, signal, options = {}) {
    this.#assertOpen();
    if (!safeSubscriptionUrl(url))
      throw new Error(
        "Subscription URL must use HTTP or HTTPS without credentials or fragments",
      );
    const userAgent = subscriptionUserAgent(options.userAgent);
    const requestHeaders = {
      accept: "text/yaml,text/plain,application/yaml,*/*",
      "user-agent": userAgent,
      ...(typeof options.etag === "string" && options.etag
        ? { "if-none-match": options.etag }
        : {}),
      ...(typeof options.lastModified === "string" && options.lastModified
        ? { "if-modified-since": options.lastModified }
        : {}),
    };
    const curl = new this.CURL(this.pool);
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let responseHeaders = "";
    this.active.add(curl);
    const detach = abortWithSignal(signal, curl);
    try {
      curl
        .setUrl(url)
        .setMethod("GET")
        .setHeaders(requestHeaders)
        .setTimeout(30000)
        .setConnectTimeout(10000)
        .setFollowRedirects(true)
        .setMaxRedirects(3)
        .setAcceptEncoding("")
        .setStreamMode(true)
        .onHeadersComplete((_status, headers) => {
          responseHeaders = headers;
        })
        .onData((buffer) => {
          const chunk = new Uint8Array(buffer);
          if (total + chunk.byteLength > MAX_SUBSCRIPTION_BYTES) {
            tooLarge = true;
            return true;
          }
          chunks.push(chunk.slice());
          total += chunk.byteLength;
          return false;
        });
      let response;
      try {
        response = await curl.perform();
      } catch (error) {
        if (tooLarge) throw new Error("Subscription exceeds 5 MiB");
        throw error;
      }
      if (response.status === 304)
        return {
          content: null,
          notModified: true,
          metadata: { status: 304, finalUrl: response.url ?? url },
        };
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Subscription returned HTTP ${response.status}`);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const headers = parseResponseHeaders(responseHeaders || response.headers);
      return {
        content: this.decoderFactory().decode(bytes),
        metadata: {
          bytes: total,
          status: response.status,
          finalUrl: response.url ?? url,
          ...(headers.etag ? { etag: headers.etag } : {}),
          ...(headers["last-modified"]
            ? { lastModified: headers["last-modified"] }
            : {}),
          ...(headers["subscription-userinfo"]
            ? { subscriptionUserinfo: headers["subscription-userinfo"] }
            : {}),
        },
      };
    } finally {
      detach();
      this.active.delete(curl);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const curl of [...this.active]) {
      try {
        curl.abort();
      } catch (_) {
        // Ignore already completed transfers during package shutdown.
      }
    }
    this.active.clear();
    this.pool.close();
  }

  #assertOpen() {
    if (this.closed) throw new Error("Controller client is closed");
  }
}

/**
 * The package runtime intentionally does not assume a browser URL global.
 * libcurl remains the authoritative URL parser; this rejects the dangerous
 * schemes and userinfo/fragment forms before handing the value to it.
 * @param {unknown} value
 */
function safeSubscriptionUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    value.includes("#")
  )
    return false;
  const match = value.match(/^https?:\/\/([^/?#]+)(?:[/?][^#]*)?$/i);
  return !!match && !match[1].includes("@");
}

function subscriptionUserAgent(value) {
  if (value === undefined || value === null || value === "")
    return "cno-mihomo-manager/0.1";
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[^\u0020-\u007e]/.test(value)
  )
    throw new Error("Subscription User-Agent must contain 1..256 printable ASCII characters");
  return value;
}

export function controllerTarget(path, query) {
  const relative = path.slice("/controller".length) || "/";
  return query ? `${relative}?${query}` : relative;
}

function forwardRequestHeaders(entries, secret) {
  const headers = controllerHeaders(secret);
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP.has(name) ||
      name === "host" ||
      name === "authorization" ||
      name === "cookie" ||
      name === "x-circud-csrf"
    )
      continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

function controllerHeaders(secret) {
  const headers = { accept: "*/*", "user-agent": "cno-mihomo-manager/0.1" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  return headers;
}

export function parseResponseHeaders(raw) {
  const result = {};
  const blocks = String(raw ?? "")
    .split(/\r?\n\r?\n/)
    .filter(Boolean);
  const block = blocks[blocks.length - 1] ?? "";
  for (const line of block.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!name || HOP_BY_HOP.has(name) || name === "set-cookie") continue;
    result[name] = result[name] ? `${result[name]}, ${value}` : value;
  }
  result["cache-control"] ??= "no-store";
  return result;
}

function abortWithSignal(signal, curl) {
  return listenAbort(signal, () => curl.abort());
}

function listenAbort(signal, listener) {
  if (signal.aborted) {
    listener();
    return () => {};
  }
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function shortReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120) || "Mihomo stream failed";
}
