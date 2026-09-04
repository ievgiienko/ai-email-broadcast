import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { safeEqual } from "@/lib/crypto";
import { runTick } from "@/lib/worker";

/**
 * Queue processor. Drive it with a cron job, an external scheduler, or the
 * bundled ticker — it is stateless and safe to call concurrently.
 *
 * Auth: a shared secret, accepted either as `Authorization: Bearer <secret>`
 * (external schedulers, the bundled ticker) or `x-vercel-cron-signature`-style
 * bearer header that Vercel Cron sends from CRON_SECRET.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorize(): Promise<boolean> {
  const secret = process.env.WORKER_SECRET ?? process.env.CRON_SECRET;
  if (!secret) return false;

  const h = await headers();
  const bearer = h.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const custom = h.get("x-worker-secret") ?? "";

  return safeEqual(bearer, secret) || safeEqual(custom, secret);
}

async function tick() {
  if (!(await authorize())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runTick();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[worker] tick failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Worker failed" },
      { status: 500 },
    );
  }
}

export async function POST() {
  return tick();
}

/** Vercel Cron issues GET requests. */
export async function GET() {
  return tick();
}
