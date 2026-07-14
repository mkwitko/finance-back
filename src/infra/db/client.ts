import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

// Lazy singleton — no connection at import; first query connects.
let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}
export const db: Db = getClient();

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
