import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import postgres from "postgres";
import { hashPassword } from "../src/lib/crypto";
import { isValidEmail, normalizeEmail } from "../src/lib/email-address";

/**
 * Creates (or resets the password of) the single administrator account.
 * Usage: npm run create-admin -- admin@example.com 'a-strong-password'
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  let [email, password] = process.argv.slice(2);

  if (!email || !password) {
    const rl = createInterface({ input: stdin, output: stdout });
    email ||= await rl.question("Admin email: ");
    password ||= await rl.question("Password (min 12 chars): ");
    rl.close();
  }

  if (!isValidEmail(email)) throw new Error(`Not a valid email address: ${email}`);
  if (password.length < 12) throw new Error("Password must be at least 12 characters.");

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const passwordHash = hashPassword(password);
    const rows = await client`
      INSERT INTO users (email, email_normalized, password_hash)
      VALUES (${email}, ${normalizeEmail(email)}, ${passwordHash})
      ON CONFLICT (email_normalized)
      DO UPDATE SET password_hash = EXCLUDED.password_hash, email = EXCLUDED.email
      RETURNING id, email
    `;
    console.log(`Admin ready: ${rows[0].email}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
