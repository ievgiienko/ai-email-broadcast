import { NextResponse } from "next/server";
import { HttpError, requireAdminMutation, requireUser } from "./auth";

export type Handler = () => Promise<NextResponse | Response>;

/** Uniform error shape; unexpected errors never leak internals to the client. */
export async function handle(fn: Handler): Promise<NextResponse | Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api]", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Read-only admin endpoint. */
export function withAuth(fn: Handler) {
  return handle(async () => {
    await requireUser();
    return fn();
  });
}

/** Mutating admin endpoint: session + same-origin required. */
export function withAuthMutation(fn: Handler) {
  return handle(async () => {
    await requireAdminMutation();
    return fn();
  });
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

export function notFound(message = "Not found"): never {
  throw new HttpError(404, message);
}

export function conflict(message: string): never {
  throw new HttpError(409, message);
}

/* --------------------------------------------------------- input helpers */

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return badRequest("Request body must be valid JSON");
  }
}

export function str(value: unknown, field: string, options: { max?: number; required?: boolean } = {}): string {
  const { max = 500, required = true } = options;
  if (typeof value !== "string") {
    if (!required && (value === null || value === undefined)) return "";
    return badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return badRequest(`${field} is required`);
  if (trimmed.length > max) return badRequest(`${field} must be at most ${max} characters`);
  return trimmed;
}

export function optionalStr(value: unknown, field: string, max = 500): string | null {
  if (value === null || value === undefined || value === "") return null;
  return str(value, field, { max });
}

export function int(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return badRequest(`${field} must be a whole number`);
  }
  if (parsed < min || parsed > max) return badRequest(`${field} must be between ${min} and ${max}`);
  return parsed;
}

export function uuidList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return badRequest(`${field} must be an array`);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = value.map(String);
  if (ids.some((id) => !UUID_RE.test(id))) return badRequest(`${field} contains an invalid id`);
  return [...new Set(ids)];
}

/** Clamped pagination, so a hostile `limit` can't scan the whole table. */
export function pagination(url: URL): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
