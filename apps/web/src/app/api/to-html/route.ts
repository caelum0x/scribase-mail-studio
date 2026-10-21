import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { logger } from "~/server/logger/log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const data = await req.json();

  try {
    const renderer = new EmailRenderer(data);
    const time = Date.now();
    const html = await renderer.render({
      shouldReplaceVariableValues: true,
      linkValues: {
        "{{usesend_unsubscribe_url}}": "https://mail.scribase.com/unsubscribe",
        "{{unsend_unsubscribe_url}}": "https://mail.scribase.com/unsubscribe",
      },
    });
    logger.info({ ms: Date.now() - time }, "[to-html]: Rendered");
    return new Response(JSON.stringify({ data: html }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (e) {
    logger.error({ err: e }, "[to-html]: Failed to render");
    return new Response(
      JSON.stringify({ data: "Error in converting to html" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      },
    );
  }
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
