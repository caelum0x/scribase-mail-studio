import { beforeEach, describe, expect, it, vi } from "vitest";

type TeamRow = {
  id: number;
  plan: "FREE" | "PRO" | "SCALE";
  isActive: boolean;
  billingCustomerId: string | null;
};
type SubRow = { id: string; teamId: number; status: string };

const { state, retrieve, refreshTeamCache, getTeamUsers, sendConfirmation } =
  vi.hoisted(() => ({
    state: {
      claimed: new Set<string>(),
      teams: [] as TeamRow[],
      subs: [] as SubRow[],
    },
    retrieve: vi.fn(),
    refreshTeamCache: vi.fn(),
    getTeamUsers: vi.fn(),
    sendConfirmation: vi.fn(),
  }));

function makeTx() {
  return {
    billingWebhookEvent: {
      createMany: vi.fn(async ({ data }: { data: { id: string }[] }) => {
        const id = data[0]!.id;
        if (state.claimed.has(id)) return { count: 0 };
        state.claimed.add(id);
        return { count: 1 };
      }),
    },
    team: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: number; billingCustomerId?: string } }) =>
          state.teams.find((t) =>
            where.id !== undefined
              ? t.id === where.id
              : t.billingCustomerId === where.billingCustomerId,
          ) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: number }; data: Partial<TeamRow> }) => {
          state.teams = state.teams.map((t) =>
            t.id === where.id ? { ...t, ...data } : t,
          );
          return state.teams.find((t) => t.id === where.id);
        },
      ),
    },
    subscription: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: SubRow;
          update: Omit<SubRow, "id">;
        }) => {
          const exists = state.subs.some((s) => s.id === where.id);
          state.subs = exists
            ? state.subs.map((s) => (s.id === where.id ? { ...s, ...update } : s))
            : [...state.subs, create];
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { teamId: number; id: { not: string }; status: { in: string[] } };
        }) =>
          state.subs.find(
            (s) =>
              s.teamId === where.teamId &&
              s.id !== where.id.not &&
              where.status.in.includes(s.status),
          ) ?? null,
      ),
    },
  };
}

vi.mock("~/env", () => ({
  env: {
    DODO_PAYMENTS_API_KEY: "test-key",
    DODO_PRODUCT_ID_PRO: "pdt_pro",
    DODO_PRODUCT_ID_SCALE: "pdt_scale",
  },
}));
vi.mock("~/server/db", () => ({
  db: {
    // Real transactions roll back on throw: emulate by snapshotting state.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone({
        claimed: [...state.claimed],
        teams: state.teams,
        subs: state.subs,
      });
      try {
        return await fn(makeTx());
      } catch (err) {
        state.claimed = new Set(snapshot.claimed);
        state.teams = snapshot.teams;
        state.subs = snapshot.subs;
        throw err;
      }
    },
  },
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/mailer", () => ({
  sendSubscriptionConfirmationEmail: sendConfirmation,
}));
vi.mock("~/server/service/team-service", () => ({
  TeamService: { refreshTeamCache, getTeamUsers },
}));
vi.mock("./dodo-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dodo-client")>();
  return {
    ...actual,
    getDodoClient: () => ({ subscriptions: { retrieve } }),
  };
});

import { afterDodoWebhook, processDodoWebhook } from "./webhook-handler";

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    subscription_id: "sub_1",
    status: "active",
    product_id: "pdt_pro",
    customer: { customer_id: "cus_1", email: "a@example.com" },
    metadata: { teamId: "1" },
    next_billing_date: "2026-11-07T00:00:00Z",
    previous_billing_date: "2026-10-07T00:00:00Z",
    cancel_at_next_billing_date: false,
    ...overrides,
  };
}

function event(type: string, data: unknown) {
  return { type, data };
}

