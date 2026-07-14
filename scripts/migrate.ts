import { execFileSync } from "node:child_process";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run migrations");

execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
process.stdout.write("migrations applied\n");
