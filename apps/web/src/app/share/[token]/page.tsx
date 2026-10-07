/**
 * Public share page — renders an email by token (Wave 2 B3).
 *
 * URL: /share/<token>
 * Tokens are created by POST /api/resend/emails/:id/share and expire after 7 days.
 */
import { notFound } from "next/navigation";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
};

export default async function SharePage({ params }: Props) {
  const { token } = await params;

  const share = await db.emailShare.findUnique({
    where: { token },
    include: {
      email: {
        select: {
          id: true,
          subject: true,
          from: true,
          to: true,
          html: true,
          text: true,
          createdAt: true,
        },
      },
    },
  });

  if (!share || share.expiresAt < new Date()) {
    notFound();
  }

  const { email } = share;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{email.subject}</title>
        <style>{`
          body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f4f5; }
          .wrapper { max-width: 680px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
          .header { padding: 20px 24px; border-bottom: 1px solid #e4e4e7; }
          .header h1 { margin: 0 0 6px; font-size: 18px; color: #09090b; }
          .meta { font-size: 13px; color: #71717a; }
          .meta span { margin-right: 16px; }
          .body { padding: 24px; }
          .text-fallback { white-space: pre-wrap; font-size: 14px; color: #3f3f46; line-height: 1.6; }
          .footer { padding: 12px 24px; border-top: 1px solid #e4e4e7; font-size: 12px; color: #a1a1aa; text-align: center; }
        `}</style>
      </head>
      <body>
        <div className="wrapper">
          <div className="header">
            <h1>{email.subject}</h1>
            <div className="meta">
              <span>From: {email.from}</span>
              <span>To: {email.to.join(", ")}</span>
              <span>{email.createdAt.toLocaleString()}</span>
            </div>
          </div>
          <div className="body">
            {email.html ? (
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              <div dangerouslySetInnerHTML={{ __html: email.html }} />
            ) : (
              <pre className="text-fallback">{email.text ?? "(no body)"}</pre>
            )}
          </div>
          <div className="footer">
            Shared via Scribase Mail &mdash; expires {share.expiresAt.toLocaleDateString()}
          </div>
        </div>
      </body>
    </html>
  );
}
