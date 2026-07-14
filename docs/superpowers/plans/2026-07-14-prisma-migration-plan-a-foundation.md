# Prisma Migration — Plan A (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay a fully-green foundation for the Drizzle→Prisma + uuid-PK migration: author `prisma/schema.prisma` (uuidv7 PK, all 11 models), generate the client, and centralize all table-embedded enums/consts/types into `src/domain/` — WITHOUT cutting over any query path. Drizzle still owns the DB and every repo; the suite stays green.

**Architecture:** Plan A is prep only. `schema.prisma` is authored + `prisma generate` run (no DB touched — generation is offline). The TS const arrays/union types/rank maps currently defined inside `*.table.ts` are moved to `src/domain/enums.ts` and both the Drizzle table files and all app consumers import them from there (single source of truth). Nothing swaps to Prisma at runtime yet — that is Plan B (the big-bang cutover). This keeps Plan A independently mergeable and green.

**Tech Stack:** Node 22, Fastify 5, TypeScript strict (ESM NodeNext, `.js` specifiers), Drizzle (still live), Prisma 6 (`prisma` + `@prisma/client`), Vitest + Testcontainers, pnpm.

## Global Constraints

- Package manager is **pnpm**. Install Prisma with `pnpm add -D prisma@^6 && pnpm add @prisma/client@^6`.
- ESM NodeNext: local imports use the `.js` extension. Zod stays `zod/v4` (unaffected here).
- Plan A must end **fully green**: `npm run typecheck` 0 errors, `npm run test:unit` and `npm run test:e2e` pass. Drizzle remains the runtime ORM; Prisma is authored-but-dormant.
- `schema.prisma` uses uuidv7 PK (`@default(uuid(7))`), Prisma default column/table naming (NO `@map`), Prisma enums, `@db.Timestamptz` on every DateTime (UTC end-to-end), audit `createdBy`/`updatedBy` as plain `String` (no relation).
- Do NOT rewrite any repository, the DB client, the household hook, or e2e boot in Plan A — those are Plan B.
- The DB is greenfield for Prisma; Plan A never runs `prisma db push`/`migrate` against a real DB (generation only). The live dev DB stays on Drizzle.

---

### Task 1: Add Prisma + author schema.prisma + generate client

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `prisma/schema.prisma`
- Create: `.gitignore` entry if needed for generated client (default `@prisma/client` lives in node_modules — no ignore needed)

**Interfaces:**
- Produces: a validated `prisma/schema.prisma` and a generated `@prisma/client` (types available for Plan B). No runtime wiring.

- [ ] **Step 1: Install Prisma**

Run: `pnpm add -D prisma@^6 && pnpm add @prisma/client@^6`
Expected: both in package.json. Confirm the installed `prisma` version supports `uuid(7)` (Prisma ≥ 6). If `prisma validate` later rejects `uuid(7)`, fall back to `@default(uuid())` (v4) for every PK and note the locality tradeoff in the report.

- [ ] **Step 2: Write schema.prisma**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum AccountKind {
  cash
  checking
  credit
  investment
  prepaid
}

enum CategoryKind {
  income
  expense
}

enum GoalType {
  house
  car
  emergency
  retirement
  trip
  debt
  independence
}

enum HouseholdType {
  individual
  family
  shared
  kids
}

enum MembershipRole {
  owner
  adult
  teen
  child
  viewer
}

enum ImportSource {
  ofx
  csv
  receipt
}

enum ImportStatus {
  pending
  processing
  completed
  failed
}

enum InsightKind {
  spending_alert
  summary
  trend
  advice
}

enum InsightSeverity {
  info
  warning
  positive
}

enum TransactionDirection {
  in
  out
}

enum TransactionSource {
  manual
  import
  receipt
}

