# Launch copy — Scribase Mail Studio

Generated 2026-10-18 via [`launchmaxxing`](https://github.com/caelum0x/launchmaxxing)
(`launchmaxxing content "Scribase Mail Studio" all --profile-file profile.json`),
deterministic/local, no LLM call. Drafts only — nothing below has been posted.
Posting to Product Hunt / Hacker News / Reddit / X / LinkedIn requires the
owner's own logged-in accounts, so that step is owner-only.

Product profile used:

```json
{
  "tagline": "Self-hosted Resend: switch with one line",
  "problem": "Teams using Resend for transactional email are locked into a closed-source, hosted-only platform with no self-hosting option and recurring per-email costs that scale with growth",
  "audience": "founders, small teams and developers running SaaS products who self-host their stack (Supabase/Neon users) or want to own their email infrastructure instead of renting it",
  "differentiator": "drop-in Resend SDK compatibility (same resend npm package, just point baseUrl at your own instance), AGPL-3.0 open source, self-host in one Docker Compose command, or use the hosted free tier -- no code rewrite to migrate off Resend",
  "url": "https://scribase.com/mail",
  "subreddit": "selfhosted"
}
```

## Product Hunt

**Tagline (60 char max):** Self-hosted Resend: switch with one line

**Description:** Teams using Resend for transactional email are locked into
a closed-source, hosted-only platform with no self-hosting option and
recurring per-email costs that scale with growth. Scribase Mail Studio
fixes that: drop-in Resend SDK compatibility (same `resend` npm package,
just point `baseUrl` at your own instance), AGPL-3.0 open source, self-host
in one Docker Compose command, or use the hosted free tier — no code
rewrite required to migrate off Resend.

## Show HN

**Title (80 char max):** Show HN: Scribase Mail Studio – drop-in Resend SDK
compatibility (same resend n…

(HN hard-caps titles at 80 chars; a tighter hand-edited version:)
`Show HN: Scribase Mail Studio – a self-hosted, Resend SDK-compatible email API`

**Body:**
Teams using Resend for transactional email are locked into a closed-source,
hosted-only platform with no self-hosting option and recurring per-email
costs that scale with growth. I built Scribase Mail Studio to fix that for
myself first: keep the official `resend` npm SDK and your existing code,
just point `baseUrl` (or `RESEND_BASE_URL`) at your own instance. AGPL-3.0,
self-host with one `docker compose up`, or use the hosted free tier.
Webhooks are signed in the Svix format so `resend.webhooks.verify()` keeps
working unchanged. Repo: https://github.com/caelum0x/scribase-mail-studio
Live: https://scribase.com/mail

## X / Twitter thread

1. Shipping Scribase Mail Studio today. https://scribase.com/mail
2. The problem: teams using Resend for transactional email are locked into
   a closed-source, hosted-only platform with no self-hosting option and
   recurring per-email costs that scale with growth.
3. Founders, small teams and developers running SaaS products who
   self-host their stack (Supabase/Neon users) or want to own their email
   infrastructure instead of renting it deal with this constantly, usually
   by cobbling together workarounds.
4. What Scribase Mail Studio does: drop-in Resend SDK compatibility (same
   `resend` npm package, just point `baseUrl` at your own instance),
   AGPL-3.0 open source, self-host in one Docker Compose command, or use
   the hosted free tier — no code rewrite to migrate off Resend.
5. Built for exactly that audience — not a generic tool with a landing
   page bolted on.
6. If that's you, take a look: https://scribase.com/mail. Feedback
   (especially the critical kind) is genuinely welcome.

## Reddit (r/selfhosted)

**Title:** Built a self-hosted, drop-in-compatible alternative to Resend
(same SDK, just change the base URL)

**Body:**
Teams using Resend for transactional email are locked into a closed-source,
hosted-only platform with no self-hosting option and recurring per-email
costs that scale with growth. I'm part of the crowd that self-hosts their
stack (Supabase/Neon users, mostly) and wanted to own email infra instead
of renting it, so I built Scribase Mail Studio to fix it for myself first.
Drop-in Resend SDK compatibility — same `resend` npm package, just point
`baseUrl` at your own instance — AGPL-3.0, self-host in one Docker Compose
command, or use the hosted free tier. No code rewrite needed to migrate
off Resend.

It's up at https://scribase.com/mail (repo:
https://github.com/caelum0x/scribase-mail-studio) if you want to poke at
it — genuinely interested in whether this is a problem other people here
have too, or if I'm the only one who found it this annoying.

## LinkedIn

Shipped Scribase Mail Studio.

The problem: teams using Resend for transactional email are locked into a
closed-source, hosted-only platform with no self-hosting option and
recurring per-email costs that scale with growth.

Drop-in Resend SDK compatibility — same `resend` npm package, just point
`baseUrl` at your own instance — AGPL-3.0 open source, self-host in one
Docker Compose command, or use the hosted free tier. No code rewrite
needed to migrate off Resend.

Built for founders, small teams and developers running SaaS products who
self-host their stack (Supabase/Neon users) or want to own their email
infrastructure instead of renting it. If that's you, I'd genuinely like
your feedback — the good and the bad.

https://scribase.com/mail

---

## Directory submissions (this pass, 2026-10-18)

- **Launching Next** — real HTTP POST to `https://www.launchingnext.com/submit/`,
  response `200`, landed on `https://www.launchingnext.com/thanks/?i=163014`
  ("Submission Received | Launching Next", "Submitted" step marked complete,
  manual review within 1 business day). Account-free, confirmed via direct
  POST, not assumed.
- Re-checked for other account-free directories in `launchmaxxing`'s catalog
  (Hacker News Show HN, DevHunt, There's An AI For That) — all still require
  login or 404/Cloudflare-challenge as of today; catalog notes were already
  accurate, no catalog fix needed.
- **Awesome-list PRs**: four relevant PRs already open from a prior session
  (none merged yet) — `dhamaniasad/awesome-postgres#606`,
  `furudo-erika/awesome-supabase-alternatives#3`,
  `punkpeye/awesome-remote-mcp-servers#1759`, and the mail-specific
  `LLazyEmail/awesome-email-marketing#321` ("Add Scribase Mail Studio to
  Self-Hosted ESPs"). No duplicate PR opened this pass.
- Checked `awesome-selfhosted/awesome-selfhosted-data` (327k-star list,
  the single best fit for an AGPL self-hosted Resend alternative) — its own
  `CONTRIBUTING.md` explicitly instructs AI agents not to open PRs/issues or
  write entry text on a human's behalf, and not to check the "submitted by a
  human" attestation box. Respected that; did not open a PR there. If the
  owner wants to submit by hand: `software/scribase-mail-studio.yml` in that
  repo, per its contribution template — first release `v1.8.2`+ is already
  well past the 4-month-age requirement.
- No existing outreach contact list or waitlist found specifically for
  Scribase Mail Studio in this repo or `~/products/plans` — did not fabricate
  any outreach; none has been sent for this product yet.
