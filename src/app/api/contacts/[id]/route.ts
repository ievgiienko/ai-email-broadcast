import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import { badRequest, conflict, notFound, optionalStr, readJson, str, withAuthMutation } from "@/lib/api";
import { isValidEmail, normalizeEmail } from "@/lib/email-address";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<{ email?: string; firstName?: string; lastName?: string }>(request);

    const email = str(body.email, "Email", { max: 254 });
    if (!isValidEmail(email)) badRequest("That is not a valid email address");

    try {
      const rows = await db
        .update(contacts)
        .set({
          email,
          emailNormalized: normalizeEmail(email),
          firstName: optionalStr(body.firstName, "First name", 200),
          lastName: optionalStr(body.lastName, "Last name", 200),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, id))
        .returning();
      if (!rows[0]) notFound("Contact not found");
      return NextResponse.json({ contact: rows[0] });
    } catch (error) {
      if (String(error).includes("contacts_email_normalized_key")) {
        conflict("Another contact already uses that email address");
      }
      throw error;
    }
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const rows = await db.delete(contacts).where(eq(contacts.id, id)).returning({ id: contacts.id });
    if (!rows[0]) notFound("Contact not found");
    return NextResponse.json({ ok: true });
  });
}
