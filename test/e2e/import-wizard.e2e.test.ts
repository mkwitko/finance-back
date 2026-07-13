import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

const OFX = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260715<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260716<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("import wizard preview+commit e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    return res.json().accessToken as string;
  }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("preview does not persist; commit persists reviewed rows; re-commit dedups", async () => {
    const auth = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: auth, payload: { name: "Casa", type: "individual" } });
    const householdId = hh.json().id as string;
    const scoped = { ...auth, "x-household-id": householdId };
    const acc = await h.app.inject({ method: "POST", url: "/accounts", headers: scoped, payload: { name: "Nubank", kind: "checking" } });
    const accountId = acc.json().id as string;

    // Preview → 2 rows, none persisted yet.
    const preview = await h.app.inject({ method: "POST", url: "/imports/preview", headers: scoped, payload: { source: "ofx", accountId, content: OFX } });
    expect(preview.statusCode).toBe(200);
    const rows = preview.json().rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { duplicate: boolean }) => r.duplicate === false)).toBe(true);
    const listAfterPreview = await h.app.inject({ method: "GET", url: "/transactions", headers: scoped });
    expect(listAfterPreview.json().transactions).toHaveLength(0); // preview persisted nothing

    // Commit only the first row (user excluded the second).
    const commit = await h.app.inject({
      method: "POST", url: "/imports/commit", headers: scoped,
      payload: { accountId, source: "ofx", rows: [{ ...rows[0], categoryName: null }] },
    });
    expect(commit.statusCode).toBe(201);
    expect(commit.json().imported).toBe(1);
    const listAfterCommit = await h.app.inject({ method: "GET", url: "/transactions", headers: scoped });
    expect(listAfterCommit.json().transactions).toHaveLength(1);

    // A second preview now flags the committed row as duplicate.
    const preview2 = await h.app.inject({ method: "POST", url: "/imports/preview", headers: scoped, payload: { source: "ofx", accountId, content: OFX } });
    const dupRow = preview2.json().rows.find((r: { rawRef: string }) => r.rawRef === rows[0].rawRef);
    expect(dupRow.duplicate).toBe(true);

    // Re-committing the same row is skipped (dedup).
    const commit2 = await h.app.inject({ method: "POST", url: "/imports/commit", headers: scoped, payload: { accountId, source: "ofx", rows: [{ ...rows[0], categoryName: null }] } });
    expect(commit2.json().imported).toBe(0);
    expect(commit2.json().skipped).toBe(1);
  });
});
