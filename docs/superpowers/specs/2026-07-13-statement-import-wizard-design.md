# World-Class Statement Import Wizard — Design Spec

**Date:** 2026-07-13
**Projects:** finance-back (Fastify 5, Drizzle, Zod 4) + finance-app (Expo, Kubb, expo-document-picker, expo-file-system)
**Status:** Approved for planning (wizard mockup approved in the visual companion)

## Context

The app can already import statements: `POST /imports` (adult, household-scoped) parses OFX/CSV (`parsers.ts`) or extracts receipt text (Deepseek), AI-categorizes (best-effort), dedups on `rawRef`, and **persists in one shot**. The frontend is crude: a paste-into-a-textarea box on the transactions screen (source guessed by a `"STMTTRN"` substring), a hardcoded first account, legacy styling, and no file picker (`expo-document-picker`/`expo-image-picker` are installed but unused).

This subsystem makes statement import **world-class**: a guided multi-step wizard that teaches the user how to export their statement (per bank), lets them pick the file, and **shows a preview to review/adjust before committing**.

## Goals

- A **multi-step wizard** (account → source + per-bank instructions → file → review → result) with a **fixed footer CTA** (+ "Voltar" from step 2), built on the design system.
- **Guided file import**: `expo-document-picker` for `.ofx`/`.csv`, read via `expo-file-system`, plus curated **per-bank download instructions**.
- **Preview before commit**: a new backend `preview` endpoint parses + AI-categorizes **without persisting** and flags duplicates; the user reviews (exclude rows, change category) and a `commit` endpoint persists the reviewed set.

## Non-Goals (deferred)

- **Receipt photo / OCR from an image** — the backend `receipt` source takes OCR *text*, not an image; on-device/vision OCR is a separate fork. Not in this wizard (OFX/CSV files only).
- Removing the existing `POST /imports` — kept for backward compatibility (existing e2e + the old paste box until the wizard replaces it).
- Bank API / Open Finance connections — out of scope (import-first, per project constraints).

## Decisions (from brainstorming)

- v1 = **wizard + guided file import + preview-before-commit**. Receipt photo deferred.
- Buttons live in a **fixed footer** on every step.
- Preview parses + categorizes and returns rows to the client; the client holds them, the user edits (exclude / change category), and **commit persists the reviewed rows** (no re-categorization). Dedup on `rawRef` happens at both preview (flag) and commit (skip).

## Backend (finance-back)

Refactor `import.service.ts` to extract two shared, reusable steps and add two service functions; keep the existing all-in-one service delegating to them.

- **Shared helpers** (extracted from today's service):
  - `parseRows(source, content, gateway): Promise<NormalizedRow[]>` — OFX/CSV (pure parsers) or receipt (gateway).
  - `categorizeRows(householdId, rows, deps): Promise<Map<index, { categoryName: string | null; confidence: number }>>` — the Deepseek categorize call + name→category resolution.
- **`previewImport`**: parse → compute `duplicate` per row via `existingRawRefs` (flag, don't skip) → categorize all rows → return rows **without persisting and without creating a batch**.
- **`commitImport`**: create a batch → skip rows whose `rawRef` already exists (server-side dedup safety) → resolve each row's `categoryName` → persist via `createMany` → `markCompleted` → return `{ importId, imported, skipped }`.

### Endpoints (household-scoped, `requireHouseholdRole('adult')`, `x-household-id`)

| Method & path | Body | Returns |
|---|---|---|
| `POST /imports/preview` | `{ accountId(uuid), source, content }` | `{ rows: PreviewRow[] }` — `PreviewRow = { amountCents, direction, occurredAt(ISO), description, rawRef: string\|null, suggestedCategory: string\|null, confidence: number, duplicate: boolean }` |
| `POST /imports/commit` | `{ accountId(uuid), rows: CommitRow[] }` — `CommitRow = { amountCents, direction, occurredAt(ISO), description, rawRef: string\|null, categoryName: string\|null }` | `{ importId(uuid), imported: number, skipped: number }` |
| `POST /imports` (existing) | unchanged | unchanged |

- `preview` creates no `import_batch` and writes no transactions.
- `commit` sets transaction `source = "import"`, resolves `categoryName` → `categoryId` (null if unknown), `aiCategorized = false` (the user reviewed), `aiConfidence = null`.
- The client is expected to send only the rows the user kept; `commit` still dedups on `rawRef` defensively (`skipped` counts both duplicates and any it drops).

## Frontend (finance-app)

A wizard, replacing the transactions-screen paste box, on the design system with a **fixed footer**.

- **Step 1 — Account**: pick from `useListAccounts`; create inline if none.
- **Step 2 — Source + instructions**: choose OFX/CSV; show curated **per-bank export steps** (Nubank, Itaú, Bradesco, Inter, C6, BB, Caixa + a generic fallback) from a static guide module. Footer: "Voltar" + "Escolher arquivo".
- **Step 3 — File**: `expo-document-picker` (`.ofx`/`.csv`), read text with `expo-file-system`; footer "Analisar extrato" → `POST /imports/preview`.
- **Step 4 — Review**: list `PreviewRow`s (`AmountText`, category `Badge`); per row an include/exclude checkbox and a category picker (from `useListCategories`); duplicates pre-unchecked + badged. Footer "Importar N".
- **Step 5 — Result**: `POST /imports/commit` → summary (`imported` / `skipped`) + a link to transactions and "importar outro".

Wizard state (step, account, source, picked file text, preview rows, per-row include/category) lives in the wizard screen (local state / a small reducer). A reusable `WizardFooter` (design-system `Button`s) renders the fixed footer.

## Testing

- **finance-back**: unit for the extracted `parseRows`/`categorizeRows` where pure (parsers already covered); e2e (Testcontainers) — `preview` returns parsed+categorized rows and persists NOTHING (assert transaction count unchanged), flags a duplicate after a prior import; `commit` persists the sent rows, dedups a duplicate `rawRef`, and honors an excluded row (client omits it → not persisted).
- **finance-app**: RNTL per step (mock API + document picker + file-system) and a flow test (account → preview → review edits → commit), asserting the commit payload reflects exclusions/category changes.
- **Contract**: after backend lands, export OpenAPI + regenerate hooks.

## Decomposition → Two Implementation Plans

1. **Plan A — Backend**: refactor `import.service` (extract helpers), add `previewImport`/`commitImport` + schemas + routes (keep `/imports`), e2e, OpenAPI export.
2. **Plan B — Frontend**: regenerate hooks; build the wizard (steps + fixed footer), document-picker + file read, per-bank guides, review screen; replace the transactions paste box; RNTL + headless export.

## Files (anticipated)

**Backend:** `src/http/api/imports/import.service.ts` (refactor + `previewImport`/`commitImport`), `imports.schema.ts` (Preview/Commit bodies + views), `imports/index.ts` (two routes), e2e.

**Frontend:** regenerated `src/api/**`; `src/constants/bank-import-guides.ts`; `src/components/imports/` (`ImportWizard`, `WizardFooter`, step components, `ReviewRow`); `src/app/(tabs)/import.tsx` (or a modal route); transactions screen paste box removed.

## Open Questions (resolve in plan, not blocking)

- Category picker source in review: `useListCategories` (visible categories). Confirm the app already exposes it (a `useListCategories` hook exists from earlier generation).
- Whether the wizard is a tab or a pushed screen from transactions — proposed: a screen reachable from a prominent "Importar extrato" button on the transactions screen (not a permanent tab).
