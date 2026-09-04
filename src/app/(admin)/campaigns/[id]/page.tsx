import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignLists, campaigns } from "@/lib/db/schema";
import CampaignDetail from "./CampaignDetail";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  const campaign = rows[0];
  if (!campaign) notFound();

  const lists = await db
    .select({ listId: campaignLists.listId })
    .from(campaignLists)
    .where(eq(campaignLists.campaignId, id));

  return (
    <CampaignDetail
      initial={{
        id: campaign.id,
        name: campaign.name,
        subject: campaign.subject,
        fromName: campaign.fromName,
        fromEmail: campaign.fromEmail,
        replyTo: campaign.replyTo,
        contentHtml: campaign.contentHtml,
        textBody: campaign.textBody,
        textBodyIsCustom: campaign.textBodyIsCustom,
        status: campaign.status,
        totalRecipients: campaign.totalRecipients,
        createdAt: campaign.createdAt.toISOString(),
        startedAt: campaign.startedAt?.toISOString() ?? null,
        completedAt: campaign.completedAt?.toISOString() ?? null,
      }}
      initialListIds={lists.map((l) => l.listId)}
    />
  );
}
