# Multi-Account Contexts — Backend (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add invitation (shareable-code) and member-management endpoints to finance-back so users can invite people into a household and manage members/roles, with a ≥1-owner invariant and an invite role-ceiling.

**Architecture:** New `invitation` table (standard `entityColumns`). New `invitations` route module (household-scoped create/list/revoke + authenticated-only redeem) and member routes (list/patch/delete) extending the households area. All logic in repository factories + Zod schemas, matching the existing accounts/households modules exactly. RBAC via the existing `requireHouseholdRole`. Invariants (last-owner, role-ceiling) enforced in handlers/repo.

**Tech Stack:** Node 22, Fastify 5, fastify-type-provider-zod, Zod 4 (`zod/v4`), Drizzle (drizzle-kit migrations), Vitest (unit + e2e via Testcontainers).

## Global Constraints

- Zod imported from `"zod/v4"`. Routes use `app.withTypeProvider<ZodTypeProvider>()`, an `operationId` (camelCase, unique — Kubb uses it), `tags`, `summary`, and a `response` schema per status.
- Public identifiers are `uuid` exposed as `id`; internal `id` (bigint) is never returned. Presenters map `uuid → id`.
- Every table uses `entityColumns("<name>")` (internal id, public uuid, createdBy/updatedBy = actor `user.uuid`, timestamps, `deletedAt` soft-delete).
- Repositories are factory functions `create<X>Repository(db)` returning an interface; rows→domain via a `toDomain` mapper; queries filter `isNull(deletedAt)`.
- Household-scoped routes: `preHandler: requireHouseholdRole(minRole)`, then `requireHousehold(req)` yields `{ id, uuid, type, role }`. Redeem is NOT household-scoped (caller is not yet a member) — authenticated-only, resolve via `requireUser(req)`.
- Roles ordered `owner(4) > adult(3) > teen(2) > child(1) > viewer(0)` (`ROLE_RANK`).
- New errors: add to `src/shared/errors/catalog.ts` under existing groups with code format `SIGLA-TNNNN`, AND add the internal-message string key to all three bundles `src/shared/errors/i18n/{pt-BR,en-US,es-ND... es-ES}.json`.
- Migrations: edit table files, then `pnpm db:generate` (drizzle-kit) to emit SQL under `src/infra/db/migrations/`; apply in tests via the test app bootstrap.
- Tests: `pnpm test:unit` (no Docker) and `pnpm test:e2e` (Testcontainers). e2e uses `buildTestApp()` + `app.inject`; fake Google login via `POST /auth/google {idToken}` where idToken is a bare name ("alice","bob").
- Commit directly on `master` (consistent with the app-side work); stage only the files each task names.

---

### Task 1: `invitation` table + migration

**Files:**
- Create: `src/infra/db/tables/households/invitation.table.ts`
- Modify: `src/infra/db/schema.ts` (add export)
- Generate: migration under `src/infra/db/migrations/`
- Test: `src/infra/db/tables/households/invitation.table.test.ts`

**Interfaces:**
- Consumes: `entityColumns`, `household`, `MEMBERSHIP_ROLES`.
- Produces: `invitation` Drizzle table; types `InvitationRow`, `InvitationInsert`.

- [ ] **Step 1: Write the failing test**

```ts
// src/infra/db/tables/households/invitation.table.test.ts
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invitation } from "./invitation.table.js";

describe("invitation table", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(getTableColumns(invitation));
    for (const c of ["id", "uuid", "householdId", "code", "role", "expiresAt", "revokedAt", "createdBy", "createdAt", "deletedAt"]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- invitation.table`
Expected: FAIL — cannot find module `./invitation.table.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/infra/db/tables/households/invitation.table.ts
import { bigint, index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { entityColumns } from "../../columns.js";
import { household } from "./household.table.js";
import { MEMBERSHIP_ROLES } from "./membership.table.js";

// A shareable invite code that grants membership (with a fixed `role`) in a household
// when redeemed by a logged-in user. Active = revokedAt IS NULL AND expiresAt > now()
// AND deletedAt IS NULL. Reusable until it expires or is revoked; the membership
// unique index still prevents a user from joining the same household twice.
export const invitation = pgTable(
  "invitation",
  {
    ...entityColumns("invitation"),
    householdId: bigint("household_id", { mode: "number" })
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 12 }).notNull(),
    role: varchar("role", { length: 16, enum: MEMBERSHIP_ROLES }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_invitation_code").on(t.code),
    index("idx_invitation_household").on(t.householdId),
  ],
);

export type InvitationRow = typeof invitation.$inferSelect;
export type InvitationInsert = typeof invitation.$inferInsert;
```

