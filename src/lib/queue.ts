import { and, eq, inArray, sql as raw } from "drizzle-orm";
import { db, sql } from "./db";
import { campaignRecipients, campaigns } from "./db/schema";

/**
 * Persistent sending queue.
 *
 * Every operation that could race with another worker is expressed as a single
 * atomic SQL statement. The database — not any in-process state — is the source
 * of truth, so a crashed or timed-out worker loses nothing.
 */

export const LEASE_SECONDS = Number(process.env.QUEUE_LEASE_SECONDS ?? 300);

export type ClaimedRecipient = {
  id: string;
  campaignId: string;
  email: string;
  emailNormalized: string;
  firstName: string | null;
  lastName: string | null;
  customFields: Record<string, unknown>;
  trackingToken: string;
  unsubscribeToken: string;
  attempts: number;
  subject: string;
  compiledHtml: string;
  textBody: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
};

/** SMTP attempts logged in the last rolling hour, across all workers. */
export async function countSentInLastHour(): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM smtp_send_log
    WHERE occurred_at > now() - interval '1 hour'
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Records one SMTP transaction attempt against the rolling-hour budget. */
export async function logSendAttempt(count = 1): Promise<number[]> {
  if (count <= 0) return [];
  const rows = await sql<{ id: number }[]>`
    INSERT INTO smtp_send_log (occurred_at)
    SELECT now() FROM generate_series(1, ${count})
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/**
 * Returns unused reservations to the hourly budget.
 *
 * Quota is reserved for a whole batch before any of it is sent, so a concurrent
 * worker sees the reservation immediately. When a batch aborts on a transport
 * failure nothing was actually sent, and holding those reservations for an hour
 * would stall real sending long after the admin fixed the configuration.
 * Refunding by explicit id can never touch another worker's rows.
 */
export async function refundSendAttempts(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`DELETE FROM smtp_send_log WHERE id = ANY(${ids}::bigint[])`;
}

/** Keeps the rate-limit log bounded without needing a separate cron job. */
export async function pruneSendLog(): Promise<void> {
  await sql`DELETE FROM smtp_send_log WHERE occurred_at < now() - interval '3 hours'`;
}

/**
 * Returns rows whose lease expired while a worker was mid-flight (crash,
 * serverless timeout) back to QUEUED so another tick can pick them up.
 *
 * Their `attempts` counter was already incremented at claim time, so a row that
 * repeatedly kills its worker still exhausts its retries instead of looping.
 */
export async function reclaimExpiredLeases(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE campaign_recipients
    SET delivery_status = 'QUEUED',
        lease_expires_at = NULL,
        claimed_by = NULL,
        last_error = COALESCE(last_error, 'Worker lease expired before completion')
    WHERE delivery_status = 'SENDING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
      AND attempts < ${maxAttempts()}
    RETURNING id
  `;

  // Rows that burned all their attempts inside crashed workers are terminal.
  await sql`
    UPDATE campaign_recipients
    SET delivery_status = 'FAILED',
        lease_expires_at = NULL,
        claimed_by = NULL,
        last_error = COALESCE(last_error, 'Worker lease expired before completion')
    WHERE delivery_status = 'SENDING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
      AND attempts >= ${maxAttempts()}
  `;
  return rows.length;
}

function maxAttempts(): number {
  return Number(process.env.SMTP_MAX_ATTEMPTS ?? 3);
}

/**
 * Atomically claims up to `limit` due recipients.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select is what makes concurrent cron
 * invocations safe: two workers running at the same instant get disjoint rows
 * instead of both grabbing the same recipient.
 *
 * Claiming also increments `attempts` and stamps a lease, so the row is already
 * accounted for even if this process dies immediately afterwards.
 */
export async function claimRecipients(workerId: string, limit: number): Promise<ClaimedRecipient[]> {
  if (limit <= 0) return [];

  const rows = await sql<ClaimedRecipient[]>`
    WITH due AS (
      SELECT r.id
      FROM campaign_recipients r
      JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.delivery_status = 'QUEUED'
        AND r.next_attempt_at <= now()
        AND c.status IN ('QUEUED', 'SENDING')
      ORDER BY r.next_attempt_at, r.created_at
      LIMIT ${limit}
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE campaign_recipients r
    SET delivery_status = 'SENDING',
        attempts = r.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + (${LEASE_SECONDS} * interval '1 second'),
        claimed_by = ${workerId}
    FROM due, campaigns c2
    WHERE r.id = due.id AND c2.id = r.campaign_id
    RETURNING
      r.id,
      r.campaign_id      AS "campaignId",
      r.email,
      r.email_normalized AS "emailNormalized",
      r.first_name       AS "firstName",
      r.last_name        AS "lastName",
      r.custom_fields    AS "customFields",
      r.tracking_token   AS "trackingToken",
      r.unsubscribe_token AS "unsubscribeToken",
      r.attempts,
      c2.subject,
      c2.compiled_html   AS "compiledHtml",
      c2.text_body       AS "textBody",
      c2.from_name       AS "fromName",
      c2.from_email      AS "fromEmail",
      c2.reply_to        AS "replyTo"
  `;
  return rows;
}

