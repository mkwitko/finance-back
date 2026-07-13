# AI Copilot — Insights & Advice (v1) Design Spec

**Date:** 2026-07-13
**Projects:** finance-back (Fastify 5, Drizzle, Zod 4, Deepseek gateway) + finance-app (Expo, Kubb, TanStack Query)
**Status:** Approved for planning

## Context

The vision includes an AI copilot. The app already uses a **Deepseek gateway**
(`src/gateways/deepseek/deepseek.gateway.ts`, OpenAI-compatible, JSON-mode,
Zod-validated, `enabled=false` graceful no-op when no key, faked in tests via the
gateways plugin) for import categorization and receipt extraction.

The copilot spans four experiences the user prioritized in order:
**(2) proactive insights → (4) advice/planning → (1) chat → (3) both**. This
spec covers the top two — **insights + advice** — which are adjacent (an insight
can carry a recommendation). **Chat (#1) is a separate later subsystem**
(streaming + tool-calling over the user's data + a chat UI).

## Goals

- Generate **proactive insight cards** over a household's finances — spending
  alerts, monthly summaries, trends — each optionally carrying an **advice
  recommendation** (covers experience #4).
- Reuse the existing **Deepseek** gateway (no new AI provider/infra).
- Feed the LLM **server-computed aggregates only** (category totals,
  month-over-month deltas, goal progress, balances) — never raw individual
  transaction descriptions — for privacy and a smaller prompt.
- **Cache** generated insights (on-demand generation with a staleness window) to
  control cost and give a stable feed.
- Household-scoped and RBAC-gated; respects the active context.

## Non-Goals (deferred)

- **Chat copilot** (natural-language Q&A, streaming, tool-calling) — separate subsystem.
- **Scheduled/cron generation** — v1 generates on-demand (on view, if stale) + manual refresh; a cron precompute is a later enhancement.
- **A second AI provider** (Claude/etc.) — Deepseek only.
- **Subscription gating** — the subscription subsystem is separate; insights ship ungated for now.

## Decisions (from brainstorming)

- Provider = **Deepseek** (reuse the existing gateway; extend it with an insights method).
- Generation = **on-demand with caching**: `GET` returns cached insights, regenerating only if none exist or the cache is older than a staleness window (24h). A `POST …/refresh` forces regeneration (adult+).
- The LLM receives **aggregates**, not raw transactions.

## Data Model

### New table: `insight`

Standard `entityColumns` (internal `id`, public `uuid`, `createdBy`/`updatedBy`, timestamps, `deletedAt`).

```
insight
  ...entityColumns("insight")
  householdId     bigint  FK → household.id (cascade)  NOT NULL
  kind            varchar(24, enum INSIGHT_KINDS)  NOT NULL   -- spending_alert | summary | trend | advice
  severity        varchar(16, enum INSIGHT_SEVERITIES)  NOT NULL  -- info | warning | positive
  title           varchar(255)  NOT NULL
  body            text  NOT NULL
  recommendation  text  NULL      -- advice text (experience #4); null when the insight is purely informational
  periodStart     timestamptz  NOT NULL   -- window the insight summarizes
  periodEnd       timestamptz  NOT NULL
  generatedAt     timestamptz  NOT NULL
  index on (householdId)
```

- Regeneration soft-deletes the household's prior active insights and inserts the new batch (a "generation" replaces the feed atomically).
- "Fresh" = the most recent `generatedAt` for the household is within the staleness window (24h).

## Backend (finance-back)

### Gateway extension

Add to `DeepseekGateway` (same shape as `categorizeTransactions`/`extractReceipt`):

- `generateInsights(input: InsightRequest): Promise<GeneratedInsight[]>` — takes the aggregate summary, returns validated structured insights; `[]` when disabled or on any failure (graceful no-op, never throws).
- `InsightRequest` carries the aggregates (below). `GeneratedInsight = { kind, severity, title, body, recommendation }`.
- JSON-mode prompt in pt-BR; Zod schema validates `kind`/`severity` enums, non-empty `title`/`body`, nullable `recommendation`.

### Aggregation (no raw transactions to the LLM)

A service computes, for the active household over a period (default: current + previous calendar month):

- expense totals per category (current vs previous month) and month-over-month deltas,
- income vs expense totals and net,
- account balances (sum by account/kind),
- goal progress (target vs current, % and pace).

These aggregates — numbers and category/goal names only — form the `InsightRequest`. No transaction descriptions are sent.

### Endpoints (household-scoped, `x-household-id`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /households/:id/insights` | `requireHouseholdRole('viewer')` | Return cached insights; if none or stale (>24h), generate, persist, and return. |
| `POST /households/:id/insights/refresh` | `requireHouseholdRole('adult')` | Force regeneration (soft-delete prior, generate fresh). |

- When the gateway is disabled (no key) or returns `[]`, the endpoints return an empty list (feed shows an empty state) — never an error.
- Presenters expose `uuid` as `id`.

## Frontend (finance-app)

Built on the design system, consuming Kubb-generated hooks; requests carry `x-household-id` from `household-store`.

- **Insights feed** — a screen listing insight `Card`s: a leading icon/tone by `severity` (`positive`→income tone, `warning`→warning tone, `info`→neutral), `title`, `body`, and, when present, the `recommendation` inside a `DisclosureSection` ("Ver recomendação"). `Skeleton` while loading, `EmptyState` when empty ("Ainda não há insights — importe transações ou toque em atualizar"), pull-to-refresh calls the refresh endpoint (adult+; viewers just re-fetch the cache).
- Uses `useGetInsights`/`useRefreshInsights` (generated). Errors surface via the existing pattern (a friendly message; reuse/extend `contextErrorMessage` or a local mapper).

## RBAC / Privacy

- `viewer` reads the feed; `adult` triggers refresh. Reuses `requireHouseholdRole`.
- Only aggregates (numbers + category/goal names) leave the server to Deepseek — no individual transaction descriptions. Documented in the aggregation service.

## Testing

- **finance-back**: unit for the aggregator (given seeded transactions/goals → correct category totals, MoM deltas, goal progress) and the gateway insights method against a fake (deterministic JSON in, validated `GeneratedInsight[]` out; `[]` when disabled). e2e (Testcontainers): seed data → `GET` generates + caches; second `GET` returns cache without regenerating; `POST refresh` replaces; disabled-gateway → empty list, not error.
- **finance-app**: RNTL for the feed (loading `Skeleton`, `EmptyState`, populated list with severity tones, recommendation disclosure, pull-to-refresh), API mocked.
- **Contract**: after backend lands, `npx tsx scripts/export-openapi.ts ../finance-app/api.json` then `pnpm api:generate`.

## Decomposition → Two Implementation Plans

1. **Plan A — Backend** (`finance-back`): `insight` table + migration, gateway `generateInsights`, aggregation service, endpoints, unit + e2e, OpenAPI export. Independently testable (gateway faked).
2. **Plan B — Frontend** (`finance-app`): regenerate hooks, build the insights feed screen/components on the design system, RNTL tests, headless export gate.

Plan A lands and exports OpenAPI before Plan B regenerates hooks.

## Files (anticipated)

**Backend:**
- `src/infra/db/tables/insights/insight.table.ts` (+ `schema.ts` export) + migration
- `src/gateways/deepseek/deepseek.gateway.ts` — add `generateInsights` (+ request/response types, Zod schema, prompt)
- `src/http/api/insights/` — routes, repository, schema, `insights.service.ts` (aggregation)
- e2e + unit tests

**Frontend:**
- regenerated `src/api/**`
- `src/components/insights/` — `InsightCard`, `InsightsFeed`
- `src/app/(tabs)/insights.tsx` (or a settings/insights route)

## Open Questions (resolve in plan, not blocking)

- Exact staleness window (proposed 24h) and whether `GET` auto-generates for a `viewer` (who can't `refresh`) — proposal: `GET` may generate-on-first-view for any member (it's a read of derived data), while explicit `refresh` stays adult+. Confirm in the backend plan.
- Aggregation period default (proposed current + previous calendar month).
