import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The connection is created on first use rather than at import time.
 *
 * Next.js imports every route module during `next build` to collect its
 * configuration, so throwing at import would make a build require a working
 * DATABASE_URL — and would mean a single missing variable breaks the build
 * rather than surfacing as a clear runtime error.
 */
const globalForDb = globalThis as unknown as {
  __sql?: postgres.Sql;
  __db?: PostgresJsDatabase<typeof schema>;
};

function connect(): postgres.Sql {
  if (globalForDb.__sql) return globalForDb.__sql;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }

  // Serverless invocations are short-lived and may run concurrently, so keep the
  // per-instance pool tiny. `prepare: false` keeps us compatible with pgbouncer
  // in transaction pooling mode (Supabase/Neon poolers).
  globalForDb.__sql = postgres(connectionString, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
  });
  return globalForDb.__sql;
}

function database(): PostgresJsDatabase<typeof schema> {
  globalForDb.__db ??= drizzle(connect(), { schema });
  return globalForDb.__db;
}

/**
 * `sql` is postgres.js's tagged-template function, so the proxy has to forward
 * calls as well as property access (`sql.end()`, `sql.array(...)`).
 */
export const sql: postgres.Sql = new Proxy((() => undefined) as unknown as postgres.Sql, {
  apply: (_target, _thisArg, args: unknown[]) =>
    (connect() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_target, property) => Reflect.get(connect() as object, property),
  has: (_target, property) => Reflect.has(connect() as object, property),
});

export const db: PostgresJsDatabase<typeof schema> = new Proxy(
  {} as PostgresJsDatabase<typeof schema>,
  {
    get: (_target, property) => Reflect.get(database() as object, property),
    has: (_target, property) => Reflect.has(database() as object, property),
  },
);

export { schema };
