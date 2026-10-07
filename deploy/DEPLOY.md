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
the first send).

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

## Rollback

```sh
cd /opt/scribase-mail
docker compose -f deploy/compose.scribase-mail.yml --env-file deploy/.env down   # keeps data
# remove "scribase-mail" from CADDY_SITES and re-run install.sh caddy
```

To roll back to a previous build, set `GIT_SHA` to the previous image tag
(`docker images scribase-mail`) and `up -d` again. Data stays in
`/srv/scribase-mail/data`.

## Notes

- Self-hosted mode (`NEXT_PUBLIC_IS_CLOUD=false`) lets anyone who can sign in
  create a team and send through the owner's OCI tenancy once their domain is
  verified. Keep email sign-in limited (for example only `ADMIN_EMAIL` and
  invited users) until abuse controls are in place.
- OCI daily/rate limits apply to the whole tenancy, shared with Rally and other
  products. Set Admin > Email provider > Send rate accordingly.
