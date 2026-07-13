import { closeDb, db } from "../src/infra/db/client.js";
import { seedDefaultCategories } from "../src/infra/db/seed/default-categories.js";

const inserted = await seedDefaultCategories(db);
await closeDb();
process.stdout.write(`seeded ${inserted} default categories\n`);
