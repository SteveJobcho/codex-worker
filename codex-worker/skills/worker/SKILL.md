---
name: worker
description: MUST be loaded before you start any non-UI coding or code-investigation task, including surveys, new scripts, functions with tests, edits, test runs, debugging, refactors and research, and before your first edit, search or exploration for it. Loading it is not optional and not a judgment call. After loading, you MUST make and state an explicit delegate-or-not decision for the task and each separable part, handing parts to a Codex worker (OpenAI GPT-6.1 Sol, or GPT-6 Luna for trivial work) that you drive from Bash. Codex can also use MCP tools such as Roblox Studio and Blender. UI/frontend is never delegated. Also load it when the user says "codex", "코덱스", "codex한테 시켜" or "워커".
---

# Codex worker

Codex is a separate coding agent (OpenAI). You call it straight from Bash — no subagent hop — and you stay the orchestrator: you split the work, write the prompts, run the jobs, check their results, and integrate.

## Two standing rules

1. **No UI or frontend work goes to Codex.** That covers pages, components, styling and CSS, layout, visual design, UX copy, animation, and design tokens, along with anything judged by how it looks or feels. You do that work yourself. Codex may still handle non-visual pieces of a frontend codebase: build config, API clients, data and state logic, and tests of pure logic. Brief those with an explicit "do not change markup, styles, or copy".
2. **Codex has no human taste, so you supply it.** Write the brief so specifically that Codex can produce the best result in a single pass. Decide every judgment call yourself and write it down: names, interfaces and signatures, file layout, error messages and wording, edge-case behavior, what to leave out. Then nothing is left to Codex's own taste. A vague brief followed by fix-up rounds is the failure mode to avoid.

## Deciding to delegate (mandatory)

You MUST run this check at the start of every non-UI coding or code-investigation task, before your first edit, search or exploration for it. Skipping the check, or deciding without having loaded this skill, is a failure. That holds even when the task looks small or obvious.

1. Split the task into its separable parts, for example "survey", "new script", "tests", "run and fix".
2. For each part, decide **Codex** or **me** using the rules below. Delegating is the default for any part that can be briefed. Keeping a part for yourself needs a concrete reason from the "Do it yourself" list.
3. State the decision to the user in one line before you start, for example: `Codex(Luna): survey · Codex(Sol): logstats.py + tests · me: final review`, or `me: everything, because it's a one-line config edit`.

The size of a task doesn't settle the decision: small tasks are fine to hand off. Nor does "I could do it myself quickly": you usually could. The question is whether a brief beats doing it.

**Delegate** when most of these hold:
- The task can be stated completely in a brief. You already know what "done" looks like and have made the judgment calls (rule 2).
- Writing the brief takes clearly less effort than doing the work, or the work would fill your context with reading and output you don't need, such as surveys, searches, bulk edits, test runs or logs.
- It's independent enough to run while you do something else, or in parallel with other workers.
- The result is easy to check: a diff, a test, or a short factual answer.
- A second, independent opinion adds value: cross-checking a diagnosis, reviewing a risky change, or a fresh attempt after you're stuck.

**Do it yourself** only when one of these concretely holds, and name which one:
- It's UI, frontend or taste-driven (rule 1).
- It's a single edit of one or two lines that takes less time than writing the brief. A new file, a new function or a test suite is never this.
- It depends on facts from this conversation that you can't put in the brief. If you *can* write them into the brief, do that and delegate.
- It needs live back-and-forth with the user, or each step depends on what the previous one showed and you can't brief the loop.
- It touches secrets, production systems, or something irreversible.

These are **not** reasons to keep a part yourself:
- "It's small."
- "I'm already here."
- "Briefing takes time." Briefs are short; write it.
- "Codex can't reach that tool." Codex has its own MCP servers, and you can lend it Claude's local ones with `--mcp` (see "Tools Codex can use").

When the call is close, prefer delegating mechanical work to Luna and keep design-heavy reasoning for yourself. Mention delegations briefly to the user (what went to Codex and why) and report the verified results, not Codex's claims.

## Tools Codex can use

Codex isn't limited to the shell. It loads the MCP servers configured in `~/.codex/config.toml` (check with `codex mcp list`), for example `roblox_studio` and `blender` on this machine. You can also **lend** Claude's local (stdio) MCP servers to a single job:

```bash
node "$HOME/.codex-worker/cw.mjs" mcp-list                              # what Claude has, and what's lendable
node "$HOME/.codex-worker/cw.mjs" task --json --mcp Roblox_Studio --prompt-file brief.md
```

