import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { runTick } from "@/lib/worker";
import { countSentInLastHour } from "@/lib/queue";
import { startFakeSmtp, type FakeSmtp } from "./smtp-server";
import {
  addRecipient, countByStatus, createCampaign, getCampaign, getRecipient, resetDatabase, suppress,
} from "./helpers";

let smtp: FakeSmtp;

beforeEach(async () => {
  await resetDatabase();
  smtp = await startFakeSmtp();

  // Point the worker at the throwaway server via environment overrides, which
  // take priority over the stored settings.
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_SECURITY = "none";
  process.env.SMTP_USER = "tester";
  process.env.SMTP_PASSWORD = "secret";
  process.env.SMTP_FROM_EMAIL = "sender@example.test";
  process.env.SMTP_FROM_NAME = "Test Sender";
  process.env.SMTP_MAX_EMAILS_PER_HOUR = "5000";
  process.env.WORKER_TICK_INTERVAL_SECONDS = "3600"; // let one tick use the hour's quota
  process.env.WORKER_BATCH_CAP = "50";
});

afterEach(async () => {
  await smtp.close();
});

afterAll(async () => { await sql.end(); });

/**
 * Undoes quoted-printable soft line breaks. Nodemailer wraps long lines at 76
 * characters, which splits URLs and tokens across lines on the wire.
 */
function decodeBody(raw: string): string {
  return raw.replace(/=\r?\n/g, "");
}

