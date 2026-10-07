# Deploying Scribase Mail to the Scribase box

Target: `https://mail.scribase.com` on the Scribase box (`ssh box`), behind the
box's Caddy. Stack: `deploy/compose.scribase-mail.yml` (web + Postgres + Redis,
local bind mounts, 1.47 GB total memory limit). No Neon, no external database.

Nothing here has been run yet. Do not start while another deploy is running on
the box, and check disk first (the image build needs about 3 GB free).

## 0. Preconditions

- DNS: `mail.scribase.com` CNAME/A to the box (Cloudflare, orange cloud, SSL mode
  Full (strict)). The `*.scribase.com` Origin CA cert is already at
  `/etc/caddy/certs/scribase-origin.{pem,key}` (used by `scribase-api`).
- OCI Email Delivery (eu-frankfurt-1): SMTP credential and an API signing key
  for a user allowed to `manage email-family` in the compartment. The values
  used by Rally are in `~/.rally-secrets/oci-smtp.env` (SMTP) and `~/.oci/config`
  (API) on the Mac.
- OCI Logging, for delivered / bounced / complained events: the same API user
  must be able to create the log group and service logs and read log content.
  Policy statements (group of the API user, same compartment as
  `OCI_COMPARTMENT_ID`, or `in tenancy` when that is unset):

  ```
  Allow group <api-user-group> to manage log-groups in compartment <compartment>
  Allow group <api-user-group> to read log-content in compartment <compartment>
  ```

  `manage log-groups` covers CreateLogGroup/CreateLog; enabling a service log
  also needs update rights on the email domain, which the existing
  `manage email-family` grant already gives; `read log-content` is what the
  Logging Search API needs (docs.oracle.com Logging > Logs and Log Groups).
  Users in the Administrators group need nothing extra. Without these,
  sending still works and bounces/complaints fall back to the 5-minute suppression-list poll, but
  there are no "delivered" events.
- DNS for the Resend-compatible API host: `mail-api.scribase.com` CNAME/A to the
  box (orange cloud, same as `mail.scribase.com`). It must stay a single-level
  subdomain: Cloudflare Universal SSL and the `*.scribase.com` Origin CA cert do
  not cover `api.mail.scribase.com`.
- `FROM_EMAIL` must be on a domain that is ACTIVE in OCI Email Delivery.
  `scribase.com` is already an OCI email domain; use
  `Scribase Mail <noreply@scribase.com>` or add `mail.scribase.com` in OCI first.

## 1. Disk and memory check (on the box)

```sh
ssh box 'df -h / && free -m && docker system df'
```

Stop if `/` is above 80% after accounting for ~3 GB of build layers. Free space
with `docker builder prune -f` and `docker image prune -f` (never prune volumes).

## 2. Ship the source

The repository is not published yet. From the Mac:

```sh
cd ~/products/scribase-mail-studio
git archive --format=tar.gz --prefix=scribase-mail-studio/ HEAD > /tmp/scribase-mail.tgz
scp /tmp/scribase-mail.tgz box:/tmp/
ssh box 'sudo mkdir -p /opt/scribase-mail && sudo chown $USER /opt/scribase-mail \
  && tar -xzf /tmp/scribase-mail.tgz -C /opt/scribase-mail --strip-components=1 \
  && rm /tmp/scribase-mail.tgz'
```

(Once `github.com/caelum0x/scribase-mail-studio` exists: `git clone` into
`/opt/scribase-mail` and `git checkout <sha>` instead.)

## 3. Secrets (on the box)

```sh
ssh box
sudo mkdir -p /etc/scribase-mail /srv/scribase-mail/data
# OCI API private key (copy from the Mac: scp ~/.oci/oci_api_key.pem box:/tmp/oci.pem)
sudo install -m 600 -o root /tmp/oci.pem /etc/scribase-mail/oci_api_key.pem && rm /tmp/oci.pem
# The web container runs as root in the image, so 600 root works.

cd /opt/scribase-mail
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# Fill in: NEXTAUTH_SECRET (openssl rand -base64 32), POSTGRES_PASSWORD
# (openssl rand -hex 24), SMTP_USER/SMTP_PASS, OCI_TENANCY/OCI_USER/
# OCI_FINGERPRINT, ADMIN_EMAIL, GIT_SHA=<commit>. Billing (optional): section 8.
```

