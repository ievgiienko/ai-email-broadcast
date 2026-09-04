import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { conflict, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Pausing only changes the campaign's status. The worker's claim query requires
 * status IN ('QUEUED','SENDING'), so queued rows simply stop being claimed —
 * their own state is preserved untouched. Messages already handed to SMTP
 * cannot be recalled and will finish.
 */
export async function POST(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const rows = await db
      .update(campaigns)
      .set({ status: "PAUSED", updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), inArray(campaigns.status, ["QUEUED", "SENDING"])))
      .returning({ id: campaigns.id });

    if (rows.length === 0) conflict("Only a queued or sending campaign can be paused");
    return NextResponse.json({ ok: true });
  });
}
