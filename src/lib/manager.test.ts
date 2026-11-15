import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagerClient, type ManagedStatus } from "./manager";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const status: ManagedStatus = {
  service: { enabled: true, state: "running", pid: 8842 },
  controller: { reachable: true, version: "1.19.0" },
  config: {
    state: "active",
    activeProfileId: "home",
    activeRevision: 7,
    sha256: "0123456789abcdef",
  },
  network: {
    state: "active",
    desired: true,
    tcpMode: "redirect",
    udpMode: "tproxy",
    ipv4: true,
    ipv6: false,
  },
};

function hostedAt(origin = "https://router.example") {
  vi.stubGlobal("location", { origin });
}

describe("Mihomo manager requests", () => {
  it("resolves status relative to the hosted package prefix with safe browser defaults", async () => {
    hostedAt();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: status })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ManagerClient().status()).resolves.toEqual(status);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://router.example/io.cno.mihomo/api/v1/status",
    );
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });

  it("preserves degraded subsystem data instead of treating it as a transport failure", async () => {
    hostedAt();
    const degraded: ManagedStatus = {
      ...status,
      controller: { reachable: false },
      config: { state: "failed", activeRevision: 6, sha256: "old-generation" },
      network: {
        ...status.network,
        state: "degraded",
        lastError: "fw4 generation no longer matches the desired revision",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true, result: degraded })),
        ),
    );

    await expect(new ManagerClient().status()).resolves.toEqual(degraded);
  });

  it("reports structured HTTP failures and invalid JSON without leaking an HTML response", async () => {
    hostedAt();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "busy", message: "操作仍在进行" },
          }),
          {
            status: 409,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>LuCI</title>"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ManagerClient();

    await expect(client.status()).rejects.toMatchObject({
      name: "ManagerApiError",
      status: 409,
      code: "busy",
      message: "操作仍在进行",
    });
    await expect(client.status()).rejects.toMatchObject({
      name: "ManagerApiError",
      status: 200,
      message: "管理 API 返回了无效 JSON",
    });
  });

  it("keeps caller cancellation distinct from an unavailable manager", async () => {
    hostedAt();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const request = new ManagerClient().status(controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("updates global enhancement through the manager revision contract", async () => {
    hostedAt();
    const result = {
      revision: 4,
      enhancement: {
        version: 1 as const,
        merge: { enabled: false, content: "{}\n" },
        script: { enabled: false, content: "function main(c) { return c; }\n" },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new ManagerClient().updateGlobalEnhancement(result.enhancement, 3),
    ).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://router.example/io.cno.mihomo/api/v1/enhancement/global",
    );
    expect(init).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "X-CNO-Mihomo-Request": "1" }),
      body: JSON.stringify({
        enhancement: result.enhancement,
        expectedRevision: 3,
      }),
    });
  });
});
