import { db, sql } from "@/lib/db";
import { campaignLists, campaignRecipients, campaigns, contactListMembers, contactLists, contacts, suppressions } from "@/lib/db/schema";
import { randomToken } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/email-address";

/** Wipes every table between tests so each one starts from a known state. */
export async function resetDatabase(): Promise<void> {
  await sql`
    TRUNCATE campaign_recipients, campaign_lists, campaigns,
             contact_list_members, contact_lists, contacts,
             suppressions, smtp_send_log, sessions, users
    RESTART IDENTITY CASCADE
  `;
}

export async function createList(name: string): Promise<string> {
  const [row] = await db.insert(contactLists).values({ name }).returning({ id: contactLists.id });
  return row.id;
}

export async function addContact(
  listId: string | null,
  email: string,
  firstName?: string,
): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ email, emailNormalized: normalizeEmail(email), firstName: firstName ?? null })
    .onConflictDoUpdate({ target: contacts.emailNormalized, set: { updatedAt: new Date() } })
    .returning({ id: contacts.id });

  if (listId) {
    await db
      .insert(contactListMembers)
      .values({ listId, contactId: contact.id })
      .onConflictDoNothing();
  }
  return contact.id;
}

export async function createCampaign(options: {
  name?: string;
  subject?: string;
  html?: string;
  listIds?: string[];
  status?: "DRAFT" | "QUEUED" | "SENDING" | "PAUSED" | "COMPLETED" | "CANCELLED";
} = {}): Promise<string> {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: options.name ?? "Test campaign",
      subject: options.subject ?? "Hello {{firstName}}",
      compiledHtml: options.html ?? "<p>Hi {{firstName}}</p>",
      contentHtml: options.html ?? "<p>Hi {{firstName}}</p>",
      status: options.status ?? "DRAFT",
    })
    .returning({ id: campaigns.id });

  for (const listId of options.listIds ?? []) {
    await db.insert(campaignLists).values({ campaignId: campaign.id, listId });
  }
  return campaign.id;
}

/** Inserts a recipient row directly, bypassing generation. */
export async function addRecipient(
  campaignId: string,
  email: string,
  overrides: Partial<typeof campaignRecipients.$inferInsert> = {},
) {
  const [row] = await db
    .insert(campaignRecipients)
    .values({
      campaignId,
      email,
      emailNormalized: normalizeEmail(email),
      trackingToken: randomToken(32),
      unsubscribeToken: randomToken(32),
      ...overrides,
    })
    .returning();
  return row;
}

export async function suppress(email: string, reason: "UNSUBSCRIBED" | "MANUAL" = "UNSUBSCRIBED") {
  await db
    .insert(suppressions)
    .values({ email, emailNormalized: normalizeEmail(email), reason })
    .onConflictDoNothing();
}

export async function getRecipient(id: string) {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM campaign_recipients WHERE id = ${id}
  `;
  return rows[0];
}

export async function getCampaign(id: string) {
  const rows = await sql<Record<string, unknown>[]>`SELECT * FROM campaigns WHERE id = ${id}`;
  return rows[0];
}

export async function countByStatus(campaignId: string): Promise<Record<string, number>> {
  const rows = await sql<{ delivery_status: string; count: string }[]>`
    SELECT delivery_status, count(*)::text AS count
    FROM campaign_recipients WHERE campaign_id = ${campaignId}
    GROUP BY delivery_status
  `;
  return Object.fromEntries(rows.map((r) => [r.delivery_status, Number(r.count)]));
}
