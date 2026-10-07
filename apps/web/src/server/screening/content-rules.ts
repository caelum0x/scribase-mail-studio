import { SCREENING_POLICY } from "~/lib/constants/sending-policy";
import {
  extractLinks,
  hostCandidates,
  isIpHost,
  isShortenerHost,
  isTextHrefMismatch,
  type ExtractedLink,
} from "./url-extraction";

/**
 * In-process content screening for outgoing email. Pure: callers supply the
 * threat-feed lookup, so this file has no I/O and is cheap enough to run on
 * every message.
 */

export type ScreeningAction = "allow" | "hold" | "reject";

export type FindingCode =
  | "MALICIOUS_URL"
  | "BLOCKED_DOMAIN"
  | "BLOCKED_ATTACHMENT"
  | "RISKY_ATTACHMENT"
  | "IP_URL"
  | "URL_SHORTENER"
  | "LINK_TEXT_MISMATCH"
  | "SCRIPT_URL"
  | "DATA_URL"
  | "BASE64_BODY"
  | "MISSING_UNSUBSCRIBE"
  | "CREDENTIAL_PHISHING"
  | "CRYPTO_SCAM"
  | "GIFT_CARD_SCAM"
  | "SPAM_PHRASES"
  | "ALL_CAPS_SUBJECT"
  | "EXCESSIVE_EXCLAMATION"
  | "HIDDEN_TEXT"
  | "FORM_IN_BODY"
  | "SCRIPT_TAG";

export type ScreeningFinding = {
  code: FindingCode;
  // reject/hold decide on their own; score findings add up.
  severity: "reject" | "hold" | "score";
  score: number;
  message: string;
  detail?: string;
};

export type ScreeningVerdict = {
  action: ScreeningAction;
  score: number;
  // A reject for malicious content; repeated strikes block the team.
  strike: boolean;
  findings: ScreeningFinding[];
};

export type ScreeningInput = {
  subject: string;
  html?: string | null;
  text?: string | null;
  attachments?: Array<{ filename: string }>;
  isMarketing: boolean;
  hasListUnsubscribe: boolean;
};

export type ScreeningContext = {
  // eslint-disable-next-line no-unused-vars -- parameter name in type signature
  isListedHost: (host: string) => boolean;
  blockedDomains: string[];
};

const STRIKE_CODES: ReadonlySet<FindingCode> = new Set([
  "MALICIOUS_URL",
  "BLOCKED_DOMAIN",
  "BLOCKED_ATTACHMENT",
]);

// Executables, scripts, disk images and shortcuts: never sent.
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "scr",
  "com",
  "pif",
  "bat",
  "cmd",
  "js",
  "jse",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "hta",
  "msi",
  "msp",
  "msc",
  "cpl",
  "jar",
  "ps1",
  "psm1",
  "lnk",
  "iso",
  "img",
  "vhd",
  "vhdx",
  "dll",
  "reg",
  "scf",
  "apk",
  "appx",
  "msix",
  "inf",
  "chm",
  "xll",
  "gadget",
  "application",
  "dmg",
]);
// Macro documents and browser-rendered files used for credential phishing.
const RISKY_EXTENSIONS = new Set([
  "docm",
  "dotm",
  "xlsm",
  "xltm",
  "xlam",
  "pptm",
  "potm",
  "ppam",
  "html",
  "htm",
  "shtml",
  "xhtml",
  "svg",
  "mht",
  "mhtml",
]);