## 4. Build and start

```sh
cd /opt/scribase-mail
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env build web
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env logs -f web
# expect: "Deploying prisma migrations" ... "Starting web server"
curl -fsS http://127.0.0.1:4350/api/health    # {"data":"Healthy"}
docker builder prune -f                         # reclaim build cache
```

Migrations (`prisma migrate deploy`) run on every web start.

## 5. Caddy

```sh
# on the Mac, in infra-box:
cp ~/products/scribase-mail-studio/deploy/scribase-mail.caddy ~/products/infra-box/caddy/sites/
# commit + pull infra-box on the box, then add "scribase-mail" to CADDY_SITES in
# /etc/products/caddy.env and run:
ssh box 'sudo /opt/infra-box/install.sh caddy'
curl -fsS https://mail.scribase.com/api/health
```

`scribase-mail.caddy` holds two site blocks, so the one `CADDY_SITES` entry
also serves the Resend-compatible API host:

| Host | Serves |
|---|---|
| `mail.scribase.com` | dashboard, native API `/api/v1/*`, Resend API at `/api/resend/*` |
| `mail-api.scribase.com` | Resend API only: Caddy runs `rewrite * /api/resend{uri}`, so `/emails?limit=2` reaches `/api/resend/emails?limit=2` and nothing else of the app is exposed |

Checked with `infra-box/caddy/test/validate.sh` and a caddy:2 container (query
strings preserved).

```sh
# expect 401 {"statusCode":401,"name":"missing_api_key",...}
curl -sS https://mail-api.scribase.com/emails
```

## 6. Smoke test

1. Open `https://mail.scribase.com/login`, sign in with `ADMIN_EMAIL` (one-time
   code from `FROM_EMAIL`).
2. Admin > Email provider: SMTP relay and Email Delivery API both "Connected".
3. Domains > add a test domain (e.g. `mail.scribase.com` if not in OCI yet),
   publish the CNAME/TXT records, wait for "Verified".
4. Developer settings > API keys > create, then:

```sh
curl -sS https://mail.scribase.com/api/v1/emails \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"from":"hello@<domain>","to":"<you>","subject":"Scribase Mail test","html":"<p>ok</p>"}'
```

The email should reach `SENT` within seconds (approved sender auto-created on
the first send) and `DELIVERED` within about 1-5 minutes (OCI Logging ingest
delay plus the one-minute poll).

5. Delivery events. On its first run the delivery log poll job creates the
   `scribase-mail` log group (`OCI_LOG_GROUP_NAME`) and, for every verified
   domain, an `emaildelivery` service log per category (`outboundrelayed`,
   `outboundaccepted`) with the OCI email domain as resource. This also
   covers domains that existed before this feature; nothing to click in the
   Console. Check in OCI Console > Observability > Logging > Log groups, or:

```sh
docker logs scribase-mail-web 2>&1 | grep -E "DeliveryLogPollJob|OciDeliveryLogs"
```

   A "Could not enable delivery logs" warning with 404/NotAuthorized means the
   IAM policy above is missing (retried every 30 minutes). If a domain's logs
   were already enabled from the Console into another log group in the same
   compartment, that is fine: the search covers the whole compartment.

6. Resend SDK compatibility. Point the official SDK at the API host; only the
   base URL changes (API keys are Scribase Mail `us_...` keys):

