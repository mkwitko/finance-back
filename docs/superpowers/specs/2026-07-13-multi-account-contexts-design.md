# Multi-Account Contexts — Design Spec

**Date:** 2026-07-13
**Projects:** finance-back (Fastify 5, Drizzle, Zod 4) + finance-app (Expo, Kubb, TanStack Query)
**Status:** Approved for planning

## Context

The finance app lets everyday people run more than one "money space": personal
(PF), family, a couple's joint pot, a kid's allowance space (and, later,
business/PJ). The backend already models this partially:

- `household` (`type ∈ individual | family | shared | kids`) — a money space.
- `membership` (user↔household, `role ∈ owner > adult > teen > child > viewer`,
  unique per user+household).
- `account`, `transaction`, `category`, `goal` are all household-scoped and
  gated by the `requireHouseholdRole(minRole)` RBAC preHandler reading the
  `x-household-id` header.
- Endpoints today: `POST /households` (create, caller becomes owner),
  `GET /households` (list mine). Frontend has only a `household-store` (active
  context switch) — no UI to create, switch, invite, or manage members.

This subsystem fills those gaps so a user can **create and switch between
multiple contexts, invite people into a context, manage members and their
roles, and run a parent-managed kids space.**

## Goals

- Create/switch multiple contexts from the app (backend create/list already exist; add the UX).
- **Invitations** via a shareable code/link (owner-generated, role-scoped, expiring) that a logged-in user redeems to join. No email infrastructure.
- **Member management**: list members, change roles, remove, and self-leave — with a "≥1 owner always" guard.
- **Kids space**: a household of type `kids` the parent owns and manages; **the child has no login** in v1.

## Non-Goals (deferred)

- **Business/PJ context** (`type = business`) — deferred; note the extension point but do not build.
- **Child login / minor onboarding** — the `child`/`teen` roles remain in the model for a future login-based flow; v1 does not create child user accounts or memberships.
- **Email invitations** — code/link only.
- **Couple future-projection / investing education** — separate subsystems.

## Decisions (from brainstorming)

- Invitation = shareable **code/link**: owner (or adult) generates a code carrying a target role and an expiry; reusable until it expires or is revoked; a logged-in invitee redeems it to become a member. Each user can hold only one membership per household (existing unique index), so re-redeem is rejected.
- Kids space = a normal `kids` household owned by the parent. No child membership row, no child user. `child`/`teen` roles are untouched (reserved for future login-based kids).

## Data Model

### New table: `invitation`

Follows the standard `entityColumns` pattern (internal `id`, public `uuid`, `createdBy`/`updatedBy` audit, timestamps, soft-delete).

```
invitation
  ...entityColumns("invitation")
  householdId   bigint  FK → household.id (cascade)   NOT NULL
  code          varchar(12)  UNIQUE  NOT NULL   -- short, URL-safe, generated
  role          varchar(16, enum MEMBERSHIP_ROLES)  NOT NULL  -- role granted on redeem
  expiresAt     timestamptz  NOT NULL
  revokedAt     timestamptz  NULL
  index on (householdId)
```

- `createdBy` (from entityColumns) records the generating user's uuid.
- A code is "active" when `revokedAt IS NULL AND expiresAt > now() AND deletedAt IS NULL`.
- The redeemable target role is capped: an inviter cannot grant a role higher than their own (an `adult` cannot mint an `owner` invite).

### No changes to `household` or `membership` schema

- `household.type` keeps its four values. `business` is a future enum addition (one-line migration + paired UX) — out of scope now.
- `membership` unchanged. Kids v1 creates no child membership.

## Backend API (finance-back)

All routes return the standard presenter shape (public `uuid` exposed as `id`). Errors use the existing `ERRORS` catalog (add new codes as needed). Household-scoped routes use `requireHouseholdRole(minRole)` via `x-household-id`; the redeem route is authenticated-only (the caller is not yet a member).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /households/:id/invitations` | `requireHouseholdRole('adult')` | Create an invite `{ role, expiresInHours? }`. Rejects `role` above caller's role. Returns `{ id, code, role, expiresAt, url }`. |
| `GET /households/:id/invitations` | `requireHouseholdRole('adult')` | List active invitations for the household. |
| `DELETE /households/:id/invitations/:invId` | `requireHouseholdRole('owner')` | Revoke (sets `revokedAt`). |
| `POST /invitations/:code/redeem` | `requireUser` | Redeem: validates active + not already a member, creates membership with the invite's role, returns the joined `HouseholdView`. |
| `GET /households/:id/members` | `requireHouseholdRole('viewer')` | List members `{ userId(uuid), name, role, joinedAt }`. |
| `PATCH /households/:id/members/:userId` | `requireHouseholdRole('owner')` | Change a member's role. Blocked if it would leave zero owners. |
| `DELETE /households/:id/members/:userId` | owner, OR caller removing self | Remove a member / leave. Blocked if it would remove the last owner. |

**Invariants enforced server-side:**
- **≥1 owner**: `PATCH`/`DELETE` that would drop the household to zero owners → 409 (`HOUSEHOLD.LAST_OWNER`).
- **Role ceiling on invite**: granted `role` ≤ inviter's role → else 403.
- **Redeem validity**: expired/revoked/unknown code → 404/410; already a member → 409.

The `url` returned by create-invitation is a deep link (e.g. `financeapp://join/<code>`); the app also supports manual code entry.

