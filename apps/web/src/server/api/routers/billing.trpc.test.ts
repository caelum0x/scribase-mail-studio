import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, sdk, envState, updateTeam, getTeamUsers } = vi.hoisted(() => ({
  mockDb: {
    teamUser: { findFirst: vi.fn() },
    team: { findUnique: vi.fn() },
    subscription: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
  sdk: {
    customers: {
      create: vi.fn(),
      customerPortal: { create: vi.fn() },
    },
    checkoutSessions: { create: vi.fn() },
    subscriptions: { changePlan: vi.fn(), update: vi.fn() },
  },
  envState: { current: {} as Record<string, string | undefined> },
  updateTeam: vi.fn(),
  getTeamUsers: vi.fn(),
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/auth", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("~/env", () => ({
  get env() {
    return envState.current;
  },
}));
vi.mock("~/server/service/team-service", () => ({
  TeamService: { updateTeam, getTeamUsers },
}));
vi.mock("~/server/service/usage-service", () => ({
  getThisMonthUsage: vi.fn(),
}));
vi.mock("~/server/billing/dodo-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/server/billing/dodo-client")>();
  return { ...actual, getDodoClient: () => sdk };
});

import { createCallerFactory } from "~/server/api/trpc";
import { billingRouter } from "~/server/api/routers/billing";

const createCaller = createCallerFactory(billingRouter);

function caller() {
  return createCaller({
    db: mockDb,
    headers: new Headers(),
    session: {
      user: {
        id: 1,
        email: "admin@example.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: true,
      },
    },
  } as never);
}

const TEAM = {
  id: 1,
  name: "Acme",
  plan: "FREE",
  isActive: true,
  billingCustomerId: null as string | null,
  billingEmail: "billing@acme.test",
};

describe("billingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.current = {
      DODO_PAYMENTS_API_KEY: "test-key",
      DODO_PRODUCT_ID_PRO: "pdt_pro",
      DODO_PRODUCT_ID_SCALE: "pdt_scale",
      NEXTAUTH_URL: "https://mail.example.test",
    };
    mockDb.teamUser.findFirst.mockResolvedValue({
      role: "ADMIN",
      team: { id: 1, name: "Acme" },
    });
    mockDb.team.findUnique.mockResolvedValue({ ...TEAM });
    mockDb.subscription.findMany.mockResolvedValue([]);
  });

  it("reports billing as not configured without keys", async () => {
    envState.current = {};
    await expect(caller().getBillingStatus()).resolves.toEqual({
      configured: false,
      availablePlans: [],
    });
    await expect(
      caller().createCheckoutSession({ plan: "PRO" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Billing not configured",
    });
  });

  it("lists only plans with a configured product", async () => {
    envState.current = { ...envState.current, DODO_PRODUCT_ID_SCALE: undefined };
    await expect(caller().getBillingStatus()).resolves.toEqual({
      configured: true,
      availablePlans: ["PRO"],
    });
  });

  it("creates a Dodo customer and a checkout for the chosen plan", async () => {
    sdk.customers.create.mockResolvedValue({ customer_id: "cus_new" });
    sdk.checkoutSessions.create.mockResolvedValue({
      session_id: "cks_1",
      checkout_url: "https://checkout.example/cks_1",
    });

    const url = await caller().createCheckoutSession({ plan: "SCALE" });

    expect(url).toBe("https://checkout.example/cks_1");
    expect(sdk.customers.create).toHaveBeenCalledWith({
      email: "billing@acme.test",
      name: "Acme",
      metadata: { teamId: "1", app: "scribase-mail" },
    });
    expect(updateTeam).toHaveBeenCalledWith(1, {
      billingCustomerId: "cus_new",
      billingEmail: "billing@acme.test",
    });
    expect(sdk.checkoutSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product_cart: [{ product_id: "pdt_scale", quantity: 1 }],
        customer: { customer_id: "cus_new" },
        metadata: { teamId: "1", plan: "SCALE", app: "scribase-mail" },
      }),
    );
  });

  it("reuses an existing customer", async () => {
    mockDb.team.findUnique.mockResolvedValue({
      ...TEAM,
      billingCustomerId: "cus_old",
    });
    sdk.checkoutSessions.create.mockResolvedValue({
      session_id: "cks_2",
      checkout_url: "https://checkout.example/cks_2",
    });

    await caller().createCheckoutSession({ plan: "PRO" });

    expect(sdk.customers.create).not.toHaveBeenCalled();
    expect(sdk.checkoutSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: { customer_id: "cus_old" } }),
    );
  });

  it("refuses a second checkout while a subscription is live", async () => {
    mockDb.subscription.findMany.mockResolvedValue([
      { id: "sub_1", status: "active", productId: "pdt_pro", plan: "PRO" },
    ]);
    await expect(
      caller().createCheckoutSession({ plan: "SCALE" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("changes plan with prorated billing", async () => {
    mockDb.subscription.findMany.mockResolvedValue([
      { id: "sub_1", status: "active", productId: "pdt_pro", plan: "PRO" },
    ]);

    await caller().changePlan({ plan: "SCALE" });

    expect(sdk.subscriptions.changePlan).toHaveBeenCalledWith("sub_1", {
      product_id: "pdt_scale",
      quantity: 1,
      proration_billing_mode: "prorated_immediately",
      on_payment_failure: "prevent_change",
    });
  });

  it("cancels at the end of the billing period", async () => {
    const end = new Date("2026-11-07T00:00:00Z");
    mockDb.subscription.findMany.mockResolvedValue([
      {
        id: "sub_1",
        status: "active",
        productId: "pdt_pro",
        plan: "PRO",
        currentPeriodEnd: end,
      },
    ]);

    await caller().cancelSubscription();

    expect(sdk.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      cancel_at_next_billing_date: true,
    });
    expect(mockDb.subscription.update).toHaveBeenCalledWith({
      where: { id: "sub_1" },
      data: { cancelAtPeriodEnd: end },
    });
  });

  it("opens the customer portal", async () => {
    mockDb.team.findUnique.mockResolvedValue({
      ...TEAM,
      billingCustomerId: "cus_old",
    });
    sdk.customers.customerPortal.create.mockResolvedValue({
      link: "https://portal.example/x",
    });

    await expect(caller().getManageSessionUrl()).resolves.toBe(
      "https://portal.example/x",
    );
    expect(sdk.customers.customerPortal.create).toHaveBeenCalledWith(
      "cus_old",
      { return_url: "https://mail.example.test/settings/billing" },
    );
  });

  it("hides provider errors from the client", async () => {
    mockDb.team.findUnique.mockResolvedValue({
      ...TEAM,
      billingCustomerId: "cus_old",
    });
    sdk.checkoutSessions.create.mockRejectedValue(
      new Error("401 secret internal detail"),
    );

    await expect(
      caller().createCheckoutSession({ plan: "PRO" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Billing provider error. Please try again.",
    });
  });

  it("blocks non-admin members from billing changes", async () => {
    mockDb.teamUser.findFirst.mockResolvedValue({
      role: "MEMBER",
      team: { id: 1, name: "Acme" },
    });
    await expect(
      caller().createCheckoutSession({ plan: "PRO" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(sdk.checkoutSessions.create).not.toHaveBeenCalled();
  });
});
