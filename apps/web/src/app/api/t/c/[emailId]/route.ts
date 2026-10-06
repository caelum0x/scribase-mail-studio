import { getRequestMeta, recordClick } from "~/server/service/tracking-service";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ emailId: string }> },
) {
  const { emailId } = await params;
  const searchParams = new URL(req.url).searchParams;

  const destination = await recordClick(
    emailId,
    searchParams.get("u"),
    searchParams.get("s"),
    getRequestMeta(req),
  );

  if (!destination) {
    return new Response("Invalid link", { status: 400 });
  }

  return Response.redirect(destination, 302);
}
