#!/usr/bin/env bash
# Stop hook — enforce documentation reconciliation.
#
# Fires when the working tree has code changes but docs/ and CLAUDE.md were not
# touched. Blocks the stop ONCE (self-disarms via stop_hook_active so it can
# never loop) and points Claude at the sync-docs skill. Escape hatch: Claude may
# judge that no doc change is warranted, say so, and stop.
set -uo pipefail

input=$(cat)

# Self-disarm: if we already blocked during this stop cycle, allow the stop.
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac

dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$dir" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

code_changed=false
docs_changed=false
while IFS= read -r line; do
  [ -z "$line" ] && continue
  f=${line:3}      # strip the 2-char status + space porcelain prefix
  f=${f##* -> }    # on renames, keep the new path
  case "$f" in
    # Canonical docs now live in the skill references (docs/ is legacy). Count
    # the skill's references/*.md and SKILL.md as doc reconciliation too.
    docs/* | CLAUDE.md | */CLAUDE.md | .claude/skills/*/references/*.md | .claude/skills/*/SKILL.md)
      docs_changed=true
      ;;
  esac
  case "$f" in
    src/* | package.json | infra/* | scripts/* | Dockerfile* | docker-compose* | drizzle.config.*)
      code_changed=true
      ;;
  esac
done < <(git status --porcelain 2>/dev/null)

if [ "$code_changed" = true ] && [ "$docs_changed" = false ]; then
  printf '%s' '{"decision":"block","reason":"Code changed in the working tree but docs/ and CLAUDE.md are untouched. Reconcile the docs now with the sync-docs skill: run /sync-docs (it maps changed code to the owning doc, auto-applies edits to existing docs, and asks before creating new docs or changing CLAUDE.md structure). If no doc update is warranted, state why briefly, then stop."}'
fi
exit 0
