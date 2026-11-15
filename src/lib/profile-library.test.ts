import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_MAX_BYTES,
  createManagerProfileRepository,
  fetchProfileSource,
  lastAppliedProfile,
  normalizeProfileSourceUrl,
  profileFileName,
  profileInput,
  rememberAppliedProfile,
  validateProfileYaml,
  type ProfileEntry,
} from "./profile-library";
import {
  defaultGlobalProfileEnhancement,
  defaultProfileEnhancement,
} from "./profile-enhancement";
import {
  ManagerApiError,
  type ManagerClient,
  type ManagedProfile,
} from "./manager";

const sourceUrl =
  "https://subscriptions.example/config.yaml?token=private-value";
const originalYaml = [
  "# 保留注释、锚点、引号与换行",
  "mixed-port: 7890",
  "defaults: &defaults",
  "  type: 'http'",
  "  interval: 3600",
  "proxy-providers:",
  "  example:",
  "    <<: *defaults",
  "    url: 'https://example.com/providers.yaml'",
  "",
].join("\r\n");

function profile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    id: "profile-one",
    name: "工作配置",
    description: "保留原始配置",
    content: originalYaml,
    sourceUrl,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("profile YAML validation", () => {
  it("accepts one mapping with anchors, aliases and merge keys without rewriting the source", () => {
    expect(validateProfileYaml(originalYaml)).toBeNull();
  });

  it.each([
    "",
    " \n\t",
    "# comments alone do not form a config\n",
    "plain text",
    "- mode: rule\n- mixed-port: 7890",
    "mode: rule\nmode: direct\n",
    "mode: rule\n---\nmode: direct\n",
    "proxies: [unterminated\n",
    "proxy-groups: *undefined-anchor\n",
  ])(
    "rejects empty, malformed, duplicate, multi-document or non-mapping YAML: %j",
    (content) => {
      expect(validateProfileYaml(content)).toEqual(expect.any(String));
      expect(validateProfileYaml(content)?.length).toBeGreaterThan(0);
    },
  );

  it("rejects alias expansion that exceeds the parser limit", () => {
    const repeatedAliases = Array.from({ length: 20 }, () => "*a").join(", ");
    const nestedAliases = Array.from({ length: 20 }, () => "*b").join(", ");
    const content = `a: &a [1, 2, 3]\nb: &b [${repeatedAliases}]\nc: [${nestedAliases}]\n`;
    expect(validateProfileYaml(content)).toEqual(expect.any(String));
  });

  it("measures the YAML limit in UTF-8 bytes rather than JavaScript characters", () => {
    const content = `name: ${"界".repeat(Math.floor(PROFILE_MAX_BYTES / 3))}`;
    expect(content.length).toBeLessThan(PROFILE_MAX_BYTES);
    expect(validateProfileYaml(content)).toMatch(/5 MiB/);
  });
});

describe("manager profile repository", () => {
  const managed = (
    overrides: Partial<ManagedProfile> = {},
  ): ManagedProfile => ({
    ...profile(),
    revision: 7,
    ...overrides,
  });

  function managerMock(overrides: Record<string, unknown> = {}) {
    return {
      profiles: vi
        .fn()
        .mockResolvedValue([{ ...managed(), content: undefined }]),
      profile: vi.fn().mockResolvedValue(managed()),
      createProfile: vi.fn().mockResolvedValue(managed()),
      updateProfile: vi.fn().mockResolvedValue(managed({ revision: 8 })),
      deleteProfile: vi.fn().mockResolvedValue(undefined),
      reorderProfiles: vi.fn().mockResolvedValue([]),
      fetchProfile: vi.fn().mockResolvedValue({ content: originalYaml }),
      previewProfile: vi.fn().mockResolvedValue({
        profileId: "profile-one",
        profileRevision: 7,
        compilerRevision: "compiler-1",
        contentHash: "hash",
        content: originalYaml,
        logs: [],
        stages: [],
      }),
      applyProfile: vi.fn().mockResolvedValue({ operationId: "operation-1" }),
      waitForOperation: vi.fn().mockResolvedValue({
        id: "operation-1",
        kind: "profile.apply",
        state: "succeeded",
        startedAt: 1,
        finishedAt: 2,
        result: {},
        error: null,
      }),
      globalEnhancement: vi.fn().mockResolvedValue({
        revision: 3,
        enhancement: defaultGlobalProfileEnhancement(),
      }),
      updateGlobalEnhancement: vi.fn().mockResolvedValue({
        revision: 4,
        enhancement: defaultGlobalProfileEnhancement(),
      }),
      ...overrides,
    };
  }

  it("loads full records after summaries and forwards revision to update, preview and apply", async () => {
    const client = managerMock();
    const repository = createManagerProfileRepository(
      client as unknown as ManagerClient,
    );
    await expect(repository.list()).resolves.toEqual([managed()]);
    await repository.update("profile-one", profileInput(managed()), 7);
    await repository.preview("profile-one", 7);
    await repository.apply("profile-one", 7);
    expect(client.profile).toHaveBeenCalledWith("profile-one", undefined);
    expect(client.updateProfile).toHaveBeenCalledWith(
      "profile-one",
      profileInput(managed()),
      7,
    );
    expect(client.previewProfile).toHaveBeenCalledWith("profile-one", 7);
    expect(client.applyProfile).toHaveBeenCalledWith("profile-one", 7);
  });

  it("surfaces a revision conflict without retrying an update or mutating the loaded record", async () => {
    const conflict = new ManagerApiError(
      "配置已被其他会话更新，请刷新后重试",
      409,
      "conflict",
    );
    const updateProfile = vi.fn().mockRejectedValue(conflict);
    const client = managerMock({ updateProfile });
    const repository = createManagerProfileRepository(
      client as unknown as ManagerClient,
    );
    const before = await repository.get("profile-one");
    await expect(
      repository.update("profile-one", profileInput(before), 6),
    ).rejects.toBe(conflict);
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(before).toEqual(managed());
  });

  it("forwards global enhancement optimistic revisions to the manager", async () => {
    const client = managerMock();
    const repository = createManagerProfileRepository(
      client as unknown as ManagerClient,
    );
    const current = await repository.globalEnhancement();
    await repository.updateGlobalEnhancement(current.enhancement, current);
    expect(client.globalEnhancement).toHaveBeenCalledWith(undefined);
    expect(client.updateGlobalEnhancement).toHaveBeenCalledWith(
      current.enhancement,
      3,
    );
  });
});

