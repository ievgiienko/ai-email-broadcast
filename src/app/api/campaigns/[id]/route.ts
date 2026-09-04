import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaignLists, campaigns } from "@/lib/db/schema";
import {
  badRequest, conflict, notFound, optionalStr, readJson, str, uuidList,
  withAuth, withAuthMutation,
} from "@/lib/api";
import { campaignStats } from "@/lib/campaign-recipients";
import { sanitizeEmailHtml, htmlToText } from "@/lib/html";
import { isValidEmail } from "@/lib/email-address";

type Ctx = { params: Promise<{ id: string }> };

async function loadCampaign(id: string) {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!rows[0]) notFound("Campaign not found");
  return rows[0];
}

export async function GET(_request: Request, ctx: Ctx) {
  return withAuth(async () => {
    const { id } = await ctx.params;
    const campaign = await loadCampaign(id);
    const lists = await db
      .select({ listId: campaignLists.listId })
      .from(campaignLists)
      .where(eq(campaignLists.campaignId, id));

    return NextResponse.json({
      campaign,
      listIds: lists.map((l) => l.listId),
      stats: await campaignStats(id),
    });
  });
}

type Body = {
  name?: string;
  subject?: string;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  contentHtml?: string;
  textBody?: string | null;
  textBodyIsCustom?: boolean;
  listIds?: string[];
};

export async function PATCH(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const campaign = await loadCampaign(id);

    // Content is frozen once the queue exists: changing it mid-send would mean
    // different recipients receive different emails from one "campaign".
    if (campaign.status !== "DRAFT") {
      conflict(`This campaign is ${campaign.status} and can no longer be edited`);
    }

    const body = await readJson<Body>(request);
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (body.name !== undefined) patch.name = str(body.name, "Campaign name", { max: 200 });
    if (body.subject !== undefined) patch.subject = str(body.subject, "Subject", { max: 300, required: false });
    if (body.fromName !== undefined) patch.fromName = optionalStr(body.fromName, "Sender name", 200);
    if (body.replyTo !== undefined) {
      const replyTo = optionalStr(body.replyTo, "Reply-To", 254);
      if (replyTo && !isValidEmail(replyTo)) badRequest("Reply-To is not a valid address");
      patch.replyTo = replyTo;
    }
    if (body.fromEmail !== undefined) {
      const fromEmail = optionalStr(body.fromEmail, "Sender email", 254);
      if (fromEmail && !isValidEmail(fromEmail)) badRequest("Sender email is not a valid address");
      patch.fromEmail = fromEmail;
    }

    if (body.contentHtml !== undefined) {
      if (body.contentHtml.length > 500_000) badRequest("Email content is too large");
      // Sanitize on the way in, so nothing unsafe is ever stored or re-rendered.
      const clean = sanitizeEmailHtml(body.contentHtml);
      patch.contentHtml = clean;
      patch.compiledHtml = clean;
      if (!campaign.textBodyIsCustom && body.textBody === undefined) {
        patch.textBody = htmlToText(clean);
      }
    }

    if (body.textBody !== undefined) {
      patch.textBody = optionalStr(body.textBody, "Plain text", 200_000);
      patch.textBodyIsCustom = body.textBodyIsCustom ?? true;
    }

    const [updated] = await db.update(campaigns).set(patch).where(eq(campaigns.id, id)).returning();

    if (body.listIds !== undefined) {
      const listIds = uuidList(body.listIds, "listIds");
      await db.delete(campaignLists).where(eq(campaignLists.campaignId, id));
      if (listIds.length > 0) {
        await db.insert(campaignLists).values(listIds.map((listId) => ({ campaignId: id, listId })));
      }
    }

    return NextResponse.json({ campaign: updated });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const campaign = await loadCampaign(id);
    if (campaign.status === "SENDING") {
      conflict("Cancel the campaign before deleting it");
    }
    await db.delete(campaigns).where(eq(campaigns.id, id));
    return NextResponse.json({ ok: true });
  });
}
