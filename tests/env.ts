import { config } from "dotenv";

/**
 * Runs in every test worker before any module is imported, so `@/lib/db` sees
 * the test database rather than the development one.
 */
config({ path: ".env", quiet: true });

const base = process.env.DATABASE_URL ?? "postgres://mailer:mailer@localhost:5435/mailer";
process.env.TEST_DATABASE_URL ??= base.replace(/\/([^/?]+)(\?|$)/, "/mailer_test$2");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.ENCRYPTION_KEY ??= "0".repeat(64);
process.env.APP_URL ??= "https://mail.example.test";
process.env.WORKER_SECRET ??= "test-worker-secret";
process.env.SMTP_MAX_EMAILS_PER_HOUR ??= "5000";
