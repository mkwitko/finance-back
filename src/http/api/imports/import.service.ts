import type { DeepseekGateway } from "../../../gateways/deepseek/deepseek.gateway.js";
import type { ImportSource } from "../../../infra/db/tables/imports/import-batch.table.js";
import type { CategoriesRepository } from "../categories/categories.repository.js";
import type {
  CreateTransactionInput,
  TransactionsRepository,
} from "../transactions/transactions.repository.js";
import type { ImportsRepository } from "./imports.repository.js";
import { type NormalizedRow, parseCsv, parseOfx } from "./parsers.js";

export type ImportInput = {
  householdId: number;
  accountId: number;
  source: ImportSource;
  content: string;
  actorUuid: string;
};

export type ImportResult = {
  importId: string;
  source: ImportSource;
  status: "completed" | "failed";
  transactionCount: number;
};

export type ImportServiceDeps = {
  deepseek: DeepseekGateway;
  categoriesRepo: CategoriesRepository;
  transactionsRepo: TransactionsRepository;
  importsRepo: ImportsRepository;
};

export function createImportService(deps: ImportServiceDeps) {
  return async (input: ImportInput): Promise<ImportResult> => {
    const batch = await deps.importsRepo.createBatch({
      householdId: input.householdId,
      source: input.source,
      actorUuid: input.actorUuid,
    });

    try {
      // 1. Parse the upload into normalized rows.
      let rows: NormalizedRow[];
      if (input.source === "ofx") {
        rows = parseOfx(input.content);
      } else if (input.source === "csv") {
        rows = parseCsv(input.content);
      } else {
        const extracted = await deps.deepseek.extractReceipt(input.content);
        rows = extracted.map((e) => ({
          amountCents: e.amountCents,
          direction: e.direction,
          occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
          description: e.description.slice(0, 512),
          rawRef: null,
        }));
      }

      // 2. Skip rows already imported for this account (dedup on rawRef).
      const refs = rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
      const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
      const fresh = rows.filter((r) => r.rawRef === null || !seen.has(r.rawRef));

      // 3. AI-categorize (best effort — never blocks the import).
      const categories = await deps.categoriesRepo.listVisible(input.householdId);
      const byName = new Map(categories.map((c) => [c.name, c]));
      const categorizations = await deps.deepseek.categorizeTransactions({
        categories: categories.map((c) => ({ name: c.name, kind: c.kind })),
        items: fresh.map((r, index) => ({
          index,
          description: r.description,
          direction: r.direction,
          amountCents: r.amountCents,
        })),
      });
      const catByIndex = new Map(categorizations.map((c) => [c.index, c]));

      // 4. Persist.
      const transactionSource = input.source === "receipt" ? "receipt" : "import";
      const toInsert: CreateTransactionInput[] = fresh.map((r, index) => {
        const guess = catByIndex.get(index);
        const matched = guess?.category ? byName.get(guess.category) : undefined;
        return {
          accountId: input.accountId,
          categoryId: matched?.id ?? null,
          importBatchId: batch.id,
          amountCents: r.amountCents,
          direction: r.direction,
          occurredAt: r.occurredAt,
          description: r.description,
          source: transactionSource,
          rawRef: r.rawRef,
          aiCategorized: matched !== undefined,
          aiConfidence: matched !== undefined ? Math.round(guess?.confidence ?? 0) : null,
          actorUuid: input.actorUuid,
        };
      });
      const count = await deps.transactionsRepo.createMany(toInsert);

      await deps.importsRepo.markCompleted(batch.id, count);
      return {
        importId: batch.uuid,
        source: input.source,
        status: "completed",
        transactionCount: count,
      };
    } catch (err) {
      await deps.importsRepo.markFailed(batch.id, err instanceof Error ? err.message : "unknown");
      throw err;
    }
  };
}
