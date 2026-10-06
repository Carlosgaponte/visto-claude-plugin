---
name: visto-agent-work
description: Use in every session where the SessionStart context contains "Visto Agent Work is active" — keeps this session's card on the Visto board truthful and routes approvals and questions through Visto so teammates can answer from the board or their phone.
---

# Visto Agent Work

Your session has a card on a shared kanban board. Humans on the team watch that board. Your job is to keep the card truthful and to ask through it when you need a decision.

## Identity

The SessionStart context gives you `VISTO_SESSION_ID=<id>`, the development project, the repo, and your card id if one exists. Pass `session_id` (that id) and `repo` to every `agent_*` tool. If the context is missing, the plugin is not active: skip this skill entirely.

## Lifecycle

1. **After you understand the first request**, call `agent_register_session` to fetch your card id (the hook created a card in Requested titled with the first line of the prompt). Then `agent_update_card` with a meaningful title (imperative, under 80 chars, e.g. "Fix login redirect loop after password reset") and `column: "working"`. If `card` is null, `agent_create_card` in `working`.
2. **At milestones**, `agent_add_note`: plan agreed, tests green, PR opened, blocked on X. One line each. Not every tool call — milestones.
3. **Before destructive or outward-facing actions** that Claude Code will not itself prompt for (deleting data, deploying, sending anything external, merging, force-pushing, changing production config), call `ask_human` with `kind: "approval"`. State exactly what you will do. Wait for `allow`. On `deny`, stop and say so.
4. **When you need the human** and they have not answered in the terminal within a minute, call `ask_human` with `kind: "input"`, a precise question, and `options` when the choice is closed.
5. **While waiting**: `ask_human` returns `{status:"waiting", decision_id}` after about two and a half minutes. Call it again with the same `decision_id` to keep waiting. Do not start unrelated work while a decision is pending.
6. **If the human answers in the terminal** while a decision is open, call `resolve_decision` with `status: "answered_in_terminal"` and their answer so the board catches up.
7. **When the work is complete and verified**, `agent_add_note` with a one-line summary and `agent_update_card` to `column: "review"`. Never move to `done`: a human accepts.

## Rules

- One card per piece of work. A second, distinct request in the same session gets a new card (`agent_create_card`).
- Titles describe the outcome, not the activity ("Add sweep cron", not "Working on cron").
- Notes are for humans skimming a board: plain language, no logs.
- Never answer your own decision. `ask_human` waits for a person.
- If any Visto tool errors, say so once and continue in the terminal; the board is a mirror, not a gate.
