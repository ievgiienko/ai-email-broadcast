import { NextResponse } from "next/server";
import { desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignRecipients, campaigns } from "@/lib/db/schema";
import { optionalStr, readJson, str, withAuth, withAuthMutation } from "@/lib/api";
import { getSmtpConfig } from "@/lib/settings";

export async function GET() {
  return withAuth(async () => {
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        subject: campaigns.subject,
        status: campaigns.status,
        createdAt: campaigns.createdAt,
        startedAt: campaigns.startedAt,
        completedAt: campaigns.completedAt,
        totalRecipients: campaigns.totalRecipients,
        queued: raw<number>`count(*) FILTER (WHERE ${campaignRecipients.deliveryStatus} = 'QUEUED')::int`,
        sending: raw<number>`count(*) FILTER (WHERE ${campaignRecipients.deliveryStatus} = 'SENDING')::int`,
        sent: raw<number>`count(*) FILTER (WHERE ${campaignRecipients.deliveryStatus} = 'SENT')::int`,
        failed: raw<number>`count(*) FILTER (WHERE ${campaignRecipients.deliveryStatus} = 'FAILED')::int`,
        uniqueOpens: raw<number>`count(*) FILTER (WHERE ${campaignRecipients.firstOpenedAt} IS NOT NULL)::int`,
      })
      .from(campaigns)
      .leftJoin(campaignRecipients, eq(campaignRecipients.campaignId, campaigns.id))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt));

    return NextResponse.json({ campaigns: rows });
  });
}

export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ name?: string; subject?: string }>(request);
    // Pre-fill the sender from settings so the wizard starts usable.
    const config = await getSmtpConfig().catch(() => null);

    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: str(body.name, "Campaign name", { max: 200 }),
        subject: optionalStr(body.subject, "Subject", 300) ?? "",
        fromName: config?.fromName ?? null,
        fromEmail: config?.fromEmail ?? null,
        replyTo: config?.replyTo ?? null,
      })
      .returning();

    return NextResponse.json({ campaign }, { status: 201 });
  });
}
