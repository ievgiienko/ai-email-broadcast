import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, sql } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { conflict, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Cancels the remaining queue. Rows currently held by a worker (SENDING) are
 * left alone — they are already in flight and will resolve on their own; the
 * campaign status stops any further claims.
 */
export async function POST(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;

    const rows = await db
      .update(campaigns)
      .set({ status: "CANCELLED", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), inArray(campaigns.status, ["QUEUED", "SENDING", "PAUSED"])))
      .returning({ id: campaigns.id });

    if (rows.length === 0) conflict("Only a queued, sending or paused campaign can be cancelled");

    const cancelled = await sql<{ id: string }[]>`
      UPDATE campaign_recipients
      SET delivery_status = 'CANCELLED',
          last_error = 'Campaign cancelled before delivery',
          lease_expires_at = NULL,
          claimed_by = NULL
      WHERE campaign_id = ${id} AND delivery_status = 'QUEUED'
      RETURNING id
    `;

    return NextResponse.json({ ok: true, cancelledRecipients: cancelled.length });
  });
}
