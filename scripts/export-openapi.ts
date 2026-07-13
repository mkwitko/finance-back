// Boots the app in-memory (no DB connection needed — /openapi.json is public and
// served from the registered Zod schemas) and writes the OpenAPI document to the
// path given as the first CLI arg. Feeds the Expo app's Kubb type generation.
import { writeFile } from "node:fs/promises";
import { setTestEnv } from "../test/e2e/helpers/env.js";

setTestEnv();
const { buildApp } = await import("../src/app.js");
const app = await buildApp({ rateLimit: false });
await app.ready();

const res = await app.inject({ method: "GET", url: "/openapi.json" });
const out = process.argv[2] ?? "openapi.json";
await writeFile(out, JSON.stringify(res.json(), null, 2));
await app.close();
process.stdout.write(`wrote ${out}\n`);
