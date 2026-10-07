import { handle } from "hono/vercel";
import { resendApp } from "~/server/public-api/resend";

// Resend-compatible API. In production the API host (api.mail.scribase.com)
// is rewritten here by Caddy; see deploy/DEPLOY.md.
export const GET = handle(resendApp);
export const POST = handle(resendApp);
export const PUT = handle(resendApp);
export const DELETE = handle(resendApp);
export const PATCH = handle(resendApp);
