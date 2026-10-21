import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  type RateLimitStore,
} from "./auth-rate-limit";

/** In-memory fake store for pure unit testing — no real Redis involved. */
class FakeStore implements RateLimitStore {
  private counts = new Map<string, number>();

  async increment(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

class ThrowingStore implements RateLimitStore {
  async increment(): Promise<number> {
    throw new Error("redis unavailable");
  }
}

describe("checkRateLimit", () => {
  it("allows requests under the limit", async () => {
    const store = new FakeStore();
    const r1 = await checkRateLimit(store, "ip:1.1.1.1", 3, 60);
    const r2 = await checkRateLimit(store, "ip:1.1.1.1", 3, 60);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it("blocks requests once the limit is exceeded", async () => {
    const store = new FakeStore();
    await checkRateLimit(store, "ip:2.2.2.2", 2, 60);
    await checkRateLimit(store, "ip:2.2.2.2", 2, 60);
    const blocked = await checkRateLimit(store, "ip:2.2.2.2", 2, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("keeps separate counters per key (per IP / per route)", async () => {
    const store = new FakeStore();
    await checkRateLimit(store, "ip:3.3.3.3", 1, 60);
    const other = await checkRateLimit(store, "ip:4.4.4.4", 1, 60);
    expect(other.allowed).toBe(true);
  });

  it("fails open when the store errors, so a Redis outage never locks out sign-in", async () => {
    const store = new ThrowingStore();
    const result = await checkRateLimit(store, "ip:5.5.5.5", 1, 60);
    expect(result.allowed).toBe(true);
  });
});