Add to `src/infra/db/schema.ts`:

```ts
export { invitation } from "./tables/households/invitation.table.js";
```

- [ ] **Step 4: Run unit test + generate migration**

Run: `pnpm test:unit -- invitation.table`
Expected: PASS.

Run: `pnpm db:generate`
Expected: a new `NNNN_*.sql` migration appears under `src/infra/db/migrations/` creating the `invitation` table + indexes. Verify the SQL includes `code` unique index and the `household_id` FK.

- [ ] **Step 5: Commit**

```bash
git add src/infra/db/tables/households/invitation.table.ts src/infra/db/tables/households/invitation.table.test.ts src/infra/db/schema.ts src/infra/db/migrations/
git commit -m "feat(db): add invitation table + migration"
```

---

### Task 2: Error codes + i18n

**Files:**
- Modify: `src/shared/errors/catalog.ts`
- Modify: `src/shared/errors/i18n/pt-BR.json`, `en-US.json`, `es-ES.json`
- Test: `src/shared/errors/invitation-errors.test.ts`

**Interfaces:**
- Produces: `ERRORS.HOUSEHOLD.LAST_OWNER` (409), `ERRORS.INVITATION.NOT_FOUND` (404), `ERRORS.INVITATION.EXPIRED` (410), `ERRORS.INVITATION.ALREADY_MEMBER` (409), `ERRORS.INVITATION.ROLE_TOO_HIGH` (403).

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/errors/invitation-errors.test.ts
import { describe, expect, it } from "vitest";
import { ERRORS } from "./catalog.js";

