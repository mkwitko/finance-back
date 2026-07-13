import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/infra/db/schema.js";
import { seedDefaultCategories } from "../../src/infra/db/seed/default-categories.js";
import { buildTestApp, type TestApp } from "./helpers/app.js";

const OFX = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD DELIVERY</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240116<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO EMPRESA</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

// End-to-end: import → AI-categorize (fake deepseek) → list, plus household RBAC.
describe("finance import + rbac e2e (db)", () => {
  let h: TestApp;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  async function login(idToken: string): Promise<string> {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }

  beforeAll(async () => {
    h = await buildTestApp();
    db = drizzle(h.pool, { schema });
    await seedDefaultCategories(db);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it("imports an OFX statement, AI-categorizes, lists, and dedups on re-import", async () => {
    const token = await login("alice");
    const auth = { authorization: `Bearer ${token}` };

    const household = await h.app.inject({
      method: "POST",
      url: "/households",
      headers: auth,
      payload: { name: "Casa da Alice", type: "individual" },
    });
    expect(household.statusCode).toBe(201);
    const householdId = household.json().id as string;
    const hh = { ...auth, "x-household-id": householdId };

    const account = await h.app.inject({
      method: "POST",
      url: "/accounts",
      headers: hh,
      payload: { name: "Nubank", kind: "checking" },
    });
    expect(account.statusCode).toBe(201);
    const accountId = account.json().id as string;

    const imported = await h.app.inject({
      method: "POST",
      url: "/imports",
      headers: hh,
      payload: { source: "ofx", accountId, content: OFX },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ status: "completed", transactionCount: 2 });

    const list = await h.app.inject({ method: "GET", url: "/transactions", headers: hh });
    expect(list.statusCode).toBe(200);
    const txns = list.json().transactions;
    expect(txns).toHaveLength(2);
    // Newest first (2024-01-16 income), AI-categorized with confidence.
    expect(txns[0]).toMatchObject({ direction: "in", aiCategorized: true, aiConfidence: 90 });
    expect(txns[0].category).not.toBeNull();

    // Re-importing the same statement adds nothing (dedup on FITID).
    const again = await h.app.inject({
      method: "POST",
      url: "/imports",
      headers: hh,
      payload: { source: "ofx", accountId, content: OFX },
    });
    expect(again.json().transactionCount).toBe(0);
  });

  it("enforces household role: viewer blocked from creating a transaction, owner allowed", async () => {
    const aliceToken = await login("alice");
    const aliceAuth = { authorization: `Bearer ${aliceToken}` };

    const household = await h.app.inject({
      method: "POST",
      url: "/households",
      headers: aliceAuth,
      payload: { name: "Família", type: "family" },
    });
    const householdUuid = household.json().id as string;
    const aliceHh = { ...aliceAuth, "x-household-id": householdUuid };

    const account = await h.app.inject({
      method: "POST",
      url: "/accounts",
      headers: aliceHh,
      payload: { name: "Carteira", kind: "cash" },
    });
    const accountId = account.json().id as string;

    // Owner can create a transaction.
    const asOwner = await h.app.inject({
      method: "POST",
      url: "/transactions",
      headers: aliceHh,
      payload: {
        accountId,
        amountCents: 1000,
        direction: "out",
        occurredAt: "2024-03-01T00:00:00.000Z",
        description: "Café",
      },
    });
    expect(asOwner.statusCode).toBe(201);

    // Bob joins as a viewer (inserted directly), then is blocked from writing.
    const bobToken = await login("bob");
    const bob = (
      await db.select().from(schema.user).where(eq(schema.user.email, "bob@example.com"))
    ).at(0);
    const hhRow = (
      await db.select().from(schema.household).where(eq(schema.household.uuid, householdUuid))
    ).at(0);
    if (!bob || !hhRow) throw new Error("test fixture not found");
    await db.insert(schema.membership).values({
      userId: bob.id,
      householdId: hhRow.id,
      role: "viewer",
      createdBy: bob.uuid,
      updatedBy: bob.uuid,
    });

    const bobHh = { authorization: `Bearer ${bobToken}`, "x-household-id": householdUuid };

    // Viewer can read...
    const read = await h.app.inject({ method: "GET", url: "/transactions", headers: bobHh });
    expect(read.statusCode).toBe(200);

    // ...but cannot write.
    const asViewer = await h.app.inject({
      method: "POST",
      url: "/transactions",
      headers: bobHh,
      payload: {
        accountId,
        amountCents: 1000,
        direction: "out",
        occurredAt: "2024-03-01T00:00:00.000Z",
        description: "Tentativa",
      },
    });
    expect(asViewer.statusCode).toBe(403);
    expect(asViewer.json().code).toBe("HH-T0003");

    // Missing household header → 400.
    const noHeader = await h.app.inject({
      method: "GET",
      url: "/transactions",
      headers: aliceAuth,
    });
    expect(noHeader.statusCode).toBe(400);
    expect(noHeader.json().code).toBe("HH-T0001");
  });
});
