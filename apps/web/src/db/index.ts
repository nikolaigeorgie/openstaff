import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };

function client() {
  if (!globalForDb.pg) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // A pooled address (pgbouncer, as on Neon) cannot use prepared statements.
    globalForDb.pg = postgres(url, {
      max: Number(process.env.DB_POOL ?? 5),
      idle_timeout: 20,
      prepare: !url.includes("-pooler"),
    });
  }
  return globalForDb.pg;
}

/** Lazy so that importing this file during `next build` does not need a database. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_t, prop) {
    const real = drizzle(client(), { schema });
    return Reflect.get(real, prop, real);
  },
});

export { schema };
