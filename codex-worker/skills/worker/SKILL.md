---
name: worker
description: Use Codex (OpenAI coding agent on GPT-6.1 Sol) as a worker Claude drives directly from Bash — delegate implementation, debugging, refactors, test writing, research or a second opinion; run several Codex jobs in parallel in isolated git worktrees; continue a job's thread with follow-ups. Use when work can be split off, when a fresh independent pass or cross-model check helps, or when the user says "codex", "코덱스", "codex한테 시켜", "워커".
---

# Codex worker

Codex is a separate coding agent (OpenAI). You call it straight from Bash — no subagent hop — and you stay the orchestrator: you split the work, write the prompts, run the jobs, check their results, and integrate.

## Launcher

```bash
node "$HOME/.codex-worker/cw.mjs" <command> ...
```

If that file is missing, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"` with the same arguments. If Codex reports missing install or auth, run `setup --json` and tell the user what it says (`codex login` is theirs to run).

## Running a job

```bash
node "$HOME/.codex-worker/cw.mjs" task --json [flags] --prompt-file <file>
```

- **Write the prompt to a file** in the scratchpad and pass `--prompt-file`. Inline prompts break on quotes, newlines and Korean text in shells.
- **Always `--json`.** The result is one JSON object: `jobId`, `status` (0 = ok), `threadId`, `cwd`, `sandbox`, `worktree`, `rawOutput` (Codex's final message), `touchedFiles`, `commands` (each shell command Codex ran with its exit code), `error`.
- **Long jobs:** run the same command with Bash `run_in_background: true` (and a generous timeout). You are notified when it exits; read its output then. Do not pass `--background` to the script and do not poll — the Bash background run is the background mode. Use `status --json` only to peek at a job that is still running.
- **Short, bounded jobs** (≤ ~2 min): run in the foreground.

Flags:

| Flag | Effect |
|---|---|
| `--sandbox read-only` (default) | Codex can read and run read-only commands, no edits |
| `--write` / `--sandbox write` | Edits inside the workspace (git root of `--cwd`) |
| `--sandbox full` | No sandbox: network, installs, writes outside the repo. Only when the task needs it |
| `--cwd <dir>` | Where Codex works (default: current directory, resolved to its git root) |
| `--worktree <name>` | Create/reuse an isolated worktree on branch `codex/<name>` (from HEAD, or `--base <ref>`) and run there; implies `--write` |
| `--thread <job-id>` | Continue that job's Codex thread (same cwd/worktree/sandbox) with a follow-up prompt |
| `--resume-last` | Continue the latest finished task thread of this session |
| `--model <id>` | Default is always `gpt-6.1-sol` (Sol; needs codex-cli ≥ 0.159 — if it 400s with "not supported when using Codex with a ChatGPT account", update the CLI: `npm install -g @openai/codex@latest`). Never pass this unless the user explicitly names another model |
| `--effort <low/medium/high/xhigh/max>` | Reasoning effort; unset = `medium`. Sol rejects `none`/`minimal` (mapped to `low`). Pick by the table in `sol-prompting` |
| `--output-schema <file.json>` | Force Codex's final message to match a JSON schema (it lands in `rawOutput` as JSON text) |

## Parallel workers

Run independent pieces at the same time:

- Each write-capable worker gets its **own worktree** (`--worktree feat-a`, `--worktree feat-b`) so no two writers share files. Read-only workers can share the main checkout.
- Launch each as its own Bash call with `run_in_background: true`, all in one message.
- `--worktree` needs at least one commit in the repo. Uncommitted changes in the main checkout are **not** in the worktree — commit (if the user allows) or tell Codex what's missing.
- Never give two concurrent jobs the same `--thread`.

## Integrating results

A worker's report is a claim, not proof. Before telling the user something is done:

1. Read `rawOutput`, `touchedFiles`, and failed `commands` (exitCode ≠ 0).
2. Look at the actual diff: `git -C <worktree path> diff` (or `git diff codex/<name>` from the main checkout once committed). Run the tests yourself when they matter.
3. For worktree jobs, bring changes back with the user's OK: `git -C <worktree> add -A && git -C <worktree> commit -m ...`, then merge/cherry-pick `codex/<name>` into the working branch, or apply `git -C <worktree> diff | git apply`.
4. Follow up with `--thread <jobId>` to fix problems instead of starting over.
5. Clean up: `worktrees --json` lists them; `worktree-remove <name> [--delete-branch] [--force]` removes one.

If a job fails, report the `error`/stderr; decide whether to retry with a sharper prompt, continue the thread, or do it yourself — say which.

## Writing the prompt

Before writing any prompt file, load the `codex-worker:sol-prompting` skill and build the prompt from its skeleton. Codex starts with none of this conversation's context. Sol tends to stop early, ask questions, over-follow AGENTS.md and skills, over-test and over-format, and those blocks counter each habit.

- One clear task per job. Split unrelated asks into separate jobs.
- Never paste secrets into prompts.

## Other commands

- `review --json [--base <ref>] [--scope auto|working-tree|branch]` — Codex's built-in reviewer on local changes.
- `adversarial-review --json [--base <ref>] [focus text]` — challenge-the-design review with structured findings.
- `status [job-id] [--all] [--json]`, `result <job-id> --json`, `cancel <job-id> --json`.

## When not to use it

- Quick edits or lookups you can finish in a few tool calls.
- Work needing this conversation's full context that would take longer to brief than to do.
- Anything the user asked *you* to do personally, or explicitly not to delegate.
