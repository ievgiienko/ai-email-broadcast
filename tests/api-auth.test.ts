import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every admin endpoint must refuse an unauthenticated caller. These tests drive
 * the real handlers with an empty cookie jar.
 */
const emptyHeaders = { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() };

beforeEach(() => {
  vi.resetModules();
  vi.doMock("next/headers", () => emptyHeaders);
});

afterEach(() => vi.doUnmock("next/headers"));

const jsonRequest = (body: unknown = {}) =>
  new Request("https://mail.example.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ctx = (id = "00000000-0000-0000-0000-000000000000") => ({ params: Promise.resolve({ id }) });

describe("admin endpoints require a session", () => {
  it("GET /api/settings", async () => {
    const { GET } = await import("@/app/api/settings/route");
    expect((await GET()).status).toBe(401);
  });

  it("PUT /api/settings", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    expect((await PUT(jsonRequest())).status).toBe(401);
  });

  it("POST /api/settings/test — no unauthenticated SMTP relay", async () => {
    const { POST } = await import("@/app/api/settings/test/route");
    expect((await POST(jsonRequest({ to: "someone@example.com", mode: "send" }))).status).toBe(401);
  });

  it("GET and POST /api/contacts", async () => {
    const { GET, POST, DELETE } = await import("@/app/api/contacts/route");
    expect((await GET(new Request("https://mail.example.test/api/contacts"))).status).toBe(401);
    expect((await POST(jsonRequest({ email: "a@b.com" }))).status).toBe(401);
    expect((await DELETE(jsonRequest({ ids: ["x"] }))).status).toBe(401);
  });

  it("GET and POST /api/lists", async () => {
    const { GET, POST } = await import("@/app/api/lists/route");
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonRequest({ name: "x" }))).status).toBe(401);
  });

  it("GET and POST /api/campaigns", async () => {
    const { GET, POST } = await import("@/app/api/campaigns/route");
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonRequest({ name: "x" }))).status).toBe(401);
  });

  it("POST /api/campaigns/:id/send — campaigns cannot be triggered anonymously", async () => {
    const { POST } = await import("@/app/api/campaigns/[id]/send/route");
    expect((await POST(jsonRequest(), ctx())).status).toBe(401);
  });

  it("POST /api/campaigns/:id/test", async () => {
    const { POST } = await import("@/app/api/campaigns/[id]/test/route");
    expect((await POST(jsonRequest({ to: "a@b.com" }), ctx())).status).toBe(401);
  });

  it("POST /api/campaigns/:id/{pause,resume,cancel}", async () => {
    const pause = await import("@/app/api/campaigns/[id]/pause/route");
    const resume = await import("@/app/api/campaigns/[id]/resume/route");
    const cancel = await import("@/app/api/campaigns/[id]/cancel/route");
    for (const mod of [pause, resume, cancel]) {
      expect((await mod.POST(jsonRequest(), ctx())).status).toBe(401);
    }
  });

  it("GET /api/campaigns/:id/recipients and /failures", async () => {
    const recipients = await import("@/app/api/campaigns/[id]/recipients/route");
    const failures = await import("@/app/api/campaigns/[id]/failures/route");
    const req = new Request("https://mail.example.test/api");
    expect((await recipients.GET(req, ctx())).status).toBe(401);
    expect((await failures.GET(req, ctx())).status).toBe(401);
  });

  it("import endpoints", async () => {
    const paste = await import("@/app/api/import/paste/route");
    const file = await import("@/app/api/import/file/route");
    expect((await paste.POST(jsonRequest({ text: "a@b.com" }))).status).toBe(401);
    expect((await file.POST(jsonRequest({ content: "a@b.com" }))).status).toBe(401);
  });

  it("suppression endpoints", async () => {
    const { GET, POST, DELETE } = await import("@/app/api/suppressions/route");
    expect((await GET(new Request("https://mail.example.test/api"))).status).toBe(401);
    expect((await POST(jsonRequest({ email: "a@b.com" }))).status).toBe(401);
    expect((await DELETE(jsonRequest({ email: "a@b.com" }))).status).toBe(401);
  });
});

describe("CSRF protection on mutating endpoints", () => {
  it("rejects a cross-origin POST even with a valid session", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => ({ value: "session-token" }) }),
      headers: async () =>
        new Headers({ origin: "https://evil.example.com", host: "mail.example.test" }),
    }));

    const { POST } = await import("@/app/api/lists/route");
    const response = await POST(jsonRequest({ name: "Attacker list" }));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("Cross-origin");
  });

  it("allows a same-origin POST through the origin check", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
      headers: async () =>
        new Headers({ origin: "https://mail.example.test", host: "mail.example.test" }),
    }));

    const { POST } = await import("@/app/api/lists/route");
    // Passes the origin check, then fails on the (absent) session — 401, not 403.
    expect((await POST(jsonRequest({ name: "x" }))).status).toBe(401);
  });
});

describe("public endpoints stay public", () => {
  it("the tracking pixel does not require a session", async () => {
    const { GET } = await import("@/app/api/track/open/[token]/route");
    const response = await GET(new Request("https://mail.example.test/"), {
      params: Promise.resolve({ token: "some-token-that-does-not-exist-000000" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
  });

  it("one-click unsubscribe does not require a session or an origin header", async () => {
    const { POST } = await import("@/app/api/unsubscribe/[token]/route");
    const response = await POST(new Request("https://mail.example.test/"), {
      params: Promise.resolve({ token: "z".repeat(43) }),
    });
    expect(response.status).toBe(200);
  });
});
