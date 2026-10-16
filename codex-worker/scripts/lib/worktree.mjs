// codex-worker: isolated git worktrees so several write-capable Codex workers
// can run in parallel without touching each other's files or the main checkout.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !allowFail) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function sanitizeName(name) {
  const slug = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Worktree name must contain letters, digits, '.', '_' or '-'.");
  }
  return slug;
}

export function resolveRepoRoot(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!top.ok || !top.stdout) {
    throw new Error(`--worktree needs a git repository, but ${cwd} is not inside one.`);
  }
  // A linked worktree's toplevel is itself; map back to the main checkout so
  // every worker of one repo shares the same worktree home.
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFail: true });
  if (common.ok && path.basename(common.stdout) === ".git") {
    return path.resolve(path.dirname(common.stdout));
  }
  return path.resolve(top.stdout);
}

export function resolveWorktreeHome(repoRoot) {
  const base = process.env.CODEX_WORKER_WORKTREE_DIR
    ? path.resolve(process.env.CODEX_WORKER_WORKTREE_DIR)
    : path.join(os.homedir(), ".codex-worker", "worktrees");
  const hash = createHash("sha256").update(repoRoot.toLowerCase()).digest("hex").slice(0, 10);
  return path.join(base, `${sanitizeName(path.basename(repoRoot))}-${hash}`);
}

export function ensureWorktree(cwd, name, { base = null } = {}) {
  const repoRoot = resolveRepoRoot(cwd);
  const slug = sanitizeName(name);
  const branch = `codex/${slug}`;
  const worktreePath = path.join(resolveWorktreeHome(repoRoot), slug);

  if (fs.existsSync(path.join(worktreePath, ".git"))) {
    return { repoRoot, path: worktreePath, branch, created: false };
  }

  const head = git(repoRoot, ["rev-parse", "--verify", "--quiet", base ?? "HEAD"], { allowFail: true });
  if (!head.ok) {
    throw new Error(
      base
        ? `Base ref "${base}" does not exist in ${repoRoot}.`
        : `${repoRoot} has no commits yet; commit once before using --worktree.`
    );
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branchExists = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).ok;
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, head.stdout];
  git(repoRoot, args);
  return { repoRoot, path: worktreePath, branch, created: true, baseCommit: head.stdout };
}

export function listWorktrees(cwd) {
  const repoRoot = resolveRepoRoot(cwd);
  const home = resolveWorktreeHome(repoRoot);
  const out = git(repoRoot, ["worktree", "list", "--porcelain"]).stdout;
  const entries = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: path.resolve(line.slice(9)) };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    }
  }
  const norm = (p) => p.toLowerCase();
  return entries
    .filter((entry) => norm(entry.path).startsWith(norm(home)))
    .map((entry) => {
      const dirty = git(entry.path, ["status", "--porcelain"], { allowFail: true }).stdout;
      return { name: path.basename(entry.path), ...entry, dirty: Boolean(dirty) };
    });
}

export function removeWorktree(cwd, name, { deleteBranch = false, force = false } = {}) {
  const repoRoot = resolveRepoRoot(cwd);
  const slug = sanitizeName(name);
  const worktreePath = path.join(resolveWorktreeHome(repoRoot), slug);
  const branch = `codex/${slug}`;
  const actions = [];
  if (fs.existsSync(worktreePath)) {
    git(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
    actions.push(`removed worktree ${worktreePath}`);
  }
  git(repoRoot, ["worktree", "prune"], { allowFail: true });
  if (deleteBranch) {
    const del = git(repoRoot, ["branch", force ? "-D" : "-d", branch], { allowFail: true });
    actions.push(del.ok ? `deleted branch ${branch}` : `kept branch ${branch} (${del.stderr || "not merged"})`);
  }
  return { repoRoot, name: slug, path: worktreePath, branch, actions };
}
