import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or, sql as raw } from "drizzle-orm";
import { db } from "@/lib/db";
import { contactListMembers, contacts } from "@/lib/db/schema";
import { badRequest, optionalStr, pagination, readJson, str, withAuth, withAuthMutation } from "@/lib/api";
import { isValidEmail, normalizeEmail } from "@/lib/email-address";
import { importContacts } from "@/lib/import";

export async function GET(request: Request) {
  return withAuth(async () => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = pagination(url);
    const search = (url.searchParams.get("search") ?? "").trim();
    const listId = url.searchParams.get("listId");

    // `ilike` is parameterized by drizzle; the % wrappers are data, not SQL.
    const searchFilter = search
      ? or(
          ilike(contacts.emailNormalized, `%${search.toLowerCase()}%`),
          ilike(contacts.firstName, `%${search}%`),
          ilike(contacts.lastName, `%${search}%`),
        )
      : undefined;

    const base = listId
      ? db
          .select({
            id: contacts.id,
            email: contacts.email,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            createdAt: contacts.createdAt,
          })
          .from(contacts)
          .innerJoin(contactListMembers, eq(contactListMembers.contactId, contacts.id))
          .where(and(eq(contactListMembers.listId, listId), searchFilter))
      : db
          .select({
            id: contacts.id,
            email: contacts.email,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            createdAt: contacts.createdAt,
          })
          .from(contacts)
          .where(searchFilter);

    const rows = await base.orderBy(desc(contacts.createdAt)).limit(pageSize).offset(offset);

    const countQuery = listId
      ? db
          .select({ count: raw<number>`count(*)::int` })
          .from(contacts)
          .innerJoin(contactListMembers, eq(contactListMembers.contactId, contacts.id))
          .where(and(eq(contactListMembers.listId, listId), searchFilter))
      : db.select({ count: raw<number>`count(*)::int` }).from(contacts).where(searchFilter);

    const [{ count }] = await countQuery;

    return NextResponse.json({ contacts: rows, total: count, page, pageSize });
  });
}

export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{
      email?: string;
      firstName?: string;
      lastName?: string;
      listId?: string | null;
    }>(request);

    const email = str(body.email, "Email", { max: 254 });
    if (!isValidEmail(email)) badRequest("That is not a valid email address");

    const summary = await importContacts(body.listId ?? null, [
      {
        email,
        firstName: optionalStr(body.firstName, "First name", 200),
        lastName: optionalStr(body.lastName, "Last name", 200),
      },
    ]);

    if (summary.skippedSuppressed > 0) {
      badRequest("That address is on the suppression list and cannot be added.");
    }

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.emailNormalized, normalizeEmail(email)))
      .limit(1);

    return NextResponse.json({ contact, summary }, { status: 201 });
  });
}

export async function DELETE(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ ids?: string[]; listId?: string | null }>(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) badRequest("No contacts selected");
    if (ids.length > 5000) badRequest("Delete at most 5000 contacts at a time");

    if (body.listId) {
      // Scoped delete: remove from this list only.
      const removed = await db
        .delete(contactListMembers)
        .where(and(eq(contactListMembers.listId, body.listId), inArray(contactListMembers.contactId, ids)))
        .returning({ contactId: contactListMembers.contactId });
      return NextResponse.json({ removed: removed.length, scope: "list" });
    }

    const deleted = await db.delete(contacts).where(inArray(contacts.id, ids)).returning({ id: contacts.id });
    return NextResponse.json({ removed: deleted.length, scope: "global" });
  });
}
