/**
 * Segment service — Resend /segments and /audiences (alias) API (Wave 2 B1).
 *
 * A Segment is a named static collection of contacts.  The /audiences endpoint
 * is an alias (Resend deprecated audiences in favour of segments).
 */
import { db } from "../db";
import { UnsendApiError } from "../public-api/api-error";

export class SegmentService {
  static async create(teamId: number, name: string) {
    return db.segment.create({ data: { teamId, name } });
  }

  static async get(teamId: number, segmentId: string) {
    const segment = await db.segment.findFirst({
      where: { id: segmentId, teamId },
      include: { _count: { select: { contacts: true } } },
    });
    if (!segment) {
      throw new UnsendApiError({ code: "NOT_FOUND", message: "Segment not found" });
    }
    return segment;
  }

  static async list(teamId: number) {
    return db.segment.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { contacts: true } } },
    });
  }

  static async update(teamId: number, segmentId: string, name: string) {
    await SegmentService.get(teamId, segmentId);
    return db.segment.update({ where: { id: segmentId }, data: { name } });
  }

  static async delete(teamId: number, segmentId: string) {
    await SegmentService.get(teamId, segmentId);
    await db.segment.delete({ where: { id: segmentId } });
  }

  /** Add one or many contacts to the segment.  Silently skips duplicates. */
  static async addContacts(
    teamId: number,
    segmentId: string,
    contactIds: string[],
  ) {
    await SegmentService.get(teamId, segmentId);

    // Verify all contacts belong to a book owned by this team.
    const contacts = await db.contact.findMany({
      where: {
        id: { in: contactIds },
        contactBook: { teamId },
      },
      select: { id: true },
    });

    if (contacts.length === 0) {
      throw new UnsendApiError({
        code: "BAD_REQUEST",
        message: "No valid contacts found for this team",
      });
    }

    await db.segmentContact.createMany({
      data: contacts.map((c) => ({ segmentId, contactId: c.id })),
      skipDuplicates: true,
    });

    return contacts;
  }

  /** Remove contacts from segment. */
  static async removeContacts(
    teamId: number,
    segmentId: string,
    contactIds: string[],
  ) {
    await SegmentService.get(teamId, segmentId);
    await db.segmentContact.deleteMany({
      where: { segmentId, contactId: { in: contactIds } },
    });
  }

  /** List contacts in a segment. */
  static async listContacts(teamId: number, segmentId: string) {
    await SegmentService.get(teamId, segmentId);
    return db.contact.findMany({
      where: { segments: { some: { segmentId } }, contactBook: { teamId } },
      orderBy: { createdAt: "desc" },
    });
  }
}
