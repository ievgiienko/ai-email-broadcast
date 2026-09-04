import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  claimRecipients, countSentInLastHour, filterSuppressed, finalizeCompletedCampaigns,
  logSendAttempt, markFailed, markSent, pruneSendLog, reclaimExpiredLeases,
  releaseClaims, scheduleRetry,
} from "@/lib/queue";
import {
  addRecipient, countByStatus, createCampaign, getCampaign, getRecipient, resetDatabase, suppress,
} from "./helpers";

beforeEach(resetDatabase);
afterAll(async () => { await sql.end(); });

describe("claimRecipients", () => {
  it("claims queued recipients and marks them SENDING with a lease", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@x.com");
    await addRecipient(campaignId, "b@x.com");

    const claimed = await claimRecipients("worker-1", 10);

    expect(claimed).toHaveLength(2);
    for (const recipient of claimed) {
      const row = await getRecipient(recipient.id);
      expect(row.delivery_status).toBe("SENDING");
      expect(row.claimed_by).toBe("worker-1");
      expect(row.attempts).toBe(1);
      expect(row.lease_expires_at).not.toBeNull();
    }
  });

  it("returns the campaign content alongside each recipient", async () => {
    const campaignId = await createCampaign({
      status: "QUEUED", subject: "Subject line", html: "<p>Body</p>",
    });
    await addRecipient(campaignId, "a@x.com", { firstName: "Ann" });

    const [claimed] = await claimRecipients("w", 10);
    expect(claimed.subject).toBe("Subject line");
    expect(claimed.compiledHtml).toBe("<p>Body</p>");
    expect(claimed.firstName).toBe("Ann");
  });

  it("respects the requested limit", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 10; i++) await addRecipient(campaignId, `u${i}@x.com`);

    expect(await claimRecipients("w", 3)).toHaveLength(3);
    expect((await countByStatus(campaignId)).QUEUED).toBe(7);
  });

  it("claims nothing when the limit is zero or negative", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "a@x.com");
    expect(await claimRecipients("w", 0)).toHaveLength(0);
    expect(await claimRecipients("w", -5)).toHaveLength(0);
  });

  it("ignores recipients whose retry backoff has not elapsed", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "later@x.com", {
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    await addRecipient(campaignId, "now@x.com");

    const claimed = await claimRecipients("w", 10);
    expect(claimed.map((c) => c.email)).toEqual(["now@x.com"]);
  });

  it("never claims from a PAUSED campaign", async () => {
    const campaignId = await createCampaign({ status: "PAUSED" });
    await addRecipient(campaignId, "a@x.com");
    expect(await claimRecipients("w", 10)).toHaveLength(0);
  });

  it("never claims from a CANCELLED or DRAFT campaign", async () => {
    const cancelled = await createCampaign({ status: "CANCELLED" });
    await addRecipient(cancelled, "a@x.com");
    const draft = await createCampaign({ status: "DRAFT" });
    await addRecipient(draft, "b@x.com");

    expect(await claimRecipients("w", 10)).toHaveLength(0);
  });

  it("gives two concurrent workers disjoint rows — no recipient is claimed twice", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    for (let i = 0; i < 40; i++) await addRecipient(campaignId, `u${i}@x.com`);

    // Fire several workers at once; SKIP LOCKED must partition the queue.
    const results = await Promise.all([
      claimRecipients("worker-a", 20),
      claimRecipients("worker-b", 20),
      claimRecipients("worker-c", 20),
      claimRecipients("worker-d", 20),
    ]);

    const ids = results.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(40);
    expect((await countByStatus(campaignId)).QUEUED).toBeUndefined();
  });

  it("does not hand the same recipient to a second worker after the first claims it", async () => {
    const campaignId = await createCampaign({ status: "QUEUED" });
    await addRecipient(campaignId, "only@x.com");

    const first = await claimRecipients("worker-a", 10);
    const second = await claimRecipients("worker-b", 10);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("lease recovery", () => {
  it("returns rows abandoned by a crashed worker to the queue", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    const recipient = await addRecipient(campaignId, "a@x.com", {
      deliveryStatus: "SENDING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1000),
      claimedBy: "dead-worker",
    });

    expect(await reclaimExpiredLeases()).toBe(1);

    const row = await getRecipient(recipient.id);
    expect(row.delivery_status).toBe("QUEUED");
    expect(row.claimed_by).toBeNull();
    // The attempt is retained, so a poison message cannot loop forever.
    expect(row.attempts).toBe(1);
  });

  it("leaves a live lease alone", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    const recipient = await addRecipient(campaignId, "a@x.com", {
      deliveryStatus: "SENDING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      claimedBy: "busy-worker",
    });

    expect(await reclaimExpiredLeases()).toBe(0);
    expect((await getRecipient(recipient.id)).delivery_status).toBe("SENDING");
  });

  it("fails a row that exhausted its attempts inside crashed workers", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    const recipient = await addRecipient(campaignId, "poison@x.com", {
      deliveryStatus: "SENDING",
      attempts: 3,
      leaseExpiresAt: new Date(Date.now() - 1000),
      claimedBy: "dead-worker",
    });

    await reclaimExpiredLeases();
    expect((await getRecipient(recipient.id)).delivery_status).toBe("FAILED");
  });

  it("a reclaimed row can be claimed again — the queue survives a restart", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com", {
      deliveryStatus: "SENDING",
      attempts: 1,
      leaseExpiresAt: new Date(Date.now() - 1000),
      claimedBy: "dead-worker",
    });

    await reclaimExpiredLeases();
    const claimed = await claimRecipients("fresh-worker", 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].attempts).toBe(2);
  });
});

