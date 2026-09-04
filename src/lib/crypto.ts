import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/* ------------------------------------------------------------- secret key */

let cachedKey: Buffer | null = null;

/**
 * 32-byte key derived from ENCRYPTION_KEY. Accepts a 64-char hex string, a
 * base64 string, or any passphrase (hashed to 32 bytes as a fallback).
 */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      "ENCRYPTION_KEY is missing or too short. Generate one with: openssl rand -hex 32",
    );
  }
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, "hex");
  else {
    const b64 = Buffer.from(raw, "base64");
    key = b64.length === 32 ? b64 : createHash("sha256").update(raw).digest();
  }
  cachedKey = key;
  return key;
}

/* ------------------------------------------------------- AES-256-GCM blob */

/** Encrypts a UTF-8 string to `v1.<iv>.<tag>.<ciphertext>` (all base64url). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Malformed encrypted value");
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/* --------------------------------------------------------------- password */

/** scrypt hash, stored as `scrypt$<N>$<r>$<p>$<salt>$<hash>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- tokens */

/**
 * 256 bits of entropy, URL-safe. Used for tracking + unsubscribe tokens, which
 * are public URL components and must be unguessable (never sequential IDs).
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison for secrets arriving from untrusted callers. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
