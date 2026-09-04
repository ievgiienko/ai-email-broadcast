import { inArray, sql as raw } from "drizzle-orm";
import { db, sql } from "./db";
import { contactListMembers, contacts } from "./db/schema";
import { isValidEmail, normalizeEmail } from "./email-address";

export type ImportRow = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  customFields?: Record<string, unknown>;
};

export type ImportSummary = {
  received: number;
  /** Newly added to the target list. */
  imported: number;
  /** Repeated in the input, or already a member of the target list. */
  duplicates: number;
  invalid: number;
  /** On the suppression list — never silently re-subscribed by an import. */
  skippedSuppressed: number;
  invalidSamples: string[];
};

export const MAX_IMPORT_ROWS = Number(process.env.MAX_IMPORT_ROWS ?? 50_000);

/**
 * Validates and de-duplicates input rows before any database work.
 * Pure, so the rules can be tested without a database.
 */
export function prepareRows(rows: ImportRow[]): {
  valid: (ImportRow & { emailNormalized: string })[];
  invalid: string[];
  duplicatesInInput: number;
} {
  const valid: (ImportRow & { emailNormalized: string })[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicatesInInput = 0;

  for (const row of rows) {
    const email = (row.email ?? "").trim();
    if (!isValidEmail(email)) {
      if (email.length > 0) invalid.push(email);
      continue;
    }
    const emailNormalized = normalizeEmail(email);
    if (seen.has(emailNormalized)) {
      duplicatesInInput += 1;
      continue;
    }
    seen.add(emailNormalized);
    valid.push({
      ...row,
      email,
      emailNormalized,
      firstName: emptyToNull(row.firstName),
      lastName: emptyToNull(row.lastName),
    });
  }

  return { valid, invalid, duplicatesInInput };
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Upserts contacts and attaches them to a list.
 *
 * A contact is global (unique by normalized email) and may belong to many
 * lists. Existing names are only filled in, never blanked by a sparser import.
 * Suppressed addresses are excluded outright: re-importing a CSV must not
 * quietly resurrect someone who unsubscribed.
 */
export async function importContacts(
  listId: string | null,
  rows: ImportRow[],
): Promise<ImportSummary> {
  const received = rows.length;
  const { valid, invalid, duplicatesInInput } = prepareRows(rows.slice(0, MAX_IMPORT_ROWS));

  const summary: ImportSummary = {
    received,
    imported: 0,
    duplicates: duplicatesInInput,
    invalid: invalid.length,
    skippedSuppressed: 0,
    invalidSamples: invalid.slice(0, 10),
  };

  if (valid.length === 0) return summary;

  const suppressed = await suppressedAmong(valid.map((r) => r.emailNormalized));
  const sendable = valid.filter((r) => !suppressed.has(r.emailNormalized));
  summary.skippedSuppressed = valid.length - sendable.length;

  const CHUNK = 500;
  for (let i = 0; i < sendable.length; i += CHUNK) {
    const chunk = sendable.slice(i, i + CHUNK);

    await db
      .insert(contacts)
      .values(
        chunk.map((r) => ({
          email: r.email,
          emailNormalized: r.emailNormalized,
          firstName: r.firstName ?? null,
          lastName: r.lastName ?? null,
          customFields: r.customFields ?? {},
        })),
      )
      .onConflictDoUpdate({
        target: contacts.emailNormalized,
        set: {
          // A new value wins; an absent one leaves the stored value intact.
          firstName: raw`COALESCE(excluded.first_name, ${contacts.firstName})`,
          lastName: raw`COALESCE(excluded.last_name, ${contacts.lastName})`,
          updatedAt: new Date(),
        },
      });

    const ids = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.emailNormalized, chunk.map((r) => r.emailNormalized)));

    if (listId) {
      const added = await db
        .insert(contactListMembers)
        .values(ids.map((c) => ({ listId, contactId: c.id })))
        .onConflictDoNothing()
        .returning({ contactId: contactListMembers.contactId });

      summary.imported += added.length;
      summary.duplicates += ids.length - added.length;
    } else {
      summary.imported += ids.length;
    }
  }

  return summary;
}

async function suppressedAmong(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await sql<{ email_normalized: string }[]>`
    SELECT email_normalized FROM suppressions WHERE email_normalized = ANY(${emails}::text[])
  `;
  return new Set(rows.map((r) => r.email_normalized));
}
