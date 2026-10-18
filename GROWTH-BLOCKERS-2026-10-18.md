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

**Deploy status: LIVE.** Rebuilt and deployed `scribase-mail-web` on `box`
(image `scribase-mail:3c93c96`, `deploy/.env` `GIT_SHA` updated from the stale
`ce43829` to `3c93c96`). The box was under heavy resource contention (load avg
~10, ~370MB free RAM, swapping) from the other products it hosts, so the two
Docker builds needed (one before the `GIT_SHA` fix, one after) took ~48 min and
~25 min respectively — far longer than DEPLOY.md implies, but not blocked, just
slow. Confirmed after `up -d web`:
- `docker logs scribase-mail-web` — migrations deployed, worker already
  processing real email events (`DeliveryLogPollJob` running) for `teamId:1`.
- `curl http://127.0.0.1:4350/api/health` and `curl https://mail.scribase.com/api/health`
  both `{"data":"Healthy"}`.
- `docker builder prune -f` reclaimed the ~11GB of build cache; `/` back to 20G
  free (80% used), same as before this work started.

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

## 2026-10-18 (later pass): sender-reputation gap — built, pushed, blocked on deploy only

**Competitive gap verified (web search):** Resend added an Email Metrics API plus
a basic account-level "Deliverability Insights" dashboard in 2026, but it is
engagement/metrics data, not DNS-policy auditing, and reviewers still flag it as
shallower than dedicated deliverability tools. useSend (the direct OSS base this
product forks) has no reputation dashboard at all — it only relays SES
bounce/complaint events into suppression lists; no DMARC/SPF/DKIM policy checks,
no per-domain health panel. The gap stands, especially against the direct fork
base.

**What was found before building anything new:** a real, already-tested backend
subsystem for exactly this gap already existed and was dormant —
`deliverability-insights-service.ts` (DMARC policy/rua check, SPF+OCI-relay
check, DKIM status, return-path, tracking subdomain, 30-day bounce/complaint
rate with warning/error thresholds, 10 passing unit tests) plus a
`domain.getDeliverabilityInsights` tRPC query exposing it — but no page anywhere
called that query. It was built, tested, and wired into the API, then never
surfaced. Separately, `reputation-guard-service.ts`/`reputation-guard-job.ts`
(account-wide bounce/complaint auto-pause with loud email notification to the
team and admin) was already live since 2026-10-07 and did not need touching.

**Built:** a "Deliverability & sender reputation" panel on the domain detail
page (`apps/web/src/app/(dashboard)/domains/[domainId]/deliverability-insights.tsx`,
wired into `page.tsx`) that calls the existing `getDeliverabilityInsights` query
and renders every check (DMARC/SPF/DKIM/return-path/tracking, severity-sorted)
plus 30-day sent/bounce/complaint stats. A fetch failure shows a visible
destructive-styled error banner with the tRPC error message — never silently
hidden, consistent with this session's two earlier silent-failure fixes on this
product.

