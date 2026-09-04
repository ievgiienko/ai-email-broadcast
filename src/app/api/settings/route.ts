import { NextResponse } from "next/server";
import { getPublicSettings, saveSettings, type SmtpSecurity } from "@/lib/settings";
import { badRequest, int, optionalStr, readJson, str, withAuth, withAuthMutation } from "@/lib/api";
import { isValidEmail } from "@/lib/email-address";

export async function GET() {
  return withAuth(async () => NextResponse.json(await getPublicSettings()));
}

type Body = {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecurity?: string;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  clearPassword?: boolean;
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  maxEmailsPerHour?: number;
};

export async function PUT(request: Request) {
  return withAuthMutation(async () => {
    const body = await readJson<Body>(request);

    const security = str(body.smtpSecurity, "Encryption mode", { max: 20 }) as SmtpSecurity;
    if (!["none", "starttls", "tls"].includes(security)) badRequest("Invalid encryption mode");

    const fromEmail = optionalStr(body.fromEmail, "Sender email", 254);
    if (fromEmail && !isValidEmail(fromEmail)) badRequest("Sender email is not a valid address");

    const replyTo = optionalStr(body.replyTo, "Reply-To", 254);
    if (replyTo && !isValidEmail(replyTo)) badRequest("Reply-To is not a valid address");

    await saveSettings({
      smtpHost: optionalStr(body.smtpHost, "SMTP host", 253),
      smtpPort: body.smtpPort === null || body.smtpPort === undefined
        ? null
        : int(body.smtpPort, "SMTP port", 1, 65535),
      smtpSecurity: security,
      smtpUser: optionalStr(body.smtpUser, "SMTP username", 254),
      // An omitted password leaves the stored one untouched.
      smtpPassword: typeof body.smtpPassword === "string" && body.smtpPassword.length > 0
        ? body.smtpPassword
        : null,
      clearPassword: body.clearPassword === true,
      fromEmail,
      fromName: optionalStr(body.fromName, "Sender name", 200),
      replyTo,
      maxEmailsPerHour: int(body.maxEmailsPerHour ?? 5000, "Hourly limit", 1, 1_000_000),
    });

    // Response deliberately re-reads the public projection: no secret echoes back.
    return NextResponse.json(await getPublicSettings());
  });
}