describe("invitation/member errors", () => {
  it("expose the new codes with correct status", () => {
    expect(ERRORS.HOUSEHOLD.LAST_OWNER().statusCode).toBe(409);
    expect(ERRORS.INVITATION.NOT_FOUND().statusCode).toBe(404);
    expect(ERRORS.INVITATION.EXPIRED().statusCode).toBe(410);
    expect(ERRORS.INVITATION.ALREADY_MEMBER().statusCode).toBe(409);
    expect(ERRORS.INVITATION.ROLE_TOO_HIGH().statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- invitation-errors`
Expected: FAIL — `ERRORS.HOUSEHOLD.LAST_OWNER` / `ERRORS.INVITATION` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/errors/catalog.ts`, add to the `HOUSEHOLD` group:

```ts
    LAST_OWNER: make("HH-T0005", 409, "household_last_owner"),
```

And add a new group after `HOUSEHOLD`:

```ts
  INVITATION: {
    NOT_FOUND: make("INV-T0001", 404, "invitation_not_found"),
    EXPIRED: make("INV-T0002", 410, "invitation_expired"),
    ALREADY_MEMBER: make("INV-T0003", 409, "invitation_already_member"),
    ROLE_TOO_HIGH: make("INV-T0004", 403, "invitation_role_too_high"),
  },
```

In each of the three i18n bundles, add the message strings (translate appropriately). Example `pt-BR.json` entries:

```json
"household_last_owner": "O contexto precisa de pelo menos um dono.",
"invitation_not_found": "Convite inválido.",
"invitation_expired": "Este convite expirou ou foi revogado.",
"invitation_already_member": "Você já faz parte deste contexto.",
"invitation_role_too_high": "Você não pode conceder um papel acima do seu."
```

`en-US.json`:

```json
"household_last_owner": "A context must keep at least one owner.",
"invitation_not_found": "Invalid invitation.",
"invitation_expired": "This invitation has expired or was revoked.",
"invitation_already_member": "You are already a member of this context.",
"invitation_role_too_high": "You cannot grant a role higher than your own."
```

`es-ES.json`:

```json
"household_last_owner": "El contexto debe mantener al menos un propietario.",
"invitation_not_found": "Invitación no válida.",
"invitation_expired": "Esta invitación ha caducado o fue revocada.",
"invitation_already_member": "Ya eres miembro de este contexto.",
"invitation_role_too_high": "No puedes otorgar un rol superior al tuyo."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- invitation-errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/errors/catalog.ts src/shared/errors/i18n/ src/shared/errors/invitation-errors.test.ts
git commit -m "feat(errors): add invitation + last-owner error codes"
```

---

### Task 3: Invite code generator

**Files:**
- Create: `src/http/api/invitations/code.ts`
- Test: `src/http/api/invitations/code.test.ts`

**Interfaces:**
- Produces: `generateInviteCode(): string` — 10-char URL-safe (`A-Za-z0-9`, no ambiguous `0/O/1/l/I`) code from `crypto.randomInt`.

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/invitations/code.test.ts
import { describe, expect, it } from "vitest";
import { generateInviteCode } from "./code.js";

describe("generateInviteCode", () => {
  it("produces a 10-char code from the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateInviteCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{10}$/);
    }
  });

  it("is effectively unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBeGreaterThan(995);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- invitations/code`
Expected: FAIL — cannot find module `./code.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/api/invitations/code.ts
import { randomInt } from "node:crypto";

// URL-safe, no visually ambiguous chars (0/O/1/l/I). 10 chars → ~57 bits entropy.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generateInviteCode(): string {
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- invitations/code`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/api/invitations/code.ts src/http/api/invitations/code.test.ts
git commit -m "feat(invitations): add invite code generator"
```

---

### Task 4: Members repository (list/count-owners/find/update-role/remove)

**Files:**
- Create: `src/http/api/households/members.repository.ts`
- Test: `src/http/api/households/members.repository.test.ts` (unit-level type/shape) — behavioral coverage is in the e2e task; here assert the factory returns the interface.

**Interfaces:**
- Consumes: `Db`, `membership`, `user`, `MembershipRole`.
- Produces: `createMembersRepository(db)` with:
  - `listMembers(householdId: number): Promise<Member[]>` where `Member = { userId: string /*uuid*/, name: string, role: MembershipRole, joinedAt: string }`
  - `countOwners(householdId: number): Promise<number>`
  - `findMember(householdId: number, userUuid: string): Promise<{ membershipId: number; userId: number; role: MembershipRole } | null>`
  - `updateRole(args: { householdId: number; userId: number; role: MembershipRole; actorUuid: string }): Promise<void>`
  - `removeMember(args: { householdId: number; userId: number; actorUuid: string }): Promise<void>` (soft-delete: set `deletedAt` + `updatedBy`)

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/households/members.repository.test.ts
import { describe, expect, it, vi } from "vitest";
import { createMembersRepository } from "./members.repository.js";

describe("createMembersRepository", () => {
  it("exposes the member-management interface", () => {
    const repo = createMembersRepository({} as never);
    expect(typeof repo.listMembers).toBe("function");
    expect(typeof repo.countOwners).toBe("function");
    expect(typeof repo.findMember).toBe("function");
    expect(typeof repo.updateRole).toBe("function");
    expect(typeof repo.removeMember).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- members.repository`
Expected: FAIL — cannot find module `./members.repository.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/api/households/members.repository.ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { membership } from "../../../infra/db/tables/households/membership.table.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { user } from "../../../infra/db/tables/users/user.table.js";

export type Member = {
  userId: string; // public uuid
  name: string;
  role: MembershipRole;
  joinedAt: string;
};

export interface MembersRepository {
  listMembers(householdId: number): Promise<Member[]>;
  countOwners(householdId: number): Promise<number>;
  findMember(
    householdId: number,
    userUuid: string,
  ): Promise<{ membershipId: number; userId: number; role: MembershipRole } | null>;
  updateRole(args: {
    householdId: number;
    userId: number;
    role: MembershipRole;
    actorUuid: string;
  }): Promise<void>;
  removeMember(args: { householdId: number; userId: number; actorUuid: string }): Promise<void>;
}

export function createMembersRepository(db: Db): MembersRepository {
  return {
    async listMembers(householdId) {
      const rows = await db
        .select({
          userId: user.uuid,
          name: user.name,
          role: membership.role,
          joinedAt: membership.createdAt,
        })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(and(eq(membership.householdId, householdId), isNull(membership.deletedAt)));
      return rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
      }));
    },

    async countOwners(householdId) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(membership)
        .where(
          and(
            eq(membership.householdId, householdId),
            eq(membership.role, "owner"),
            isNull(membership.deletedAt),
          ),
        );
      return rows[0]?.n ?? 0;
    },

    async findMember(householdId, userUuid) {
      const rows = await db
        .select({ membershipId: membership.id, userId: membership.userId, role: membership.role })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(
          and(
            eq(membership.householdId, householdId),
            eq(user.uuid, userUuid),
            isNull(membership.deletedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateRole({ householdId, userId, role, actorUuid }) {
      await db
        .update(membership)
        .set({ role, updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(membership.householdId, householdId), eq(membership.userId, userId)));
    },

    async removeMember({ householdId, userId, actorUuid }) {
      await db
        .update(membership)
        .set({ deletedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(membership.householdId, householdId), eq(membership.userId, userId)));
    },
  };
}
```

(Confirmed: `user.table.ts` has a `name` varchar column, and `usersRepository.findByUuid(uuid)` returns a `User` with numeric `.id` — both used above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- members.repository`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/api/households/members.repository.ts src/http/api/households/members.repository.test.ts
git commit -m "feat(households): add members repository"
```

---

### Task 5: Invitations repository

**Files:**
- Create: `src/http/api/invitations/invitations.repository.ts`
- Test: `src/http/api/invitations/invitations.repository.test.ts` (factory shape)

**Interfaces:**
- Consumes: `Db`, `invitation`, `household`, `generateInviteCode`.
- Produces: `createInvitationsRepository(db)` with:
  - `create(args: { householdId: number; role: MembershipRole; expiresAt: Date; actorUuid: string }): Promise<Invitation>` — retries on unique-code collision (max 5).
  - `listActive(householdId: number): Promise<Invitation[]>` — `revokedAt IS NULL AND expiresAt > now() AND deletedAt IS NULL`.
  - `findActiveByCode(code: string): Promise<(Invitation & { householdId: number; householdUuid: string }) | null>`.
  - `revoke(args: { householdId: number; invitationUuid: string; actorUuid: string }): Promise<boolean>` — sets `revokedAt`; returns false if not found in that household.
  - `Invitation = { id: string /*uuid*/, code: string, role: MembershipRole, expiresAt: string, createdAt: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/http/api/invitations/invitations.repository.test.ts
import { describe, expect, it } from "vitest";
import { createInvitationsRepository } from "./invitations.repository.js";

describe("createInvitationsRepository", () => {
  it("exposes the invitations interface", () => {
    const repo = createInvitationsRepository({} as never);
    expect(typeof repo.create).toBe("function");
    expect(typeof repo.listActive).toBe("function");
    expect(typeof repo.findActiveByCode).toBe("function");
    expect(typeof repo.revoke).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- invitations.repository`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/api/invitations/invitations.repository.ts
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../infra/db/client.js";
import { household } from "../../../infra/db/tables/households/household.table.js";
import {
  type InvitationRow,
  invitation,
} from "../../../infra/db/tables/households/invitation.table.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { generateInviteCode } from "./code.js";

export type Invitation = {
  id: string;
  code: string;
  role: MembershipRole;
  expiresAt: string;
  createdAt: string;
};

function toDomain(row: InvitationRow): Invitation {
  return {
    id: row.uuid,
    code: row.code,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface InvitationsRepository {
  create(args: {
    householdId: number;
    role: MembershipRole;
    expiresAt: Date;
    actorUuid: string;
  }): Promise<Invitation>;
  listActive(householdId: number): Promise<Invitation[]>;
  findActiveByCode(
    code: string,
  ): Promise<(Invitation & { householdDbId: number; householdUuid: string }) | null>;
  revoke(args: {
    householdId: number;
    invitationUuid: string;
    actorUuid: string;
  }): Promise<boolean>;
}

export function createInvitationsRepository(db: Db): InvitationsRepository {
  return {
    async create({ householdId, role, expiresAt, actorUuid }) {
      const now = new Date();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const inserted = await db
            .insert(invitation)
            .values({
              householdId,
              code: generateInviteCode(),
              role,
              expiresAt,
              createdBy: actorUuid,
              updatedBy: actorUuid,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return toDomain(inserted[0] as InvitationRow);
        } catch (err) {
          // Unique-code collision → retry with a fresh code.
          if (attempt === 4) throw err;
        }
      }
      throw new Error("unreachable");
    },

    async listActive(householdId) {
      const rows = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.householdId, householdId),
            isNull(invitation.revokedAt),
            isNull(invitation.deletedAt),
            gt(invitation.expiresAt, new Date()),
          ),
        );
      return rows.map(toDomain);
    },

    async findActiveByCode(code) {
      const rows = await db
        .select({ inv: invitation, householdUuid: household.uuid })
        .from(invitation)
        .innerJoin(household, eq(household.id, invitation.householdId))
        .where(
          and(
            eq(invitation.code, code),
            isNull(invitation.revokedAt),
            isNull(invitation.deletedAt),
            gt(invitation.expiresAt, new Date()),
          ),
        )
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return { ...toDomain(r.inv), householdDbId: r.inv.householdId, householdUuid: r.householdUuid };
    },

    async revoke({ householdId, invitationUuid, actorUuid }) {
      const res = await db
        .update(invitation)
        .set({ revokedAt: new Date(), updatedBy: actorUuid, updatedAt: new Date() })
        .where(and(eq(invitation.householdId, householdId), eq(invitation.uuid, invitationUuid)))
        .returning({ id: invitation.id });
      return res.length > 0;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- invitations.repository`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/api/invitations/invitations.repository.ts src/http/api/invitations/invitations.repository.test.ts
git commit -m "feat(invitations): add invitations repository"
```

---

### Task 6: Invitation routes (create / list / revoke / redeem)

**Files:**
- Create: `src/http/api/invitations/invitations.schema.ts`
- Create: `src/http/api/invitations/index.ts`
- Modify: `src/http/index.ts` (register `invitationsRoutes`)
- Test: covered by the e2e task (Task 8).

**Interfaces:**
- Consumes: `requireHouseholdRole`, `requireHousehold`, `requireUser`, `createInvitationsRepository`, `createHouseholdsRepository` (for `addMember`), `createUsersRepository` (`findByUuid`), `createMembersRepository` (`findMember` to detect existing membership), `ROLE_RANK`, `ERRORS`.
- Produces: routes `createInvitation`, `listInvitations`, `revokeInvitation`, `redeemInvitation`.

- [ ] **Step 1: Write the schema**

```ts
// src/http/api/invitations/invitations.schema.ts
import { z } from "zod/v4";
import { MEMBERSHIP_ROLES } from "../../../infra/db/tables/households/membership.table.js";
import { HouseholdView } from "../households/households.schema.js";

export const CreateInvitationBody = z.object({
  role: z.enum(MEMBERSHIP_ROLES),
  expiresInHours: z.number().int().min(1).max(720).default(168), // 7 days
});
export type CreateInvitationBody = z.infer<typeof CreateInvitationBody>;

export const InvitationView = z.object({
  id: z.uuid(),
  code: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  expiresAt: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type InvitationView = z.infer<typeof InvitationView>;

export const ListInvitationsResponse = z.object({ invitations: z.array(InvitationView) });
export const RedeemResponse = HouseholdView;
```

If `HouseholdView` is not exported from `households.schema.ts`, export it there (it already backs the households routes).

- [ ] **Step 2: Write the routes**

```ts
// src/http/api/invitations/index.ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createHouseholdsRepository } from "../households/households.repository.js";
import { createMembersRepository } from "../households/members.repository.js";
import { createUsersRepository } from "../users/users.repository.js";
import type { Invitation } from "./invitations.repository.js";
import { createInvitationsRepository } from "./invitations.repository.js";
import {
  CreateInvitationBody,
  InvitationView,
  type InvitationView as InvitationViewT,
  ListInvitationsResponse,
  RedeemResponse,
} from "./invitations.schema.js";

const ROLE_RANK: Record<MembershipRole, number> = { owner: 4, adult: 3, teen: 2, child: 1, viewer: 0 };

function present(inv: Invitation, baseUrl: string): InvitationViewT {
  return { ...inv, url: `${baseUrl}${inv.code}` };
}

export const invitationsRoutes: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);
  const households = createHouseholdsRepository(db);
  const members = createMembersRepository(db);
  const users = createUsersRepository(db);
  const JOIN_LINK = "financeapp://join/";

  app.withTypeProvider<ZodTypeProvider>().post(
    "/households/:id/invitations",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "createInvitation",
        tags: ["invitations"],
        summary: "Create a shareable invite code for the active household",
        body: CreateInvitationBody,
        response: { 201: InvitationView },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      // Role ceiling: cannot grant a role above the caller's own.
      if (ROLE_RANK[req.body.role] > ROLE_RANK[hh.role]) throw ERRORS.INVITATION.ROLE_TOO_HIGH();
      const expiresAt = new Date(Date.now() + req.body.expiresInHours * 3600_000);
      const created = await invites.create({
        householdId: hh.id,
        role: req.body.role,
        expiresAt,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(present(created, JOIN_LINK));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households/:id/invitations",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "listInvitations",
        tags: ["invitations"],
        summary: "List active invitations for the active household",
        response: { 200: ListInvitationsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const list = await invites.listActive(hh.id);
      return reply.code(200).send({ invitations: list.map((i) => present(i, JOIN_LINK)) });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    "/households/:id/invitations/:invId",
    {
      preHandler: requireHouseholdRole("owner"),
      schema: {
        operationId: "revokeInvitation",
        tags: ["invitations"],
        summary: "Revoke an invitation",
        params: z.object({ id: z.string(), invId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const ok = await invites.revoke({
        householdId: hh.id,
        invitationUuid: (req.params as { invId: string }).invId,
        actorUuid: requireUser(req).sub,
      });
      if (!ok) throw ERRORS.INVITATION.NOT_FOUND();
      return reply.code(204).send();
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/invitations/:code/redeem",
    {
      // NOT household-scoped: caller is not yet a member. Authenticated-only.
      schema: {
        operationId: "redeemInvitation",
        tags: ["invitations"],
        summary: "Redeem an invite code to join a household",
        params: z.object({ code: z.string() }),
        response: { 200: RedeemResponse },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      const code = (req.params as { code: string }).code;
      const invite = await invites.findActiveByCode(code);
      if (!invite) throw ERRORS.INVITATION.EXPIRED();
      const user = await users.findByUuid(auth.sub);
      if (!user) throw ERRORS.AUTH.USER_NOT_FOUND();
      const existing = await members.findMember(invite.householdDbId, auth.sub);
      if (existing) throw ERRORS.INVITATION.ALREADY_MEMBER();
      await households.addMember({
        householdId: invite.householdDbId,
        userId: user.id,
        role: invite.role,
        actorUuid: auth.sub,
      });
      const joined = await households
        .listForUser(auth.sub)
        .then((hs) => hs.find((h) => h.uuid === invite.householdUuid));
      if (!joined) throw ERRORS.HOUSEHOLD.NOT_FOUND();
      return reply.code(200).send({
        id: joined.uuid,
        name: joined.name,
        type: joined.type,
        ...(joined.role ? { role: joined.role } : {}),
        createdAt: joined.createdAt,
        updatedAt: joined.updatedAt,
      });
    },
  );
};
```

Register in `src/http/index.ts`: import `invitationsRoutes` and `await app.register(invitationsRoutes);` after `householdsRoutes`.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. Fix any type mismatches (e.g. presenter fields).

- [ ] **Step 4: Commit**

```bash
git add src/http/api/invitations/index.ts src/http/api/invitations/invitations.schema.ts src/http/index.ts src/http/api/households/households.schema.ts
git commit -m "feat(invitations): create/list/revoke/redeem routes"
```

---

### Task 7: Member routes (list / patch role / remove-leave)

**Files:**
- Create: `src/http/api/households/members.schema.ts`
- Create: `src/http/api/households/members.routes.ts`
- Modify: `src/http/index.ts` (register `membersRoutes`)
- Test: covered by e2e (Task 8).

**Interfaces:**
- Consumes: `requireHouseholdRole`, `requireHousehold`, `requireUser`, `createMembersRepository`, `ROLE_RANK`, `ERRORS`.
- Produces: routes `listMembers`, `updateMemberRole`, `removeMember`.

- [ ] **Step 1: Write the schema**

```ts
// src/http/api/households/members.schema.ts
import { z } from "zod/v4";
import { MEMBERSHIP_ROLES } from "../../../infra/db/tables/households/membership.table.js";

export const MemberView = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  joinedAt: z.string(),
});
export const ListMembersResponse = z.object({ members: z.array(MemberView) });
export const UpdateMemberRoleBody = z.object({ role: z.enum(MEMBERSHIP_ROLES) });
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;
```

- [ ] **Step 2: Write the routes**

```ts
// src/http/api/households/members.routes.ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createMembersRepository } from "./members.repository.js";
import { ListMembersResponse, MemberView, UpdateMemberRoleBody } from "./members.schema.js";

export const membersRoutes: FastifyPluginAsync = async (app) => {
  const members = createMembersRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households/:id/members",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "listMembers",
        tags: ["members"],
        summary: "List members of the active household",
        response: { 200: ListMembersResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const list = await members.listMembers(hh.id);
      return reply.code(200).send({ members: list });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().patch(
    "/households/:id/members/:userId",
    {
      preHandler: requireHouseholdRole("owner"),
      schema: {
        operationId: "updateMemberRole",
        tags: ["members"],
        summary: "Change a member's role",
        params: z.object({ id: z.string(), userId: z.uuid() }),
        body: UpdateMemberRoleBody,
        response: { 200: MemberView },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const targetUuid = (req.params as { userId: string }).userId;
      const target = await members.findMember(hh.id, targetUuid);
      if (!target) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      // Last-owner guard: demoting the only owner is forbidden.
      if (target.role === "owner" && req.body.role !== "owner") {
        const owners = await members.countOwners(hh.id);
        if (owners <= 1) throw ERRORS.HOUSEHOLD.LAST_OWNER();
      }
      await members.updateRole({
        householdId: hh.id,
        userId: target.userId,
        role: req.body.role,
        actorUuid: requireUser(req).sub,
      });
      const refreshed = await members.listMembers(hh.id);
      const view = refreshed.find((m) => m.userId === targetUuid);
      if (!view) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      return reply.code(200).send(view);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    "/households/:id/members/:userId",
    {
      // Owner can remove anyone; a non-owner may remove ONLY themselves (leave).
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "removeMember",
        tags: ["members"],
        summary: "Remove a member (owner) or leave the household (self)",
        params: z.object({ id: z.string(), userId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const auth = requireUser(req);
      const targetUuid = (req.params as { userId: string }).userId;
      const isSelf = targetUuid === auth.sub;
      if (!isSelf && hh.role !== "owner") throw ERRORS.HOUSEHOLD.INSUFFICIENT_ROLE();
      const target = await members.findMember(hh.id, targetUuid);
      if (!target) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      // Last-owner guard: the only owner cannot be removed / leave.
      if (target.role === "owner") {
        const owners = await members.countOwners(hh.id);
        if (owners <= 1) throw ERRORS.HOUSEHOLD.LAST_OWNER();
      }
      await members.removeMember({ householdId: hh.id, userId: target.userId, actorUuid: auth.sub });
      return reply.code(204).send();
    },
  );
};
```

Register in `src/http/index.ts`: `await app.register(membersRoutes);` after `householdsRoutes`.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/http/api/households/members.routes.ts src/http/api/households/members.schema.ts src/http/index.ts
git commit -m "feat(members): list/patch-role/remove routes with last-owner guard"
```

---

### Task 8: End-to-end tests

**Files:**
- Create: `test/e2e/multi-account.e2e.test.ts`

**Interfaces:**
- Consumes: `buildTestApp`, `app.inject`, fake Google login.

- [ ] **Step 1: Write the e2e test**

```ts
// test/e2e/multi-account.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("multi-account: invitations + members e2e (db)", () => {
  let h: TestApp;
  async function login(idToken: string) {
    const res = await h.app.inject({ method: "POST", url: "/auth/google", payload: { idToken } });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  }
  beforeAll(async () => { h = await buildTestApp(); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("owner invites, invitee redeems and becomes a member", async () => {
    const owner = { authorization: `Bearer ${await login("alice")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Casa", type: "shared" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };

    const inv = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: ownerHh, payload: { role: "adult" } });
    expect(inv.statusCode).toBe(201);
    const { code } = inv.json();
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);

    const bob = { authorization: `Bearer ${await login("bob")}` };
    const redeem = await h.app.inject({ method: "POST", url: `/invitations/${code}/redeem`, headers: bob });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().id).toBe(householdId);

    // Bob now sees the household and can list members (2).
    const membersRes = await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: { ...bob, "x-household-id": householdId } });
    expect(membersRes.statusCode).toBe(200);
    expect(membersRes.json().members).toHaveLength(2);

    // Re-redeem is rejected (already a member).
    const again = await h.app.inject({ method: "POST", url: `/invitations/${code}/redeem`, headers: bob });
    expect(again.statusCode).toBe(409);
  });

  it("rejects an invite role above the inviter's role", async () => {
    const owner = { authorization: `Bearer ${await login("carol")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Fam", type: "family" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };
    // Owner invites an adult; adult tries to mint an owner invite → 403.
    const inv = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: ownerHh, payload: { role: "adult" } });
    const dave = { authorization: `Bearer ${await login("dave")}` };
    await h.app.inject({ method: "POST", url: `/invitations/${inv.json().code}/redeem`, headers: dave });
    const daveHh = { ...dave, "x-household-id": householdId };
    const bad = await h.app.inject({ method: "POST", url: `/households/${householdId}/invitations`, headers: daveHh, payload: { role: "owner" } });
    expect(bad.statusCode).toBe(403);
  });

  it("blocks demoting or removing the last owner", async () => {
    const owner = { authorization: `Bearer ${await login("erin")}` };
    const hh = await h.app.inject({ method: "POST", url: "/households", headers: owner, payload: { name: "Solo", type: "individual" } });
    const householdId = hh.json().id as string;
    const ownerHh = { ...owner, "x-household-id": householdId };
    // Resolve own userId (uuid) via members list.
    const me = (await h.app.inject({ method: "GET", url: `/households/${householdId}/members`, headers: ownerHh })).json().members[0];
    const demote = await h.app.inject({ method: "PATCH", url: `/households/${householdId}/members/${me.userId}`, headers: ownerHh, payload: { role: "adult" } });
    expect(demote.statusCode).toBe(409);
    const leave = await h.app.inject({ method: "DELETE", url: `/households/${householdId}/members/${me.userId}`, headers: ownerHh });
    expect(leave.statusCode).toBe(409);
  });

  it("rejects an expired/unknown code", async () => {
    const bob = { authorization: `Bearer ${await login("frank")}` };
    const res = await h.app.inject({ method: "POST", url: `/invitations/ZZZZZZZZZZ/redeem`, headers: bob });
    expect(res.statusCode).toBe(410);
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e -- multi-account`
Expected: all 4 tests PASS. If the last-owner test fails because the members-list ordering puts a different member first, adjust to find the owner by `role === "owner"`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/multi-account.e2e.test.ts
git commit -m "test(e2e): multi-account invitations + members flows"
```

---

### Task 9: Export OpenAPI for the frontend

**Files:**
- Modify: `../finance-app/api.json` (generated artifact)

**Interfaces:**
- Consumes: the new routes' `operationId`s.

- [ ] **Step 1: Run the full suite as a gate**

Run: `pnpm test:run`
Expected: all unit + e2e tests pass.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Export the OpenAPI document**

Run: `npx tsx scripts/export-openapi.ts ../finance-app/api.json`
Expected: `../finance-app/api.json` updated; grep confirms the new operationIds are present:

Run: `grep -o '"operationId":"[a-zA-Z]*"' ../finance-app/api.json | sort -u | grep -E 'Invitation|Member'`
Expected: `createInvitation`, `listInvitations`, `revokeInvitation`, `redeemInvitation`, `listMembers`, `updateMemberRole`, `removeMember`.

- [ ] **Step 3: Commit**

```bash
cd ../finance-app && git add api.json && git commit -m "chore(api): regenerate OpenAPI with invitation + member endpoints"
```

(Then the frontend plan — Plan B — regenerates Kubb hooks from this `api.json`.)

---

## Self-Review

**Spec coverage:**
- Invitation table (code, role, expiry, revoke) → Task 1. ✓
- Invitation create/list/revoke/redeem endpoints → Task 6. ✓
- Member list/patch/remove-leave endpoints → Task 7. ✓
- Role ceiling on invite → Task 6 (handler), tested Task 8. ✓
- ≥1-owner guard on demote + remove/leave → Task 7, tested Task 8. ✓
- Redeem validity (expired/revoked/dup) → Task 6 + Task 8. ✓
- New error codes + i18n → Task 2. ✓
- Code generator → Task 3. ✓
- OpenAPI export for Plan B → Task 9. ✓
- Kids space: no backend change needed (a `kids` household is created via existing `POST /households`); confirmed no task required. ✓

**Placeholder scan:** No placeholders. Task 6 uses the file-level `z` import throughout.

**Type consistency:** `Member.userId` is a uuid string across repo (Task 4), routes (Task 7), and schema. `Invitation.id` is uuid; `findActiveByCode` returns extra `householdDbId`/`householdUuid` used by redeem (Task 6). `ROLE_RANK` is duplicated in the invitations route (matches the hook's ranking) — acceptable for a small constant; a reviewer may prefer exporting it from the household hook module, which is a fine optional cleanup.

**Confirmed against source:** `user.name` column exists; `usersRepository.findByUuid` returns `.id`; `households.addMember` (onConflictDoNothing) and `listForUser` exist as used by the redeem route.
