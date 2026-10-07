import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, mockRedis } = vi.hoisted(() => {
  const store = new Map<string, string | Buffer>();
  const mockRedis = {
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    get: vi.fn(async (key: string) => {
      const v = store.get(key);
      return typeof v === "string" ? v : null;
    }),
    getBuffer: vi.fn(async (key: string) => {
      const v = store.get(key);
      return Buffer.isBuffer(v) ? v : null;
    }),
    multi: vi.fn(() => {
      const ops: Array<[string, string | Buffer]> = [];
      const chain = {
        set: (key: string, value: string | Buffer) => {
          ops.push([key, value]);
          return chain;
        },
        exec: async () => {
          for (const [k, v] of ops) store.set(k, v);
          return [];
        },
      };
      return chain;
    }),
  };
  return { store, mockRedis };
});

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => `test:${key}`,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getThreatIndex,
  parseListEnv,
  refreshThreatFeeds,
  resetThreatIndexCache,
} from "./threat-feed-store";

function feedResponse(body: string, status = 200) {
  return new Response(body, { status });
}

describe("threat feed store", () => {
  beforeEach(() => {
    store.clear();
    resetThreatIndexCache();
  });

  it("downloads feeds, saves the index, and serves lookups from it", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("a")
        ? feedResponse("evil.test\n# c\nphish.example\n")
        : feedResponse("https://bad.test/x\n"),
    ) as unknown as typeof fetch;

    const result = await refreshThreatFeeds({
      urls: ["https://feeds/a.txt", "https://feeds/b.txt"],
      fetchImpl,
      now: new Date("2026-10-07T00:00:00Z"),
    });

    expect(result.saved).toBe(true);
    expect(result.meta.hosts).toBe(3);
    const index = await getThreatIndex();
    expect(index.isListed("www.evil.test")).toBe(true);
    expect(index.isListed("bad.test")).toBe(true);
    expect(index.isListed("good.test")).toBe(false);
  });

  it("keeps the previous index when a feed fails", async () => {
    const ok = vi.fn(async () =>
      feedResponse("evil.test\n"),
    ) as unknown as typeof fetch;
    await refreshThreatFeeds({ urls: ["https://feeds/a.txt"], fetchImpl: ok });

    const failing = vi.fn(async () =>
      feedResponse("", 503),
    ) as unknown as typeof fetch;
    const result = await refreshThreatFeeds({
      urls: ["https://feeds/a.txt"],
      fetchImpl: failing,
    });

    expect(result.saved).toBe(false);
    expect(result.meta.sources[0]?.error).toBe("HTTP 503");
    expect((await getThreatIndex()).isListed("evil.test")).toBe(true);
  });

  it("rejects feeds that declare an oversized body", async () => {
    const huge = vi.fn(
      async () =>
        new Response("x", {
          headers: { "content-length": String(1024 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    const result = await refreshThreatFeeds({
      urls: ["https://feeds/huge.txt"],
      fetchImpl: huge,
    });
    expect(result.meta.sources[0]?.error).toMatch(/too large/);
  });

  it("returns an empty index when nothing was downloaded yet", async () => {
    const index = await getThreatIndex();
    expect(index.size).toBe(0);
  });

  it("returns an empty index when Redis fails", async () => {
    mockRedis.get.mockRejectedValueOnce(new Error("down"));
    const index = await getThreatIndex();
    expect(index.size).toBe(0);
  });

  it("parses comma or whitespace separated env lists", () => {
    expect(parseListEnv(" a.test, b.test\nc.test ")).toEqual([
      "a.test",
      "b.test",
      "c.test",
    ]);
    expect(parseListEnv(undefined)).toEqual([]);
  });
});
