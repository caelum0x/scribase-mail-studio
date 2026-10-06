<p align="center">
  <img style="width: 120px;height: 120px; margin: auto;" src="apps/web/public/logo-squircle.png" alt="Scribase Mail">
</p>

<h1 align="center">Scribase Mail</h1>

<p align="center">
  Email API and dashboard for Scribase. Send transactional and marketing email
  with a familiar REST API, verified domains, campaigns, contacts and webhooks.
</p>

## About

Scribase Mail is the email layer of [Scribase](https://scribase.com). It is a
fork of [useSend](https://github.com/usesend/useSend) (AGPL-3.0) in which the
sending provider was replaced: mail is delivered through **Oracle Cloud
Infrastructure (OCI) Email Delivery** (SMTP for sending, the Email Delivery API
for domains, DKIM, approved senders and suppressions). See
[MERGE.md](./MERGE.md) for attribution and the list of changes.

## Features

- REST API for sending (single, batch, scheduled), domains, contacts, contact
  books and campaigns; TypeScript, Python and Go SDKs
- Domain verification with OCI-managed DKIM (CNAME) and SPF
- Approved senders created automatically on first send
- First-party open and click tracking (signed pixel and redirect links)
- Bounces and complaints from the OCI suppression list, polled on a schedule,
  feeding the team suppression list, metrics and webhooks
- Signed webhooks with retries
- Campaign editor, double opt-in, one-click unsubscribe
- Optional SMTP proxy (`apps/smtp-server`) that forwards to the REST API

What is different from push-based providers is documented in
[`apps/docs/self-hosting/oci-email-delivery.mdx`](./apps/docs/self-hosting/oci-email-delivery.mdx).

## Tech stack

Next.js, Prisma (Postgres), Redis + BullMQ, tRPC, Hono (public API), NextAuth,
Tailwind, the OCI TypeScript SDK and nodemailer.

## Local development

```sh
pnpm install
cp .env.example .env        # fill in OCI SMTP + API values to actually send
pnpm dx:up                  # Postgres + Redis in Docker
pnpm db:migrate-dev
pnpm dev                    # http://localhost:3000
```

Tests and checks for the web app:

```sh
pnpm --filter=web test:unit
pnpm --filter=web typecheck
```

## Self hosting

See [`deploy/DEPLOY.md`](./deploy/DEPLOY.md) and
[`apps/docs/self-hosting/overview.mdx`](./apps/docs/self-hosting/overview.mdx).
All configuration is in `.env.selfhost.example`.

## License

GNU Affero General Public License v3.0, see [LICENSE](./LICENSE). If you run a
modified version for users over a network, you must offer them its source code;
the app links to it from the sidebar, the login page and unsubscribe pages.

Built on useSend by Koushik and the useSend contributors.
