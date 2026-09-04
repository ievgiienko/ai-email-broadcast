import { NextResponse } from "next/server";
import { desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/lib/db";
import { contactListMembers, contactLists } from "@/lib/db/schema";
import { optionalStr, readJson, str, withAuth, withAuthMutation } from "@/lib/api";

export async function GET() {
  return withAuth(async () => {
    const rows = await db
      .select({
        id: contactLists.id,
        name: contactLists.name,
        description: contactLists.description,
        createdAt: contactLists.createdAt,
        contactCount: raw<number>`count(${contactListMembers.contactId})::int`,
      })
      .from(contactLists)
      .leftJoin(contactListMembers, eq(contactListMembers.listId, contactLists.id))
      .groupBy(contactLists.id)
      .orderBy(desc(contactLists.createdAt));

    return NextResponse.json({ lists: rows });
  });
}

export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ name?: string; description?: string }>(request);
    const [list] = await db
      .insert(contactLists)
      .values({
        name: str(body.name, "List name", { max: 200 }),
        description: optionalStr(body.description, "Description", 1000),
      })
      .returning();
    return NextResponse.json({ list }, { status: 201 });
  });
}
