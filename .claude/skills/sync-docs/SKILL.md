---
name: sync-docs
description: "Use when code changes may have outdated the documentation — after editing src/, package.json, infra/, Docker, or scripts/; when the doc-sync Stop hook asks to reconcile docs; or when invoked as /sync-docs. Keeps the b2b-reservas-backend skill (SKILL.md + references/*.md) and CLAUDE.md in sync with the code."
trigger: /sync-docs
---

# /sync-docs

Reconcile this repo's documentation with the code. The canonical docs live in the **`b2b-reservas-backend` skill** — `.claude/skills/b2b-reservas-backend/references/*.md` (detail) and `.claude/skills/b2b-reservas-backend/SKILL.md` (entry point) — plus `CLAUDE.md` (thin pointer).

**Two tiers, different rules:**

- **General (company standard)** — SKILL.md + every `references/*.md` *except* PROJECT.md. These describe **patterns and mechanisms**, valid for any company Node.js backend. They use a neutral illustrative example (`bookings`) and **must not** accrete this project's concrete values. Keep them true, conservative, and consistent.
- **Project-specific** — `references/PROJECT.md` is the single sink for facts true only of this service (identity, domain modules, permission catalog values, active error siglas, gateway/env inventory, identity bootstrap, commands, ARNs, transient status). When the code changes a project fact, edit **PROJECT.md**, not a general reference.

**Do NOT churn on these (code is the source of truth — no doc edit needed):**

- **Adding/removing an error code** — touches only `catalog.ts` + `i18n/<locale>.json`. ERRORS.md describes the *mechanism*, not the inventory. (Edit ERRORS.md only if the error *system* changes: `app-error.ts`, the error-handler, the envelope shape, or i18n resolution.)
- **Adding a permission persona** — touches `catalog.ts` (+ a line in PROJECT.md §3 mirror). INTEGRATIONS.md describes the *pattern*, not the catalog values.
- **Adding a route/use-case** — covered by the existing patterns; no doc edit unless it introduces a new cross-cutting concern.

> **Path note.** All `*.md` doc targets below live under `.claude/skills/b2b-reservas-backend/references/`. The `docs/` folder no longer holds reference docs (only `docs/superpowers/` specs + plans, which `/sync-docs` does not touch).

## Scope (pick from the argument)

| Invocation | What to reconcile |
|---|---|
| `/sync-docs` | The working-tree delta — `git status --porcelain` (staged + unstaged + untracked). Matches the Stop hook. |
| `/sync-docs <path>` | Only the area you point at (e.g. `src/gateways`). |
| `/sync-docs all` | Full audit: whole codebase vs every doc. |

## Procedure

1. **Resolve scope** → list the changed (or targeted) files. For default scope: `git status --porcelain`. For `all`: walk `src/` and config.
2. **Map** each changed area to its owning doc (table below).
3. **Read** the owning doc(s). Compare documented behavior, commands, code samples, and stack against the actual code.
4. **Draft + apply** the minimal edits that make the doc true again. Match the doc's existing tone and structure; do not rewrite wholesale.
5. **Report**: list what was applied and what is proposed-pending-approval.

## Code → doc mapping

All doc paths are relative to `.claude/skills/b2b-reservas-backend/references/`.

Map to a **general** doc only when the *pattern/mechanism* changed; map to **PROJECT.md** when only a project-specific *value* changed.

```
gateway/integration PATTERN      → INTEGRATIONS.md   (new gateway type, resilience, token flow)
gateway/env VALUE (this project) → PROJECT.md §5     (added env var, gateway instance, ARN/bucket)
slice/layer PATTERN              → ARCHITECTURE.md, CODING_STANDARDS.md
error SYSTEM change              → ERRORS.md         (envelope, app-error.ts, handler, i18n resolution)
error CODE add/remove            → (none — catalog.ts + i18n only; siglas → PROJECT.md §4)
auth/permission PATTERN          → INTEGRATIONS.md
permission catalog VALUES        → PROJECT.md §3     (+ catalog.ts is SSOT)
identity bootstrap (this project)→ PROJECT.md §6
test pattern                     → TESTING.md
perf / SLO mechanism             → PERFORMANCE.md    (numeric SLO override → PROJECT.md §2)
OTel / Pino / logging            → OBSERVABILITY.md
Dockerfile, docker-compose       → DOCKER.md
infra/** (CDK), pipeline         → DEPLOYMENT.md
boot / shutdown / migrations     → OPERATIONS.md
package.json deps / stack swap   → DECISIONS.md      (+ SKILL.md §2 table → ASK)
package.json scripts / gotchas   → PROJECT.md §7     (+ CLAUDE.md §4 if a pillar command changed)
transient status (disabled job)  → PROJECT.md §8
new subsystem with no doc home   → propose a new references/X.md + SKILL.md §5 index → ASK
```

> **Smell test before editing a general doc:** "Is this true for *every* company backend, or only this one?" If only this one, it belongs in PROJECT.md. A general doc naming a concrete env var, ARN, persona, or error code is a leak — point it at PROJECT.md instead.

## Autonomy rules

**Auto-apply (no prompt):**
- Edits to existing `references/*.md` prose, code samples, and tables — **including PROJECT.md** (the expected home for project-fact drift).
- Fixes to commands in `CLAUDE.md` §4.

**ASK first (propose, wait for approval):**
- Creating a **new** `references/*.md` file.
- Adding a `SKILL.md` §5 index entry (always paired with a new reference).
- Changing the `SKILL.md` §2 stack table.

A new reference is warranted only for a genuinely new subsystem or cross-cutting concern with no existing home. Default to extending an existing reference.

## Common mistakes

- **Editing ERRORS.md because a code was added.** Don't — the inventory is `catalog.ts`. Same for permission personas (INTEGRATIONS.md) and PROJECT.md §3.
- **Leaking a project fact into a general doc.** A new env var / ARN / persona / sigla goes in PROJECT.md, never inline in ARCHITECTURE/INTEGRATIONS/DEPLOYMENT prose.
- Editing a doc the change does not actually affect — only touch mapped, verified gaps.
- Rewriting a whole reference when a targeted edit suffices.
- Auto-creating a new reference or editing the stack table without asking.
- Leaving `SKILL.md` §5 index stale after a new reference is approved.
- Reporting "docs updated" without naming which files and what changed.
