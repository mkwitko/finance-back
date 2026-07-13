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
