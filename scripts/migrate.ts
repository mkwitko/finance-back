import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required to run migrations");

const pool = new Pool({ connectionString: url, max: 1, statement_timeout: 60_000 });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./src/infra/db/migrations" });
await pool.end();
process.stdout.write("migrations applied\n");
