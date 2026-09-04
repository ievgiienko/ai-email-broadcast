import { NextResponse } from "next/server";
import { and, asc, eq, ilike, sql as raw } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignRecipients } from "@/lib/db/schema";
import { pagination, withAuth } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SUPPRESSED", "CANCELLED"] as const;
type Status = (typeof STATUSES)[number];

/** Recipient-level table: paginated, searchable, filterable. */
export async function GET(request: Request, ctx: Ctx) {
  return withAuth(async () => {
    const { id } = await ctx.params;
    const url = new URL(request.url);
    const { page, pageSize, offset } = pagination(url);

    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const statusParam = url.searchParams.get("status");
    const status = STATUSES.includes(statusParam as Status) ? (statusParam as Status) : null;

    const where = and(
      eq(campaignRecipients.campaignId, id),
      search ? ilike(campaignRecipients.emailNormalized, `%${search}%`) : undefined,
      status ? eq(campaignRecipients.deliveryStatus, status) : undefined,
    );

    const rows = await db
      .select({
        id: campaignRecipients.id,
        email: campaignRecipients.email,
        deliveryStatus: campaignRecipients.deliveryStatus,
        sentAt: campaignRecipients.sentAt,
        firstOpenedAt: campaignRecipients.firstOpenedAt,
        lastOpenedAt: campaignRecipients.lastOpenedAt,
        openCount: campaignRecipients.openCount,
        attempts: campaignRecipients.attempts,
        lastError: campaignRecipients.lastError,
      })
      .from(campaignRecipients)
      .where(where)
      .orderBy(asc(campaignRecipients.email))
      .limit(pageSize)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: raw<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(where);

    return NextResponse.json({ recipients: rows, total: count, page, pageSize });
  });
}
