import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockQueueEmail, mockInvalidate } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    email: { update: vi.fn() },
    emailEvent: { create: vi.fn() },
    emailReview: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    domain: { findUnique: vi.fn() },
    team: { updateMany: vi.fn() },
  },
  mockQueueEmail: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/server/provider", () => ({
  getProviderRegion: () => "eu-frankfurt-1",
}));
vi.mock("./email-queue-service", () => ({
  EmailQueueService: { queueEmail: mockQueueEmail },
}));
vi.mock("./team-service", () => ({
  TeamService: { invalidateTeamCache: mockInvalidate },
}));

import { EmailReviewService } from "./email-review-service";

const now = new Date("2026-10-07T12:00:00Z");

const pendingReview = {
  id: "rv_1",
  emailId: "em_1",
  teamId: 7,
  unsubUrl: "https://mail.scribase.com/unsubscribe?id=c",
  isBulk: true,
  email: { domainId: 3 },
};

describe("EmailReviewService.approve", () => {
  beforeEach(() => {
    mockDb.$transaction.mockResolvedValue([]);
    mockDb.emailReview.findMany.mockResolvedValue([pendingReview]);
    mockDb.emailReview.updateMany.mockResolvedValue({ count: 1 });
    mockDb.domain.findUnique.mockResolvedValue({ region: "us-ashburn-1" });
    mockQueueEmail.mockResolvedValue(undefined);
  });

  it("claims the review, re-queues the email as approved and keeps job data", async () => {
    const result = await EmailReviewService.approve({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      trustTeam: false,
      now,
    });

    expect(result).toEqual({ approved: 1, failed: 0 });
    expect(mockDb.emailReview.updateMany).toHaveBeenCalledWith({
      where: { id: "rv_1", status: "PENDING" },
      data: { status: "APPROVED", decidedAt: now, decidedBy: 1 },
    });
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "QUEUED" },
    });
    expect(mockQueueEmail).toHaveBeenCalledWith(
      "em_1",
      7,
      "us-ashburn-1",
      false, // bulk -> marketing queue
      "https://mail.scribase.com/unsubscribe?id=c",
      undefined,
      { reviewApproved: true },
    );
    expect(mockDb.team.updateMany).not.toHaveBeenCalled();
  });

  it("skips reviews another admin already decided", async () => {
    mockDb.emailReview.updateMany.mockResolvedValue({ count: 0 });
    const result = await EmailReviewService.approve({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      trustTeam: false,
      now,
    });
    expect(result).toEqual({ approved: 0, failed: 0 });
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it("marks the team trusted when asked", async () => {
    await EmailReviewService.approve({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      trustTeam: true,
      now,
    });
    expect(mockDb.team.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] }, sendingTrustedAt: null },
      data: { sendingTrustedAt: now },
    });
    expect(mockInvalidate).toHaveBeenCalledWith(7);
  });

  it("fails the email when it cannot be queued", async () => {
    mockQueueEmail.mockRejectedValue(new Error("redis down"));
    const result = await EmailReviewService.approve({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      trustTeam: false,
      now,
    });
    expect(result).toEqual({ approved: 0, failed: 1 });
    expect(mockDb.email.update).toHaveBeenLastCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
  });
});

describe("EmailReviewService.approveTeam", () => {
  it("approves pending emails in batches until none are left", async () => {
    mockDb.$transaction.mockResolvedValue([]);
    mockDb.emailReview.updateMany.mockResolvedValue({ count: 1 });
    mockDb.domain.findUnique.mockResolvedValue({ region: "eu-frankfurt-1" });
    mockDb.emailReview.findMany
      .mockResolvedValueOnce([{ id: "rv_1" }]) // batch ids
      .mockResolvedValueOnce([pendingReview]) // approve() lookup
      .mockResolvedValueOnce([]); // nothing left

    const result = await EmailReviewService.approveTeam({
      teamId: 7,
      adminUserId: 1,
      trustTeam: true,
      now,
    });
    expect(result).toEqual({ approved: 1, failed: 0 });
    expect(mockDb.team.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("EmailReviewService.reject", () => {
  beforeEach(() => {
    mockDb.$transaction.mockResolvedValue([]);
    mockDb.emailReview.updateMany.mockResolvedValue({ count: 1 });
  });

  it("fails the selected email with the admin note", async () => {
    mockDb.emailReview.findMany
      .mockResolvedValueOnce([{ teamId: 7 }])
      .mockResolvedValueOnce([{ id: "rv_1", emailId: "em_1", teamId: 7 }]);

    const result = await EmailReviewService.reject({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      blockTeam: false,
      note: "phishing",
      now,
    });

    expect(result).toEqual({ rejected: 1, blockedTeams: [] });
    expect(mockDb.email.update).toHaveBeenCalledWith({
      where: { id: "em_1" },
      data: { latestStatus: "FAILED" },
    });
    expect(mockDb.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "FAILED",
        data: { error: "Rejected by Scribase Mail review: phishing" },
      }),
    });
    expect(mockDb.team.updateMany).not.toHaveBeenCalled();
  });

  it("blocks the team and rejects all of its held emails", async () => {
    mockDb.emailReview.findMany
      .mockResolvedValueOnce([{ teamId: 7 }])
      .mockResolvedValueOnce([
        { id: "rv_1", emailId: "em_1", teamId: 7 },
        { id: "rv_2", emailId: "em_2", teamId: 7 },
      ])
      .mockResolvedValueOnce([]);

    const result = await EmailReviewService.reject({
      reviewIds: ["rv_1"],
      adminUserId: 1,
      blockTeam: true,
      now,
    });

    expect(result).toEqual({ rejected: 2, blockedTeams: [7] });
    expect(mockDb.team.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] }, isBlocked: false },
      data: expect.objectContaining({
        isBlocked: true,
        blockedReason: "REVIEW: held email rejected by admin",
      }),
    });
    expect(mockDb.emailReview.findMany).toHaveBeenNthCalledWith(2, {
      where: { teamId: { in: [7] }, status: "PENDING" },
      select: { id: true, emailId: true, teamId: true },
      take: 200,
    });
    expect(mockInvalidate).toHaveBeenCalledWith(7);
  });
});

describe("EmailReviewService.listPending", () => {
  it("pages with a cursor and reports the pending total", async () => {
    mockDb.emailReview.findMany.mockResolvedValue([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    mockDb.emailReview.count.mockResolvedValue(3);
    const result = await EmailReviewService.listPending({ limit: 2 });
    expect(result.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.nextCursor).toBe("b");
    expect(mockDb.emailReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PENDING" }, take: 3 }),
    );
    await EmailReviewService.listPending({ limit: 2, cursor: "b", teamId: 7 });
    expect(mockDb.emailReview.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { status: "PENDING", teamId: 7 },
        cursor: { id: "b" },
        skip: 1,
      }),
    );
    expect(result.pendingTotal).toBe(3);
  });
});