/** Releases claimed rows back to QUEUED without consuming another attempt. */
export async function releaseClaims(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE campaign_recipients
    SET delivery_status = 'QUEUED', lease_expires_at = NULL, claimed_by = NULL,
        attempts = GREATEST(attempts - 1, 0)
    WHERE id = ANY(${ids}::uuid[]) AND delivery_status = 'SENDING'
  `;
}

export async function markSent(id: string): Promise<void> {
  await db
    .update(campaignRecipients)
    .set({
      deliveryStatus: "SENT",
      sentAt: new Date(),
      lastError: null,
      leaseExpiresAt: null,
      claimedBy: null,
    })
    .where(and(eq(campaignRecipients.id, id), eq(campaignRecipients.deliveryStatus, "SENDING")));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(campaignRecipients)
    .set({ deliveryStatus: "FAILED", lastError: error, leaseExpiresAt: null, claimedBy: null })
    .where(and(eq(campaignRecipients.id, id), eq(campaignRecipients.deliveryStatus, "SENDING")));
}

export async function markSuppressed(id: string, reason: string): Promise<void> {
  await db
    .update(campaignRecipients)
    .set({
      deliveryStatus: "SUPPRESSED",
      lastError: reason,
      leaseExpiresAt: null,
      claimedBy: null,
      attempts: raw`GREATEST(${campaignRecipients.attempts} - 1, 0)`,
    })
    .where(and(eq(campaignRecipients.id, id), eq(campaignRecipients.deliveryStatus, "SENDING")));
}

export async function scheduleRetry(id: string, delaySeconds: number, error: string): Promise<void> {
  await sql`
    UPDATE campaign_recipients
    SET delivery_status = 'QUEUED',
        next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
        last_error = ${error},
        lease_expires_at = NULL,
        claimed_by = NULL
    WHERE id = ${id} AND delivery_status = 'SENDING'
  `;
}

/** Addresses on the global suppression list, out of the given candidates. */
export async function filterSuppressed(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await sql<{ email_normalized: string }[]>`
    SELECT email_normalized FROM suppressions WHERE email_normalized = ANY(${emails}::text[])
  `;
  return new Set(rows.map((r) => r.email_normalized));
}

/** Flips QUEUED campaigns that now have in-flight work to SENDING. */
export async function markCampaignsStarted(campaignIds: string[]): Promise<void> {
  if (campaignIds.length === 0) return;
  await db
    .update(campaigns)
    .set({ status: "SENDING", startedAt: raw`COALESCE(${campaigns.startedAt}, now())`, updatedAt: new Date() })
    .where(and(inArray(campaigns.id, campaignIds), eq(campaigns.status, "QUEUED")));
}

/**
 * Marks campaigns COMPLETED once nothing is left to do. Runs as one statement so
 * two workers finishing simultaneously can't produce a half-updated campaign.
 */
export async function finalizeCompletedCampaigns(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE campaigns c
    SET status = 'COMPLETED', completed_at = now(), updated_at = now()
    WHERE c.status = 'SENDING'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_recipients r
        WHERE r.campaign_id = c.id
          AND r.delivery_status IN ('QUEUED', 'SENDING')
      )
    RETURNING c.id
  `;
  return rows.length;
}

export type QueueSnapshot = {
  queued: number;
  sending: number;
  sentLastHour: number;
};

export async function queueSnapshot(): Promise<QueueSnapshot> {
  const [counts] = await sql<{ queued: string; sending: string }[]>`
    SELECT
      count(*) FILTER (WHERE delivery_status = 'QUEUED')::text  AS queued,
      count(*) FILTER (WHERE delivery_status = 'SENDING')::text AS sending
    FROM campaign_recipients
  `;
  return {
    queued: Number(counts?.queued ?? 0),
    sending: Number(counts?.sending ?? 0),
    sentLastHour: await countSentInLastHour(),
  };
}
