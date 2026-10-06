# Docker setup for Scribase Mail

- `Dockerfile` builds the web app (Next.js standalone) from the monorepo root.
- `start.sh` runs `prisma migrate deploy` and starts the server.
- `dev/compose.yml` starts Postgres and Redis for local development (`pnpm dx:up`).
- `testing/compose.yml` starts Postgres and Redis for integration tests.

For production use `deploy/compose.scribase-mail.yml` and follow
`deploy/DEPLOY.md`. Environment variables are documented in
`.env.selfhost.example`.

Build the image locally:

```sh
./docker/build.sh
```
