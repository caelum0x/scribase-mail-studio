import { db } from "~/server/db";
import type { DkimKeyStore } from "./smtp-provider";

/** Candidate domain names from most to least specific: a.b.c -> a.b.c, b.c */
export function candidateDomains(domainName: string) {
  const labels = domainName.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/** DKIM keys stored in DomainDkimKey (generic SMTP provider). */
export const prismaDkimKeyStore: DkimKeyStore = {
  async getSigningKey(domainName) {
    const names = candidateDomains(domainName);
    if (names.length === 0) {
      return null;
    }
    const domains = await db.domain.findMany({
      where: { name: { in: names }, dkimKey: { isNot: null } },
      select: { name: true, dkimKey: { select: { selector: true, privateKey: true } } },
    });
    for (const name of names) {
      const match = domains.find((d) => d.name.toLowerCase() === name);
      if (match?.dkimKey) {
        return {
          domainName: name,
          selector: match.dkimKey.selector,
          privateKey: match.dkimKey.privateKey,
        };
      }
    }
    return null;
  },
};
