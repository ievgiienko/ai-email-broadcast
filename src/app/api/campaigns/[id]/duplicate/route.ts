import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignLists, campaigns } from "@/lib/db/schema";
import { notFound, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** Copies content + list selection into a fresh DRAFT. No stats are carried over. */
export async function POST(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const source = rows[0];
    if (!source) notFound("Campaign not found");

    const [copy] = await db
      .insert(campaigns)
      .values({
        name: `${source.name} (copy)`.slice(0, 200),
        subject: source.subject,
        fromName: source.fromName,
        fromEmail: source.fromEmail,
        replyTo: source.replyTo,
        contentHtml: source.contentHtml,
        compiledHtml: source.compiledHtml,
        textBody: source.textBody,
        textBodyIsCustom: source.textBodyIsCustom,
        status: "DRAFT",
      })
      .returning();

    const lists = await db
      .select({ listId: campaignLists.listId })
      .from(campaignLists)
      .where(eq(campaignLists.campaignId, id));

    if (lists.length > 0) {
      await db
        .insert(campaignLists)
        .values(lists.map((l) => ({ campaignId: copy.id, listId: l.listId })));
    }

    return NextResponse.json({ campaign: copy }, { status: 201 });
  });
}
