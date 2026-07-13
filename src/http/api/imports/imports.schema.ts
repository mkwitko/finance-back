import { z } from "zod/v4";
import { IMPORT_SOURCES } from "../../../infra/db/tables/imports/import-batch.table.js";

export const CreateImportBody = z.object({
  source: z.enum(IMPORT_SOURCES),
  accountId: z.uuid(),
  // Raw statement text (OFX/CSV) or receipt OCR text.
  content: z.string().min(1).max(1_000_000),
});
export type CreateImportBody = z.infer<typeof CreateImportBody>;

export const ImportResultView = z.object({
  importId: z.uuid(),
  source: z.enum(IMPORT_SOURCES),
  status: z.enum(["completed", "failed"]),
  transactionCount: z.number().int(),
});

export const PreviewImportBody = z.object({
  source: z.enum(IMPORT_SOURCES),
  accountId: z.uuid(),
  content: z.string().min(1).max(1_000_000),
});

export const PreviewRowView = z.object({
  amountCents: z.number().int().positive(),
  direction: z.enum(["in", "out"]),
  occurredAt: z.iso.datetime(),
  description: z.string(),
  rawRef: z.string().nullable(),
  suggestedCategory: z.string().nullable(),
  confidence: z.number().int(),
  duplicate: z.boolean(),
});
export const PreviewImportResponse = z.object({ rows: z.array(PreviewRowView) });

export const CommitImportBody = z.object({
  source: z.enum(IMPORT_SOURCES),
  accountId: z.uuid(),
  rows: z
    .array(
      z.object({
        amountCents: z.number().int().positive(),
        direction: z.enum(["in", "out"]),
        occurredAt: z.iso.datetime(),
        description: z.string().min(1).max(512),
        rawRef: z.string().max(512).nullable(),
        categoryName: z.string().max(255).nullable(),
      }),
    )
    .max(2000),
});
export const CommitImportResponse = z.object({
  importId: z.uuid(),
  imported: z.number().int(),
  skipped: z.number().int(),
});
