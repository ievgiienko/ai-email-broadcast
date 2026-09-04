import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignRecipients } from "@/lib/db/schema";
import { suppressEmail } from "@/lib/worker";

/**
 * Unsubscribe endpoint.
 *
 * POST is the RFC 8058 one-click target referenced by the List-Unsubscribe
 * header, so it is intentionally public and exempt from CSRF checks: the token
 * in the URL is the credential, and the action is idempotent and only ever
 * removes consent.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

async function unsubscribe(token: string): Promise<boolean> {
  if (!token || token.length < 16 || token.length > 128) return false;

  const rows = await db
    .select({
      email: campaignRecipients.email,
      emailNormalized: campaignRecipients.emailNormalized,
      campaignId: campaignRecipients.campaignId,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.unsubscribeToken, token))
    .limit(1);

  const recipient = rows[0];
  if (!recipient) return false;

  await suppressEmail({
    email: recipient.email,
    emailNormalized: recipient.emailNormalized,
    reason: "UNSUBSCRIBED",
    campaignId: recipient.campaignId,
  });
  return true;
}

export async function POST(_request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const ok = await unsubscribe(token);
  // Always 200 for one-click: mail clients treat non-2xx as a broken link, and
  // the response must not reveal whether a token exists.
  return NextResponse.json({ ok });
}

export async function GET(request: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  return NextResponse.redirect(new URL(`/unsubscribe/${encodeURIComponent(token)}`, request.url));
}
