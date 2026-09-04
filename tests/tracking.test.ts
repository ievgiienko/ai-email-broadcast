import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { GET as trackOpen } from "@/app/api/track/open/[token]/route";
import { POST as unsubscribePost } from "@/app/api/unsubscribe/[token]/route";
import { campaignStats } from "@/lib/campaign-recipients";
import { suppressEmail } from "@/lib/worker";
import { addRecipient, createCampaign, getRecipient, resetDatabase } from "./helpers";

beforeEach(resetDatabase);
afterAll(async () => { await sql.end(); });

const params = (token: string) => ({ params: Promise.resolve({ token }) });
const request = new Request("https://mail.example.test/");

describe("open tracking pixel", () => {
  it("returns a real GIF, not an error page", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });

    const response = await trackOpen(request, params(recipient.trackingToken));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // GIF89a magic number.
    expect(Array.from(bytes.slice(0, 6))).toEqual([71, 73, 70, 56, 57, 97]);
  });

  it("forbids caching, so repeat opens actually reach the server", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com");
    const response = await trackOpen(request, params(recipient.trackingToken));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("records the first open", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });

    await trackOpen(request, params(recipient.trackingToken));

    const row = await getRecipient(recipient.id);
    expect(row.first_opened_at).not.toBeNull();
    expect(row.last_opened_at).not.toBeNull();
    expect(row.open_count).toBe(1);
  });

  it("counts repeat requests as one unique open but many total opens", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });

    await trackOpen(request, params(recipient.trackingToken));
    const first = await getRecipient(recipient.id);

    await new Promise((r) => setTimeout(r, 20));
    await trackOpen(request, params(recipient.trackingToken));
    await trackOpen(request, params(recipient.trackingToken));

    const row = await getRecipient(recipient.id);
    expect(row.open_count).toBe(3);
    // firstOpenedAt is pinned by COALESCE; lastOpenedAt keeps moving.
    expect(row.first_opened_at).toEqual(first.first_opened_at);
    expect(new Date(row.last_opened_at as string).getTime())
      .toBeGreaterThan(new Date(first.last_opened_at as string).getTime());

    const stats = await campaignStats(campaignId);
    expect(stats.uniqueOpens).toBe(1);
    expect(stats.totalOpens).toBe(3);
  });

  it("never leaks delivery state — an open does not overwrite deliveryStatus", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com", { deliveryStatus: "SENT" });

    await trackOpen(request, params(recipient.trackingToken));
    expect((await getRecipient(recipient.id)).delivery_status).toBe("SENT");
  });

  it("returns the pixel for an unknown token without disclosing anything", async () => {
    const response = await trackOpen(request, params("definitely-not-a-real-token-000000000000"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
  });

  it("does not accept a database id in place of a token", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "a@x.com");

    await trackOpen(request, params(recipient.id));
    expect((await getRecipient(recipient.id)).open_count).toBe(0);
  });

  it("counts opens only for the recipient owning the token", async () => {
    const campaignId = await createCampaign();
    const first = await addRecipient(campaignId, "a@x.com");
    const second = await addRecipient(campaignId, "b@x.com");

    await trackOpen(request, params(first.trackingToken));

    expect((await getRecipient(first.id)).open_count).toBe(1);
    expect((await getRecipient(second.id)).open_count).toBe(0);
  });
});

describe("unsubscribe", () => {
  it("adds the address to the global suppression list", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "Bye@Example.com", { deliveryStatus: "SENT" });

    const response = await unsubscribePost(request, params(recipient.unsubscribeToken));
    expect(response.status).toBe(200);

    const rows = await sql<{ email_normalized: string; reason: string }[]>`
      SELECT email_normalized, reason FROM suppressions
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].email_normalized).toBe("bye@example.com");
    expect(rows[0].reason).toBe("UNSUBSCRIBED");
  });

  it("pulls the address out of any queue it is still sitting in", async () => {
    const campaignA = await createCampaign({ status: "QUEUED" });
    const campaignB = await createCampaign({ status: "QUEUED" });
    const recipient = await addRecipient(campaignA, "bye@x.com", { deliveryStatus: "SENT" });
    const pending = await addRecipient(campaignB, "bye@x.com");

    await unsubscribePost(request, params(recipient.unsubscribeToken));

    expect((await getRecipient(pending.id)).delivery_status).toBe("SUPPRESSED");
    // Already-sent history is untouched.
    expect((await getRecipient(recipient.id)).delivery_status).toBe("SENT");
  });

  it("is idempotent — clicking twice is not an error", async () => {
    const campaignId = await createCampaign();
    const recipient = await addRecipient(campaignId, "bye@x.com");

    await unsubscribePost(request, params(recipient.unsubscribeToken));
    const second = await unsubscribePost(request, params(recipient.unsubscribeToken));

    expect(second.status).toBe(200);
    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM suppressions`;
    expect(Number(count)).toBe(1);
  });

  it("answers 200 for an unknown token, revealing nothing", async () => {
    const response = await unsubscribePost(request, params("x".repeat(43)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("records a manual suppression with its own reason", async () => {
    await suppressEmail({ email: "Manual@X.com", emailNormalized: "manual@x.com", reason: "MANUAL" });
    const [row] = await sql<{ reason: string }[]>`SELECT reason FROM suppressions`;
    expect(row.reason).toBe("MANUAL");
  });
});
