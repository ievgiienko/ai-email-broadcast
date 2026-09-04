import nodemailer, { type Transporter } from "nodemailer";
import type { ResolvedSmtpConfig } from "./settings";
import { formatSender } from "./email-address";

/**
 * Nodemailer transport factory. Provider-agnostic: everything SendPulse-specific
 * lives in configuration, not in code.
 */
export function createTransport(config: ResolvedSmtpConfig): Transporter {
  const auth = config.user ? { user: config.user, pass: config.password ?? "" } : undefined;

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // `secure: true` means implicit TLS (port 465). STARTTLS upgrades a plain
    // connection; `requireTLS` makes that upgrade mandatory rather than optional.
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth,
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS ?? 3),
    maxMessages: 100,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
}

export type OutgoingMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Per-campaign overrides; fall back to the configured defaults. */
  fromEmail?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
};

export async function sendMessage(
  transport: Transporter,
  config: ResolvedSmtpConfig,
  message: OutgoingMessage,
): Promise<{ messageId: string }> {
  const info = await transport.sendMail({
    // A campaign may carry its own sender; the configured one is the default.
    from: formatSender(
      message.fromName ?? config.fromName,
      message.fromEmail || config.fromEmail,
    ),
    to: message.to,
    replyTo: message.replyTo || config.replyTo || undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
  });
  return { messageId: String(info.messageId ?? "") };
}

/**
 * Classifies an SMTP failure.
 *
 * 5xx replies are permanent (bad mailbox, rejected sender) and retrying only
 * wastes quota. 4xx and socket-level errors are temporary. When in doubt we
 * treat the error as temporary — a wrongly-permanent classification silently
 * drops a real recipient, which is worse than one extra retry.
 */
export function isPermanentSmtpError(error: unknown): boolean {
  const err = error as { responseCode?: number; code?: string; message?: string } | null;
  if (!err) return false;

  if (typeof err.responseCode === "number") {
    return err.responseCode >= 500 && err.responseCode < 600;
  }
  if (err.code === "EENVELOPE" || err.code === "EMESSAGE") return true;
  return false;
}

/** Short, credential-free error text safe to persist and display. */
export function sanitizeErrorMessage(error: unknown, config?: ResolvedSmtpConfig): string {
  let message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  const code = (error as { responseCode?: number } | null)?.responseCode;
  if (code) message = `${code} ${message}`;

  // Belt and braces: never let a credential reach the database or the UI.
  if (config?.password) message = message.split(config.password).join("***");
  if (config?.user) message = message.split(config.user).join("***");
  message = message
    .replace(/AUTH\s+(PLAIN|LOGIN)\s+\S+/gi, "AUTH $1 ***")
    .replace(/\bpass(word)?["'\s:=]+\S+/gi, "password ***");

  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
