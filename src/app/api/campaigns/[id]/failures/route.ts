import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignRecipients } from "@/lib/db/schema";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** CSV export of failed recipients, for re-checking or re-importing elsewhere. */
export async function GET(_request: Request, ctx: Ctx) {
  return handle(async () => {
    await requireUser();
    const { id } = await ctx.params;

    const rows = await db
      .select({
        email: campaignRecipients.email,
        attempts: campaignRecipients.attempts,
        lastError: campaignRecipients.lastError,
      })
      .from(campaignRecipients)
      .where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.deliveryStatus, "FAILED")))
      .orderBy(asc(campaignRecipients.email));

    const csv = [
      "email,attempts,last_error",
      ...rows.map((r) => [r.email, String(r.attempts), r.lastError ?? ""].map(csvCell).join(",")),
    ].join("\n");

    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="failed-recipients-${id}.csv"`,
      },
    });
  });
}

/** Quotes a value and neutralizes spreadsheet formula injection. */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
