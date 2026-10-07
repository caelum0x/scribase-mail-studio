import { describe, expect, it } from "vitest";
import {
  decideAction,
  screenContent,
  type ScreeningContext,
  type ScreeningInput,
} from "./content-rules";

const ctx: ScreeningContext = {
  isListedHost: (host) => host === "evil.test" || host.endsWith(".evil.test"),
  blockedDomains: ["banned.test"],
};

function input(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    subject: "Your receipt",
    html: '<p>Thanks for your order. <a href="https://shop.example.com/orders/1">View order</a></p>',
    text: null,
    attachments: [],
    isMarketing: false,
    hasListUnsubscribe: false,
    ...overrides,
  };
}

const codes = (v: ReturnType<typeof screenContent>) =>
  v.findings.map((f) => f.code);

describe("screenContent", () => {
  it("allows an ordinary transactional email", () => {
    const verdict = screenContent(input(), ctx);
    expect(verdict.action).toBe("allow");
    expect(verdict.findings).toEqual([]);
  });

  it("allows a normal signup confirmation with a hidden preheader", () => {
    const verdict = screenContent(
      input({
        subject: "Confirm your email address",
        html: `<div style="display:none">Welcome to Acme, one more step</div>
          <p>Please verify your email address to finish signing up.</p>
          <a href="https://app.acme.com/verify?token=abc">Verify email</a>`,
      }),
      ctx,
    );
    expect(verdict.action).toBe("allow");
  });

  it("rejects links to hosts on a threat feed and counts a strike", () => {
    const verdict = screenContent(
      input({ html: '<a href="https://login.evil.test/x">Log in</a>' }),
      ctx,
    );
    expect(verdict.action).toBe("reject");
    expect(verdict.strike).toBe(true);
    expect(codes(verdict)).toContain("MALICIOUS_URL");
    expect(verdict.findings[0]?.detail).toBe("login.evil.test");
  });

  it("finds malicious targets hidden behind redirects", () => {
    const verdict = screenContent(
      input({
        html: `<a href="https://www.google.com/url?q=${encodeURIComponent("https://evil.test/a")}">x</a>`,
      }),
      ctx,
    );
    expect(verdict.action).toBe("reject");
  });

  it("rejects admin-blocked domains", () => {
    const verdict = screenContent(
      input({ text: "go to https://www.banned.test now", html: null }),
      ctx,
    );
    expect(verdict.action).toBe("reject");
    expect(codes(verdict)).toContain("BLOCKED_DOMAIN");
  });

  it("rejects dangerous attachment types", () => {
    for (const filename of [
      "invoice.pdf.exe",
      "run.JS",
      "a.scr",
      "disk.iso",
      "x.lnk",
    ]) {
      const verdict = screenContent(
        input({ attachments: [{ filename }] }),
        ctx,
      );
      expect(verdict.action, filename).toBe("reject");
      expect(codes(verdict)).toContain("BLOCKED_ATTACHMENT");
    }
  });

  it("holds macro documents and html/svg attachments", () => {
    expect(
      screenContent(input({ attachments: [{ filename: "q3.xlsm" }] }), ctx)
        .action,
    ).toBe("hold");
    expect(
      screenContent(input({ attachments: [{ filename: "scan.svg" }] }), ctx)
        .action,
    ).toBe("hold");
  });

  it("allows ordinary attachments", () => {
    const verdict = screenContent(
      input({
        attachments: [{ filename: "invoice.pdf" }, { filename: "a.png" }],
      }),
      ctx,
    );
    expect(verdict.action).toBe("allow");
  });

  it("holds raw IP links and URL shorteners", () => {
    expect(
      codes(
        screenContent(
          input({ html: '<a href="http://203.0.113.9/x">x</a>' }),
          ctx,
        ),
      ),
    ).toContain("IP_URL");
    const verdict = screenContent(
      input({ html: '<a href="https://bit.ly/abc">x</a>' }),
      ctx,
    );
    expect(verdict.action).toBe("hold");
    expect(codes(verdict)).toContain("URL_SHORTENER");
  });

  it("holds links whose visible text names another domain", () => {
    const verdict = screenContent(
      input({
        html: '<a href="https://evil-but-unlisted.test/login">https://www.paypal.com/signin</a>',
      }),
      ctx,
    );
    expect(verdict.action).toBe("hold");
    expect(codes(verdict)).toContain("LINK_TEXT_MISMATCH");
  });

  it("holds javascript: and data: links", () => {
    expect(
      codes(
        screenContent(input({ html: '<a href="javascript:x()">x</a>' }), ctx),
      ),
    ).toContain("SCRIPT_URL");
    expect(
      codes(
        screenContent(
          input({ html: '<a href="data:text/html;base64,AAAA">x</a>' }),
          ctx,
        ),
      ),
    ).toContain("DATA_URL");
  });

  it("scores phishing language and holds when combined with other signals", () => {
    const verdict = screenContent(
      input({
        subject: "URGENT: YOUR ACCOUNT HAS BEEN SUSPENDED!!!",
        html: '<p>Unusual sign-in activity. Confirm your password here: <a href="https://acc-check.test/x">restore</a></p>',
      }),
      ctx,
    );
    expect(codes(verdict)).toEqual(
      expect.arrayContaining([
        "CREDENTIAL_PHISHING",
        "ALL_CAPS_SUBJECT",
        "EXCESSIVE_EXCLAMATION",
      ]),
    );
    expect(verdict.action).toBe("hold");
  });

  it("holds crypto and gift card scams", () => {
    const verdict = screenContent(
      input({
        subject: "Claim your airdrop",
        html: "<p>Connect your wallet and enter your seed phrase. Also buy me some gift cards and send me the codes.</p>",
      }),
      ctx,
    );
    expect(codes(verdict)).toEqual(
      expect.arrayContaining(["CRYPTO_SCAM", "GIFT_CARD_SCAM"]),
    );
    expect(verdict.action).toBe("hold");
  });

  it("holds marketing email without an unsubscribe option", () => {
    const verdict = screenContent(
      input({ isMarketing: true, html: "<p>Big sale this week</p>" }),
      ctx,
    );
    expect(verdict.action).toBe("hold");
    expect(codes(verdict)).toContain("MISSING_UNSUBSCRIBE");
  });

  it("accepts marketing email with an unsubscribe link or header", () => {
    expect(
      screenContent(
        input({
          isMarketing: true,
          html: '<p>Sale</p><a href="https://x.example.com/u">Unsubscribe</a>',
        }),
        ctx,
      ).action,
    ).toBe("allow");
    expect(
      screenContent(
        input({
          isMarketing: true,
          hasListUnsubscribe: true,
          html: "<p>Sale</p>",
        }),
        ctx,
      ).action,
    ).toBe("allow");
  });

  it("flags large hidden text blocks", () => {
    const hidden = "cheap pills best price ".repeat(30);
    const verdict = screenContent(
      input({
        html: `<p>Hello</p><span style="font-size:0px">${hidden}</span>`,
      }),
      ctx,
    );
    expect(codes(verdict)).toContain("HIDDEN_TEXT");
  });

  it("holds bodies that are just a base64 blob", () => {
    const blob = Buffer.from("x".repeat(900)).toString("base64");
    const verdict = screenContent(input({ html: null, text: blob }), ctx);
    expect(verdict.action).toBe("hold");
    expect(codes(verdict)).toContain("BASE64_BODY");
  });

  it("does not flag inline base64 images as a base64 body", () => {
    const img = Buffer.from("y".repeat(3000)).toString("base64");
    const verdict = screenContent(
      input({
        html: `<p>Your report is ready.</p><img src="data:image/png;base64,${img}">`,
      }),
      ctx,
    );
    expect(codes(verdict)).not.toContain("BASE64_BODY");
    expect(codes(verdict)).not.toContain("DATA_URL");
  });
});

