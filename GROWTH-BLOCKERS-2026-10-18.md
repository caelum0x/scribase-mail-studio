# Growth blockers — audit 2026-10-18

Audit of the live funnel (mail.scribase.com + scribase.com/mail) for signup/payment
blockers. Context: already-fixed incidents before this audit: the own account's
silent 100/day FREE-plan cap (critical, fixed), and a HEAD-request wire-layer/CORS
bug (fixed). This file is for the next layer of blockers found during this pass.

## Fixed in this pass (code, committed + pushed)

**Biggest blocker found: every new cloud team's first test send was silently held
for manual admin review, with zero signal to the caller.**

`send-gate-service.ts`'s first-sends review holds a new team's emails until it has
sent 20 emails AND is 48 hours old (`FIRST_SENDS_REVIEW`, both configurable via env).
The API call that queues the send still returns `200 {id: ...}` immediately — the
hold happens later, async, in the queue worker. DEPLOY.md's own documented smoke
test is literally `{"to": "<you>"}` — a brand-new paying customer's first "does the
one-line Resend switch actually work" test send is exactly the kind of send this
silently stalls on, unless an admin is actively watching Admin > Review within the
hold window. That is the realistic failure mode for 100% of new signups: curl
succeeds, nothing arrives, developer assumes the product (or their own DNS/SMTP
setup) is broken, and churns before ever reaching a second send.

Fix (commit `3c93c96`, pushed to `origin/main`): a send where every recipient is
already a member of the sending team cannot reach a third-party mailbox, so it
carries none of the reputation/abuse risk the first-sends review exists to catch.
That self-test case now skips only the `FIRST_SENDS` hold reason — content
screening (malicious links/phishing) still runs unconditionally for every send,
and first-sends review still applies in full to any send with even one
non-member recipient (so real campaigns/third-party sends to new teams are
unaffected). 2 new unit tests added
(`send-gate-service.unit.test.ts`): self-test send passes, mixed
member/non-member recipients still held.

**Verification caveat:** `apps/web/node_modules/.pnpm` was found wiped on this Mac
(the whole monorepo's node_modules is broken — not something this change did; most
likely fallout from an earlier disk-cleanup pass that pruned the pnpm store while
something still referenced it). Could not run the full web unit/typecheck suite
locally. Verified instead with: (1) an isolated TS parse of the 3 changed files via
a different product's intact `typescript` package — 0 syntax diagnostics; (2) a
manual check of the Prisma schema for the `teamUser`/`user` relation the new code
queries, matching an existing call pattern already used elsewhere
(`team-service.ts: getTeamUsers`). Recommend running
`pnpm install && pnpm test:web:unit` here once the Mac's disk/pnpm situation is
sorted, to get this into CI-verified state.

**Deploy status:** rebuilding the `scribase-mail-web` image on `box` to ship this
live. The box is under heavy resource contention (load avg ~10, ~370MB free RAM,
swapping) from the other products it hosts, so the Docker build is taking far
longer than DEPLOY.md implies (first build pass took ~48 min; a second pass, after
correcting `GIT_SHA` in `deploy/.env` from the stale `ce43829` to `3c93c96` so the
image is tagged correctly, was still running past the 20-minute mark when this file
was written). The build is NOT blocked, just slow — it was left running
server-side. **To finish the deploy once the build completes:**

```sh
ssh box 'docker images | grep "scribase-mail:3c93c96"'   # confirm the new image exists
ssh box 'cd /opt/scribase-mail && docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env up -d web'
ssh box 'curl -fsS http://127.0.0.1:4350/api/health'      # expect {"data":"Healthy"}
curl -fsS https://mail.scribase.com/api/health             # same, through Caddy
ssh box 'docker builder prune -f'                          # reclaim build cache (grew to ~11GB during this build)
```

If the build is still running, just re-run the first command later — it isn't
tied to any session and won't be lost.

## Confirmed NOT broken (checked, do not re-investigate)

- **Marketing/landing page** (`https://scribase.com/mail`): live, 200, clear
  headline ("Self-hosted Resend: switch with one line"), accurate pricing table
  (Free $0/3k, Pro $20/50k, Scale $90/100k matching `packages/lib/src/constants/pricing.ts`),
  comparison table vs Resend/useSend/Postal, working CTAs to
  `mail.scribase.com/signup`, migration guide at `/mail/migrate-from-resend` (200).
