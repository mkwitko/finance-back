# Subscription & Entitlements (v1) Design Spec

**Date:** 2026-07-13
**Projects:** finance-back + finance-app
**Status:** Approved for build (user delegated: "siga para subscription, back e front e push"). Design decisions below made autonomously; documented for course-correction.

## Context

The vision includes a subscription so users unlock more features. No subscription/payment code exists yet, and no payment SDK is installed. Following the project's import-first pragmatism (build the model, defer the hard external rail), v1 builds the **entitlement model + paywall UX with a stub activation** — real store IAP / RevenueCat / Stripe validation is deferred.

## Goals

- A **subscription state** per household (`free` | `premium`) with status + period.
- A **static entitlements map** (`PLAN_ENTITLEMENTS`) defining what each plan unlocks.
- Backend: `GET` current subscription + entitlements; stub `activate`/`cancel` (owner).
- Frontend: an **upgrade/paywall screen** (plan comparison → activate) and a reusable `useEntitlement(feature)` / `<PaywallGate>` to gate premium UI.

## Non-Goals (deferred)

- **Real payments** (App Store/Play IAP, RevenueCat, Stripe) — activation is a stub (`provider: "stub"`); real purchase validation is a later subsystem.
- **Hard backend enforcement** on existing features — v1 exposes entitlements and the FRONTEND gates (shows paywall). Server-side gating of specific endpoints is a documented per-feature follow-up (avoids breaking existing flows/e2e).
- Family/tiered plans beyond free/premium.

## Decisions (autonomous, v1)

- Subscription is scoped **per household** (the money space), consistent with multi-account.
- Two plans: `free` (default when no row) and `premium`.
- Entitlements (v1 set): `aiInsights`, `futureProjection`, `unlimitedContexts` (+ `maxContexts` number). free = all false / `maxContexts: 2`; premium = all true / `maxContexts: Infinity` (represented as a large number / null).
- `activate` sets `plan: premium`, `status: active`, `currentPeriodEnd: now + 30d`, `provider: "stub"`. `cancel` sets `status: canceled` and entitlements revert to free immediately (v1 simplification).
- Enforcement is frontend-first (paywall); GET is the source of truth.

## Data Model (finance-back)

### New table: `subscription`

Standard `entityColumns`. One active row per household (unique on householdId where not deleted).

```
subscription
  ...entityColumns("subscription")
  householdId     bigint FK → household.id (cascade)  NOT NULL
  plan            varchar(16, enum SUBSCRIPTION_PLANS)   NOT NULL   -- free | premium
  status          varchar(16, enum SUBSCRIPTION_STATUSES) NOT NULL  -- active | canceled | expired
  provider        varchar(16)  NOT NULL default 'stub'
  providerRef     varchar(255) NULL
  currentPeriodEnd timestamptz NULL
  uniqueIndex on (householdId) where deletedAt IS NULL
```

`SUBSCRIPTION_PLANS = ["free","premium"]`, `SUBSCRIPTION_STATUSES = ["active","canceled","expired"]`.

### Entitlements (static config, not a table)

`src/domain/entitlements.ts`:
```
type Entitlements = { aiInsights: boolean; futureProjection: boolean; unlimitedContexts: boolean; maxContexts: number };
PLAN_ENTITLEMENTS: Record<Plan, Entitlements>
entitlementsFor(plan, status): Entitlements  // canceled/expired → free entitlements
```

## Backend API (household-scoped, `x-household-id`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /households/:id/subscription` | `requireHouseholdRole('viewer')` | Return `{ plan, status, currentPeriodEnd, entitlements }`; if no row → `plan:"free", status:"active", entitlements: free`. |
| `POST /households/:id/subscription/activate` | `requireHouseholdRole('owner')` | Stub-activate premium (upsert row: plan premium, status active, provider stub, period +30d). Returns the subscription view. |
| `POST /households/:id/subscription/cancel` | `requireHouseholdRole('owner')` | status → canceled (entitlements revert to free). Returns the view. |

- Upsert on `householdId` (resurrect a soft-deleted/canceled row).
- Presenter exposes `uuid` as `id`.

## Frontend (finance-app)

- `useEntitlements()` — wraps `useGetSubscription(activeHouseholdId)`, returns `{ plan, entitlements, isPremium }` (defaults to free while loading / no data).
- `<PaywallGate feature>` — renders children if entitled; else a locked overlay/CTA routing to the upgrade screen. Also a `useEntitlement(feature): boolean` helper.
- **Upgrade screen** (`src/app/(tabs)/settings/plan.tsx` or a pushed route): plan comparison (free vs premium feature list from a static describe), a "Assinar Premium" `Button` → `useActivateSubscription().mutate({id})` (stub) → success state; "Cancelar" when premium.
- Example gating: wrap the insights feed's refresh / or show a paywall banner on a premium feature — v1 wires `PaywallGate` around ONE premium surface (the AI insights screen) as the reference usage, non-destructively (free users see a "recurso premium" CTA instead of the feed's generate).

## Testing

- **finance-back**: unit for `entitlementsFor` (premium→all true; canceled→free); e2e — default GET (no row → free), activate → premium entitlements, cancel → reverts.
- **finance-app**: RNTL for `useEntitlements`/`PaywallGate` (mock the hook), upgrade screen (activate → premium), insights paywall gate.
- Contract: export OpenAPI + regenerate hooks.

## Decomposition → Two Plans

1. **Plan A — Backend**: `subscription` table + migration, `entitlements.ts` + unit, repository, GET/activate/cancel routes, e2e, OpenAPI export.
2. **Plan B — Frontend**: regenerate hooks, `useEntitlements`/`PaywallGate`, upgrade screen, gate the insights surface, RNTL + headless export.

## Files (anticipated)

**Backend:** `src/infra/db/tables/subscriptions/subscription.table.ts` (+ migration, schema export); `src/domain/entitlements.ts` (+ test); `src/http/api/subscriptions/` (repository, schema, routes).

**Frontend:** regenerated hooks; `src/hooks/use-entitlements.ts`; `src/components/subscription/{paywall-gate,plan-comparison}.tsx`; `src/app/(tabs)/settings/plan.tsx`.

## Open Questions (non-blocking; defaulted)

- Real payment provider — deferred (stub). When added: replace `activate` with store-receipt validation.
- Whether entitlements are per-household or per-user — chose per-household (matches multi-account). A user in multiple households sees each household's own plan.
