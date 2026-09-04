import { NextResponse } from "next/server";
import { badRequest, readJson, str, withAuthMutation } from "@/lib/api";
import { getSmtpConfig } from "@/lib/settings";
import { createTransport, sanitizeErrorMessage, sendMessage } from "@/lib/mailer";
import { isValidEmail } from "@/lib/email-address";

/**
 * Verifies the connection, and optionally sends a real test message.
 * Test sends never touch campaign statistics — they create no recipient rows.
 */
export async function POST(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<{ to?: string; mode?: "verify" | "send" }>(request);
    const mode = body.mode === "send" ? "send" : "verify";

    const config = await getSmtpConfig();
    if (!config) badRequest("SMTP is not configured yet. Fill in host, port and sender email first.");

    const transport = createTransport(config);
    try {
      await transport.verify();
      if (mode === "verify") {
        return NextResponse.json({ ok: true, message: `Connected to ${config.host}:${config.port}.` });
      }

      const to = str(body.to, "Recipient", { max: 254 });
      if (!isValidEmail(to)) badRequest("Recipient is not a valid email address");

      await sendMessage(transport, config, {
        to,
        subject: "SMTP test message",
        html: "<p>This is a test message confirming your SMTP settings work.</p>",
        text: "This is a test message confirming your SMTP settings work.",
      });
      return NextResponse.json({ ok: true, message: `Test email sent to ${to}.` });
    } catch (error) {
      // sanitizeErrorMessage strips any credential that appears in the error.
      return NextResponse.json({ ok: false, error: sanitizeErrorMessage(error, config) }, { status: 400 });
    } finally {
      transport.close();
    }
  });
}
