# Subscription v2 — Stripe-backed, DB-less (design spec)

**Date:** 2026-07-13
**Projects:** finance-back + finance-app
**Status:** Approved for build (design dialogue 2026-07-13). Supersedes `2026-07-13-subscription-design.md` (the stub/DB v1).

## Context

v1 (shipped) stored plan/status/period in a `subscription` table with a stub activation. This v2 replaces the stub with **real Stripe billing** and makes **Stripe the single source of truth**: our DB stores **no plan/subscription data at all**. Premium is scoped **per household** with **seat-based pricing** (price scales with member count). Payment is collected in-app via the **native Stripe PaymentSheet**; subscription management (switch interval, cancel) is a **custom in-app portal** screen.

## Goals

- Real recurring billing via Stripe (monthly + annual premium), **seat-based** (quantity = household member count).
- **Zero subscription data persisted** in our DB. Everything read live from Stripe per request.
- In-app subscribe (PaymentSheet) and in-app manage (switch interval, cancel-at-period-end).
- Entitlements unchanged in shape (`aiInsights`, `futureProjection`, `unlimitedContexts`, `maxContexts`) — now derived from the live Stripe subscription.

## Non-Goals (deferred)

- **Stripe webhooks** — not needed for correctness because entitlements are read live from Stripe (read-time = truth). Documented follow-up if we later want push-based reconciliation or dunning emails.
- **Caching** — pure read-time (~2 Stripe calls per subscription load). A short TTL cache is a documented follow-up if latency/rate-limits bite.
- **Hosted Stripe Billing Portal / Checkout** — using native PaymentSheet + a custom manage screen instead.
- **Proration UX customization** — rely on Stripe's default proration on interval switch / quantity change.
- **Multiple tiers** — only `free` / `premium`.

## Key Decisions

1. **Source of truth = Stripe. DB stores nothing about subscriptions.** The `subscription` table, its repository, and the `activate`/`cancel` routes from v1 are **removed** (drop migration). `entitlements.ts` and the `SubscriptionView` schema are **kept** (re-derived from Stripe).
2. **Join key lives in Stripe, not our DB:** each Stripe subscription carries `metadata.householdId`. This is how we map a Stripe customer's subscription back to a household without persisting anything.
3. **Customer identity = household owner's email.** No `stripeCustomerId` stored. We look up (or lazily create) the Stripe customer by the owner's email (`customers.list({ email })`). Resolving the owner + email uses our existing `users`/`members` tables — that's identity data we already own, not Stripe/plan data.
4. **Per-household, seat-based.** Subscription `quantity` = count of active memberships in the household. Two per-seat Stripe prices (`PRICE_PREMIUM_MONTHLY`, `PRICE_PREMIUM_ANNUAL`) via env. Backend syncs `quantity` on member join/leave.
5. **Payment = native PaymentSheet**, `payment_behavior: 'default_incomplete'` + `expand: ['latest_invoice.payment_intent']`. No webhook: after PaymentSheet succeeds, the next GET reflects `active`.
6. **Cancel = `cancel_at_period_end`** (access retained until period end); **switch interval = `subscriptions.update` items price swap** (Stripe prorates).

## Data flow

### GET `/households/:id/subscription` — `requireHouseholdRole('viewer')`
1. Resolve household owner → owner email (our DB).
2. `stripe.customers.list({ email, limit: 1 })`. None → return `{ plan:'free', status:'active', currentPeriodEnd:null, entitlements: free, interval:null }`.
3. `stripe.subscriptions.list({ customer })`; pick the one with `metadata.householdId === id` and a live status (`active`/`trialing`/`past_due`). None → free.
4. Map `items.data[0].price.id` → interval (monthly/annual) and plan (`premium`); build view via `entitlementsFor(plan, status)`.
5. Response adds `interval: 'monthly'|'annual'|null` and `cancelAtPeriodEnd: boolean` to the existing `SubscriptionView`.

### POST `/households/:id/subscription/checkout` — `requireHouseholdRole('owner')`
Body: `{ interval: 'monthly'|'annual' }`.
1. Reuse-or-create customer by owner email.
2. If a live subscription already exists for this household → 409 (use manage instead).
3. `quantity` = active-membership count.
4. `stripe.ephemeralKeys.create({ customer }, { apiVersion })`.
5. `stripe.subscriptions.create({ customer, items:[{ price, quantity }], payment_behavior:'default_incomplete', payment_settings:{ save_default_payment_method:'on_subscription' }, expand:['latest_invoice.payment_intent'], metadata:{ householdId:id } })`.
6. Return `{ paymentIntentClientSecret, ephemeralKeySecret, customerId, publishableKey }`.

### POST `/households/:id/subscription/switch` — `requireHouseholdRole('owner')`
Body `{ interval }`. Find household's live subscription → `subscriptions.update(sub.id, { items:[{ id: itemId, price: targetPrice }], proration_behavior:'create_prorations' })`. Return the GET view.

### POST `/households/:id/subscription/cancel` — `requireHouseholdRole('owner')`
Find live subscription → `subscriptions.update(sub.id, { cancel_at_period_end:true })`. Return the GET view (`cancelAtPeriodEnd:true`, still entitled until `currentPeriodEnd`).

