# Ownership Transfer — Design Spec

**Date:** 2026-07-14
**Projects:** finance-back (new endpoint + service/repo), finance-app (members UI)
**Status:** Approved for build (brainstorm 2026-07-14).

## Context

The subscription v2 design promised: *"Owner leaves → offer ownership to a non-kid (`adult`) member; transfer re-points the Stripe customer email."* The backend has a `SubscriptionsService.transferOwner(ctx, newOwnerEmail)` method (Stripe customer email repoint + `SUB-T0007 OWNER_EMAIL_COLLISION` guard) but **it is orphaned — wired to no HTTP route** — and `updateMemberRole` does not call it. The frontend members screen (`finance-app/src/components/contexts/member-list.tsx`) has only per-row "Remover" (owner) and a "Sair do contexto" self-leave; there is **no role-change or ownership-transfer UI**. Consequently ownership cannot be transferred today, and promoting a member to owner (were the UI to exist) would leave Stripe billing pointing at the old owner.

The household/membership/RBAC model (roles `owner > adult > teen > child > viewer`, `requireHouseholdRole`, `x-household-id` header, soft-deleted memberships, atomic last-owner guard via `pg_advisory_xact_lock`) is described in the multi-account and subscription memories. Email is resolved backend-side from the users table (see `subscriptions.data.ts#ownerEmail`).

## Goals

- Let a household **owner** transfer ownership to an eligible member through the app.
- **Semantics (decided):** transfer = promote an **adult** member to `owner` **and** the caller exits the household. Both entry points below invoke the identical operation.
- Keep Stripe billing correct across the handover (repoint the customer email so the new owner resolves the subscription).
- Two entry points: an **explicit** "Transferir propriedade" action available anytime, and an **auto-offer** when the last owner tries to leave (otherwise the last-owner guard blocks the leave).

## Decisions (from brainstorm)

- **Trigger:** both — explicit action + on-leave offer. Both call one endpoint.
- **Old owner fate:** **leaves** the household (membership soft-deleted). Not demoted-and-stays.
- **Backend shape:** a **dedicated atomic endpoint**, not a reuse of `updateMemberRole`.
- **Eligible target:** role **`adult`** only (the sole non-kid, non-owner role fit to own). `teen`/`child`/`viewer` are ineligible.
- **General per-member role editing is out of scope** — this feature adds only ownership transfer.
- **i18n:** new user-facing strings are hardcoded pt-BR, consistent with the current app (a systemic i18n pass is a separate, subsequent feature).

## Architecture

### Backend — endpoint

`POST /households/:id/transfer-ownership`
- preHandler: `requireHouseholdRole("owner")` (only an owner may transfer).
- body: `{ newOwnerUserId: string (uuid) }`.
- response `200`: `{ ok: true }`.
- operationId `transferOwnership`, tags `["households"]`.
- New error `HH-T0006 TRANSFER_TARGET_INELIGIBLE` (target is not an active `adult` member of this household). Caller cannot target themselves (that is not a transfer) → also `TRANSFER_TARGET_INELIGIBLE`.

### Backend — service orchestration

Ordering is chosen for recoverability: the Stripe repoint runs **before** the DB mutation, and is idempotent, so if the DB step fails the caller is still owner and can safely retry.

1. **Resolve + validate target.** Load the target membership by `newOwnerUserId` in this household: must be active (`deletedAt = null`) and `role = "adult"`, and `newOwnerUserId !== caller`. Else throw `TRANSFER_TARGET_INELIGIBLE`. Resolve the target's email from the users table (a new `memberEmail(householdUuid, userUuid)` data helper alongside `ownerEmail`).
2. **Stripe repoint.** Call `subscriptions.service.transferOwner(ctx, targetEmail)`. This already: no-ops for a free household (no live sub); checks `OWNER_EMAIL_COLLISION` (target email already a *different* Stripe customer) → `SUB-T0007`; and `updateCustomerEmail`. Idempotent: on retry the customer email already equals the target email, so the collision check resolves to the same customer (no throw).
3. **DB role swap.** New `MembersRepository.transferOwnership({ householdId, newOwnerUserId, callerUserId, actorUuid })`: one `db.$transaction` holding `pg_advisory_xact_lock(hashtextextended(householdId, 0))` (same scheme as `insights.replaceAll` / the last-owner guard). Inside: re-verify the target is still an active `adult` (throw `TRANSFER_TARGET_INELIGIBLE` if not — guards against a concurrent role/membership change), set target `role = "owner"`, and soft-delete the caller's membership (`deletedAt = now`, `updatedBy = actorUuid`). No last-owner guard is needed because a new owner is created in the same transaction.
4. Return `{ ok: true }`.

