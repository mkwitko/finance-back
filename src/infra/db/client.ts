import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

// Lazy singleton: the PrismaClient is NOT constructed at import time — importing this
// module opens no connection. The first property access on `db` (e.g. `db.user`)
// instantiates the client, so tests/tools that only import (or dynamic-import in a
// beforeAll) don't spin up a pool until they actually query.
let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const c = getClient();
    const value = Reflect.get(c, prop) as unknown;
    // Bind client methods (`$queryRaw`, `$transaction`, `$disconnect`, …) to the real
    // client so `this` is correct; model delegates (`db.user`) are returned as-is.
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(c) : value;
  },
  has(_target, prop) {
    return Reflect.has(getClient(), prop);
  },
});

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
