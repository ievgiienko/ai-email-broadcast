import { randomUUID } from "node:crypto";
import type { Transporter } from "nodemailer";
import { db, sql } from "./db";
import { suppressions } from "./db/schema";
import { getSmtpConfig, appUrl, type ResolvedSmtpConfig } from "./settings";
import { createTransport, isPermanentSmtpError, sanitizeErrorMessage, sendMessage } from "./mailer";
import { buildMessage } from "./message-builder";
import {
  claimRecipients,
  countSentInLastHour,
  filterSuppressed,
  finalizeCompletedCampaigns,
  logSendAttempt,
  markCampaignsStarted,
  markFailed,
  markSent,
  markSuppressed,
  pruneSendLog,
  refundSendAttempts,
  reclaimExpiredLeases,
  releaseClaims,
  scheduleRetry,
  type ClaimedRecipient,
} from "./queue";
import { MAX_ATTEMPTS, batchSize, retryDelaySeconds, shouldRetry } from "./rate-limit";

export type TickResult = {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  suppressed: number;
  reclaimed: number;
  completedCampaigns: number;
  rateLimited: boolean;
  durationMs: number;
  note?: string;
};

/** Leave headroom before the platform kills the invocation mid-send. */
const DEFAULT_TIME_BUDGET_MS = Number(process.env.WORKER_TIME_BUDGET_MS ?? 45_000);
const BATCH_CAP = Number(process.env.WORKER_BATCH_CAP ?? 200);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const TICK_INTERVAL_SECONDS = Number(process.env.WORKER_TICK_INTERVAL_SECONDS ?? 60);

/**
 * Processes one bounded slice of the queue and returns.
 *
 * The invariant: a recipient row is claimed atomically (QUEUED -> SENDING with
 * an incremented attempt count and a lease) *before* any SMTP traffic happens.
 * Everything after that only ever narrows the row's state, so re-running a tick
 * — or running two concurrently — cannot produce a second send.
 */
export async function runTick(options: { timeBudgetMs?: number } = {}): Promise<TickResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const workerId = `${process.env.WORKER_ID ?? "worker"}-${randomUUID().slice(0, 8)}`;

  const result: TickResult = {
    claimed: 0, sent: 0, failed: 0, retried: 0, suppressed: 0,
    reclaimed: 0, completedCampaigns: 0, rateLimited: false,
    durationMs: 0,
  };

  result.reclaimed = await reclaimExpiredLeases();

  const config = await getSmtpConfig();
  if (!config) {
    result.completedCampaigns = await finalizeCompletedCampaigns();
    result.durationMs = Date.now() - startedAt;
    result.note = "SMTP is not configured; nothing was sent.";
    return result;
  }

  let transport: Transporter | null = null;

  try {
    while (Date.now() < deadline) {
      const sentInLastHour = await countSentInLastHour();
      const limit = batchSize({
        maxPerHour: config.maxEmailsPerHour,
        sentInLastHour,
        batchCap: BATCH_CAP,
        tickIntervalSeconds: TICK_INTERVAL_SECONDS,
      });

      if (limit <= 0) {
        result.rateLimited = true;
        result.note = `Hourly rate limit reached (${sentInLastHour} sent in the last hour).`;
        break;
      }

      const claimed = await claimRecipients(workerId, limit);
      if (claimed.length === 0) break;
      result.claimed += claimed.length;

      await markCampaignsStarted([...new Set(claimed.map((r) => r.campaignId))]);

      // Suppression is re-checked here, not just at queue-generation time: an
      // address can unsubscribe while its campaign is mid-flight.
      const suppressed = await filterSuppressed(claimed.map((r) => r.emailNormalized));
      const sendable: ClaimedRecipient[] = [];
      for (const recipient of claimed) {
        if (suppressed.has(recipient.emailNormalized)) {
          await markSuppressed(recipient.id, "Address is on the suppression list");
          result.suppressed += 1;
        } else {
          sendable.push(recipient);
        }
      }

      if (sendable.length === 0) continue;

      if (!transport) transport = createTransport(config);

      // Reserve quota for the whole batch before sending any of it, so a
      // concurrent worker sees the reservation immediately.
      const reservations = await logSendAttempt(sendable.length);

      const outcome = await sendBatch(transport, config, sendable);
      result.sent += outcome.sent;
      result.failed += outcome.failed;
      result.retried += outcome.retried;

      // A batch that hit a hard transport failure means the next one will too.
      if (outcome.abort) {
        const attempted = outcome.sent + outcome.failed + outcome.retried;
        await refundSendAttempts(reservations.slice(attempted));
        result.note = outcome.abortReason;
        break;
      }
    }
  } finally {
    transport?.close();
  }

  result.completedCampaigns = await finalizeCompletedCampaigns();
  await pruneSendLog().catch(() => undefined);
  result.durationMs = Date.now() - startedAt;
  return result;
}

