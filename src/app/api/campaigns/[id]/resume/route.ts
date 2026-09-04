import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { conflict, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** Puts the campaign back in the worker's sights; queued rows are untouched. */
export async function POST(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const rows = await db
      .update(campaigns)
      .set({ status: "SENDING", updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "PAUSED")))
      .returning({ id: campaigns.id });

    if (rows.length === 0) conflict("Only a paused campaign can be resumed");
    return NextResponse.json({ ok: true });
  });
}
