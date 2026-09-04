import { cookies, headers } from "next/headers";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "./db";
import { sessions, users } from "./db/schema";
import { randomToken, sha256, verifyPassword } from "./crypto";

export const SESSION_COOKIE = "mailer_session";
const SESSION_TTL_DAYS = 14;

export type SessionUser = { id: string; email: string };

/** Creates a session row and returns the raw cookie value (stored hashed). */
export async function createSession(userId: string): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });

  // Opportunistic cleanup; keeps the table from growing without a cron job.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  store.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
}

export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.emailNormalized, email.trim().toLowerCase()))
    .limit(1);

  const user = rows[0];
  if (!user) {
    // Burn comparable time so a missing account isn't distinguishable by timing.
    verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA");
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, email: user.email };
}

/* --------------------------------------------------------------- guards */

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Throws 401 unless a valid admin session is present. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Authentication required");
  return user;
}

/**
 * CSRF defence for state-changing requests: the session cookie is SameSite=Lax
 * (so cross-site POSTs carry no cookie at all), and we additionally require the
 * Origin header to match this deployment when one is present.
 */
export async function assertSameOrigin(): Promise<void> {
  const h = await headers();
  const origin = h.get("origin");
  if (!origin) return; // same-origin navigations may omit it; Lax already covers us

  const host = h.get("x-forwarded-host") ?? h.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Invalid origin");
  }
  if (!host || originHost !== host) throw new HttpError(403, "Cross-origin request rejected");
}

/** Both checks, for every mutating admin endpoint. */
export async function requireAdminMutation(): Promise<SessionUser> {
  await assertSameOrigin();
  return requireUser();
}
