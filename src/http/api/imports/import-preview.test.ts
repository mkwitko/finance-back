import { describe, expect, it, vi } from "vitest";
import { createCommitService, createPreviewService } from "./import.service.js";

// Minimal fakes matching the deps the services use.
const OFX = `<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260715<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260716<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO</STMTTRN></OFX>`;

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    deepseek: {
      enabled: true,
      categorizeTransactions: vi.fn(async () => []),
      extractReceipt: vi.fn(async () => []),
      generateInsights: vi.fn(async () => []),
    },
    categoriesRepo: { listVisible: vi.fn(async () => []) },
    transactionsRepo: { create: vi.fn(), createMany: vi.fn(async () => 0) },
    importsRepo: {
      createBatch: vi.fn(async () => ({ id: 1, uuid: "batch-uuid" })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      existingRawRefs: vi.fn(async () => new Set(["TX1"])), // TX1 already imported
    },
    ...overrides,
  } as never;
}

describe("previewImport", () => {
  it("parses + flags duplicates and persists NOTHING", async () => {
    const d = deps();
    const preview = createPreviewService(d);
    const rows = await preview({ householdId: 1, accountId: 9, source: "ofx", content: OFX });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.rawRef === "TX1")?.duplicate).toBe(true);
    expect(rows.find((r) => r.rawRef === "TX2")?.duplicate).toBe(false);
    // no batch created, no transactions written during preview:
    expect((d as { importsRepo: { createBatch: { mock: { calls: unknown[] } } } }).importsRepo.createBatch).not.toHaveBeenCalled();
    expect((d as { transactionsRepo: { createMany: { mock: { calls: unknown[] } } } }).transactionsRepo.createMany).not.toHaveBeenCalled();
  });
});

describe("commitImport", () => {
  it("persists only non-duplicate rows and reports skipped", async () => {
    const d = deps();
    const commit = createCommitService(d);
    const res = await commit({
      householdId: 1,
      accountId: 9,
      actorUuid: "actor",
      rows: [
        { amountCents: 4590, direction: "out", occurredAt: "2026-07-15T00:00:00.000Z", description: "iFood", rawRef: "TX1", categoryName: null },
        { amountCents: 350000, direction: "in", occurredAt: "2026-07-16T00:00:00.000Z", description: "Salário", rawRef: "TX2", categoryName: null },
      ],
    });
    // TX1 is an existing rawRef → skipped; only TX2 persisted.
    const createMany = (d as { transactionsRepo: { createMany: { mock: { calls: unknown[][] } } } }).transactionsRepo.createMany;
    expect((createMany.mock.calls[0]?.[0] as unknown[]).length).toBe(1);
    expect(res.skipped).toBe(1);
  });
});