**Code generation**: 8–12 char URL-safe random (crypto), collision-retry on the unique index.

## Frontend UX (finance-app)

Built entirely on the design-system components (`Sheet`, `ListRow`, `Card`, `Field`, `Segmented`, `Button`, `Badge`, `EmptyState`, `AmountText` where relevant). API hooks are Kubb-generated from the refreshed `api.json`; requests carry `x-household-id` from `household-store` (except redeem).

- **Context switcher** — a `Sheet` (Uber-style) listing the caller's contexts with type badge; tapping switches the active household in `household-store`. Footer actions: **"Criar contexto"** and **"Entrar com código"**.
- **Create context** — a form (`Field` name + `Segmented` type: Pessoal/Família/Casal/Criança). `kids` is just a type choice here.
- **Invitations** — within a context's settings: generate a code (pick role + expiry), show code + **native share sheet** for the link, list active invites, revoke.
- **Redeem** — "Entrar com código" → code `Field` → calls redeem → on success switches to the joined context.
- **Members** — list with role `Badge`; owner can change role (`Segmented`/sheet) or remove; every member sees **"Sair do contexto"** (self-leave).
- **Kids** — creating a `kids`-typed context is the normal create flow; no invitations shown for it.

## RBAC

Reuses `requireHouseholdRole(minRole)` and the existing `ROLE_RANK` ordering. New cross-cutting rule implemented in the members/invitations service layer: **a household always retains at least one `owner`** (guards last-owner demotion/removal). Invite role ceiling is enforced in the create-invitation handler using the caller's membership role.

## Testing

- **finance-back**: e2e (Testcontainers) covering invite → redeem → membership created; role-ceiling rejection; last-owner guard on demote and on remove/leave; expired/revoked/duplicate redeem. Unit tests for the code generator (uniqueness/charset) and the active-invite predicate.
- **finance-app**: RNTL for the switcher, create form, redeem form, and member list (API mocked); assert active-household switch on redeem success.
- **Contract**: after backend lands, `npx tsx scripts/export-openapi.ts ../finance-app/api.json` then `pnpm api:generate` in the app; the frontend plan consumes the generated hooks.

## Decomposition → Two Implementation Plans

One coherent design (this spec), **two sequential plans**:

1. **Plan A — Backend** (`finance-back`): `invitation` table + migration, invitation endpoints, member-management endpoints, RBAC invariants (last-owner, role ceiling), e2e + unit tests, OpenAPI export. Independently testable.
2. **Plan B — Frontend** (`finance-app`): regenerate API hooks, then build the context switcher, create-context, invitation generate/share/redeem, and member-management UX on the design system, with RNTL tests.

Plan A must land (and export the OpenAPI) before Plan B regenerates hooks.

## Files (anticipated)

**Backend:**
- `src/infra/db/tables/households/invitation.table.ts` (+ export in `schema.ts`)
- new Drizzle migration for `invitation`
- `src/http/api/invitations/` (routes, repository, schema, types) — redeem + household-scoped invite routes
- `src/http/api/households/members/` (or extend `households/`) — member list/patch/delete
- `src/shared/errors/catalog.ts` — new `HOUSEHOLD.LAST_OWNER`, `INVITATION.*` codes
- e2e + unit tests alongside

**Frontend:**
- regenerated `src/api/**` (Kubb)
- `src/components/contexts/` — `ContextSwitcher`, `CreateContextForm`, `RedeemCodeForm`, `MemberList`, `InviteManager`
- `src/app/(tabs)/settings/contexts/*` routes
- `src/stores/household-store.ts` — extend if needed (e.g. optimistic switch on redeem)

## Open Questions (resolve in plan, not blocking)

- Deep-link scheme registration for `financeapp://join/<code>` (Expo Linking config) — frontend plan.
- Exact invite expiry default (propose 7 days) and whether owner can set it — default 7d, owner-adjustable in the create form.