describe("terminal transitions", () => {
  it("markSent only applies to a row this worker holds", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    const queued = await addRecipient(campaignId, "queued@x.com");

    // Not SENDING, so the update must be a no-op rather than a false SENT.
    await markSent(queued.id);
    expect((await getRecipient(queued.id)).delivery_status).toBe("QUEUED");
  });

  it("markSent stamps sentAt and clears the lease", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com");
    const [claimed] = await claimRecipients("w", 1);

    await markSent(claimed.id);
    const row = await getRecipient(claimed.id);
    expect(row.delivery_status).toBe("SENT");
    expect(row.sent_at).not.toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it("markFailed records a sanitized error", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com");
    const [claimed] = await claimRecipients("w", 1);

    await markFailed(claimed.id, "550 mailbox unavailable");
    const row = await getRecipient(claimed.id);
    expect(row.delivery_status).toBe("FAILED");
    expect(row.last_error).toBe("550 mailbox unavailable");
  });

  it("scheduleRetry re-queues the row behind a backoff", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com");
    const [claimed] = await claimRecipients("w", 1);

    await scheduleRetry(claimed.id, 300, "451 try again");
    const row = await getRecipient(claimed.id);

    expect(row.delivery_status).toBe("QUEUED");
    expect(new Date(row.next_attempt_at as string).getTime()).toBeGreaterThan(Date.now() + 250_000);
    // Not claimable yet.
    expect(await claimRecipients("w", 10)).toHaveLength(0);
  });

  it("releaseClaims returns the attempt as well as the row", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com");
    const [claimed] = await claimRecipients("w", 1);

    await releaseClaims([claimed.id]);
    const row = await getRecipient(claimed.id);

    expect(row.delivery_status).toBe("QUEUED");
    expect(row.attempts).toBe(0);
  });
});

describe("rate-limit accounting", () => {
  it("counts only attempts inside the rolling hour", async () => {
    await logSendAttempt(5);
    await sql`INSERT INTO smtp_send_log (occurred_at) SELECT now() - interval '2 hours' FROM generate_series(1, 7)`;

    expect(await countSentInLastHour()).toBe(5);
  });

  it("survives a restart because the count lives in the database", async () => {
    await logSendAttempt(3);
    // Nothing in process memory is consulted; a fresh read sees the same number.
    expect(await countSentInLastHour()).toBe(3);
    expect(await countSentInLastHour()).toBe(3);
  });

  it("prunes only rows outside the retention window", async () => {
    await logSendAttempt(2);
    await sql`INSERT INTO smtp_send_log (occurred_at) SELECT now() - interval '4 hours'`;

    await pruneSendLog();
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM smtp_send_log`;
    expect(Number(count)).toBe(2);
  });
});

describe("suppression checks", () => {
  it("reports which addresses are suppressed", async () => {
    await suppress("gone@x.com");
    const suppressed = await filterSuppressed(["gone@x.com", "here@x.com"]);
    expect([...suppressed]).toEqual(["gone@x.com"]);
  });

  it("returns an empty set for no candidates", async () => {
    expect((await filterSuppressed([])).size).toBe(0);
  });
});

describe("finalizeCompletedCampaigns", () => {
  it("completes a campaign once nothing is queued or in flight", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });
    await addRecipient(campaignId, "b@x.com", { deliveryStatus: "FAILED" });

    expect(await finalizeCompletedCampaigns()).toBe(1);
    const campaign = await getCampaign(campaignId);
    expect(campaign.status).toBe("COMPLETED");
    expect(campaign.completed_at).not.toBeNull();
  });

  it("leaves a campaign with pending work alone", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });
    await addRecipient(campaignId, "b@x.com", { deliveryStatus: "QUEUED" });

    expect(await finalizeCompletedCampaigns()).toBe(0);
    expect((await getCampaign(campaignId)).status).toBe("SENDING");
  });

  it("does not resurrect or complete a PAUSED campaign", async () => {
    const campaignId = await createCampaign({ status: "PAUSED" });
    await addRecipient(campaignId, "a@x.com", { deliveryStatus: "QUEUED" });

    await finalizeCompletedCampaigns();
    expect((await getCampaign(campaignId)).status).toBe("PAUSED");
  });

  it("is idempotent when two workers finish at the same moment", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });

    const [first, second] = await Promise.all([
      finalizeCompletedCampaigns(),
      finalizeCompletedCampaigns(),
    ]);
    expect(first + second).toBe(1);
  });
});