const PHRASE_GROUPS: Array<{
  code: FindingCode;
  score: number;
  message: string;
  patterns: RegExp[];
}> = [
  {
    code: "CREDENTIAL_PHISHING",
    score: 3,
    message: "Language typical of credential phishing",
    patterns: [
      /\b(account|mailbox|password|apple id|wallet) (has been |was |will be )?(suspended|locked|disabled|deactivated|terminated|on hold)\b/,
      /\bunusual (sign[- ]?in|login|log[- ]?in) (activity|attempt)/,
      /\bconfirm (your )?(password|login details|credentials)\b/,
      /\b(re-?enter|validate|verify) (your )?(credentials|password|login details)\b/,
      /\bmailbox (is )?(full|over (its )?quota)\b/,
      /\bpassword (expires|will expire|has expired)\b/,
      /\bupdate (your )?(billing|payment) (info|information|details) (now|immediately|to avoid)/,
    ],
  },
  {
    code: "CRYPTO_SCAM",
    score: 3,
    message: "Language typical of crypto scams",
    patterns: [
      /\b(seed|recovery|secret) phrase\b/,
      /\b(private|wallet) key\b/,
      /\bsend (btc|bitcoin|eth|ethereum|usdt|crypto)\b/,
      /\bdouble your (bitcoin|crypto|btc|eth|money)\b/,
      /\b(crypto|bitcoin|token|nft) (airdrop|giveaway)\b/,
      /\bclaim (your )?(airdrop|free tokens|tokens|crypto)\b/,
      /\bconnect (your )?wallet\b/,
    ],
  },
  {
    code: "GIFT_CARD_SCAM",
    score: 3,
    message: "Language typical of gift card scams",
    patterns: [
      /\b(buy|purchase|get) (me )?(some )?((itunes|apple|google play|steam|amazon|ebay|walmart|target|visa) )?gift ?cards?\b/,
      /\b(scratch|send me) (off )?(the )?(codes?|card)\b/,
      /\bgift ?card (codes?|numbers?)\b/,
    ],
  },
];

const SPAM_PHRASES = [
  /\b100% free\b/,
  /\bact now\b/,
  /\brisk[- ]free\b/,
  /\byou (have|'ve) won\b/,
  /\bcongratulations,? you\b/,
  /\bclaim your (prize|reward)\b/,
  /\blimited time offer\b/,
  /\bcash bonus\b/,
  /\bno credit check\b/,
  /\bearn \$\d/,
  /\bwork from home\b/,
  /\b(viagra|cialis)\b/,
  /\bonline casino\b/,
  /\bwire transfer\b/,
  /\bbeneficiary\b/,
];
const SPAM_PHRASE_MAX_SCORE = 4;

const HIDDEN_STYLE =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|max-height\s*:\s*0(?:px)?\s*(?:;|$))/i;
const STYLED_ELEMENT =
  /<(\w+)\b[^>]{0,2000}?\bstyle\s*=\s*(["'])([^"']{0,2000})\2[^>]{0,2000}>([\s\S]{0,8000}?)<\/\1\s*>/gi;
// Markup checks only look at the start of very large bodies.
const MAX_MARKUP_SCAN_CHARS = 500_000;
const HIDDEN_TEXT_MIN_CHARS = 300;

const BASE64_RUN = /[A-Za-z0-9+/]{400,}={0,2}/g;
const UNSUBSCRIBE_TEXT =
  /unsubscribe|opt[- ]?out|abmelden|d[ée]sinscri|darse de baja|abonelikten [çc]ık|manage (your )?(email )?preferences/i;

function finding(
  code: FindingCode,
  severity: ScreeningFinding["severity"],
  score: number,
  message: string,
  detail?: string,
): ScreeningFinding {
  return detail === undefined
    ? { code, severity, score, message }
    : { code, severity, score, message, detail: detail.slice(0, 200) };
}

function visibleText(
  html: string | null | undefined,
  text: string | null | undefined,
) {
  const fromHtml = (html ?? "")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return `${fromHtml} ${text ?? ""}`.replace(/\s+/g, " ").trim();
}

function extensionOf(filename: string): string {
  const base = filename
    .trim()
    .toLowerCase()
    .replace(/[\s.]+$/, "");
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1);
}

function attachmentFindings(
  attachments: ScreeningInput["attachments"],
): ScreeningFinding[] {
  return (attachments ?? []).flatMap((attachment) => {
    const ext = extensionOf(attachment.filename);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return [
        finding(
          "BLOCKED_ATTACHMENT",
          "reject",
          0,
          `Attachment type .${ext} is not allowed`,
          attachment.filename,
        ),
      ];
    }
    if (RISKY_EXTENSIONS.has(ext)) {
      return [
        finding(
          "RISKY_ATTACHMENT",
          "hold",
          0,
          `Attachment type .${ext} needs review`,
          attachment.filename,
        ),
      ];
    }
    return [];
  });
}

