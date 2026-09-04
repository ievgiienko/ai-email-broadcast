import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { badRequest, notFound, readJson, str, withAuthMutation } from "@/lib/api";
import { buildMessage } from "@/lib/message-builder";
import { appUrl, getSmtpConfig } from "@/lib/settings";
import { createTransport, sanitizeErrorMessage, sendMessage } from "@/lib/mailer";
import { isValidEmail } from "@/lib/email-address";
import { logSendAttempt } from "@/lib/queue";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Sends exactly the campaign email to one address.
 *
 * No CampaignRecipient row is created and no tracking pixel is injected, so a
 * test send is invisible to campaign statistics. It does count against the SMTP
 * rate limit, because the provider counts it.
 */
export async function POST(request: Request, ctx: Ctx) {
  return withAuthMutation(async () => {
    const { id } = await ctx.params;
    const body = await readJson<{ to?: string; firstName?: string; lastName?: string }>(request);

    const to = str(body.to, "Recipient", { max: 254 });
    if (!isValidEmail(to)) badRequest("That is not a valid email address");

    const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    const campaign = rows[0];
    if (!campaign) notFound("Campaign not found");
    if (!campaign.subject.trim()) badRequest("Give the campaign a subject first");

    const config = await getSmtpConfig();
    if (!config) badRequest("Configure SMTP in Settings first");

    const message = buildMessage({
      campaign,
      recipient: {
        email: to,
        firstName: body.firstName ?? "there",
        lastName: body.lastName ?? "",
      },
      baseUrl: appUrl(),
      preview: true,
    });

    const transport = createTransport(config);
    try {
      await sendMessage(transport, config, {
        to,
        subject: `[TEST] ${message.subject}`,
        html: message.html,
        text: message.text,
        fromName: campaign.fromName,
        fromEmail: campaign.fromEmail,
        replyTo: campaign.replyTo,
      });
      await logSendAttempt(1);
      return NextResponse.json({ ok: true, message: `Test email sent to ${to}.` });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: sanitizeErrorMessage(error, config) },
        { status: 400 },
      );
    } finally {
      transport.close();
    }
  });
}
