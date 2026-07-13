import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../../config/env.js";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

// Lazy pool singleton: the `Pool` is constructed on first use (no connection is
// opened until the first query), so importing this module does not require a live
// database — only actually querying does.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
  }
  return pool;
}

export const db: Db = drizzle(getPool(), { schema });

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
