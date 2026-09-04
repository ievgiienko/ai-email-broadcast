import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignLists } from "@/lib/db/schema";
import { withAuth } from "@/lib/api";
import { previewAudience } from "@/lib/campaign-recipients";
import { getSmtpConfig } from "@/lib/settings";
import { estimateDurationSeconds, formatDuration } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ id: string }> };

/** Numbers behind the recipient-selection and confirmation screens. */
export async function GET(_request: Request, ctx: Ctx) {
  return withAuth(async () => {
    const { id } = await ctx.params;
    const lists = await db
      .select({ listId: campaignLists.listId })
      .from(campaignLists)
      .where(eq(campaignLists.campaignId, id));

    const audience = await previewAudience(lists.map((l) => l.listId));
    const config = await getSmtpConfig().catch(() => null);
    const maxPerHour = config?.maxEmailsPerHour ?? Number(process.env.SMTP_MAX_EMAILS_PER_HOUR ?? 5000);
    const seconds = estimateDurationSeconds(audience.finalRecipients, maxPerHour);

    return NextResponse.json({
      ...audience,
      maxEmailsPerHour: maxPerHour,
      estimatedSeconds: seconds,
      estimatedDuration: formatDuration(seconds),
    });
  });
}