```sh
# Node: RESEND_BASE_URL or the baseUrl option
RESEND_BASE_URL=https://mail-api.scribase.com RESEND_API_KEY=$KEY node -e '
  const { Resend } = require("resend");
  new Resend().emails.send({ from: "hello@<domain>", to: "<you>", subject: "SDK test",
    html: "<p>ok</p>", scheduledAt: "in 2 min" }).then(console.log)'
# Python: RESEND_API_URL=https://mail-api.scribase.com
```

   The path-prefix form `https://mail.scribase.com/api/resend` works too (the
   SDK concatenates base URL and path). Implemented so far: `POST /emails`,
   `GET /emails/{id}`, `GET /emails` (cursor pagination). Fields not yet
   supported (`attachments[].path`, `content_id`, `content_type`, `topic_id`)
   return a 422 with a clear message instead of being dropped. API keys with
   "Sending access" can only call `POST /emails` and `POST /emails/batch`
   (Resend semantics) on both APIs. Default rate limit is 10 req/s per team
   (Admin > Teams to change it per team), shared by both APIs.

In cloud mode a new team's first emails are `HELD` for review: open
Admin > Review, check the preview, and click Approve (or "Approve and trust
team" for your own team). The email should then reach `SENT` within seconds
(approved sender auto-created on the first send). A test with a link to a
listed phishing domain should be refused with `400 Email rejected by content
screening`.

## 7. Backups

```sh
# nightly dump, keep 14 days (add to the box crontab)
0 3 * * * docker exec scribase-mail-postgres pg_dump -U scribase_mail -Fc scribase_mail \
  > /srv/scribase-mail/backups/$(date +\%F).dump && find /srv/scribase-mail/backups -mtime +14 -delete
```

## 8. Billing (Dodo Payments)

Billing is optional. Without the Dodo keys the app runs normally and the
billing page shows "Billing not configured". Prices and quotas live in one
file, `packages/lib/src/constants/pricing.ts`; the Dodo products below must
match it (Free 3,000/mo + 100/day + 1 domain; Pro $20 with 50,000/mo and 10
domains; Scale $90 with 100,000/mo and 1,000 domains; $0.90 per 1,000 extra
emails on Pro and Scale).

Do everything in **test mode** first, then repeat in live mode.

**Production state (2026-10-08, created via the Dodo API in live mode on the
shared business):** meter `mtr_0NpFcOMHHeIraqL8p95ok` (event
`scribase_mail.email.sent`, sum over `emails`), Pro `pdt_0NpFcORN2iMOkMVRw7VBG`,
Scale `pdt_0NpFcOUMth7PWNLxeoKTA` (usage-based price: fixed $20 / $90 monthly,
meter at `price_per_unit` `"0.09"` = 0.09 cents per email, free threshold
50,000 / 100,000), webhook `ep_3KNwODDOloA51pjBbf2ZX2Buiu9`. The event name is
namespaced because Dodo meters are business-wide and other products share the
business; set `DODO_USAGE_EVENT_NAME` to match. Over the API,
`price_per_unit` is in the lowest denomination (cents), not dollars.

1. **Meter** (Dashboard > Products > Meters > Create):
   name `Emails sent`, event name `email.sent`, aggregation **Sum** over
   metadata key `emails`, unit `emails`. Copy the id (`mtr_...`).
   The app reports one event per team per UTC day
   (id `scribase-mail:usage:<teamId>:<date>`, so repeats are ignored).
2. **Pro product** (Products > Create > Subscription): name
   `Scribase Mail Pro`, $20.00 every 1 month, tax category SaaS. Under usage
   pricing attach the `Emails sent` meter: price per unit `0.0009` (=$0.90
   per 1,000), free threshold `50000`. Copy the id (`pdt_...`).
3. **Scale product**: `Scribase Mail Scale`, $90.00 monthly, same meter at
   `0.0009`, free threshold `100000`. Copy the id.
4. **Customer portal** (Settings > Customer portal): enable cancel and
   payment-method update. Optionally put Pro and Scale in one product
   collection to allow switching from the portal.
5. **Webhook** (Developer > Webhooks > Create): URL
   `https://mail.scribase.com/api/webhook/dodo`. Subscribe to
   `subscription.active`, `subscription.renewed`, `subscription.updated`,
   `subscription.plan_changed`, `subscription.on_hold`,
   `subscription.cancelled`, `subscription.failed`, `subscription.expired`,
   `payment.succeeded`, `payment.failed`. Copy the signing secret
   (`whsec_...`). The Dodo business is shared with other products: events for
   other product ids are acknowledged and ignored.
6. **API key** (Developer > API keys): create a key for this app.
7. On the box, add to `deploy/.env` (never commit it):

```sh
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_WEBHOOK_KEY=whsec_...
DODO_PAYMENTS_ENVIRONMENT=test_mode   # live_mode with live keys
DODO_PRODUCT_ID_PRO=pdt_...
DODO_PRODUCT_ID_SCALE=pdt_...
DODO_USAGE_METER_ID=mtr_...
DODO_USAGE_EVENT_NAME=email.sent
```

   then `docker compose ... up -d web` (no rebuild needed).
8. **Test**: Settings > Billing > Pro > Upgrade, pay with a Dodo test card.
   The team flips to Pro after `subscription.active` (the return page polls).
   Dashboard > Webhooks > delivery log should show 200s; a resent delivery
   returns `{"status":"duplicate"}`. After a day of sending, Dashboard >
   Meters shows the `email.sent` events.
9. **Go live**: recreate meter, products and webhook in live mode, swap all
   seven values, set `DODO_PAYMENTS_ENVIRONMENT=live_mode`, restart web.

Behaviour: `active`/`past_due` grant the plan; `on_hold` (renewal failed)
keeps the plan but applies Free limits until the payment is fixed;
`cancelled`/`expired`/`failed` return the team to Free. Cancel from the app
ends the plan at the end of the paid period. Warm-up caps for new teams still
apply on every plan (the stricter limit wins).

## Inbound MX (Wave 3 — receiving emails)

Receiving email requires a separate `mx` Docker service and firewall changes.

### DNS

1. Add `inbound.scribase.com` → box public IP as a Cloudflare DNS record with
   the **grey cloud** (DNS only, not proxied).  Cloudflare's proxy does not
   forward raw SMTP.
2. For each customer domain that has **Receiving** enabled, show them the MX
   record that appears in Dashboard > Domains > DNS Records:
   ```
   MX  @  10 inbound.scribase.com.
   ```

### OCI firewall

OCI Compute instances have a default security list that blocks inbound port 25.
You must open it explicitly:

1. OCI Console → Networking → Virtual Cloud Networks → your VCN →
   Security Lists → your instance's security list → Add Ingress Rule:
   - Source CIDR: `0.0.0.0/0`
   - Protocol: TCP
   - Destination port: 25
2. Also check the instance's OS firewall (iptables/nftables):
   ```sh
   sudo iptables -I INPUT -p tcp --dport 25 -j ACCEPT
   ```

> **Note**: OCI blocks *outbound* port 25 from Compute instances but inbound
> TCP port 25 is allowed once you add the security list rule.  This has been
> documented in OCI docs but always verify against the current console.

### Start the MX service

```sh
# Add to deploy/.env:
INBOUND_ENABLED=true
INBOUND_INTERNAL_SECRET=$(openssl rand -hex 32)
INBOUND_MX_HOSTNAME=inbound.scribase.com
# optional: INBOUND_SSL_KEY_PATH / INBOUND_SSL_CERT_PATH for STARTTLS

cd /opt/scribase-mail
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env \
  --profile mx build mx
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env \
  --profile mx up -d mx
docker compose ... logs -f mx
# expect: "[inbound] MX server listening on port 25 (STARTTLS)"
```

Test from a remote machine:
```sh
# Check MX record resolves
dig MX yourdomain.com
# Send a test mail (Resend API or swaks)
swaks --to test@yourdomain.com --from sender@example.com \
      --server inbound.scribase.com --port 25
```

## Rollback

```sh
cd /opt/scribase-mail
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env down   # keeps data
# remove "scribase-mail" from CADDY_SITES and re-run install.sh caddy
```

To roll back to a previous build, set `GIT_SHA` to the previous image tag
(`docker images scribase-mail`) and `up -d` again. Data stays in
`/srv/scribase-mail/data`.

## Abuse controls (content screening + review queue)

Every email (API, SMTP proxy, campaigns, scheduled) passes one gate in the
send queue right after the limit check:

- **Reject**: link to a host on a threat feed or in
  `SCREENING_BLOCKED_DOMAINS`, or an executable/script/disk-image attachment
  (`.exe .js .scr .iso .lnk ...`). The API and SMTP proxy return
  `400 Email rejected by content screening: <reason>`; campaigns are refused
  when scheduled. Each such rejection is a strike; 3 strikes in 7 days block
  the team (`blockedReason: CONTENT: ...`) and email `ADMIN_EMAIL`.
- **Hold**: raw-IP links, URL shorteners, link text showing a different
  domain than the href, `javascript:`/`data:` links, base64-only bodies,
  macro/html/svg attachments, marketing mail without unsubscribe, or a
  heuristic score >= 5 (phishing/crypto/gift-card language, all-caps subject,
  hidden text, forms...). Thresholds live in
  `apps/web/src/lib/constants/sending-policy.ts` (`SCREENING_POLICY`).
- **First sends**: in cloud mode a new team's emails are held until it has
  sent 20 emails and is 48 hours old (`FIRST_SENDS_REVIEW` /
  `FIRST_SENDS_REVIEW_EMAILS` / `FIRST_SENDS_REVIEW_HOURS`), unless the team
  is admin-verified or trusted.

Held emails show as `HELD` in the customer's email log and in
`GET /api/v1/emails/{id}` (`latestStatus`). The admin gets at most one email
per 30 minutes about the queue. Review at **Admin > Review**
(`/admin/review`): the preview runs in a sandboxed iframe with a CSP that
blocks scripts and every remote load. Actions: Approve, Approve and trust team
(ends the first-sends review for that team), Approve all from this team,
Reject (optional note shown to the customer), Reject and block team.

Threat feeds are downloaded every 6 hours (`SCREENING_FEED_CRON`) into Redis
as a ~3 MB hash index (8 bytes per host); a refresh briefly uses ~30 MB. If a
feed download fails the previous index is kept; if Redis is down, screening
continues with heuristics only. Default feed:
[Phishing.Database](https://github.com/Phishing-Database/Phishing.Database)
active phishing domains (MIT license, commercial use allowed, ~390k hosts).
Shared platforms the feed lists (sites.google.com, vercel.app, ...) are
exempt so legitimate mail isn't rejected; subdomains on them still match.

Feeds deliberately **not** used by default because their terms forbid or
restrict commercial use: Spamhaus DNSBLs, Google Safe Browsing Lookup v4,
OpenPhish community feed (non-commercial only), abuse.ch URLhaus/ThreatFox
(Auth-Key required; commercial use may need a paid subscription), Phishing
Army (CC BY-NC). Add a feed to `SCREENING_FEED_URLS` only after checking its
terms.

## Notes

- Self-hosted mode (`NEXT_PUBLIC_IS_CLOUD=false`) lets anyone who can sign in
  create a team and send through the owner's OCI tenancy once their domain is
  verified. Keep email sign-in limited (for example only `ADMIN_EMAIL` and
  invited users) until abuse controls are in place.
- Delivery events come from the OCI Email Delivery "OutboundRelayed" log
  (`relay` -> delivered, `bounce` -> bounced, hard = permanent / soft =
  transient, `complaint` -> complained), read every minute via Logging Search
  (`DELIVERY_LOG_POLL_CRON`). OCI open/click/unsubscribe records are ignored;
  Scribase Mail tracks those itself. The suppression-list poll stays as a
  fallback; the same bounce/complaint for the same recipient is counted once.
- OCI daily/rate limits apply to the whole tenancy, shared with Rally and other
  products. Set Admin > Email provider > Send rate accordingly.
