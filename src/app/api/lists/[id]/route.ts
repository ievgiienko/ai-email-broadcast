import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contactLists } from "@/lib/db/schema";
import { notFound, optionalStr, readJson, str, withAuth, withAuthMutation } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return withAuth(async () => {
    const { id } = await ctx.params;
    const rows = await db.select().from(contactLists).where(eq(contactLists.id, id)).limit(1);
    if (!rows[0]) notFound("List not found");
    return NextResponse.json({ list: rows[0] });
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<{ name?: string; description?: string }>(request);
    const rows = await db
      .update(contactLists)
      .set({
        name: str(body.name, "List name", { max: 200 }),
        description: optionalStr(body.description, "Description", 1000),
        updatedAt: new Date(),
      })
      .where(eq(contactLists.id, id))
      .returning();
    if (!rows[0]) notFound("List not found");
    return NextResponse.json({ list: rows[0] });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    // Memberships cascade; the contacts themselves survive, since they may be
    // on other lists and are referenced by historical campaign recipients.
    const rows = await db.delete(contactLists).where(eq(contactLists.id, id)).returning();
    if (!rows[0]) notFound("List not found");
    return NextResponse.json({ ok: true });
  });
}
