# Self-hosting Scribase Mail

Requirements: Docker with Compose v2, about 2 GB RAM.

## One command

```sh
git clone https://github.com/caelum0x/scribase-mail-studio && cd scribase-mail-studio && ./scripts/selfhost.sh
```

`scripts/selfhost.sh` creates `.env` from `.env.selfhost.example` with generated
secrets, pulls `ghcr.io/caelum0x/scribase-mail-studio:latest` (or builds it from
the checkout when the image is unavailable; `--build` forces a local build),
starts Postgres, Redis, the web app and Mailpit, and waits until the app is healthy.

| What | URL |
| --- | --- |
| Dashboard | http://localhost:3000 |
| Resend-compatible API (`RESEND_BASE_URL`) | http://localhost:3000/api/resend |
| Native REST API | http://localhost:3000/api/v1 |
| Mailpit, catches all mail in trial mode | http://localhost:8025 |

## First send

1. Open http://localhost:3000, sign in with any email address and read the
   code in Mailpit. The first account owns the installation; later accounts
   need a team invite.
2. Add a domain. In trial mode use a reserved name such as `acme.test`
   (`.test`, `.localhost`, `.example` and `.invalid` verify without DNS).
3. Create an API key (Developer settings > API keys) and send with the official
   Resend SDK:

```js
// npm i resend
import { Resend } from "resend";

// RESEND_BASE_URL=http://localhost:3000/api/resend
const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: "Acme <hello@acme.test>",
  to: ["you@example.com"],
  subject: "Hello from Scribase Mail",
  html: "<p>It works.</p>",
});
```

The message shows up in Mailpit with a `DKIM-Signature` header.

## Real delivery

Edit `.env`:

```sh
EMAIL_PROVIDER="smtp"
SMTP_HOST="smtp.your-relay.example"
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASS="..."
SMTP_REQUIRE_TLS="true"
SMTP_SPF_RECORD="v=spf1 include:your-relay.example ~all"
NEXTAUTH_URL="https://mail.example.com"
FROM_EMAIL="Mail <noreply@example.com>"
COMPOSE_PROFILES=""
```

then run `./scripts/selfhost.sh` again. For each sending domain publish the DKIM
TXT and SPF TXT records shown on the domain page. Put a TLS reverse proxy (Caddy,
nginx) in front of port 3000; set `SCRIBASE_MAIL_BIND=0.0.0.0` only if you expose
the port directly. For the API on its own host (like `mail-api.scribase.com`),
rewrite every path to `/api/resend{uri}`; see `deploy/scribase-mail.caddy`.

With `EMAIL_PROVIDER="smtp"` bounces and complaints come from your relay's
behaviour only (no provider log polling). `EMAIL_PROVIDER="oci"` uses Oracle Cloud
Email Delivery with managed DKIM, the suppression list and delivery logs; see the
OCI section of `.env.selfhost.example` and `deploy/DEPLOY.md`.

## Operations

```sh
docker compose logs -f web      # logs
docker compose pull && docker compose up -d   # upgrade (migrations run on start)
docker compose exec postgres pg_dump -U scribase_mail scribase_mail > backup.sql
docker compose down             # stop (data kept in volumes)
```