describe("remote profile sources", () => {
  it("preserves query authentication, removes fragments and uses direct CORS without browser credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(originalYaml));
    await expect(
      fetchProfileSource(` ${sourceUrl}#section `, undefined, fetcher),
    ).resolves.toBe(originalYaml);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      sourceUrl,
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it.each([
    "/relative.yaml",
    "file:///etc/config.yaml",
    "data:text/yaml,mode:rule",
    "ftp://example.com/config.yaml",
    "https://user:password@example.com/config.yaml",
  ])(
    "rejects unsupported or credential-bearing source URLs before fetching: %s",
    async (url) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(() => normalizeProfileSourceUrl(url)).toThrow();
      await expect(
        fetchProfileSource(url, undefined, fetcher),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("retains the HTTP status and explains native browser CORS/network failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("denied", { status: 403, statusText: "Forbidden" }),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      fetchProfileSource(sourceUrl, undefined, fetcher),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      fetchProfileSource(sourceUrl, undefined, fetcher),
    ).rejects.toThrow(/Failed to fetch.*CORS/);
  });

  it("decodes UTF-8 correctly when a character spans separate streamed chunks", async () => {
    const content = "name: '香港'\r\nmode: rule\r\n";
    const encoded = new TextEncoder().encode(content);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 8));
          controller.enqueue(encoded.slice(8, 10));
          controller.enqueue(encoded.slice(10));
          controller.close();
        },
      }),
    );
    await expect(
      fetchProfileSource(
        sourceUrl,
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).resolves.toBe(content);
  });

  it.each([undefined, "1"])(
    "rejects oversized streamed responses when Content-Length is %j",
    async (declaredLength) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(PROFILE_MAX_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
        {
          headers: declaredLength
            ? { "content-length": declaredLength }
            : undefined,
        },
      );
      await expect(
        fetchProfileSource(
          sourceUrl,
          undefined,
          vi.fn<typeof fetch>().mockResolvedValue(response),
        ),
      ).rejects.toThrow(/5 MiB/);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("rejects a declared oversized response before reading its body", async () => {
    const response = new Response("mode: rule\n", {
      headers: { "content-length": String(PROFILE_MAX_BYTES + 1) },
    });
    const read = vi.spyOn(response.body!, "getReader");
    await expect(
      fetchProfileSource(
        sourceUrl,
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).rejects.toThrow(/5 MiB/);
    expect(read).not.toHaveBeenCalled();
  });

  it("aborts a stalled fetch after 20 seconds and reports a timeout", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const result = expect(
      fetchProfileSource(sourceUrl, undefined, fetcher),
    ).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation without reclassifying it as a CORS failure", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const abortError = new DOMException("User cancelled import", "AbortError");
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () =>
          reject(requestSignal?.reason),
        );
      });
    });
    const result = expect(
      fetchProfileSource(sourceUrl, caller.signal, fetcher),
    ).rejects.toBe(abortError);
    caller.abort(abortError);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("profile file and session identity", () => {
  it("retains source content and generated content separately with an enhancement signature", () => {
    const client = {};
    const entry = profile({ enhancement: defaultProfileEnhancement() });
    const signature = JSON.stringify({ enhancement: entry.enhancement });
    rememberAppliedProfile(client, entry, {
      content: "mode: direct\n",
      enhancementSignature: signature,
    });
    entry.enhancement!.merge.content = "mode: global";
    expect(lastAppliedProfile(client)).toMatchObject({
      content: originalYaml,
      generatedContent: "mode: direct\n",
      enhancementSignature: signature,
    });
    rememberAppliedProfile(client, entry);
    expect(lastAppliedProfile(client)).not.toHaveProperty("generatedContent");
    expect(lastAppliedProfile(client)).not.toHaveProperty(
      "enhancementSignature",
    );
  });

  it("keeps YAML extensions and removes path separators and unsafe filename characters", () => {
    expect(profileFileName(" 工作配置 ")).toBe("工作配置.yaml");
    expect(profileFileName("office.YML")).toBe("office.YML");
    expect(profileFileName("config.yaml")).toBe("config.yaml");
    expect(profileFileName("folder/subfolder\\bad:name?")).toBe(
      "folder-subfolder-bad-name-.yaml",
    );
    expect(profileFileName("... ")).toBe("config.yaml");
  });

  it("remembers the applied content snapshot only for the exact controller session", () => {
    const client = {};
    const otherSession = {};
    const entry = profile();
    rememberAppliedProfile(client, entry);
    entry.content = "mode: direct\n";
    expect(lastAppliedProfile(client)).toMatchObject({
      id: entry.id,
      content: originalYaml,
    });
    expect(lastAppliedProfile(otherSession)).toBeUndefined();
    expect(lastAppliedProfile(null)).toBeUndefined();
    rememberAppliedProfile(client, entry);
    expect(lastAppliedProfile(client)?.content).toBe(entry.content);
  });
});