type BatchOutcome = { sent: number; failed: number; retried: number; abort: boolean; abortReason?: string };

async function sendBatch(
  transport: Transporter,
  config: ResolvedSmtpConfig,
  recipients: ClaimedRecipient[],
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { sent: 0, failed: 0, retried: 0, abort: false };
  const baseUrl = appUrl();
  const queue = [...recipients];
  let authFailure: string | null = null;

  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, queue.length)) }, async () => {
    for (;;) {
      const recipient = queue.shift();
      if (!recipient) return;
      if (authFailure) {
        // Stop burning attempts on a transport that is definitely broken.
        await releaseClaims([recipient.id]);
        continue;
      }

      try {
        const message = buildMessage({
          campaign: {
            subject: recipient.subject,
            compiledHtml: recipient.compiledHtml,
            textBody: recipient.textBody,
          },
          recipient,
          baseUrl,
          unsubscribeMailto:
            recipient.replyTo ?? config.replyTo ?? recipient.fromEmail ?? config.fromEmail,
        });

        await sendMessage(transport, config, {
          to: recipient.email,
          ...message,
          fromName: recipient.fromName,
          fromEmail: recipient.fromEmail,
          replyTo: recipient.replyTo,
        });
        await markSent(recipient.id);
        outcome.sent += 1;
      } catch (error) {
        const message = sanitizeErrorMessage(error, config);
        const permanent = isPermanentSmtpError(error);

        // Authentication/connection failures are configuration problems, not
        // recipient problems — abort the batch instead of failing everyone.
        if (isTransportFailure(error)) {
          authFailure = message;
          await releaseClaims([recipient.id]);
          continue;
        }

        if (shouldRetry(recipient.attempts, permanent, MAX_ATTEMPTS)) {
          await scheduleRetry(recipient.id, retryDelaySeconds(recipient.attempts), message);
          outcome.retried += 1;
        } else {
          await markFailed(recipient.id, message);
          outcome.failed += 1;
        }
      }
    }
  });

  await Promise.all(workers);

  if (authFailure) {
    outcome.abort = true;
    outcome.abortReason = `SMTP transport failure, batch aborted: ${authFailure}`;
  }
  return outcome;
}

/** Distinguishes "the SMTP server is unusable" from "this recipient failed". */
function isTransportFailure(error: unknown): boolean {
  const err = error as { code?: string; command?: string; responseCode?: number } | null;
  if (!err) return false;
  if (err.code === "EAUTH") return true;
  if (err.code === "ECONNECTION" || err.code === "ESOCKET" || err.code === "ETIMEDOUT") return true;
  if (err.code === "EDNS" || err.code === "ENOTFOUND") return true;
  // 421/451 on connect means the server is throttling or shutting us down.
  if (err.responseCode === 421) return true;
  return false;
}

/* -------------------------------------------------------- suppression ops */

/** Adds an address to the global suppression list (idempotent). */
export async function suppressEmail(input: {
  email: string;
  emailNormalized: string;
  reason: "UNSUBSCRIBED" | "MANUAL" | "HARD_BOUNCE" | "COMPLAINT";
  campaignId?: string | null;
  note?: string | null;
}): Promise<void> {
  await db
    .insert(suppressions)
    .values({
      email: input.email,
      emailNormalized: input.emailNormalized,
      reason: input.reason,
      campaignId: input.campaignId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing({ target: suppressions.emailNormalized });

  // Pull the address out of any queue it is currently sitting in.
  await sql`
    UPDATE campaign_recipients
    SET delivery_status = 'SUPPRESSED',
        last_error = 'Unsubscribed before delivery',
        lease_expires_at = NULL,
        claimed_by = NULL
    WHERE email_normalized = ${input.emailNormalized}
      AND delivery_status = 'QUEUED'
  `;
}
