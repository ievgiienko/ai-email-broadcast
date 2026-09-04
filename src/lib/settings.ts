import { eq } from "drizzle-orm";
import { db } from "./db";
import { appSettings } from "./db/schema";
import { decryptSecret, encryptSecret } from "./crypto";

export type SmtpSecurity = "none" | "starttls" | "tls";

export type PublicSettings = {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: SmtpSecurity;
  smtpUser: string | null;
  /** Whether a password is stored. The value itself is never sent to a client. */
  smtpPasswordSet: boolean;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  maxEmailsPerHour: number;
  updatedAt: string | null;
  /**
   * Fields currently taken from environment variables instead of this row.
   * Surfaced so the admin is never silently editing a value that has no effect.
   */
  envOverrides: string[];
};

/** Environment variable names that shadow each stored setting. */
const ENV_OVERRIDES: Record<string, string> = {
  smtpHost: "SMTP_HOST",
  smtpPort: "SMTP_PORT",
  smtpSecurity: "SMTP_SECURITY",
  smtpUser: "SMTP_USER",
  smtpPassword: "SMTP_PASSWORD",
  fromEmail: "SMTP_FROM_EMAIL",
  fromName: "SMTP_FROM_NAME",
  replyTo: "SMTP_REPLY_TO",
  maxEmailsPerHour: "SMTP_MAX_EMAILS_PER_HOUR",
};

export function activeEnvOverrides(): string[] {
  return Object.entries(ENV_OVERRIDES)
    .filter(([, variable]) => Boolean(process.env[variable]))
    .map(([field]) => field);
}

export async function loadSettingsRow() {
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db
    .insert(appSettings)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const again = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  return again[0];
}

/** Settings safe to serialize to the browser: no credential material. */
export async function getPublicSettings(): Promise<PublicSettings> {
  const row = await loadSettingsRow();
  return {
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecurity: row.smtpSecurity,
    smtpUser: row.smtpUser,
    smtpPasswordSet: Boolean(row.smtpPasswordEncrypted),
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
    maxEmailsPerHour: row.maxEmailsPerHour,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    envOverrides: activeEnvOverrides(),
  };
}

export type ResolvedSmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  password: string | null;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  maxEmailsPerHour: number;
};

/**
 * Server-only. Environment variables win over the database row, so a hardened
 * deployment can keep credentials entirely out of the DB.
 */
export async function getSmtpConfig(): Promise<ResolvedSmtpConfig | null> {
  const row = await loadSettingsRow();

  const host = process.env.SMTP_HOST || row.smtpHost;
  const portRaw = process.env.SMTP_PORT || row.smtpPort;
  const fromEmail = process.env.SMTP_FROM_EMAIL || row.fromEmail;
  if (!host || !portRaw || !fromEmail) return null;

  const envSecurity = process.env.SMTP_SECURITY as SmtpSecurity | undefined;
  const security: SmtpSecurity =
    envSecurity && ["none", "starttls", "tls"].includes(envSecurity) ? envSecurity : row.smtpSecurity;

  let password: string | null = process.env.SMTP_PASSWORD || null;
  if (!password && row.smtpPasswordEncrypted) {
    try {
      password = decryptSecret(row.smtpPasswordEncrypted);
    } catch {
      // A rotated ENCRYPTION_KEY makes the stored blob unreadable. Fail closed
      // rather than attempting to send unauthenticated.
      throw new Error(
        "Stored SMTP password could not be decrypted. Re-enter it in Settings (ENCRYPTION_KEY may have changed).",
      );
    }
  }

  const envLimit = Number(process.env.SMTP_MAX_EMAILS_PER_HOUR);
  const maxEmailsPerHour =
    Number.isFinite(envLimit) && envLimit > 0 ? envLimit : row.maxEmailsPerHour;

  return {
    host,
    port: Number(portRaw),
    security,
    user: process.env.SMTP_USER || row.smtpUser,
    password,
    fromEmail,
    fromName: process.env.SMTP_FROM_NAME || row.fromName,
    replyTo: process.env.SMTP_REPLY_TO || row.replyTo,
    maxEmailsPerHour,
  };
}

export async function saveSettings(input: {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: SmtpSecurity;
  smtpUser: string | null;
  smtpPassword?: string | null;
  clearPassword?: boolean;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  maxEmailsPerHour: number;
}) {
  await loadSettingsRow();

  const patch: Record<string, unknown> = {
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecurity: input.smtpSecurity,
    smtpUser: input.smtpUser,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    replyTo: input.replyTo,
    maxEmailsPerHour: input.maxEmailsPerHour,
    updatedAt: new Date(),
  };

  // An omitted password means "leave the stored one alone".
  if (input.clearPassword) patch.smtpPasswordEncrypted = null;
  else if (input.smtpPassword) patch.smtpPasswordEncrypted = encryptSecret(input.smtpPassword);

  await db.update(appSettings).set(patch).where(eq(appSettings.id, 1));
}

/** Absolute base URL used for tracking + unsubscribe links. */
export function appUrl(): string {
  const explicit = process.env.APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
