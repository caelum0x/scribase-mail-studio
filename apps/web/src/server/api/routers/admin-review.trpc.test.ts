import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReviewService } = vi.hoisted(() => {
  process.env.ADMIN_EMAIL = "admin@scribase.com";
  return {
    mockReviewService: {
      listPending: vi.fn(),
      getPreview: vi.fn(),
      approve: vi.fn(),
      approveTeam: vi.fn(),
      reject: vi.fn(),
    },
  };
});

vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/auth", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("~/server/service/email-review-service", () => ({
  EmailReviewService: mockReviewService,
  MAX_REVIEW_BATCH: 200,
}));
vi.mock("~/server/screening/threat-feed-store", () => ({
  getThreatFeedMeta: vi.fn(async () => ({ hosts: 10 })),
}));

import { createCallerFactory } from "~/server/api/trpc";
import { adminReviewRouter } from "~/server/api/routers/admin-review";

const createCaller = createCallerFactory(adminReviewRouter);

function context(email: string) {
  return {
    db: {},
    headers: new Headers(),
    session: {
      user: {
        id: 42,
        email,
        isWaitlisted: false,
        isAdmin: email === "admin@scribase.com",
        isBetaUser: true,
      },
    },
  } as any;
}

const admin = () => createCaller(context("admin@scribase.com"));

describe("adminReviewRouter", () => {
  beforeEach(() => {
    mockReviewService.approve.mockResolvedValue({ approved: 1, failed: 0 });
    mockReviewService.reject.mockResolvedValue({
      rejected: 1,
      blockedTeams: [],
    });
  });

  it("refuses non-admin users", async () => {
    const caller = createCaller(context("customer@example.com"));
    await expect(caller.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.approve({ reviewIds: ["rv_1"] })).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
    expect(mockReviewService.approve).not.toHaveBeenCalled();
  });

  it("approves with the admin's user id and defaults trustTeam to false", async () => {
    await expect(admin().approve({ reviewIds: ["rv_1"] })).resolves.toEqual({
      approved: 1,
      failed: 0,
    });
    expect(mockReviewService.approve).toHaveBeenCalledWith({
      reviewIds: ["rv_1"],
      adminUserId: 42,
      trustTeam: false,
    });
  });

  it("rejects with block and a trimmed note", async () => {
    await admin().reject({
      reviewIds: ["rv_1"],
      blockTeam: true,
      note: "  phishing kit  ",
    });
    expect(mockReviewService.reject).toHaveBeenCalledWith({
      reviewIds: ["rv_1"],
      adminUserId: 42,
      blockTeam: true,
      note: "phishing kit",
    });
  });

  it("validates review id batches", async () => {
    await expect(admin().approve({ reviewIds: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      admin().approve({
        reviewIds: Array.from({ length: 201 }, (_, i) => `rv_${i}`),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("previews without attachment contents", async () => {
    mockReviewService.getPreview.mockResolvedValue({
      id: "rv_1",
      status: "PENDING",
      email: {
        id: "em_1",
        from: "a@b.test",
        to: ["c@d.test"],
        replyTo: [],
        subject: "Hi",
        html: "<p>Hi</p>",
        text: null,
        attachments: JSON.stringify([
          { filename: "invoice.pdf", content: "SECRET_BASE64" },
        ]),
      },
    });
    const preview = await admin().preview({ reviewId: "rv_1" });
    expect(preview.email.attachments).toEqual(["invoice.pdf"]);
    expect(JSON.stringify(preview)).not.toContain("SECRET_BASE64");
  });

  it("returns NOT_FOUND for unknown reviews", async () => {
    mockReviewService.getPreview.mockResolvedValue(null);
    await expect(admin().preview({ reviewId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("approves a whole team", async () => {
    mockReviewService.approveTeam.mockResolvedValue({ approved: 5, failed: 0 });
    await admin().approveTeam({ teamId: 7, trustTeam: true });
    expect(mockReviewService.approveTeam).toHaveBeenCalledWith({
      teamId: 7,
      adminUserId: 42,
      trustTeam: true,
    });
  });
});