The route handler builds the subscriptions service the same way the subscription routes do (via `app.gateways`), and the members service/repo the way the members routes do.

### Frontend — members UI

Files: `finance-app/src/components/contexts/member-list.tsx`, `finance-app/src/app/(tabs)/settings/members.tsx`, plus a small confirm/picker. New Kubb hook `useTransferOwnership` (regenerated from the exported OpenAPI).

- **Explicit transfer.** For each **adult** member row, when the caller is owner (`canManage`), show a **"Transferir propriedade"** action (in addition to "Remover"). Tapping it opens a confirm: *"Você deixará o contexto e {nome} será o dono. Continuar?"* On confirm → `useTransferOwnership.mutate({ id: householdId, data: { newOwnerUserId } })`.
- **On-leave offer.** "Sair do contexto": compute whether the caller is the **last owner** (owner count in the member list `=== 1` and caller's role is `owner`). If last owner → do **not** call remove; instead open a **picker of adult members**. Selecting one → transfer (same mutation). If there are **no adult members** → show a message: *"Promova ou convide um adulto antes de sair."* (leave stays blocked). If the caller is **not** the last owner → normal `removeMember(self)` as today.
- **Post-success** (the caller has left the household): clear `activeHouseholdId` in `household-store`, refetch households, and route to the context switcher (`settings/contexts`), so the app is not left pointed at a household the user no longer belongs to.
- Errors surface via `contextErrorMessage` (map `HH-T0006`, `SUB-T0007` to pt-BR), consistent with `member-list.tsx`'s existing error handling.

## Testing / parity oracle

**Backend (Vitest + Testcontainers, faked Stripe gateway):**
- Happy path: owner transfers to an adult → target becomes `owner`, caller's membership soft-deleted, fake Stripe customer email repointed.
- Target not an adult (`teen`/`viewer`/nonexistent/self) → `TRANSFER_TARGET_INELIGIBLE`.
- Stripe email collision → `SUB-T0007`, and DB is unchanged (Stripe step precedes the DB swap).
- Free household (no live sub) → transfer succeeds, no Stripe call needed.
- Non-owner caller → `requireHouseholdRole("owner")` rejects.
- OpenAPI re-export → new `transferOwnership` op present; existing contract otherwise unchanged.

**Frontend (jest-expo + RNTL 14):**
- Adult row shows "Transferir propriedade"; confirm → mutation fired with `newOwnerUserId`.
- Last-owner "Sair" → picker appears (not a direct remove); selecting an adult fires transfer.
- Last owner with no adults → message shown, no mutation.
- Non-last-owner "Sair" → normal remove (unchanged).
- Error path → `contextErrorMessage` text rendered.
- Route tests live under `src/__tests__/routes/` (never under `src/app/`).

## Decomposition → Plan

One plan, one branch (`master`), backend tasks then frontend:

1. Backend: `HH-T0006` error + `memberEmail` data helper + `MembersRepository.transferOwnership` (tx + advisory lock) with unit coverage.
2. Backend: route `POST /households/:id/transfer-ownership` + service orchestration (resolve/validate → `subs.transferOwner` → repo) + e2e; export OpenAPI → `../finance-app/api.json`.
3. Frontend: regen Kubb hooks; `member-list` explicit "Transferir propriedade" + confirm + post-success household switch; `contextErrorMessage` mappings; tests.
4. Frontend: last-owner "Sair" → adult picker (and no-adults message); tests.

## Non-Goals

- No general per-member role editing (only ownership transfer).
- No transfer to non-adult roles; no multi-owner households as a feature (a household still has exactly one owner after transfer).
- No i18n conversion (separate feature); strings are pt-BR.
- No change to the subscription read model, webhooks, or seat-sync design.

## Risks

- **Two-system consistency (DB + Stripe).** Mitigation: Stripe repoint first (idempotent) then DB swap; on DB failure the caller is still owner and retries safely. On the reverse (Stripe transient failure) nothing is committed.
- **Concurrent role/membership change to the target** between validation and swap. Mitigation: advisory lock + re-verify target inside the transaction.
- **Caller stranded on a household they left.** Mitigation: post-success clears active household and routes to the context switcher.
- **No eligible adult** for a last owner who wants to leave. Accepted: leave is blocked with a clear message; the owner must promote/invite an adult first (household deletion is out of scope).