### Seat sync (membership integration)
On **member join** (invitation accept) and **member remove**, after the membership mutation: resolve the household's live subscription; if one exists, `subscriptions.update(sub.id, { items:[{ id:itemId, quantity:newCount }], proration_behavior:'create_prorations' })`. If household is free (no live sub), no-op. Failures are logged but do not block the membership mutation (best-effort; read-time GET always shows current truth).

## Components

**Backend (finance-back)**
- `src/gateways/stripe/stripe.gateway.ts` — thin wrapper over the `stripe` SDK (client from `STRIPE_SECRET_KEY`), registered on `app.gateways`. Injectable/mubable for tests (MSW or a fake).
- `src/domain/entitlements.ts` — **kept**; `entitlementsFor(plan, status)` unchanged. Add `planForPriceId(priceId)` + `intervalForPriceId(priceId)` helpers driven by env price ids.
- `src/http/api/subscriptions/subscriptions.service.ts` — the Stripe orchestration (get/checkout/switch/cancel/syncSeats). No repository.
- `src/http/api/subscriptions/subscriptions.routes.ts` — the 4 routes above (GET/checkout/switch/cancel). All household-scoped.
- `src/http/api/subscriptions/subscriptions.schema.ts` — extend `SubscriptionView` (+`interval`, +`cancelAtPeriodEnd`); add `CheckoutBody`, `CheckoutSession`, `SwitchBody`.
- Membership hook: call `subscriptionsService.syncSeats(householdId)` from the invitation-accept and member-remove flows.
- **Removed:** `subscription.table.ts` (+ its test, migration to drop), `subscriptions.repository.ts` (+ test), v1 activate/cancel route bodies.
- Config/env: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `PRICE_PREMIUM_MONTHLY`, `PRICE_PREMIUM_ANNUAL`.

**Frontend (finance-app)**
- `@stripe/stripe-react-native` added; `<StripeProvider publishableKey>` at app root (key fetched from checkout response or a small `/config` value).
- Regenerated Kubb hooks for the new/changed endpoints.
- `src/hooks/use-entitlements.ts` — **kept**, unchanged surface (reads GET).
- `src/app/(tabs)/settings/plan.tsx` — the **subscribe + manage portal**: shows current plan/interval/renewal, monthly vs annual comparison, "Assinar" → checkout + PaymentSheet, and when premium: switch interval + cancel (with "acesso até <date>" on cancel-at-period-end).
- `<PaywallGate>` / `useEntitlement()` — **kept** as-is.

## Error handling

- Stripe errors → mapped to the project error catalog (a `SUB-Txxxx` family), surfaced with i18n messages; never leak raw Stripe messages to the client beyond a safe summary.
- Missing/duplicate Stripe customer for an email → treat as free (list, take first); log a warning on duplicates.
- `checkout` when a live subscription exists → 409.
- Seat sync failure → logged, non-blocking.
- Missing env price ids at boot → fail fast (config validation).

## Testing

- **finance-back:** unit for `entitlementsFor` / `planForPriceId` / `intervalForPriceId`; service tests with a **faked Stripe gateway** (no network) covering get(free/premium/canceled-at-period-end), checkout(new + 409 existing), switch, cancel, syncSeats(join/leave, free no-op). e2e for the 4 routes with the gateway faked at the app boundary. OpenAPI export + hook regen.
- **finance-app:** RNTL for the plan screen (free→subscribe calls checkout + PaymentSheet mocked; premium→switch/cancel), `useEntitlements` unchanged. Headless expo export.

## Decomposition → Two Plans

1. **Plan A — Backend:** stripe gateway, entitlements helpers, service (get/checkout/switch/cancel/syncSeats), 4 routes, remove v1 table/repo/routes + drop migration, membership seat-sync hooks, config env, tests, OpenAPI export.
2. **Plan B — Frontend:** add `@stripe/stripe-react-native` + provider, regen hooks, rebuild `plan.tsx` as subscribe + manage portal with PaymentSheet, keep gate/hook, RNTL + export.

## Ownership transfer (owner leaves)

Because the Stripe customer is keyed to the **owner's email**, an owner leaving would orphan the subscription (a new owner's email wouldn't find it). Handling:

- When the owner leaves, the household offers ownership to another member who is **not a kid** (i.e. an `adult`/`owner`-eligible member). A kid cannot become owner.
- On transfer, the subscription service re-points Stripe to the new owner: locate the household's live subscription (via old owner email + `metadata.householdId`), then `stripe.customers.update(customerId, { email: newOwnerEmail })`. Subscription + `metadata.householdId` stay intact; read-time GET now resolves via the new owner's email.
- If no eligible (non-kid) member exists, offer the leaving owner to cancel the subscription (`cancel_at_period_end`) before leaving.
- **Scope note:** the full ownership-transfer UX/flow is a household-membership concern (separate subsystem). This subscription work provides the Stripe re-point hook (`subscriptionsService.transferOwner(householdId, newOwnerEmail)`) the transfer flow will call; wiring the leave/transfer UI is tracked separately.

## Open Questions (defaulted)

- Trial period? — none in v1 (immediate charge). Easy to add via `trial_period_days`.
- Currency — BRL (matches app). Prices configured in Stripe dashboard.
- Publishable key delivery — returned in checkout response (and optionally a tiny public `/config`); no secret ever leaves the backend.
