# Scribase Mail: fork notes

## Upstream

- Project: useSend, https://github.com/usesend/useSend
- License: GNU AGPL-3.0 (unchanged; see `LICENSE`)
- Forked from upstream `main` at `bcf7e07` ("fix: declare SMTP workspace
  package (#451)"). Full upstream history is kept in this repository; the
  `upstream` remote points at useSend with pushing disabled.
- Credit: useSend was created by Koushik and the useSend contributors. The
  dashboard, public API, SDKs, campaign editor, contacts, webhooks, SMTP proxy
  and almost all application code are theirs.

## AGPL source offer

Every page of the app links to the source code
(`https://github.com/caelum0x/scribase-mail-studio`): the sidebar
("Source code"), the login page footer and the unsubscribe page footer. The
URL lives in `apps/web/src/lib/source-code.ts`. The repository must be
published at that URL (or the constant changed) before the service is offered
to users.

## What changed

### Provider: Oracle Cloud Email Delivery instead of the previous cloud provider

- New provider layer `apps/web/src/server/provider/`:
  - `types.ts`: `EmailProvider` interface (send, domains, DKIM, approved
    senders, suppressions, status).
  - `oci/oci-provider.ts`: OCI implementation. Sending over SMTP with a pooled
    nodemailer transport (4xx and socket errors are retryable, 5xx permanent,
    SMTP credentials redacted from errors). Domains via the OCI Email Delivery
    API (`createEmailDomain`, `createDkim` with OCI-generated keys and CNAME
    records, lifecycle state mapping for verification). Approved senders are
    created on demand and cached. Suppression list list/get/delete.
  - `oci/config.ts`, `oci/factory.ts`, `oci/mappers.ts`: env parsing (PEM,
    escaped or base64 keys, key path), SDK and transport construction,
    lifecycle/reason mapping, SPF value
    `v=spf1 include:rp.oracleemaildelivery.com ~all`.
  - Works around an OCI SDK bug that formats `Date` query params in local time
    with an unpadded hour (`toRfc3339Utc`).
- Removed the previous provider client code, the push-notification callback
  route, its settings service, configuration-set helpers and all of its SDK
  packages. No package from that vendor remains in `pnpm-lock.yaml`.
- `ProviderSetting` (auto-created per region) replaces the old per-region
  settings table; rate limit and transactional share are editable on
  **Admin > Email provider**, which also shows live SMTP/API status.
- Email events are provider neutral (`apps/web/src/types/mail-events.ts`,
  `server/service/email-event-service.ts`):
  - `SENT` is recorded when the SMTP relay accepts the message.
  - Bounces and complaints come from polling the OCI suppression list
    (`server/jobs/provider-suppression-poll-job.ts`, default every 5 minutes),
    de-duplicated in `ProcessedProviderSuppression`, matched to the email by
    Message-ID or recipient, and fed through the existing pipeline (team
    suppression list, contact unsubscribe, metrics, webhooks).
  - Open and click tracking is now first-party
    (`server/utils/email-tracking.ts`, routes `/api/t/o/:id` and
    `/api/t/c/:id`): HMAC-signed pixel and redirect URLs, http(s) only.
- Message-ID is set by Scribase Mail (`<emailId@sender-domain>`) and stored as
  `Email.providerMessageId`; replies thread with `In-Reply-To`/`References`.
- Domains: DNS records are a DKIM CNAME, an SPF TXT and the recommended DMARC
  TXT. The domain page lists approved senders and can add new ones.
- Image uploads in the editor use OCI Object Storage pre-authenticated
  requests instead of an S3 client.
- System emails (sign-in codes, invites) go straight to the SMTP relay from
  `FROM_EMAIL`, so a fresh install can sign in before any domain is added.
- Prisma migrations were squashed into one baseline
  (`20261007000000_scribase_mail_init`) for the new schema. This fork is meant
  for fresh databases; it is not a drop-in upgrade of an existing useSend
  database.

### Brand

- Product name "Scribase Mail" across the web app, emails, marketing site and
  docs; new monochrome mark, favicons and a neutral black/white theme in
  `packages/ui/styles/globals.css`.
- No emoji in the UI (contact book emoji picker and glyphs removed; the API
  field is kept for compatibility).
- Marketing site rewritten (no upstream testimonials, sponsors, pricing or
  incident history); legal pages defer to scribase.com.
- Docs: self-hosting rewritten for OCI, new "OCI Email Delivery notes" page,
  upstream changelog and provider credential guides removed.
- Custom header `X-Scribase-Email-ID` (the upstream header names stay reserved).

### Kept as is

- Public REST API (`/api/v1/...`), request/response shapes (domain records now
  include `CNAME`; `publicKey` replaced by `dkimSelector`), webhook payloads
  (`sesTenantId` removed from domain payloads).
- SDK package names (`usesend-js`, Python `usesend`, Go) for compatibility;
  point them at your instance with `USESEND_BASE_URL`.
- SMTP proxy (`apps/smtp-server`), now defaulting to `mail.scribase.com` and
  also reading `SCRIBASE_MAIL_BASE_URL`.

## Not available on OCI Email Delivery

See `apps/docs/self-hosting/oci-email-delivery.mdx`: no delivered or
delivery-delayed events, no provider-side reject/rendering-failure events,
bounces/complaints are polled (up to 5 minutes late) and limited to what OCI
suppresses, no custom MAIL FROM, account-level suppressions are shared across
teams.

## Syncing with upstream

```sh
git fetch upstream
git merge upstream/main   # expect conflicts in provider code, schema and branding
```

After a merge, re-run `pnpm --filter=web test:unit`, `pnpm --filter=web typecheck`
and the legacy-provider check (must print nothing; the bracketed letters keep
the pattern from matching itself):

```sh
grep -rniwE "a[w]s|s[e]s|s[n]s|a[m]azon(s[e]s)?" \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next \
  --exclude=pnpm-lock.yaml --exclude=LICENSE .
grep -ciE "@a[w]s-sdk|a[m]azon" pnpm-lock.yaml   # must print 0
```
