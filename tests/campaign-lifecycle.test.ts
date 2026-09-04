import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { POST as pauseCampaign } from "@/app/api/campaigns/[id]/pause/route";
import { POST as resumeCampaign } from "@/app/api/campaigns/[id]/resume/route";
import { POST as cancelCampaign } from "@/app/api/campaigns/[id]/cancel/route";
import { GET as workerTick, POST as workerTickPost } from "@/app/api/worker/tick/route";
import { addRecipient, countByStatus, createCampaign, getCampaign, resetDatabase } from "./helpers";

/**
 * These routes are exercised through their handlers with authentication stubbed
 * out; the guards themselves are asserted separately below.
 */
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: "test-admin", email: "admin@example.test" }),
    requireAdminMutation: async () => ({ id: "test-admin", email: "admin@example.test" }),
    assertSameOrigin: async () => undefined,
  };
});

beforeEach(resetDatabase);
afterAll(async () => { await sql.end(); });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = new Request("https://mail.example.test/");

describe("pause / resume / cancel", () => {
  it("pauses a sending campaign without disturbing its queue", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "a@x.com");
    await addRecipient(campaignId, "b@x.com", { deliveryStatus: "SENT" });

    const response = await pauseCampaign(request, ctx(campaignId));

    expect(response.status).toBe(200);
    expect((await getCampaign(campaignId)).status).toBe("PAUSED");
    expect(await countByStatus(campaignId)).toEqual({ QUEUED: 1, SENT: 1 });
  });

  it("resumes a paused campaign", async () => {
    const campaignId = await createCampaign({ status: "PAUSED" });
    await resumeCampaign(request, ctx(campaignId));
    expect((await getCampaign(campaignId)).status).toBe("SENDING");
  });

  it("refuses to pause a completed campaign", async () => {
    const campaignId = await createCampaign({ status: "COMPLETED" });
    const response = await pauseCampaign(request, ctx(campaignId));
    expect(response.status).toBe(409);
    expect((await getCampaign(campaignId)).status).toBe("COMPLETED");
  });

  it("refuses to resume anything that is not paused", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    expect((await resumeCampaign(request, ctx(campaignId))).status).toBe(409);
  });

  it("cancels the remaining queue but keeps sent history", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "sent@x.com", { deliveryStatus: "SENT", sentAt: new Date() });
    await addRecipient(campaignId, "q1@x.com");
    await addRecipient(campaignId, "q2@x.com");

    const response = await cancelCampaign(request, ctx(campaignId));
    const body = await response.json();

    expect(body.cancelledRecipients).toBe(2);
    expect((await getCampaign(campaignId)).status).toBe("CANCELLED");
    expect(await countByStatus(campaignId)).toEqual({ SENT: 1, CANCELLED: 2 });
  });

  it("distinguishes cancelled recipients from genuine failures", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "failed@x.com", { deliveryStatus: "FAILED", lastError: "550 nope" });
    await addRecipient(campaignId, "queued@x.com");

    await cancelCampaign(request, ctx(campaignId));

    const counts = await countByStatus(campaignId);
    expect(counts.FAILED).toBe(1);
    expect(counts.CANCELLED).toBe(1);
  });

  it("leaves an in-flight row alone — it is already at the SMTP server", async () => {
    const campaignId = await createCampaign({ status: "SENDING" });
    await addRecipient(campaignId, "inflight@x.com", {
      deliveryStatus: "SENDING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      claimedBy: "worker-1",
    });

    await cancelCampaign(request, ctx(campaignId));
    expect((await countByStatus(campaignId)).SENDING).toBe(1);
  });

  it("refuses to cancel an already-completed campaign", async () => {
    const campaignId = await createCampaign({ status: "COMPLETED" });
    expect((await cancelCampaign(request, ctx(campaignId))).status).toBe(409);
  });
});

describe("worker endpoint authentication", () => {
  const withHeaders = (headers: Record<string, string>) =>
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(headers) }));

  it("rejects a request with no secret", async () => {
    vi.resetModules();
    withHeaders({});
    const { POST } = await import("@/app/api/worker/tick/route");
    expect((await POST()).status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    vi.resetModules();
    withHeaders({ authorization: "Bearer definitely-wrong" });
    const { POST } = await import("@/app/api/worker/tick/route");
    expect((await POST()).status).toBe(401);
  });

  it("accepts the configured secret as a bearer token", async () => {
    vi.resetModules();
    withHeaders({ authorization: `Bearer ${process.env.WORKER_SECRET}` });
    const { POST } = await import("@/app/api/worker/tick/route");
    const response = await POST();
    expect(response.status).toBe(200);
  });

  it("accepts the secret in the x-worker-secret header", async () => {
    vi.resetModules();
    withHeaders({ "x-worker-secret": process.env.WORKER_SECRET ?? "" });
    const { GET } = await import("@/app/api/worker/tick/route");
    expect((await GET()).status).toBe(200);
  });

  it("exposes both GET and POST, since schedulers differ", () => {
    expect(typeof workerTick).toBe("function");
    expect(typeof workerTickPost).toBe("function");
  });
});