model User {
  uuid          String    @id @default(uuid(7)) @db.Uuid
  createdBy     String    @db.Uuid
  updatedBy     String    @db.Uuid
  createdAt     DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt     DateTime? @db.Timestamptz(6)
  googleSub     String    @unique
  email         String    @unique
  name          String
  picture       String?
  emailVerified Boolean   @default(false)
  memberships   Membership[]
  refreshTokens RefreshToken[]

  @@index([createdAt, uuid])
}

model RefreshToken {
  uuid      String    @id @default(uuid(7)) @db.Uuid
  createdBy String    @db.Uuid
  updatedBy String    @db.Uuid
  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt DateTime? @db.Timestamptz(6)
  userId    String    @db.Uuid
  user      User      @relation(fields: [userId], references: [uuid], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime  @db.Timestamptz(6)
  revokedAt DateTime? @db.Timestamptz(6)

  @@index([userId])
}

model Household {
  uuid          String    @id @default(uuid(7)) @db.Uuid
  createdBy     String    @db.Uuid
  updatedBy     String    @db.Uuid
  createdAt     DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt     DateTime? @db.Timestamptz(6)
  name          String
  type          HouseholdType
  accounts      Account[]
  categories    Category[]
  goals         Goal[]
  memberships   Membership[]
  invitations   Invitation[]
  importBatches ImportBatch[]
  insights      Insight[]

  @@index([createdAt, uuid])
}

model Account {
  uuid         String    @id @default(uuid(7)) @db.Uuid
  createdBy    String    @db.Uuid
  updatedBy    String    @db.Uuid
  createdAt    DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt    DateTime? @db.Timestamptz(6)
  householdId  String    @db.Uuid
  household    Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  name         String
  kind         AccountKind
  institution  String?
  currency     String    @default("BRL") @db.Char(3)
  transactions Transaction[]

  @@index([householdId])
}

model Category {
  uuid         String    @id @default(uuid(7)) @db.Uuid
  createdBy    String    @db.Uuid
  updatedBy    String    @db.Uuid
  createdAt    DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt    DateTime? @db.Timestamptz(6)
  householdId  String?   @db.Uuid
  household    Household? @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  name         String
  kind         CategoryKind
  parentId     String?   @db.Uuid
  parent       Category?  @relation("CategoryChildren", fields: [parentId], references: [uuid], onDelete: SetNull)
  children     Category[] @relation("CategoryChildren")
  icon         String?
  transactions Transaction[]

  @@index([householdId])
}

model Goal {
  uuid               String    @id @default(uuid(7)) @db.Uuid
  createdBy          String    @db.Uuid
  updatedBy          String    @db.Uuid
  createdAt          DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt          DateTime? @db.Timestamptz(6)
  householdId        String    @db.Uuid
  household          Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  type               GoalType
  name               String
  targetAmountCents  BigInt?
  targetDate         DateTime? @db.Timestamptz(6)
  currentAmountCents BigInt    @default(0)
  params             Json      @default("{}")

  @@index([householdId])
}

model Invitation {
  uuid        String    @id @default(uuid(7)) @db.Uuid
  createdBy   String    @db.Uuid
  updatedBy   String    @db.Uuid
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)
  householdId String    @db.Uuid
  household   Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  code        String    @unique
  role        MembershipRole
  expiresAt   DateTime  @db.Timestamptz(6)
  revokedAt   DateTime? @db.Timestamptz(6)

  @@index([householdId])
}

model Membership {
  uuid        String    @id @default(uuid(7)) @db.Uuid
  createdBy   String    @db.Uuid
  updatedBy   String    @db.Uuid
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)
  userId      String    @db.Uuid
  user        User       @relation(fields: [userId], references: [uuid], onDelete: Cascade)
  householdId String    @db.Uuid
  household   Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  role        MembershipRole

  @@unique([userId, householdId])
  @@index([householdId])
}

model ImportBatch {
  uuid             String    @id @default(uuid(7)) @db.Uuid
  createdBy        String    @db.Uuid
  updatedBy        String    @db.Uuid
  createdAt        DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt        DateTime? @db.Timestamptz(6)
  householdId      String    @db.Uuid
  household        Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  source           ImportSource
  status           ImportStatus @default(pending)
  fileRef          String?
  transactionCount Int       @default(0)
  error            String?
  transactions     Transaction[]

  @@index([householdId])
}

