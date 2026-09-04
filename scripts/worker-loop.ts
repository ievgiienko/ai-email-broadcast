import "dotenv/config";

/**
 * Standalone ticker for non-serverless deployments (Docker/VPS).
 *
 * It does nothing clever: it calls the same HTTP worker endpoint a cron job
 * would call, on an interval. The queue lives in Postgres either way, so this
 * process holds no state and can be restarted at any moment.
 */
/**
 * Target the server on its own loopback address, not APP_URL: APP_URL is the
 * *public* base for tracking and unsubscribe links, and may well be a domain
 * that does not resolve from inside the container.
 */
const target =
  process.env.WORKER_TARGET_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const url = `${target.replace(/\/+$/, "")}/api/worker/tick`;
const secret = process.env.WORKER_SECRET;
const intervalMs = Number(process.env.WORKER_TICK_INTERVAL_SECONDS ?? 60) * 1000;

if (!secret) {
  console.error("WORKER_SECRET is not set; refusing to start the worker loop.");
  process.exit(1);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(`\n${signal} received, finishing current tick then exiting.`);
  });
}

async function tick() {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) console.error(`[worker] ${response.status}`, body);
    else if (body.claimed > 0 || body.reclaimed > 0) console.log("[worker]", body);
  } catch (error) {
    console.error("[worker] tick failed:", error instanceof Error ? error.message : error);
  }
}

async function main() {
  console.log(`[worker] ticking ${url} every ${intervalMs / 1000}s`);
  // The web server may still be booting on the first iteration.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  while (!stopping) {
    await tick();
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  process.exit(0);
}

void main();
