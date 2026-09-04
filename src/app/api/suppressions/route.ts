import { NextResponse } from "next/server";
import { desc, eq, ilike, sql as raw } from "drizzle-orm";
import { db } from "@/lib/db";
import { suppressions } from "@/lib/db/schema";
import { badRequest, pagination, readJson, str, withAuth, withAuthMutation } from "@/lib/api";
import { isValidEmail, normalizeEmail } from "@/lib/email-address";
import { suppressEmail } from "@/lib/worker";

export async function GET(request: Request) {
  return withAuth(async () => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = pagination(url);
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const where = search ? ilike(suppressions.emailNormalized, `%${search}%`) : undefined;

    const rows = await db
      .select()
      .from(suppressions)
      .where(where)
      .orderBy(desc(suppressions.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: raw<number>`count(*)::int` })
      .from(suppressions)
      .where(where);

    return NextResponse.json({ suppressions: rows, total: count, page, pageSize });
  });
}

export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ email?: string; note?: string }>(request);
    const email = str(body.email, "Email", { max: 254 });
    if (!isValidEmail(email)) badRequest("That is not a valid email address");

    await suppressEmail({
      email,
      emailNormalized: normalizeEmail(email),
      reason: "MANUAL",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  });
}

/**
 * Removing a suppression is a deliberate, explicit admin action — it never
 * happens as a side effect of importing a contact list.
 */
export async function DELETE(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ email?: string }>(request);
    const email = str(body.email, "Email", { max: 254 });
    await db.delete(suppressions).where(eq(suppressions.emailNormalized, normalizeEmail(email)));
    return NextResponse.json({ ok: true });
  });
}