function isBlockedDomain(host: string, blockedDomains: string[]): boolean {
  if (blockedDomains.length === 0) return false;
  const blocked = new Set(blockedDomains.map((d) => d.toLowerCase()));
  return hostCandidates(host).some((candidate) => blocked.has(candidate));
}

function firstLink(
  links: ExtractedLink[],
  predicate: (link: ExtractedLink) => boolean, // eslint-disable-line no-unused-vars
): ExtractedLink | undefined {
  return links.find(predicate);
}

function linkFindings(
  links: ExtractedLink[],
  ctx: ScreeningContext,
): ScreeningFinding[] {
  const findings: ScreeningFinding[] = [];
  const webLinks = links.filter((l) => l.host);

  const malicious = firstLink(webLinks, (l) => ctx.isListedHost(l.host));
  if (malicious) {
    findings.push(
      finding(
        "MALICIOUS_URL",
        "reject",
        0,
        "Link to a known phishing or malware host",
        malicious.host,
      ),
    );
  }
  const blocked = firstLink(webLinks, (l) =>
    isBlockedDomain(l.host, ctx.blockedDomains),
  );
  if (blocked) {
    findings.push(
      finding(
        "BLOCKED_DOMAIN",
        "reject",
        0,
        "Link to a blocked domain",
        blocked.host,
      ),
    );
  }
  const ip = firstLink(webLinks, (l) => isIpHost(l.host));
  if (ip) {
    findings.push(
      finding("IP_URL", "hold", 0, "Link to a raw IP address", ip.host),
    );
  }
  const shortener = firstLink(webLinks, (l) => isShortenerHost(l.host));
  if (shortener) {
    findings.push(
      finding(
        "URL_SHORTENER",
        "hold",
        0,
        "Link through a URL shortener hides the destination",
        shortener.host,
      ),
    );
  }
  const mismatch = firstLink(
    webLinks,
    (l) => Boolean(l.displayText) && isTextHrefMismatch(l.displayText!, l.url),
  );
  if (mismatch) {
    findings.push(
      finding(
        "LINK_TEXT_MISMATCH",
        "hold",
        0,
        "Link text shows a different domain than the real link",
        `${mismatch.displayText} -> ${mismatch.host}`,
      ),
    );
  }
  const script = firstLink(
    links,
    (l) => l.scheme === "javascript:" || l.scheme === "vbscript:",
  );
  if (script) {
    findings.push(finding("SCRIPT_URL", "hold", 0, "Script link in the email"));
  }
  const data = firstLink(
    links,
    (l) => l.scheme === "data:" && !/^data:\s*image\//i.test(l.url),
  );
  if (data) {
    findings.push(
      finding(
        "DATA_URL",
        "hold",
        0,
        "Embedded data: link that is not an image",
      ),
    );
  }
  return findings;
}

function hiddenTextLength(html: string): { chars: number; hasLink: boolean } {
  let chars = 0;
  let hasLink = false;
  for (const match of html.matchAll(STYLED_ELEMENT)) {
    if (!HIDDEN_STYLE.test(match[3] ?? "")) continue;
    const inner = match[4] ?? "";
    if (/<a\b/i.test(inner)) hasLink = true;
    chars += visibleText(inner, null).replace(/[^\p{L}\p{N}]/gu, "").length;
  }
  return { chars, hasLink };
}