model Insight {
  uuid           String    @id @default(uuid(7)) @db.Uuid
  createdBy      String    @db.Uuid
  updatedBy      String    @db.Uuid
  createdAt      DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt      DateTime? @db.Timestamptz(6)
  householdId    String    @db.Uuid
  household      Household  @relation(fields: [householdId], references: [uuid], onDelete: Cascade)
  kind           InsightKind
  severity       InsightSeverity
  title          String
  body           String
  recommendation String?
  periodStart    DateTime  @db.Timestamptz(6)
  periodEnd      DateTime  @db.Timestamptz(6)
  generatedAt    DateTime  @db.Timestamptz(6)

  @@index([householdId])
}

model Transaction {
  uuid          String    @id @default(uuid(7)) @db.Uuid
  createdBy     String    @db.Uuid
  updatedBy     String    @db.Uuid
  createdAt     DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt     DateTime? @db.Timestamptz(6)
  accountId     String    @db.Uuid
  account       Account    @relation(fields: [accountId], references: [uuid], onDelete: Cascade)
  categoryId    String?   @db.Uuid
  category      Category?  @relation(fields: [categoryId], references: [uuid], onDelete: SetNull)
  importBatchId String?   @db.Uuid
  importBatch   ImportBatch? @relation(fields: [importBatchId], references: [uuid], onDelete: SetNull)
  amountCents   BigInt
  direction     TransactionDirection
  occurredAt    DateTime  @db.Timestamptz(6)
  description   String
  source        TransactionSource
  rawRef        String?
  aiCategorized Boolean   @default(false)
  aiConfidence  Int?

  @@index([accountId, occurredAt])
  @@index([categoryId])
}
```

> Notes: String length caps (varchar(n)) are intentionally dropped — DB-level length was a soft cap; Zod HTTP schemas already enforce input bounds, and greenfield TEXT columns are behavior-equivalent. `currency` keeps `@db.Char(3)`. Money `*_cents` are `BigInt` (Plan B repos convert to `number` at the mapping boundary, as amounts fit JS safe-int). `params` is `Json`.

- [ ] **Step 3: Add scripts + validate + generate**

In `package.json` scripts, add:
```json
    "prisma:generate": "prisma generate",
    "prisma:validate": "prisma validate"
```
(Leave the existing `db:migrate`/`db:seed` Drizzle scripts untouched in Plan A — they're rewritten in Plan B. Do NOT add `postinstall` yet; it's a Plan B concern once Prisma is the runtime.)

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀". Fix any schema error before continuing.

Run: `npx prisma generate`
Expected: "Generated Prisma Client" — `@prisma/client` now has the typed models.

- [ ] **Step 4: Verify nothing else broke**

Run: `npm run typecheck`
Expected: 0 errors (no source imports `@prisma/client` yet; Drizzle path untouched).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml prisma/schema.prisma
git commit -m "feat(prisma): add Prisma + schema.prisma (uuidv7 PK, 11 models) + generate"
```

---

### Task 2: Centralize table-embedded enums/consts/types into `src/domain/enums.ts`

Move every const array, union type, and rank map currently defined inside `*.table.ts` into one domain module, then repoint BOTH the Drizzle table files AND all app consumers to import from it. Single source of truth; still green on Drizzle.

**Files:**
- Create: `src/domain/enums.ts`
- Test: `src/domain/enums.test.ts`
- Modify: the 8 `*.table.ts` files that define consts (import from domain instead of defining)
- Modify: all app consumers that import these consts/types (repoint via grep)