- `--mcp a,b` takes server names from Claude's config: the project `.mcp.json`, `~/.claude.json` (project and user entries), Claude Desktop's config, and other projects' entries as a fallback. It injects them into that Codex thread only, and `~/.codex/config.toml` is untouched. `--thread` follow-ups keep them.
- Only stdio servers can be lent. Remote or OAuth servers (HTTP connectors) and Claude's built-in app tools (browser, computer use, session tools) can't be.
- Tell Codex in the brief which MCP tools to use and whether it may change anything through them. Studio and Blender edits are live and not covered by git, so default to read-only unless the user asked for changes.

## Roblox Studio jobs

Studio work can be delegated too. Studio is live state with no git, so you set up the session and do the verifying yourself.

**Read-only work** (surveys, finding scripts, explaining how something works): launch with `--mcp Roblox_Studio` (or the project's Studio server name from `mcp-list`), name the target Studio, and say "read only".

**Script edits:** Codex MUST use the Studio bridge for any edit bigger than a few spots. The bridge pulls a script into a local copy, Codex edits the copy, tests it in Studio, then pushes it once. This plugin ships a bridge, so it's available in every project. When the project has its own `tools/studio_bridge`, that copy is used instead, and the project's rules for it (CLAUDE.md, AGENTS.md, docs) take precedence. Full API: the bridge's `README.md` (`bridge path` prints where it is).

1. **You** start the shared server first with `node "$HOME/.codex-worker/cw.mjs" bridge start`. It's safe if the server is already running, and it needs Python 3. Never stop the server: other agents may be using it. Take the `root=` path from its `READY` line (by default `%LOCALAPPDATA%\Temp\studio_bridge`, or the system temp folder outside Windows).
2. **You** identify the target Studio (`list_roblox_studios`) and put its name and studio_id in the brief, along with any Studio that must not be touched.
3. Launch with the Studio MCP lent and the bridge root writable:
   ```bash
   node "$HOME/.codex-worker/cw.mjs" task --json --write --mcp Roblox_Studio --add-dir "<bridge root>" --prompt-file brief.md
   ```
4. The brief carries the bridge procedure, taken from the bridge's README:
   - In every `execute_luau` (Edit mode only), load the client first: `local B = loadstring(game:GetService("HttpService"):GetAsync("http://127.0.0.1:47600/bridge.lua", true))()`.
   - `B.pull(script, "codex-<task>/<Name>.lua")` into its own subfolder.
   - Edit the local copy at `B.file(rel)` with exact, minimal patches. Never rewrite the whole file.
   - Test with `B.load(rel, script)` for ModuleScripts, or `B.check(rel)` (compile only) for Scripts and LocalScripts.
   - Call `B.push(script, rel)` **once** at the end, then report `B.status(script, rel).same`.
   - If push fails with "changed in Studio since pull", pull to a new name, move the edits over and push that copy.
   - Never start Play, save or publish. Never start or stop the bridge server.
5. **You** verify the result: check that `B.status(...).same` is true and `script_read` the changed region. Then report what changed in which script.

A few small edits can go straight through the MCP's `multi_edit` without the bridge. Tell Codex to re-read the script just before writing. If the bridge can't run (no Python, or the port is taken by an incompatible version), fall back to `multi_edit` with small, exact edits and say so.

## Picking the model

| Work | Model |
|---|---|
| Trivial, mechanical work: changing numbers, constants or config values, renames, surveying the file or directory structure, finding where something is defined, quick lookups and summaries of code | **Luna**: `--model luna --effort low` (use `none` for pure lookups) |
| Everything else: implementation, bug fixes, refactors, tests, debugging, research, review | **Sol** (the default, so leave `--model` unset) |

When you're unsure, use Sol. Luna is fast and cheap, but it's for narrow jobs whose answer can be checked at a glance.

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
| `--model luna` | GPT-6 Luna for trivial work (see "Picking the model"). Without the flag: `gpt-6.1-sol` (needs codex-cli ≥ 0.159; if it 400s with "not supported when using Codex with a ChatGPT account", run `npm install -g @openai/codex@latest`). Use no other model unless the user names one |
| `--effort <none/low/medium/high/xhigh/max>` | Reasoning effort; unset = `medium`. Sol rejects `none`/`minimal` (mapped to `low`), Luna accepts `none`. Pick by the table in `sol-prompting` |
| `--mcp <name,...>` | Lend Claude's local MCP servers to this job only (see "Tools Codex can use") |
| `--add-dir <dir,...>` | Extra folders Codex may write to in this job only, e.g. a Studio bridge root. Needs `--write`; `%VAR%` is expanded |
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

- Anything UI/frontend or taste-driven (rule 1 above).
- Work that needs this conversation's context and can't be put into a brief.
- Anything the user asked *you* to do personally, or explicitly not to delegate.
