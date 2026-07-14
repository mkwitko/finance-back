import type { ImportSource } from "../../../domain/enums.js";
import type { DeepseekGateway } from "../../../gateways/deepseek/deepseek.gateway.js";
import type { CategoriesRepository } from "../categories/categories.repository.js";
import type {
  CreateTransactionInput,
  TransactionsRepository,
} from "../transactions/transactions.repository.js";
import type { ImportsRepository } from "./imports.repository.js";
import { type NormalizedRow, parseCsv, parseOfx } from "./parsers.js";

export type ImportInput = {
  householdId: string;
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

export type PreviewRow = {
  amountCents: number;
  direction: "in" | "out";
  occurredAt: string;
  description: string;
  rawRef: string | null;
  suggestedCategory: string | null;
  confidence: number;
  duplicate: boolean;
};

export type CommitRow = {
  amountCents: number;
  direction: "in" | "out";
  occurredAt: string;
  description: string;
  rawRef: string | null;
  categoryName: string | null;
};

async function parseRows(
  source: ImportSource,
  content: string,
  gateway: DeepseekGateway,
): Promise<NormalizedRow[]> {
  if (source === "ofx") return parseOfx(content);
  if (source === "csv") return parseCsv(content);
  const extracted = await gateway.extractReceipt(content);
  return extracted.map((e) => ({
    amountCents: e.amountCents,
    direction: e.direction,
    occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
    description: e.description.slice(0, 512),
    rawRef: null,
  }));
}

async function categorizeRows(
  householdId: string,
  rows: NormalizedRow[],
  deps: { deepseek: DeepseekGateway; categoriesRepo: CategoriesRepository },
) {
  const categories = await deps.categoriesRepo.listVisible(householdId);
  const byName = new Map(categories.map((c) => [c.name, c]));
  const categorizations = await deps.deepseek.categorizeTransactions({
    categories: categories.map((c) => ({ name: c.name, kind: c.kind })),
    items: rows.map((r, index) => ({
      index,
      description: r.description,
      direction: r.direction,
      amountCents: r.amountCents,
    })),
  });
  return { byName, catByIndex: new Map(categorizations.map((c) => [c.index, c])) };
}

export function createPreviewService(deps: ImportServiceDeps) {
  return async (input: {
    householdId: string;
    accountId: number;
    source: ImportSource;
    content: string;
  }): Promise<PreviewRow[]> => {
    const rows = await parseRows(input.source, input.content, deps.deepseek);
    const refs = rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
    const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
    const { catByIndex } = await categorizeRows(input.householdId, rows, deps);
    return rows.map((r, index) => {
      const guess = catByIndex.get(index);
      return {
        amountCents: r.amountCents,
        direction: r.direction,
        occurredAt: r.occurredAt.toISOString(),
        description: r.description.slice(0, 512),
        rawRef: r.rawRef,
        suggestedCategory: guess?.category ?? null,
        confidence: Math.round(guess?.confidence ?? 0),
        duplicate: r.rawRef !== null && seen.has(r.rawRef),
      };
    });
  };
}

export function createCommitService(deps: ImportServiceDeps) {
  return async (input: {
    householdId: string;
    accountId: number;
    source: ImportSource;
    rows: CommitRow[];
    actorUuid: string;
  }): Promise<{ importId: string; imported: number; skipped: number }> => {
    const batch = await deps.importsRepo.createBatch({
      householdId: input.householdId,
      source: input.source,
      actorUuid: input.actorUuid,
    });
    try {
      const refs = input.rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
      const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
      const seenInBatch = new Set<string>();
      const fresh = input.rows.filter((r) => {
        if (r.rawRef === null) return true;
        if (seen.has(r.rawRef)) return false;
        if (seenInBatch.has(r.rawRef)) return false;
        seenInBatch.add(r.rawRef);
        return true;
      });
      const categories = await deps.categoriesRepo.listVisible(input.householdId);
      const byName = new Map(categories.map((c) => [c.name, c]));
      const toInsert: CreateTransactionInput[] = fresh.map((r) => ({
        accountId: input.accountId,
        categoryId: r.categoryName ? (byName.get(r.categoryName)?.uuid ?? null) : null,
        importBatchId: batch.id,
        amountCents: r.amountCents,
        direction: r.direction,
        occurredAt: new Date(r.occurredAt),
        description: r.description.slice(0, 512),
        source: "import",
        rawRef: r.rawRef,
        aiCategorized: false,
        aiConfidence: null,
        actorUuid: input.actorUuid,
      }));
      const imported = await deps.transactionsRepo.createMany(toInsert);
      await deps.importsRepo.markCompleted(batch.id, imported);
      return { importId: batch.uuid, imported, skipped: input.rows.length - fresh.length };
    } catch (err) {
      await deps.importsRepo.markFailed(batch.id, err instanceof Error ? err.message : "unknown");
      throw err;
    }
  };
}

export function createImportService(deps: ImportServiceDeps) {
  return async (input: ImportInput): Promise<ImportResult> => {
    const batch = await deps.importsRepo.createBatch({
      householdId: input.householdId,
      source: input.source,
      actorUuid: input.actorUuid,
    });

    try {
      // 1. Parse the upload into normalized rows.
      const rows = await parseRows(input.source, input.content, deps.deepseek);

      // 2. Skip rows already imported for this account (dedup on rawRef).
      const refs = rows.map((r) => r.rawRef).filter((r): r is string => r !== null);
      const seen = await deps.importsRepo.existingRawRefs(input.accountId, refs);
      const fresh = rows.filter((r) => r.rawRef === null || !seen.has(r.rawRef));

      // 3. AI-categorize (best effort — never blocks the import).
      const { byName, catByIndex } = await categorizeRows(input.householdId, fresh, deps);

      // 4. Persist.
      const transactionSource = input.source === "receipt" ? "receipt" : "import";
      const toInsert: CreateTransactionInput[] = fresh.map((r, index) => {
        const guess = catByIndex.get(index);
        const matched = guess?.category ? byName.get(guess.category) : undefined;
        return {
          accountId: input.accountId,
          categoryId: matched?.uuid ?? null,
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