function textFindings(input: ScreeningInput, links: ExtractedLink[]) {
  const findings: ScreeningFinding[] = [];
  const body = visibleText(input.html, input.text);
  const haystack = `${input.subject} ${body}`.toLowerCase();

  for (const group of PHRASE_GROUPS) {
    const hit = group.patterns.find((p) => p.test(haystack));
    if (!hit) continue;
    // Phishing language next to a link is what makes it dangerous.
    const bonus = group.code === "CREDENTIAL_PHISHING" && links.length ? 1 : 0;
    findings.push(
      finding(
        group.code,
        "score",
        group.score + bonus,
        group.message,
        hit.exec(haystack)?.[0],
      ),
    );
  }

  const spamHits = SPAM_PHRASES.filter((p) => p.test(haystack)).length;
  if (spamHits > 0) {
    findings.push(
      finding(
        "SPAM_PHRASES",
        "score",
        Math.min(spamHits, SPAM_PHRASE_MAX_SCORE),
        "Common spam phrases",
        `${spamHits} phrase(s)`,
      ),
    );
  }

  const letters = input.subject.replace(/[^\p{L}]/gu, "");
  const upper = letters.replace(/[^\p{Lu}]/gu, "");
  if (letters.length >= 10 && upper.length / letters.length > 0.7) {
    findings.push(
      finding(
        "ALL_CAPS_SUBJECT",
        "score",
        1.5,
        "Subject is mostly capital letters",
      ),
    );
  }

  const subjectBangs = (input.subject.match(/!/g) ?? []).length;
  const bodyBangs = (body.match(/!/g) ?? []).length;
  if (subjectBangs >= 3 || bodyBangs >= 15) {
    findings.push(
      finding(
        "EXCESSIVE_EXCLAMATION",
        "score",
        1,
        "Too many exclamation marks",
      ),
    );
  }

  const nonSpace = body.replace(/\s/g, "");
  const base64Chars = (nonSpace.match(BASE64_RUN) ?? []).reduce(
    (sum, run) => sum + run.length,
    0,
  );
  if (base64Chars >= 400 && base64Chars / nonSpace.length > 0.6) {
    findings.push(
      finding(
        "BASE64_BODY",
        "hold",
        0,
        "The body is mostly an encoded blob, not readable text",
      ),
    );
  }

  if (
    input.isMarketing &&
    !input.hasListUnsubscribe &&
    !UNSUBSCRIBE_TEXT.test(`${input.html ?? ""} ${input.text ?? ""}`)
  ) {
    findings.push(
      finding(
        "MISSING_UNSUBSCRIBE",
        "hold",
        0,
        "Marketing email without an unsubscribe link",
      ),
    );
  }
  return findings;
}

function markupFindings(html: string): ScreeningFinding[] {
  const findings: ScreeningFinding[] = [];
  const hidden = hiddenTextLength(html);
  if (hidden.chars >= HIDDEN_TEXT_MIN_CHARS || hidden.hasLink) {
    findings.push(
      finding(
        "HIDDEN_TEXT",
        "score",
        2,
        "Hidden text or links in the html",
        `${hidden.chars} hidden characters`,
      ),
    );
  }
  if (/<form\b/i.test(html)) {
    findings.push(finding("FORM_IN_BODY", "score", 3, "Email contains a form"));
  }
  if (/<script\b/i.test(html)) {
    findings.push(
      finding("SCRIPT_TAG", "score", 2, "Email contains a script tag"),
    );
  }
  return findings;
}

export function decideAction(
  findings: ScreeningFinding[],
): Pick<ScreeningVerdict, "action" | "score" | "strike"> {
  const score = findings.reduce((sum, f) => sum + f.score, 0);
  const rejecting = findings.filter((f) => f.severity === "reject");
  if (rejecting.length > 0) {
    return {
      action: "reject",
      score,
      strike: rejecting.some((f) => STRIKE_CODES.has(f.code)),
    };
  }
  if (score >= SCREENING_POLICY.rejectScore) {
    return { action: "reject", score, strike: false };
  }
  if (
    score >= SCREENING_POLICY.holdScore ||
    findings.some((f) => f.severity === "hold")
  ) {
    return { action: "hold", score, strike: false };
  }
  return { action: "allow", score, strike: false };
}

export function screenContent(
  input: ScreeningInput,
  ctx: ScreeningContext,
): ScreeningVerdict {
  const links = extractLinks({ html: input.html, text: input.text });
  const findings = [
    ...attachmentFindings(input.attachments),
    ...linkFindings(links, ctx),
    ...textFindings(input, links),
    ...markupFindings((input.html ?? "").slice(0, MAX_MARKUP_SCAN_CHARS)),
  ];
  return { ...decideAction(findings), findings };
}

/** Short customer-facing summary, e.g. for API errors and email events. */
export function describeFindings(findings: ScreeningFinding[]): string {
  return findings
    .filter((f) => f.severity !== "score" || f.score >= 2)
    .map((f) => (f.detail ? `${f.message} (${f.detail})` : f.message))
    .join("; ");
}