describe("processDodoWebhook", () => {
  beforeEach(() => {
    state.claimed = new Set();
    state.teams = [
      { id: 1, plan: "FREE", isActive: true, billingCustomerId: "cus_1" },
    ];
    state.subs = [];
    retrieve.mockReset();
    refreshTeamCache.mockReset();
    getTeamUsers.mockReset();
    sendConfirmation.mockReset();
  });

  it("activates the paid plan on subscription.active", async () => {
    const outcome = await processDodoWebhook(
      "wh_1",
      event("subscription.active", subscription()),
    );

    expect(outcome).toEqual({
      status: "processed",
      teamId: 1,
      plan: "PRO",
      isActive: true,
      becamePaid: true,
    });
    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: true });
    expect(state.subs[0]).toMatchObject({
      id: "sub_1",
      status: "active",
      plan: "PRO",
      productId: "pdt_pro",
      provider: "dodo",
    });
  });

  it("is idempotent per webhook-id", async () => {
    await processDodoWebhook("wh_1", event("subscription.active", subscription()));
    const again = await processDodoWebhook(
      "wh_1",
      event("subscription.on_hold", subscription({ status: "on_hold" })),
    );

    expect(again).toEqual({ status: "duplicate" });
    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: true });
  });

  it("maps Scale and plan changes", async () => {
    await processDodoWebhook("wh_1", event("subscription.active", subscription()));
    const outcome = await processDodoWebhook(
      "wh_2",
      event(
        "subscription.plan_changed",
        subscription({ product_id: "pdt_scale" }),
      ),
    );

    expect(outcome).toMatchObject({ plan: "SCALE", becamePaid: false });
    expect(state.teams[0]!.plan).toBe("SCALE");
  });

  it("keeps the plan but suspends paid limits on hold, then recovers on renewal", async () => {
    await processDodoWebhook("wh_1", event("subscription.active", subscription()));
    await processDodoWebhook(
      "wh_2",
      event("subscription.on_hold", subscription({ status: "on_hold" })),
    );
    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: false });

    await processDodoWebhook("wh_3", event("subscription.renewed", subscription()));
    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: true });
  });

  it.each(["subscription.cancelled", "subscription.expired", "subscription.failed"])(
    "returns the team to free on %s",
    async (type) => {
      await processDodoWebhook("wh_1", event("subscription.active", subscription()));
      const status = type.split(".")[1];
      await processDodoWebhook("wh_2", event(type, subscription({ status })));

      expect(state.teams[0]).toMatchObject({ plan: "FREE", isActive: true });
      expect(state.subs[0]!.status).toBe(status);
    },
  );

  it("keeps access until period end when cancelled at next billing date", async () => {
    await processDodoWebhook("wh_1", event("subscription.active", subscription()));
    await processDodoWebhook(
      "wh_2",
      event(
        "subscription.cancelled",
        subscription({ status: "active", cancel_at_next_billing_date: true }),
      ),
    );

    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: true });
    expect(state.subs[0]).toMatchObject({
      cancelAtPeriodEnd: new Date("2026-11-07T00:00:00Z"),
    });
  });

  it("does not downgrade when an old subscription ends after a newer one started", async () => {
    await processDodoWebhook(
      "wh_1",
      event("subscription.active", subscription({ subscription_id: "sub_new" })),
    );
    await processDodoWebhook(
      "wh_2",
      event(
        "subscription.expired",
        subscription({ subscription_id: "sub_old", status: "expired" }),
      ),
    );

    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: true });
  });

  it("finds the team by metadata and binds the customer id", async () => {
    state.teams = [{ id: 1, plan: "FREE", isActive: true, billingCustomerId: null }];

    await processDodoWebhook(
      "wh_1",
      event("subscription.active", subscription({ customer: { customer_id: "cus_9" } })),
    );

    expect(state.teams[0]).toMatchObject({
      plan: "PRO",
      billingCustomerId: "cus_9",
    });
  });

  it("ignores products that are not Scribase Mail plans (shared Dodo business)", async () => {
    const outcome = await processDodoWebhook(
      "wh_1",
      event("subscription.active", subscription({ product_id: "pdt_menivor" })),
    );

    expect(outcome).toMatchObject({ status: "ignored" });
    expect(state.teams[0]!.plan).toBe("FREE");
    expect(state.subs).toHaveLength(0);
  });

  it("ignores customers with no team", async () => {
    const outcome = await processDodoWebhook(
      "wh_1",
      event(
        "subscription.active",
        subscription({ customer: { customer_id: "cus_x" }, metadata: {} }),
      ),
    );
    expect(outcome).toMatchObject({ status: "ignored" });
  });

  it("syncs from the API on payment.succeeded", async () => {
    retrieve.mockResolvedValue(subscription());

    const outcome = await processDodoWebhook(
      "wh_1",
      event("payment.succeeded", { payment_id: "pay_1", subscription_id: "sub_1" }),
    );

    expect(retrieve).toHaveBeenCalledWith("sub_1");
    expect(outcome).toMatchObject({ status: "processed", plan: "PRO" });
  });

  it("syncs on hold after payment.failed", async () => {
    await processDodoWebhook("wh_1", event("subscription.active", subscription()));
    retrieve.mockResolvedValue(subscription({ status: "on_hold" }));

    await processDodoWebhook(
      "wh_2",
      event("payment.failed", { payment_id: "pay_2", subscription_id: "sub_1" }),
    );

    expect(state.teams[0]).toMatchObject({ plan: "PRO", isActive: false });
  });

  it("ignores one-time payments and unrelated events but still claims them", async () => {
    const p = await processDodoWebhook(
      "wh_1",
      event("payment.succeeded", { payment_id: "pay_1", subscription_id: null }),
    );
    const r = await processDodoWebhook("wh_2", event("refund.succeeded", {}));

    expect(p).toMatchObject({ status: "ignored" });
    expect(r).toMatchObject({ status: "ignored" });
    expect(state.claimed.has("wh_2")).toBe(true);
  });

  it("rolls back the claim when processing fails so a retry can succeed", async () => {
    retrieve.mockRejectedValueOnce(new Error("api down"));
    await expect(
      processDodoWebhook(
        "wh_1",
        event("payment.succeeded", { payment_id: "pay_1", subscription_id: "sub_1" }),
      ),
    ).rejects.toThrow("api down");
    expect(state.claimed.has("wh_1")).toBe(false);

    retrieve.mockResolvedValue(subscription());
    const retry = await processDodoWebhook(
      "wh_1",
      event("payment.succeeded", { payment_id: "pay_1", subscription_id: "sub_1" }),
    );
    expect(retry).toMatchObject({ status: "processed" });
  });

  it("requires a webhook id", async () => {
    await expect(
      processDodoWebhook("", event("subscription.active", subscription())),
    ).rejects.toThrow();
  });
});

describe("afterDodoWebhook", () => {
  beforeEach(() => {
    refreshTeamCache.mockReset();
    getTeamUsers.mockReset();
    sendConfirmation.mockReset();
  });

  it("refreshes the team cache and emails members when a team becomes paid", async () => {
    getTeamUsers.mockResolvedValue([
      { user: { email: "a@example.com" } },
      { user: { email: null } },
    ]);

    await afterDodoWebhook({
      status: "processed",
      teamId: 1,
      plan: "PRO",
      isActive: true,
      becamePaid: true,
    });

    expect(refreshTeamCache).toHaveBeenCalledWith(1);
    expect(sendConfirmation).toHaveBeenCalledTimes(1);
    expect(sendConfirmation).toHaveBeenCalledWith("a@example.com");
  });

  it("does nothing for duplicates and never throws on email failure", async () => {
    await afterDodoWebhook({ status: "duplicate" });
    expect(refreshTeamCache).not.toHaveBeenCalled();

    getTeamUsers.mockRejectedValue(new Error("db"));
    await expect(
      afterDodoWebhook({
        status: "processed",
        teamId: 1,
        plan: "PRO",
        isActive: true,
        becamePaid: true,
      }),
    ).resolves.toBeUndefined();
  });
});