describe("runTick", () => {
  it("sends queued recipients and marks them SENT", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@example.test", { firstName: "Ann" });
    await addRecipient(campaignId, "b@example.test", { firstName: "Bob" });

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.sent).toBe(2);
    expect(smtp.messages).toHaveLength(2);
    expect(await countByStatus(campaignId)).toEqual({ SENT: 2 });
  });

  it("personalizes each message and injects that recipient's pixel", async () => {
    const campaignId = await createCampaign({ status: "QUEUED", subject: "Hi {{firstName}}" });
    const recipient = await addRecipient(campaignId, "ann@example.test", { firstName: "Ann" });

    await runTick({ timeBudgetMs: 10_000 });

    const message = decodeBody(smtp.messages[0].data);
    expect(message).toContain("Hi Ann");
    expect(message).toContain(recipient.trackingToken);
    expect(message).toContain(recipient.unsubscribeToken);
    expect(message).toContain("List-Unsubscribe");
  });

  it("moves the campaign through SENDING to COMPLETED", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@example.test");

    await runTick({ timeBudgetMs: 10_000 });

    const campaign = await getCampaign(campaignId);
    expect(campaign.status).toBe("COMPLETED");
    expect(campaign.started_at).not.toBeNull();
    expect(campaign.completed_at).not.toBeNull();
  });

  it("never sends the same recipient twice across repeated ticks", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 8; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await runTick({ timeBudgetMs: 10_000 });
    await runTick({ timeBudgetMs: 10_000 });
    await runTick({ timeBudgetMs: 10_000 });

    expect(smtp.messages).toHaveLength(8);
    const addresses = smtp.messages.flatMap((m) => m.to);
    expect(new Set(addresses).size).toBe(8);
  });

  it("never double-sends when two workers run at the same instant", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 20; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await Promise.all([
      runTick({ timeBudgetMs: 10_000 }),
      runTick({ timeBudgetMs: 10_000 }),
      runTick({ timeBudgetMs: 10_000 }),
    ]);

    expect(smtp.messages).toHaveLength(20);
    expect(new Set(smtp.messages.flatMap((m) => m.to)).size).toBe(20);
    expect(await countByStatus(campaignId)).toEqual({ SENT: 20 });
  });

  it("skips a recipient suppressed after the queue was generated", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "ok@example.test");
    const gone = await addRecipient(campaignId, "gone@example.test");
    await suppress("gone@example.test");

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.sent).toBe(1);
    expect(result.suppressed).toBe(1);
    expect((await getRecipient(gone.id)).delivery_status).toBe("SUPPRESSED");
    expect(smtp.messages.flatMap((m) => m.to)).toEqual(["ok@example.test"]);
  });

  it("does not touch a PAUSED campaign, and resumes exactly where it stopped", async () => {
    const campaignId = await createCampaign({ status: "PAUSED" });
    for (let i = 0; i < 4; i++) await addRecipient(campaignId, `u${i}@example.test`);

    const paused = await runTick({ timeBudgetMs: 10_000 });
    expect(paused.sent).toBe(0);
    expect(smtp.messages).toHaveLength(0);
    expect((await countByStatus(campaignId)).QUEUED).toBe(4);

    await sql`UPDATE campaigns SET status = 'SENDING' WHERE id = ${campaignId}`;
    const resumed = await runTick({ timeBudgetMs: 10_000 });

    expect(resumed.sent).toBe(4);
    expect(smtp.messages).toHaveLength(4);
  });

  it("preserves already-sent rows when a campaign is paused mid-flight", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "first@example.test", { deliveryStatus: "SENT", sentAt: new Date() });
    await addRecipient(campaignId, "second@example.test");

    await sql`UPDATE campaigns SET status = 'PAUSED' WHERE id = ${campaignId}`;
    await runTick({ timeBudgetMs: 10_000 });

    expect(await countByStatus(campaignId)).toEqual({ SENT: 1, QUEUED: 1 });
  });

  it("retries a temporary failure and marks it FAILED after the last attempt", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    const recipient = await addRecipient(campaignId, "flaky@example.test");
    smtp.rejectRecipients.set("flaky@example.test", 451);

    const first = await runTick({ timeBudgetMs: 10_000 });
    expect(first.retried).toBe(1);

    let row = await getRecipient(recipient.id);
    expect(row.delivery_status).toBe("QUEUED");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("451");

    // Fast-forward past the backoff twice more to exhaust the attempts.
    for (let attempt = 2; attempt <= 3; attempt++) {
      await sql`UPDATE campaign_recipients SET next_attempt_at = now() WHERE id = ${recipient.id}`;
      await runTick({ timeBudgetMs: 10_000 });
      row = await getRecipient(recipient.id);
      expect(row.attempts).toBe(attempt);
    }

    expect(row.delivery_status).toBe("FAILED");
    expect(row.attempts).toBe(3);
  });

  it("fails a permanent 5xx rejection immediately, without wasting retries", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    const recipient = await addRecipient(campaignId, "nobody@example.test");
    smtp.rejectRecipients.set("nobody@example.test", 550);

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    const row = await getRecipient(recipient.id);
    expect(row.delivery_status).toBe("FAILED");
    expect(row.attempts).toBe(1);
  });

  it("lets a failed recipient not block the rest of the campaign", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "bad@example.test");
    for (let i = 0; i < 5; i++) await addRecipient(campaignId, `good${i}@example.test`);
    smtp.rejectRecipients.set("bad@example.test", 550);

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.sent).toBe(5);
    expect(result.failed).toBe(1);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });

  it("stores a sanitized error that never contains the SMTP password", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    const recipient = await addRecipient(campaignId, "nobody@example.test");
    smtp.rejectRecipients.set("nobody@example.test", 550);

    await runTick({ timeBudgetMs: 10_000 });

    const row = await getRecipient(recipient.id);
    expect(String(row.last_error)).not.toContain("secret");
    expect(String(row.last_error)).not.toContain("tester");
  });

  it("aborts the batch on an authentication failure instead of failing everyone", async () => {
    smtp.rejectAuth = true;
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 5; i++) await addRecipient(campaignId, `u${i}@example.test`);

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    // Everything stays queued for after the admin fixes the credentials.
    expect((await countByStatus(campaignId)).QUEUED).toBe(5);
  });

  it("uses the campaign's own sender when one is set", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await sql`
      UPDATE campaigns
      SET from_name = 'Campaign Sender', from_email = 'campaign@example.test',
          reply_to = 'replies@example.test'
      WHERE id = ${campaignId}
    `;
    await addRecipient(campaignId, "a@example.test");

    await runTick({ timeBudgetMs: 10_000 });

    const message = decodeBody(smtp.messages[0].data);
    expect(message).toContain("Campaign Sender");
    expect(message).toContain("campaign@example.test");
    expect(message).toContain("replies@example.test");
  });

  it("falls back to the configured sender when the campaign has none", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@example.test");

    await runTick({ timeBudgetMs: 10_000 });

    const message = decodeBody(smtp.messages[0].data);
    expect(message).toContain("sender@example.test");
    expect(message).toContain("Test Sender");
  });

  it("advertises a real address in List-Unsubscribe, never a fabricated one", async () => {
    process.env.SMTP_REPLY_TO = "replies@example.test";
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@example.test");

    await runTick({ timeBudgetMs: 10_000 });

    const message = decodeBody(smtp.messages[0].data);
    expect(message).toContain("mailto:replies@example.test");
    expect(message).not.toContain("unsubscribe@");
    delete process.env.SMTP_REPLY_TO;
  });

  it("refunds reserved quota when a batch aborts without sending", async () => {
    smtp.rejectAuth = true;
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 5; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await runTick({ timeBudgetMs: 10_000 });

    // Nothing was sent, so nothing should be charged against the hourly budget:
    // a broken password must not also lock out sending for an hour.
    expect(await countSentInLastHour()).toBe(0);
  });

  it("records each send against the rolling-hour budget", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 3; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await runTick({ timeBudgetMs: 10_000 });
    expect(await countSentInLastHour()).toBe(3);
  });

  it("stops sending once the hourly limit is spent, leaving the rest queued", async () => {
    process.env.SMTP_MAX_EMAILS_PER_HOUR = "10";
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 20; i++) await addRecipient(campaignId, `u${i}@example.test`);

    const result = await runTick({ timeBudgetMs: 10_000 });

    // 10/hour with the 0.95 safety factor allows 9.
    expect(result.sent).toBe(9);
    expect(result.rateLimited).toBe(true);
    expect((await countByStatus(campaignId)).QUEUED).toBe(11);
    expect((await getCampaign(campaignId)).status).toBe("SENDING");
  });

  it("sends nothing more within the same hour once the budget is used", async () => {
    process.env.SMTP_MAX_EMAILS_PER_HOUR = "10";
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 20; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await runTick({ timeBudgetMs: 10_000 });
    const second = await runTick({ timeBudgetMs: 10_000 });

    expect(second.sent).toBe(0);
    expect(smtp.messages).toHaveLength(9);
  });

  it("resumes on the next tick once the rolling window frees up", async () => {
    process.env.SMTP_MAX_EMAILS_PER_HOUR = "10";
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 20; i++) await addRecipient(campaignId, `u${i}@example.test`);

    await runTick({ timeBudgetMs: 10_000 });
    // Age the log out of the rolling window, as an hour passing would.
    await sql`UPDATE smtp_send_log SET occurred_at = now() - interval '2 hours'`;
    const second = await runTick({ timeBudgetMs: 10_000 });

    expect(second.sent).toBe(9);
    expect(smtp.messages).toHaveLength(18);
  });

  it("recovers work abandoned by a crashed worker", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    const stranded = await addRecipient(campaignId, "stranded@example.test", {
      deliveryStatus: "SENDING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1000),
      claimedBy: "worker-that-died",
    });

    const result = await runTick({ timeBudgetMs: 10_000 });

    expect(result.reclaimed).toBe(1);
    expect(result.sent).toBe(1);
    expect((await getRecipient(stranded.id)).delivery_status).toBe("SENT");
  });

  it("does nothing when SMTP is unconfigured, rather than failing recipients", async () => {
    delete process.env.SMTP_HOST;
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@example.test");

    const result = await runTick({ timeBudgetMs: 5_000 });

    expect(result.sent).toBe(0);
    expect(result.note).toContain("not configured");
    expect((await countByStatus(campaignId)).QUEUED).toBe(1);
  });

  it("is a cheap no-op when the queue is empty", async () => {
    const result = await runTick({ timeBudgetMs: 5_000 });
    expect(result).toMatchObject({ claimed: 0, sent: 0, failed: 0 });
    expect(smtp.messages).toHaveLength(0);
  });
});
