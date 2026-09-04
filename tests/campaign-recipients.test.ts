import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { campaignStats, generateRecipients, previewAudience } from "@/lib/campaign-recipients";
import { importContacts } from "@/lib/import";
import { addContact, addRecipient, createCampaign, createList, resetDatabase, suppress } from "./helpers";

beforeEach(resetDatabase);
afterAll(async () => { await sql.end(); });

describe("generateRecipients", () => {
  it("sends once to an address that is on two targeted lists", async () => {
    const listA = await createList("A");
    const listB = await createList("B");
    await addContact(listA, "a@example.com");
    await addContact(listA, "b@example.com");
    await addContact(listB, "b@example.com");
    await addContact(listB, "c@example.com");

    const campaignId = await createCampaign({ listIds: [listA, listB] });
    const result = await generateRecipients(campaignId);

    // A+B has four memberships but only three distinct addresses.
    expect(result.total).toBe(3);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("treats differently-cased addresses as the same recipient", async () => {
    const listA = await createList("A");
    const listB = await createList("B");
    await addContact(listA, "Ann@Example.com");
    // A second list holding the same mailbox in different casing.
    await sql`
      INSERT INTO contacts (email, email_normalized) VALUES ('other@example.com', 'other@example.com')
    `;
    await addContact(listB, "other@example.com");

    const campaignId = await createCampaign({ listIds: [listA, listB] });
    expect((await generateRecipients(campaignId)).total).toBe(2);
  });

  it("excludes suppressed addresses from the queue entirely", async () => {
    const list = await createList("A");
    await addContact(list, "ok@example.com");
    await addContact(list, "gone@example.com");
    await suppress("gone@example.com");

    const campaignId = await createCampaign({ listIds: [list] });
    const result = await generateRecipients(campaignId);

    expect(result.total).toBe(1);
    expect(result.skippedSuppressed).toBe(1);

    const rows = await sql<{ email: string }[]>`
      SELECT email FROM campaign_recipients WHERE campaign_id = ${campaignId}
    `;
    expect(rows.map((r) => r.email)).toEqual(["ok@example.com"]);
  });

  it("is idempotent — a retried request cannot duplicate the queue", async () => {
    const list = await createList("A");
    for (let i = 0; i < 5; i++) await addContact(list, `u${i}@example.com`);
    const campaignId = await createCampaign({ listIds: [list] });

    const first = await generateRecipients(campaignId);
    const second = await generateRecipients(campaignId);

    expect(first.inserted).toBe(5);
    expect(second.inserted).toBe(0);
    expect(second.total).toBe(5);
  });

  it("stays consistent when two requests generate concurrently", async () => {
    const list = await createList("A");
    for (let i = 0; i < 20; i++) await addContact(list, `u${i}@example.com`);
    const campaignId = await createCampaign({ listIds: [list] });

    await Promise.allSettled([generateRecipients(campaignId), generateRecipients(campaignId)]);

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM campaign_recipients WHERE campaign_id = ${campaignId}
    `;
    expect(Number(count)).toBe(20);
  });

  it("rejects a duplicate row at the database level", async () => {
    const campaignId = await createCampaign();
    await addRecipient(campaignId, "dup@example.com");

    // UNIQUE(campaign_id, email_normalized) is the last line of defence.
    await expect(addRecipient(campaignId, "DUP@example.com")).rejects.toThrow();
  });

  it("gives every recipient distinct, unguessable tokens", async () => {
    const list = await createList("A");
    for (let i = 0; i < 10; i++) await addContact(list, `u${i}@example.com`);
    const campaignId = await createCampaign({ listIds: [list] });
    await generateRecipients(campaignId);

    const rows = await sql<{ tracking_token: string; unsubscribe_token: string }[]>`
      SELECT tracking_token, unsubscribe_token FROM campaign_recipients WHERE campaign_id = ${campaignId}
    `;
    const tracking = rows.map((r) => r.tracking_token);
    const unsub = rows.map((r) => r.unsubscribe_token);

    expect(new Set(tracking).size).toBe(10);
    expect(new Set([...tracking, ...unsub]).size).toBe(20);
    // 32 random bytes in base64url.
    for (const token of tracking) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("snapshots contact details so later edits cannot rewrite history", async () => {
    const list = await createList("A");
    const contactId = await addContact(list, "ann@example.com", "Ann");
    const campaignId = await createCampaign({ listIds: [list] });
    await generateRecipients(campaignId);

    await sql`UPDATE contacts SET first_name = 'Renamed' WHERE id = ${contactId}`;

    const [row] = await sql<{ first_name: string }[]>`
      SELECT first_name FROM campaign_recipients WHERE campaign_id = ${campaignId}
    `;
    expect(row.first_name).toBe("Ann");
  });

  it("keeps recipient history when the contact is deleted", async () => {
    const list = await createList("A");
    const contactId = await addContact(list, "ann@example.com");
    const campaignId = await createCampaign({ listIds: [list] });
    await generateRecipients(campaignId);

    await sql`DELETE FROM contacts WHERE id = ${contactId}`;

    const [row] = await sql<{ email: string; contact_id: string | null }[]>`
      SELECT email, contact_id FROM campaign_recipients WHERE campaign_id = ${campaignId}
    `;
    expect(row.email).toBe("ann@example.com");
    expect(row.contact_id).toBeNull();
  });

  it("produces nothing for a campaign with no lists", async () => {
    const campaignId = await createCampaign({ listIds: [] });
    expect((await generateRecipients(campaignId)).total).toBe(0);
  });
});

describe("previewAudience", () => {
  it("reports the numbers shown on the confirmation screen", async () => {
    const listA = await createList("A");
    const listB = await createList("B");
    await addContact(listA, "a@x.com");
    await addContact(listA, "shared@x.com");
    await addContact(listB, "shared@x.com");
    await addContact(listB, "gone@x.com");
    await suppress("gone@x.com");

    const preview = await previewAudience([listA, listB]);

    expect(preview.totalMemberships).toBe(4);
    expect(preview.duplicatesRemoved).toBe(1);
    expect(preview.uniqueContacts).toBe(3);
    expect(preview.suppressed).toBe(1);
    expect(preview.finalRecipients).toBe(2);
  });

  it("is empty when no list is selected", async () => {
    expect((await previewAudience([])).finalRecipients).toBe(0);
  });
});

describe("importContacts", () => {
  it("adds a contact to a list and reports the summary", async () => {
    const list = await createList("A");
    const summary = await importContacts(list, [
      { email: "a@x.com", firstName: "Ann" },
      { email: "A@X.com" },
      { email: "broken" },
    ]);

    expect(summary.imported).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.invalid).toBe(1);
  });

  it("counts an existing list member as a duplicate, not a new import", async () => {
    const list = await createList("A");
    await importContacts(list, [{ email: "a@x.com" }]);
    const second = await importContacts(list, [{ email: "a@x.com" }]);

    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("never re-subscribes a suppressed address", async () => {
    const list = await createList("A");
    await suppress("gone@x.com");

    const summary = await importContacts(list, [{ email: "gone@x.com" }, { email: "ok@x.com" }]);

    expect(summary.skippedSuppressed).toBe(1);
    expect(summary.imported).toBe(1);

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM contacts WHERE email_normalized = 'gone@x.com'
    `;
    expect(Number(count)).toBe(0);
  });

  it("lets the same contact belong to several lists", async () => {
    const listA = await createList("A");
    const listB = await createList("B");
    await importContacts(listA, [{ email: "a@x.com" }]);
    await importContacts(listB, [{ email: "a@x.com" }]);

    const [{ count }] = await sql<{ count: string }[]>`SELECT count(*)::text FROM contacts`;
    expect(Number(count)).toBe(1);

    const [{ memberships }] = await sql<{ memberships: string }[]>`
      SELECT count(*)::text AS memberships FROM contact_list_members
    `;
    expect(Number(memberships)).toBe(2);
  });

  it("fills in a missing name without blanking an existing one", async () => {
    const list = await createList("A");
    await importContacts(list, [{ email: "a@x.com", firstName: "Ann", lastName: "Lee" }]);
    await importContacts(list, [{ email: "a@x.com", firstName: "Anna" }]);

    const [row] = await sql<{ first_name: string; last_name: string }[]>`
      SELECT first_name, last_name FROM contacts WHERE email_normalized = 'a@x.com'
    `;
    expect(row.first_name).toBe("Anna");
    expect(row.last_name).toBe("Lee");
  });
});

describe("campaignStats", () => {
  it("counts each delivery state and computes the open rate against sent mail", async () => {
    const campaignId = await createCampaign();
    await addRecipient(campaignId, "s1@x.com", { deliveryStatus: "SENT", firstOpenedAt: new Date(), openCount: 3 });
    await addRecipient(campaignId, "s2@x.com", { deliveryStatus: "SENT", firstOpenedAt: new Date(), openCount: 1 });
    await addRecipient(campaignId, "s3@x.com", { deliveryStatus: "SENT" });
    await addRecipient(campaignId, "s4@x.com", { deliveryStatus: "FAILED" });
    await addRecipient(campaignId, "s5@x.com", { deliveryStatus: "QUEUED" });

    const stats = await campaignStats(campaignId);

    expect(stats.total).toBe(5);
    expect(stats.sent).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.uniqueOpens).toBe(2);
    expect(stats.totalOpens).toBe(4);
    expect(stats.openRate).toBeCloseTo(2 / 3);
  });

  it("reports a zero open rate rather than dividing by zero", async () => {
    const campaignId = await createCampaign();
    await addRecipient(campaignId, "a@x.com", { deliveryStatus: "QUEUED" });
    expect((await campaignStats(campaignId)).openRate).toBe(0);
  });
});
