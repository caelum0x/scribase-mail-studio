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
# OCI_FINGERPRINT, ADMIN_EMAIL, GIT_SHA=<commit>.
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
- OCI daily/rate limits apply to the whole tenancy, shared with Rally and other
  products. Set Admin > Email provider > Send rate accordingly.
