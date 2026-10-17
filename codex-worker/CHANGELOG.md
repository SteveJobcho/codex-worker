# Changelog

## codex-worker 1.10.0 (fork)

- `task --image <img,...>` attaches images to the turn, so Codex sees them directly.
- New "Image analysis" guidance: design decisions stay with Claude (Opus), but exact image analysis (measuring values, sizes and colors, diffing renders) and large image batches can go to Codex. Codex returns facts with evidence, and Claude makes the call.

## codex-worker 1.9.0 (fork)

- New `image` command and `/codex-worker:image`. It generates or edits images (`--ref`, up to 5) with `gpt-image-2` through Codex's image backend, using the ChatGPT login in `auth.json`. No Codex turn and no `OPENAI_API_KEY` are involved. Tokens are refreshed by Codex itself (`account/read` with `refreshToken`), files are written atomically, and existing files are never overwritten without `--force`. This follows the approach of jdmnk/codex-imagegen-cli and crazygit/pi-codex-image-gen.
- On machines with TLS-inspecting antivirus or proxies, the command re-runs itself with `--use-system-ca` so Node trusts the OS certificate store.

## codex-worker 1.8.0 (fork)

- Write-capable jobs now pre-approve the tools of servers lent with `--mcp` (`default_tools_approval_mode = "approve"` for that thread only). Before this, gated tools such as Roblox Studio's `execute_luau` were always rejected, because workers run with approval policy "never". Read-only jobs keep the tools gated.

## codex-worker 1.7.0 (fork)

- The Roblox Studio bridge (`studio_bridge/server.py`, `bridge.lua`) ships with the plugin, so Studio script edits through the bridge work in any project. A project's own `tools/studio_bridge` still wins. The copies are byte-identical (`SHA256SUMS.txt`), so they share one server on port 47600.
- New `bridge [start|status|path]` command. It needs Python 3, and it never stops the shared server.

## codex-worker 1.6.0 (fork)

- `task --add-dir <dir,...>` adds writable folders for a single job, set per thread through `sandbox_workspace_write.writable_roots`. `%VAR%` is expanded, and `--thread` follow-ups keep the folders.
- New "Roblox Studio jobs" section in the `worker` skill. Read-only jobs get the Studio MCP lent via `--mcp`. Script edits go through the project's Studio bridge (`tools/studio_bridge`): Claude starts the shared server and picks the target Studio, Codex pulls, edits the copy, loads it and pushes once, and Claude verifies `B.status().same`.

## codex-worker 1.5.0 (fork)

- `task --mcp <name,...>` lends Claude's local (stdio) MCP servers to a single Codex job. It reads them from the project `.mcp.json`, `~/.claude.json` and Claude Desktop's config, and injects them as a per-thread config override, so `~/.codex/config.toml` is untouched. `--thread` follow-ups keep them. `mcp-list` shows what can be lent.
- Delegation wording is now mandatory: the skill MUST be loaded before any non-UI coding or code-investigation task, each part gets an explicit Codex-or-me decision stated to the user, and delegating is the default. The skill lists the reasons that don't count for keeping a part ("it's small", "Codex can't reach that tool").

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
