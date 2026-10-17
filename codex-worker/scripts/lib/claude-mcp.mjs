// codex-worker: lend Claude's local (stdio) MCP servers to a single Codex job.
// Definitions are read from Claude's own config and passed to the Codex thread as
// a per-thread config override, so ~/.codex/config.toml is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeDir(dir) {
  return path.resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function ancestors(dir) {
  const out = [];
  let current = path.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

// Ordered most specific first: project .mcp.json, ~/.claude.json project entry,
// ~/.claude.json user entry, Claude Desktop config, then other projects' entries.
function collectSources(cwd) {
  const sources = [];
  for (const dir of ancestors(cwd)) {
    const file = path.join(dir, ".mcp.json");
    const data = readJson(file);
    if (data?.mcpServers) sources.push({ label: file, servers: data.mcpServers });
  }

  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  const claudeJson = readJson(claudeJsonPath) ?? {};
  const projects = claudeJson.projects ?? {};
  const wanted = new Set(ancestors(cwd).map(normalizeDir));
  const otherProjects = [];
  for (const [projectDir, project] of Object.entries(projects)) {
    if (!project?.mcpServers || !Object.keys(project.mcpServers).length) continue;
    const entry = { label: `${claudeJsonPath} (project ${projectDir})`, servers: project.mcpServers };
    if (wanted.has(normalizeDir(projectDir))) sources.push(entry);
    else otherProjects.push(entry);
  }
  if (claudeJson.mcpServers) sources.push({ label: `${claudeJsonPath} (user)`, servers: claudeJson.mcpServers });

  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  for (const file of [
    path.join(appData, "Claude", "claude_desktop_config.json"),
    path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json")
  ]) {
    const data = readJson(file);
    if (data?.mcpServers) sources.push({ label: file, servers: data.mcpServers });
  }
  return [...sources, ...otherProjects];
}

function isStdio(def) {
  return Boolean(def?.command) && (!def.type || def.type === "stdio");
}

export function listClaudeMcpServers(cwd) {
  const seen = new Map();
  for (const source of collectSources(cwd)) {
    for (const [name, def] of Object.entries(source.servers)) {
      if (seen.has(name.toLowerCase())) continue;
      seen.set(name.toLowerCase(), {
        name,
        transport: isStdio(def) ? "stdio" : def?.type ?? (def?.url ? "http" : "unknown"),
        lendable: isStdio(def),
        command: def?.command ?? null,
        source: source.label
      });
    }
  }
  return [...seen.values()];
}

function findServer(cwd, name) {
  const lower = name.toLowerCase();
  for (const source of collectSources(cwd)) {
    for (const [serverName, def] of Object.entries(source.servers)) {
      if (serverName.toLowerCase() === lower) return { name: serverName, def, source: source.label };
    }
  }
  return null;
}

// Codex server keys must be simple identifiers.
function codexKey(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Builds the per-thread config override for the requested server names.
 * @returns {{ config: Record<string, unknown>, lent: {name: string, codexName: string, source: string}[] }}
 */
export function buildMcpConfig(cwd, names, { approve = false } = {}) {
  const config = {};
  const lent = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const found = findServer(cwd, name);
    if (!found) {
      const known = listClaudeMcpServers(cwd).map((s) => s.name).join(", ") || "none";
      throw new Error(`No Claude MCP server named "${name}". Known: ${known}.`);
    }
    if (!isStdio(found.def)) {
      throw new Error(
        `Claude MCP server "${found.name}" is ${found.def?.type ?? "remote"}, not a local stdio server; ` +
          "its login can't be lent to Codex. Configure it in Codex itself (`codex mcp add`) instead."
      );
    }
    const key = codexKey(found.name);
    const prefix = `mcp_servers.${key}`;
    config[`${prefix}.command`] = found.def.command;
    config[`${prefix}.args`] = Array.isArray(found.def.args) ? found.def.args.map(String) : [];
    if (found.def.env && Object.keys(found.def.env).length) config[`${prefix}.env`] = found.def.env;
    if (found.def.cwd) config[`${prefix}.cwd`] = found.def.cwd;
    // A same-named server may exist but be disabled in ~/.codex/config.toml.
    config[`${prefix}.enabled`] = true;
    // Workers run with approval policy "never", so any tool that would prompt
    // (e.g. Studio's execute_luau) is rejected outright. Write-capable jobs
    // pre-approve the lent server's tools (user-approved design); read-only
    // jobs keep them gated.
    if (approve) config[`${prefix}.default_tools_approval_mode`] = "approve";
    lent.push({ name: found.name, codexName: key, source: found.source, toolsApproved: approve });
  }
  return { config, lent };
}
