import {
  TRANSPARENT_GIF,
  getRequestMeta,
  recordOpen,
} from "~/server/service/tracking-service";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ emailId: string }> },
) {
  const { emailId } = await params;
  const signature = new URL(req.url).searchParams.get("s");

  await recordOpen(emailId, signature, getRequestMeta(req));

  return new Response(new Uint8Array(TRANSPARENT_GIF), {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
