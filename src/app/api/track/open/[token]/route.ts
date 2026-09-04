import { sql } from "@/lib/db";

/**
 * Open-tracking pixel. Public and deliberately minimal: one UPDATE, then a
 * 1x1 GIF. It never fails visibly — a broken image in a delivered email is
 * worse than a missed statistic.
 *
 * The token is 256 bits of CSPRNG output, never a database id, so opens cannot
 * be enumerated or forged for an arbitrary recipient.
 */
export const dynamic = "force-dynamic";

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixelResponse(): Response {
  return new Response(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      // Defeat proxy/client caching so repeat opens actually reach us.
      "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
      pragma: "no-cache",
      expires: "0",
    },
  });
}

export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;

    if (token && token.length >= 16 && token.length <= 128) {
      // firstOpenedAt is only ever set once (COALESCE), so repeat requests from
      // the same recipient increment the total but never the unique count.
      await sql`
        UPDATE campaign_recipients
        SET first_opened_at = COALESCE(first_opened_at, now()),
            last_opened_at  = now(),
            open_count      = open_count + 1
        WHERE tracking_token = ${token}
      `;
    }
  } catch {
    // Swallowed on purpose: tracking must never break the email.
  }
  return pixelResponse();
}
