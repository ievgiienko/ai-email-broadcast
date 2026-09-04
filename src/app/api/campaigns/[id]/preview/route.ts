import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { notFound, withAuth } from "@/lib/api";
import { buildMessage } from "@/lib/message-builder";
import { appUrl } from "@/lib/settings";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Renders the campaign against sample merge data. `preview: true` omits the
 * tracking pixel, so opening a preview can never register as an open.
 */
export async function GET(request: Request, ctx: Ctx) {
  return withAuth(async () => {
    const { id } = await ctx.params;
    const url = new URL(request.url);

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const campaign = rows[0];
    if (!campaign) notFound("Campaign not found");

    const message = buildMessage({
      campaign,
      recipient: {
        email: url.searchParams.get("email") || "jane.doe@example.com",
        firstName: url.searchParams.get("firstName") || "Jane",
        lastName: url.searchParams.get("lastName") || "Doe",
      },
      baseUrl: appUrl(),
      preview: true,
    });

    return NextResponse.json({ subject: message.subject, html: message.html, text: message.text });
  });
}
