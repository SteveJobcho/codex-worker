---
description: Hand a task to a Codex worker (investigation, a fix, or a follow-up on an earlier job)
argument-hint: "[--background] [--worktree <name>] [--thread <job-id>|--resume|--fresh] [--sandbox read-only|write|full] [--model <model|sol|luna>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should do]"
allowed-tools: Bash(node:*), Read, Skill
---

Load the `codex-worker:worker` skill and follow it to run this request as one Codex worker job.

Raw user request:
$ARGUMENTS

- Flags in the request are runtime controls for `task`; pass them through and keep them out of the prompt text. `--background` means: run the `task` command with Bash `run_in_background: true` (do not pass `--background` to the script).
- Default to `--write` unless the user asked for read-only work (review, diagnosis, research).
- If the user gave no task, ask what Codex should do.
- When the job finishes, report Codex's result faithfully: what it concluded, the files it touched, and anything that failed. Do not redo the work yourself unless the user asks.