describe("screenContent performance", () => {
  it("stays fast on hostile html with thousands of unclosed tags", () => {
    const html =
      '<a href="https://x.test/">'.repeat(20_000) +
      '<div style="display:none">'.repeat(20_000);
    const started = Date.now();
    screenContent(input({ html }), ctx);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("decideAction", () => {
  it("rejects on any reject finding", () => {
    expect(
      decideAction([
        { code: "MALICIOUS_URL", severity: "reject", score: 0, message: "" },
      ]),
    ).toMatchObject({ action: "reject", strike: true });
  });

  it("holds on any hold finding or when the score reaches the hold score", () => {
    expect(
      decideAction([
        { code: "IP_URL", severity: "hold", score: 0, message: "" },
      ]).action,
    ).toBe("hold");
    expect(
      decideAction([
        { code: "SPAM_PHRASES", severity: "score", score: 2, message: "" },
        { code: "CRYPTO_SCAM", severity: "score", score: 3, message: "" },
      ]).action,
    ).toBe("hold");
  });

  it("rejects without a strike when the heuristic score is extreme", () => {
    expect(
      decideAction([
        { code: "CRYPTO_SCAM", severity: "score", score: 8, message: "" },
        { code: "GIFT_CARD_SCAM", severity: "score", score: 8, message: "" },
      ]),
    ).toMatchObject({ action: "reject", strike: false });
  });

  it("allows low scores", () => {
    expect(
      decideAction([
        {
          code: "ALL_CAPS_SUBJECT",
          severity: "score",
          score: 1.5,
          message: "",
        },
      ]).action,
    ).toBe("allow");
  });
});
