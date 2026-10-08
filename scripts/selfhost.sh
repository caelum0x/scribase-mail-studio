#!/usr/bin/env sh
# Scribase Mail one-command self-host.
#   ./scripts/selfhost.sh           start (pulls the prebuilt image, builds if unavailable)
#   ./scripts/selfhost.sh --build   build the image from this checkout
# Creates .env from .env.selfhost.example with generated secrets on first run.
set -eu

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/get-docker/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (docker compose)." >&2
  exit 1
fi

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f .env ]; then
  cp .env.selfhost.example .env
  tmp="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *__GENERATE__*) printf '%s\n' "$(printf '%s' "$line" | sed "s/__GENERATE__/$(gen_secret)/")" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  echo "Created .env with generated secrets."
else
  echo "Using existing .env."
fi

if [ "${1:-}" = "--build" ]; then
  docker compose up -d --build
else
  if ! docker compose pull --quiet web 2>/dev/null; then
    echo "Prebuilt image not available; building from source (several minutes)."
    docker compose build web
  fi
  docker compose up -d
fi

port="$(grep -E '^SCRIBASE_MAIL_PORT=' .env | tail -1 | cut -d= -f2 | tr -d '"' || true)"
port="${port:-3000}"

printf 'Waiting for Scribase Mail to become healthy'
i=0
until [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    echo
    echo "Not healthy after 3 minutes. Logs: docker compose logs web" >&2
    exit 1
  fi
  printf '.'
  sleep 2
done
echo

cat <<MSG

Scribase Mail is running.

  Dashboard              http://localhost:${port}
  Resend-compatible API  http://localhost:${port}/api/resend
  Caught mail (Mailpit)  http://localhost:8025

Sign in with any email address; the sign-in code arrives in Mailpit.
The first account becomes the owner. Then create an API key and send:

  RESEND_BASE_URL=http://localhost:${port}/api/resend RESEND_API_KEY=<key> node app.js

Real delivery: set SMTP_* in .env and remove "mailpit" from COMPOSE_PROFILES,
then run ./scripts/selfhost.sh again. See docs/SELF-HOSTING.md.
MSG
