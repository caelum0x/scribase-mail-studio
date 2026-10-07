import { beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map<string, number>() }));

vi.mock("~/server/redis", () => ({
  redisKey: (k: string) => k,
  getRedis: () => ({
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    del: async (k: string) => store.delete(k),
    incr: async (k: string) => {
      store.set(k, (store.get(k) ?? 0) + 1);
      return store.get(k)!;
    },
    expire: async () => 1,
  }),
}));

import { MFA_MAX_FAILURES, withMfaAttemptGuard } from "./mfa-attempt-guard";

describe("withMfaAttemptGuard", () => {
  beforeEach(() => store.clear());

  it("locks after too many failures, even for a correct code", async () => {
    for (let i = 0; i < MFA_MAX_FAILURES; i++) {
      expect(await withMfaAttemptGuard(1, async () => false)).toBe(false);
    }
    await expect(withMfaAttemptGuard(1, async () => true)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("resets the counter on success and is per user", async () => {
    await withMfaAttemptGuard(1, async () => false);
    expect(await withMfaAttemptGuard(1, async () => true)).toBe(true);
    expect(store.size).toBe(0);
    for (let i = 0; i < MFA_MAX_FAILURES; i++) await withMfaAttemptGuard(2, async () => false);
    expect(await withMfaAttemptGuard(3, async () => true)).toBe(true);
  });
});
