# Changelog

## codex-worker 1.4.0 (fork)

- The `worker` skill description is rewritten as a trigger: check it at the start of every non-UI coding task.
- The SessionStart hook adds a one-line reminder to weigh delegation before starting work. `CODEX_WORKER_NUDGE=0` turns it off.

## codex-worker 1.3.1 (fork)

- `worker` skill gains "Deciding to delegate": Claude judges per task whether to hand off (briefable, cheaper to brief than to do, independent, easy to verify) or do it itself (UI, one-step edits, context-heavy or back-and-forth work, secrets or irreversible actions).

## codex-worker 1.3.0 (fork)

Forked from openai/codex-plugin-cc 1.0.4 and reworked so Claude drives Codex as a worker:

- Claude calls the runtime straight from Bash through `~/.codex-worker/cw.mjs`, which the SessionStart hook keeps up to date. The Sonnet forwarding subagent is gone.
- `task` gains `--worktree <name>` (an isolated git worktree on `codex/<name>`), `--sandbox read-only|write|full`, `--thread <job-id>` (continue a specific job in the same place), `--output-schema` and a richer `--json` payload. New commands: `worktrees` and `worktree-remove`.
- State is global (`~/.codex-worker/state`), guarded by a cross-process lock and written atomically, so parallel workers can't lose each other's jobs.
- Each worker runs its own app-server by default; set `CODEX_WORKER_BROKER=1` to share one.
- Trivial work (value tweaks, renames, structure surveys, lookups) goes to `--model luna` (`gpt-6-luna`), and small tasks are delegated too.
- The default model is `gpt-6.1-sol` (`CODEX_WORKER_MODEL` overrides it). `max` effort is accepted, and `none`/`minimal` are mapped to `low` on Sol and Astra.
- Skills: `worker` (when and how to delegate) and `sol-prompting` (prompting GPT-6 workers, from OpenAI's latest-model guide). The 5.4 prompting and runtime-forwarder skills are removed.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