**Interfaces:**
- Produces from `src/domain/enums.ts` (exact names — must match today's, since consumers import by these names):
  - `ACCOUNT_KINDS` + `type AccountKind`
  - `CATEGORY_KINDS` + `type CategoryKind`
  - `GOAL_TYPES` + `type GoalType`
  - `HOUSEHOLD_TYPES` + `type HouseholdType`
  - `MEMBERSHIP_ROLES` + `type MembershipRole` + `ROLE_RANK`
  - `IMPORT_SOURCES` + `type ImportSource`, `IMPORT_STATUSES` + `type ImportStatus`
  - `INSIGHT_KINDS` + `type InsightKind`, `INSIGHT_SEVERITIES` + `type InsightSeverity`
  - `TRANSACTION_DIRECTIONS` + `type TransactionDirection`, `TRANSACTION_SOURCES` + `type TransactionSource`

- [ ] **Step 1: Write the domain module**

`src/domain/enums.ts` (copy the exact arrays + types + ROLE_RANK verbatim from the current table files):

```ts
export const ACCOUNT_KINDS = ["cash", "checking", "credit", "investment", "prepaid"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CATEGORY_KINDS = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const GOAL_TYPES = ["house", "car", "emergency", "retirement", "trip", "debt", "independence"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const HOUSEHOLD_TYPES = ["individual", "family", "shared", "kids"] as const;
export type HouseholdType = (typeof HOUSEHOLD_TYPES)[number];

export const MEMBERSHIP_ROLES = ["owner", "adult", "teen", "child", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export const ROLE_RANK: Record<MembershipRole, number> = { owner: 4, adult: 3, teen: 2, child: 1, viewer: 0 };

export const IMPORT_SOURCES = ["ofx", "csv", "receipt"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const INSIGHT_KINDS = ["spending_alert", "summary", "trend", "advice"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export const INSIGHT_SEVERITIES = ["info", "warning", "positive"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export const TRANSACTION_DIRECTIONS = ["in", "out"] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];
export const TRANSACTION_SOURCES = ["manual", "import", "receipt"] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];
```

- [ ] **Step 2: Write a guard test**

`src/domain/enums.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MEMBERSHIP_ROLES, ROLE_RANK, INSIGHT_KINDS, TRANSACTION_SOURCES } from "./enums.js";

describe("domain enums", () => {
  it("membership roles ranked owner→viewer", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["owner", "adult", "teen", "child", "viewer"]);
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.viewer);
  });
  it("carries insight + transaction enums", () => {
    expect(INSIGHT_KINDS).toContain("summary");
    expect(TRANSACTION_SOURCES).toContain("import");
  });
});
```

Run: `npm run test:unit -- src/domain/enums.test.ts` → PASS.

- [ ] **Step 3: Repoint the Drizzle table files to import from domain**

In each `*.table.ts` that currently DEFINES a const, delete the local definition and import from domain instead. Example — `src/infra/db/tables/households/membership.table.ts`: remove the `MEMBERSHIP_ROLES`/`MembershipRole`/`ROLE_RANK` definitions, add:
```ts
import { MEMBERSHIP_ROLES, ROLE_RANK, type MembershipRole } from "../../../../domain/enums.js";
```
and re-export what other table files import from it (e.g. `invitation.table.ts` imports `MEMBERSHIP_ROLES` from `membership.table.js`) — either repoint `invitation.table.ts` to import from domain directly, or re-export from the table file. Prefer repointing consumers directly to `@domain`. Do the same for: `account.table.ts` (ACCOUNT_KINDS), `category.table.ts` (CATEGORY_KINDS), `goal.table.ts` (GOAL_TYPES), `household.table.ts` (HOUSEHOLD_TYPES), `import-batch.table.ts` (IMPORT_SOURCES/IMPORT_STATUSES), `insight.table.ts` (INSIGHT_KINDS/INSIGHT_SEVERITIES), `transaction.table.ts` (TRANSACTION_DIRECTIONS/TRANSACTION_SOURCES). The table's `varchar(..., { enum: X })` keeps working with the imported array.
Keep the `$inferSelect`/`$inferInsert` Row/Insert type exports in the table files as-is (they're Drizzle-derived; Plan B replaces them).

- [ ] **Step 4: Repoint all app consumers**

Find every non-table importer of these consts/types and repoint it to `@/domain/enums` (relative `.../domain/enums.js`). Run this to enumerate them:
```bash
grep -rn "MEMBERSHIP_ROLES\|ROLE_RANK\|MembershipRole\|ACCOUNT_KINDS\|AccountKind\|CATEGORY_KINDS\|CategoryKind\|GOAL_TYPES\|GoalType\|HOUSEHOLD_TYPES\|HouseholdType\|IMPORT_SOURCES\|ImportSource\|IMPORT_STATUSES\|ImportStatus\|INSIGHT_KINDS\|InsightKind\|INSIGHT_SEVERITIES\|InsightSeverity\|TRANSACTION_DIRECTIONS\|TransactionDirection\|TRANSACTION_SOURCES\|TransactionSource" src --include=*.ts | grep -v "domain/enums" | grep -v "\.table\.ts"
```
For each hit whose import path points at a `*.table.js`, change the import to `.../domain/enums.js`. (Known consumers include the RBAC hook `src/http/hooks/household/household.ts` → `ROLE_RANK`, the deepseek gateway → `INSIGHT_KINDS`/`INSIGHT_SEVERITIES`, HTTP schemas using `z.enum(...)`, invitations/members code → `MEMBERSHIP_ROLES`. Repoint every one the grep surfaces.)

- [ ] **Step 5: Verify green**

Run: `npm run typecheck` → 0 errors.
Run: `npm run test:unit` → all pass.
Run: `npm run test:e2e` → all pass (Docker up; behavior unchanged — still Drizzle).

- [ ] **Step 6: Commit**

```bash
git add src/domain/enums.ts src/domain/enums.test.ts src/infra/db/tables src/
git commit -m "refactor(domain): centralize table enums/consts/types into src/domain/enums"
```

---

## Self-Review

**Spec coverage (Plan A scope only):**
- Prisma deps + schema.prisma (11 models, uuidv7 PK, enums, relations, indexes, timestamptz) → Task 1. ✅
- Prisma default naming, no `@map`, audit cols plain String → Task 1 schema. ✅
- Enum/const/type relocation to `src/domain/` → Task 2. ✅
- Plan A stays green (Drizzle still runtime) → both tasks end with typecheck+unit(+e2e) green; Prisma authored-but-dormant. ✅
- NOT in Plan A (correctly deferred to Plan B): client swap, repo rewrites, uuid-PK app ripple (HouseholdContext/hook/subscription), e2e boot swap, teardown, `prisma db push`/migrate against a DB, `postinstall generate`. ✅

**Placeholder scan:** Task 2 Steps 3–4 are grep-and-repoint instructions against files the plan can't fully enumerate — these are defined mechanical steps gated by typecheck, not placeholders. Full schema + full domain module code are inline.

**Type consistency:** Domain export names match the exact identifiers today's consumers import (`MEMBERSHIP_ROLES`, `ROLE_RANK`, `INSIGHT_KINDS`, etc.), so repointing is import-path-only. Prisma enum values mirror the TS const arrays 1:1 (checked against every table file).

## Handoff to Plan B (the big-bang cutover — separate plan)
Plan B: swap `src/infra/db/client.ts` to `PrismaClient` (`db`); rewrite all ~25 repos to Prisma + uuid; drop `HouseholdContext.id` → uuid-only (+ household hook, auth types, subscription data/service/members ripple); e2e boot → `prisma db push`; Drizzle→Prisma seed/migrate scripts + `postinstall generate`; delete all `*.table.ts`/`columns.ts`/`schema.ts`/drizzle migrations/`drizzle.config.ts`; remove `drizzle-orm`/`drizzle-kit`; final green + OpenAPI diff. Suite is red from the client swap until the final integration task (accepted big-bang tradeoff).