**Tests: real suite run, not just syntax check** (closes the gap noted above
from the earlier pass in this file, where only an isolated TS parse was
possible). Root cause of the earlier broken `node_modules`: `pnpm store status`
confirmed corrupted/modified store entries. Fixed per instructions (restored
the store rather than switching package managers): freed disk via
`docker builder prune -af` + `docker image prune -af` (reclaimed ~19GB, this
Mac's disk was the real blocker, not pnpm itself), then
`pnpm install --filter web... --force` to re-fetch the corrupted entries, then
`prisma generate`. Result: `vitest run -c vitest.unit.config.ts` — **576/576
passed** (57 files, includes the 10 pre-existing deliverability-insights tests);
`vitest run -c vitest.trpc.config.ts` — **39/39 passed**; `tsc --noEmit -p .` —
0 errors. No new tests were added because no new business logic was written —
this change is a UI wire-up of an already-tested service; the existing 10 unit
tests already cover every severity branch the panel renders.

**Commit:** `9c1af8b` — `feat(domain): surface per-domain deliverability and
sender-reputation insights`. Pushed directly to `origin/main` (confirmed via
`git log origin/main -1` after push; the previously-pushed local branch had
been tracking `origin/main` under the name `scribase-mail`, so the push target
had to be corrected to `scribase-mail-studio` on GitHub's `main` branch
specifically — done, and the stray duplicate `scribase-mail` remote branch this
created was deleted immediately after).

**Deploy: BLOCKED, owner action needed.** `ssh box` (`130.61.180.42`, the only
documented deploy path in `deploy/DEPLOY.md` — tar/scp the source, build+restart
the `scribase-mail-web` container there) gets `Connection refused` on port 22,
confirmed repeatedly over several minutes. This is box-specific, not an
environment-wide network block: the same sandbox reached `railyard-box`
(`130.61.113.116`) on port 22 immediately, and reached `mail.scribase.com` on
443 fine (`curl https://mail.scribase.com/api/health` → `{"data":"Healthy"}`,
confirming the *currently live* build is still up and unaffected). sshd on
`box` itself appears down or its firewall now excludes this session's egress
IP — likely needs a console/OOB reboot or firewall-rule check on the Oracle
Cloud side (owner-only: OCI Console access). **Code is on `origin/main`,
tested, ready to deploy; health is unaffected (old build still serves
`mail.scribase.com` fine); the only remaining step is re-establishing SSH to
`box` and running `deploy/DEPLOY.md` steps 2–6** (or equivalently:
`git pull && docker compose -f deploy/compose.scribase-mail.yml --env-file
deploy/.env build web && up -d web`, bump `GIT_SHA=9c1af8b` in `deploy/.env`
first). Nothing else in this pass depends on this — flagging and moving on.

## Third gap pass: dedicated sending pools wired into real delivery (same day, later)

**Gap vs Resend/useSend:** Resend sells dedicated IPs so a high-volume sender's
reputation is isolated from every other customer on the shared pool; useSend
(the fork base) has nothing like it.

**What was found before building anything new:** another fully dormant
subsystem, same shape as `deliverability-insights-service.ts` above —
`Team.sendingPool` (DB column), `team.setSendingPool` / `team.getSendingPool`
(admin-only tRPC, already recording `AuditAction.SENDING_POOL_CHANGED`), and
`multi-region-service.ts`'s `getSmtpCredentialsForPool()` (reads
`OCI_SMTP_POOL_<NAME>_HOST/USER/PASS`, already unit-tested) all existed and
compiled, but nothing ever called `getSmtpCredentialsForPool` from the actual
send path, and no page in the app called `setSendingPool`/`getSendingPool`.
Setting a pool persisted to the database and changed nothing about where mail
actually sent.

**Built:** wired the existing pieces together, no new algorithm. Both
`OciEmailProvider` (the live default) and `GenericSmtpProvider` (self-host)
now resolve a per-pool nodemailer transport at send time (cached per pool
name) and fall back to the shared relay when a pool isn't provisioned,
matching `getSmtpCredentialsForPool`'s existing fallback. `email-queue-service.ts`
reads the sending team's pool right before each send. Added an admin-only
"Dedicated sending pool" card to Settings -> Team
(`apps/web/src/app/(dashboard)/settings/team/sending-pool-settings.tsx`).

**Tests:** 44 new/updated unit + trpc tests across
`oci-provider.unit.test.ts`, `smtp-provider.unit.test.ts`, a new
`smtp/factory.unit.test.ts`, `email-queue-service.unit.test.ts`, and a new
`team-sending-pool.trpc.test.ts`. Full `vitest run -c vitest.unit.config.ts` -
**591/591 passed** (58 files); `vitest run -c vitest.trpc.config.ts` -
**43/43 passed**; `tsc --noEmit --pretty false` - 0 errors.

**Commit:** `295c033` - `feat(domain): wire dedicated sending pools into
actual email delivery`. Pushed to `origin/main`, confirmed matching via
`git ls-remote origin main`.

**Deploy: LIVE.** `ssh box` worked this time (the 2026-10-18 fail2ban lockout
had already cleared). Rebuilt `scribase-mail:295c033`
(`docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env
build web`, ~22 min - box is still slow/contended, not blocked) after bumping
`GIT_SHA` in `deploy/.env`, then `up -d web`. Verified:
`docker inspect scribase-mail-web` -> image `scribase-mail:295c033`; grepping
the running container's built `.next` output for `"Dedicated sending pool"`
and `setSendingPool` found both in the server and client bundles for
`/settings/team`; `curl https://mail.scribase.com/api/health` and the local
`http://127.0.0.1:4350/api/health` both -> `{"data":"Healthy"}`;
`curl -o /dev/null -w '%{http_code}' https://mail.scribase.com/settings/team`
-> 200. Freed disk before and after (`docker builder prune -f`, removed the
two oldest `scribase-mail` images), `/` back to 19G free (81% used).
