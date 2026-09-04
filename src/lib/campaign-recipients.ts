import { eq, inArray } from "drizzle-orm";
import { db, sql } from "./db";
import { campaignLists, campaignRecipients, campaigns, contactListMembers, contacts } from "./db/schema";
import { normalizeEmail } from "./email-address";
import { randomToken } from "./crypto";

export type CandidateContact = {
  contactId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  customFields: Record<string, unknown>;
};

/**
 * Collapses contacts appearing in several selected lists down to one entry per
 * address. Comparison is case-insensitive; the first occurrence wins so the
 * retained record is deterministic.
 *
 * Pure and exported for testing — this is the rule that turns "A + B" with an
 * overlapping address into 3 emails rather than 4.
 */
export function dedupeCandidates(candidates: CandidateContact[]): {
  unique: (CandidateContact & { emailNormalized: string })[];
  duplicatesRemoved: number;
} {
  const seen = new Map<string, CandidateContact & { emailNormalized: string }>();
  let duplicatesRemoved = 0;

  for (const candidate of candidates) {
    const emailNormalized = normalizeEmail(candidate.email);
    if (!emailNormalized) continue;
    if (seen.has(emailNormalized)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.set(emailNormalized, { ...candidate, emailNormalized });
  }

  return { unique: [...seen.values()], duplicatesRemoved };
}

/** Every contact in the given lists, with duplicates still present. */
async function loadCandidates(listIds: string[]): Promise<CandidateContact[]> {
  if (listIds.length === 0) return [];
  const rows = await db
    .select({
      contactId: contacts.id,
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      customFields: contacts.customFields,
    })
    .from(contactListMembers)
    .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
    .where(inArray(contactListMembers.listId, listIds))
    .orderBy(contacts.createdAt);

  return rows.map((r) => ({ ...r, customFields: (r.customFields ?? {}) as Record<string, unknown> }));
}

export type AudiencePreview = {
  listIds: string[];
  totalMemberships: number;
  uniqueContacts: number;
  duplicatesRemoved: number;
  suppressed: number;
  finalRecipients: number;
};

/** Counts shown on the recipient-selection and confirmation screens. */
export async function previewAudience(listIds: string[]): Promise<AudiencePreview> {
  const candidates = await loadCandidates(listIds);
  const { unique, duplicatesRemoved } = dedupeCandidates(candidates);

  const suppressedSet = await suppressedAmong(unique.map((u) => u.emailNormalized));

  return {
    listIds,
    totalMemberships: candidates.length,
    uniqueContacts: unique.length,
    duplicatesRemoved,
    suppressed: suppressedSet.size,
    finalRecipients: unique.length - suppressedSet.size,
  };
}

async function suppressedAmong(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await sql<{ email_normalized: string }[]>`
    SELECT email_normalized FROM suppressions WHERE email_normalized = ANY(${emails}::text[])
  `;
  return new Set(rows.map((r) => r.email_normalized));
}

export type GenerateResult = {
  inserted: number;
  skippedSuppressed: number;
  duplicatesRemoved: number;
  total: number;
};

/**
 * Materializes the campaign's queue.
 *
 * Recipient rows carry a *snapshot* of the contact, so later edits or deletions
 * to a contact list never rewrite history. The UNIQUE(campaign_id,
 * email_normalized) index plus ON CONFLICT DO NOTHING makes this safe to call
 * more than once: a retried HTTP request cannot duplicate the queue.
 */
export async function generateRecipients(campaignId: string): Promise<GenerateResult> {
  const listRows = await db
    .select({ listId: campaignLists.listId })
    .from(campaignLists)
    .where(eq(campaignLists.campaignId, campaignId));

  const listIds = listRows.map((r) => r.listId);
  const candidates = await loadCandidates(listIds);
  const { unique, duplicatesRemoved } = dedupeCandidates(candidates);

  const suppressedSet = await suppressedAmong(unique.map((u) => u.emailNormalized));
  const sendable = unique.filter((u) => !suppressedSet.has(u.emailNormalized));

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < sendable.length; i += CHUNK) {
    const chunk = sendable.slice(i, i + CHUNK);
    const rows = await db
      .insert(campaignRecipients)
      .values(
        chunk.map((c) => ({
          campaignId,
          contactId: c.contactId,
          email: c.email,
          emailNormalized: c.emailNormalized,
          firstName: c.firstName,
          lastName: c.lastName,
          customFields: c.customFields,
          trackingToken: randomToken(32),
          unsubscribeToken: randomToken(32),
        })),
      )
      .onConflictDoNothing({
        target: [campaignRecipients.campaignId, campaignRecipients.emailNormalized],
      })
      .returning({ id: campaignRecipients.id });
    inserted += rows.length;
  }

  const totalRows = await sql<{ total: string }[]>`
    SELECT count(*)::text AS total FROM campaign_recipients WHERE campaign_id = ${campaignId}
  `;
  const total = Number(totalRows[0]?.total ?? 0);

  await db
    .update(campaigns)
    .set({ totalRecipients: total, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  return { inserted, skippedSuppressed: suppressedSet.size, duplicatesRemoved, total };
}

export type CampaignStats = {
  total: number;
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  uniqueOpens: number;
  totalOpens: number;
  openRate: number;
};

export async function campaignStats(campaignId: string): Promise<CampaignStats> {
  const [row] = await sql<Record<string, string>[]>`
    SELECT
      count(*)::text                                                    AS total,
      count(*) FILTER (WHERE delivery_status = 'QUEUED')::text          AS queued,
      count(*) FILTER (WHERE delivery_status = 'SENDING')::text         AS sending,
      count(*) FILTER (WHERE delivery_status = 'SENT')::text            AS sent,
      count(*) FILTER (WHERE delivery_status = 'FAILED')::text          AS failed,
      count(*) FILTER (WHERE delivery_status = 'SUPPRESSED')::text      AS suppressed,
      count(*) FILTER (WHERE delivery_status = 'CANCELLED')::text        AS cancelled,
      count(*) FILTER (WHERE first_opened_at IS NOT NULL)::text         AS unique_opens,
      COALESCE(sum(open_count), 0)::text                                AS total_opens
    FROM campaign_recipients
    WHERE campaign_id = ${campaignId}
  `;

  const sent = Number(row?.sent ?? 0);
  const uniqueOpens = Number(row?.unique_opens ?? 0);

  return {
    total: Number(row?.total ?? 0),
    queued: Number(row?.queued ?? 0),
    sending: Number(row?.sending ?? 0),
    sent,
    failed: Number(row?.failed ?? 0),
    suppressed: Number(row?.suppressed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    uniqueOpens,
    totalOpens: Number(row?.total_opens ?? 0),
    // Denominator is delivered mail: opens on unsent messages are impossible.
    openRate: sent > 0 ? uniqueOpens / sent : 0,
  };
}