- **GitHub repo** (`github.com/caelum0x/scribase-mail-studio`): public, matches
  every "Star on GitHub" / "Self-host (AGPL)" link on the marketing site.
- **Signup/login flow**: `POST /api/auth/signin/email` returns 200 and the expected
  `verify-request` redirect for a fresh email; no 500s, no broken CSRF handling.
- **Billing**: Dodo Payments is fully configured on `box` in live mode
  (`DODO_PAYMENTS_API_KEY`, webhook key, product ids, usage meter all set).
  `billing.ts` router maps provider errors to client-safe tRPC errors; nothing
  obviously broken in the checkout/webhook code path.
- **Resend-compat API** (`mail-api.scribase.com`): returns the documented 401 for
  an unauthenticated request, matching DEPLOY.md.
- **Waitlist auto-approve**: `AUTO_APPROVE_WAITLIST=true` is set on `box` (opt-in
  feature, correctly enabled). Business-domain signups are auto-approved off the
  waitlist same-day; consumer-domain (gmail.com, etc.) signups still queue for
  manual review by design — a real but *separate* known trade-off, see below.
- **Plan-limit "siblings" of the original 100/day bug**: domains, contact books,
  webhooks and team members all have working `LimitService` checks derived from
  the single `PRICING_PLANS` source of truth (no stale/duplicated limit tables
  found). Pro/Scale's advertised "no daily sending cap" technically still reads
  from a per-team `dailyEmailLimit` DB column (default 10,000/day) rather than the
  plan's `-1`, so it's not literally unlimited — but 10k/day is far above what a
  50k/month (Pro) or 100k/month (Scale) customer would hit in practice. Low
  priority; noted below, not fixed in this pass.

## Owner-attention items (not fixed in this pass — judgment calls, not code bugs)

1. **Consumer-domain signups stay on the manual waitlist indefinitely.**
   `signup-screening.ts` only auto-approves business-domain emails with a working
   MX record; disposable and consumer providers (gmail.com, outlook.com, etc.)
   always queue for a human. Given the Free plan is explicitly marketed as "for
   trying Scribase Mail and side projects" — exactly the case where a solo
   developer signs up with a personal email — this blocks a meaningful slice of
   the target audience from ever reaching the dashboard unless someone manually
   approves them in Admin > Waitlist. Left alone in this pass because it is a
   deliberate, tested, documented anti-abuse policy (shared OCI sending tenancy;
   one bad sender risk suspends delivery for every customer), not a bug — and
   because the already-built layers (content screening, warm-up caps, reputation
   auto-pause, first-sends review) already bound the abuse risk *after* approval,
   so the marginal protection from blocking personal-email signups specifically is
   thinner than it looks. Recommend deciding: either raise `AUTO_APPROVE_DAILY_CAP`
   and widen auto-approval to consumer domains (relying on the other layers for
   abuse control), or commit to checking Admin > Waitlist at least daily so
   approval turnaround stays same-day.

2. **Pro/Scale's `dailyEmailLimit` default (10,000/day) isn't synced to the
   plan's `-1` ("no daily cap") on upgrade.** Marketing says "No daily sending
   cap" for Pro/Scale; the enforced value is a per-team DB column that an admin
   can raise but nothing currently sets to unlimited automatically when a team's
   Dodo subscription goes active. Not a practical blocker today (10k/day exceeds
   any Pro/Scale customer's realistic daily volume), but worth fixing so the
   webhook handler for `subscription.active`/`subscription.plan_changed` also
   sets `dailyEmailLimit = -1` for PRO/SCALE teams, to close the gap between what
   is promised and what is enforced before it ever bites a real high-volume
   customer.

3. **No web analytics anywhere** (marketing site or app) — no Plausible/PostHog/GA
   found in either `apps/marketing` or `apps/web`. There's currently no way to
   measure landing-page → signup → paid conversion. Not a code "bug" but worth
   wiring up so future growth work on this product has numbers to act on.
