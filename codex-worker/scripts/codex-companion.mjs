#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { ensureWorktree, listWorktrees, removeWorktree } from "./lib/worktree.mjs";
import { buildMcpConfig, listClaudeMcpServers } from "./lib/claude-mcp.mjs";
import { resolveBridge, runBridgeServer } from "./lib/studio-bridge.mjs";
import { generateImage } from "./lib/codex-images.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// GPT-6 Astra and GPT-6.1 Sol reject these efforts; the closest supported one is low.
const NO_NONE_EFFORT_MODELS = /^gpt-6(\.\d+)?-(sol|astra)$/;
// codex-worker: workers always run on Sol unless a run names another model.
// CODEX_WORKER_MODEL overrides the default without editing the plugin.
const DEFAULT_WORKER_MODEL = process.env.CODEX_WORKER_MODEL?.trim() || "gpt-6.1-sol";
const MODEL_ALIASES = new Map([
  ["sol", DEFAULT_WORKER_MODEL],
  ["luna", process.env.CODEX_WORKER_LUNA_MODEL?.trim() || "gpt-6-luna"]
]);
const SANDBOX_ALIASES = new Map([
  ["read-only", "read-only"],
  ["ro", "read-only"],
  ["read", "read-only"],
  ["write", "workspace-write"],
  ["workspace-write", "workspace-write"],
  ["full", "danger-full-access"],
  ["danger-full-access", "danger-full-access"]
]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write|--sandbox <read-only|write|full>] [--worktree <name> [--base <ref>]] [--resume-last|--thread <job-id|thread-id>|--fresh] [--model <model|sol|luna>] [--effort <none|minimal|low|medium|high|xhigh>] [--output-schema <file>] [--mcp <claude-server,...>] [--add-dir <dir,...>] [--prompt-file <file>] [--json] [prompt]",
      "  node scripts/codex-companion.mjs mcp-list [--json]",
      "  node scripts/codex-companion.mjs bridge [start|status|path] [--json]",
      "  node scripts/codex-companion.mjs image [--out <file.png>] [--ref <img,...>] [--size auto|1024x1024|1536x1024|1024x1536] [--quality auto|low|medium|high] [--background auto|transparent|opaque] [--force] [--json] <prompt>",
      "  node scripts/codex-companion.mjs worktrees [--json]",
      "  node scripts/codex-companion.mjs worktree-remove <name> [--delete-branch] [--force] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  const normalized = String(model ?? "").trim();
  if (!normalized) {
    return DEFAULT_WORKER_MODEL;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh, max (none/minimal only for models that accept them).`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex-worker:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex-worker:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex-worker:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex-worker:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex-worker:review` target is not supported by the built-in reviewer. Retry with `/codex-worker:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex-worker:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = request.threadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const effectiveSandbox = request.sandbox ?? (request.write ? "workspace-write" : "read-only");
  const mcp = request.mcp?.length
    ? buildMcpConfig(request.mcpLookupCwd ?? request.cwd, request.mcp, { approve: effectiveSandbox !== "read-only" })
    : null;
  if (mcp?.lent.length) {
    request.onProgress?.(`Lending Claude MCP servers: ${mcp.lent.map((s) => s.codexName).join(", ")}.`);
  }
  const threadConfig = { ...(mcp?.config ?? {}) };
  if (request.addDirs?.length) {
    // Extra writable roots for this job only, e.g. a Studio bridge's copy folder.
    threadConfig["sandbox_workspace_write.writable_roots"] = request.addDirs;
    request.onProgress?.(`Extra writable dirs: ${request.addDirs.join(", ")}.`);
  }
  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    config: Object.keys(threadConfig).length ? threadConfig : null,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.sandbox ?? (request.write ? "workspace-write" : "read-only"),
    outputSchema: request.outputSchema ?? null,
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    jobId: request.jobId ?? null,
    status: result.status,
    threadId: result.threadId,
    cwd: workspaceRoot,
    sandbox: request.sandbox ?? (request.write ? "workspace-write" : "read-only"),
    worktree: request.worktree ?? null,
    mcp: mcp?.lent ?? [],
    addDirs: request.addDirs ?? [],
    mcpLookupCwd: request.mcp?.length ? request.mcpLookupCwd ?? request.cwd : null,
    rawOutput,
    touchedFiles: result.touchedFiles,
    commands: (result.commandExecutions ?? []).map((c) => ({ command: c.command, exitCode: c.exitCode ?? null })),
    error: result.error?.message ?? null,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex-worker:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, sandbox, threadId, outputSchema, worktree, mcp, mcpLookupCwd, addDirs }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    sandbox,
    threadId,
    outputSchema,
    worktree,
    mcp,
    mcpLookupCwd,
    addDirs
  };
}

function normalizeSandbox(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = SANDBOX_ALIASES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported sandbox "${value}". Use read-only, write, or full.`);
  }
  return normalized;
}

function resolveThreadReference(cwd, reference) {
  if (!reference) {
    return null;
  }
  const value = String(reference).trim();
  const job = readStoredJob(resolveWorkspaceRoot(cwd), value);
  if (job) {
    if (!job.threadId) {
      throw new Error(`Job ${value} has no Codex thread to continue.`);
    }
    if (job.status === "queued" || job.status === "running") {
      throw new Error(`Job ${value} is still ${job.status}; wait for it before continuing its thread.`);
    }
    // Background jobs keep their request; foreground jobs only keep the result payload.
    const result = job.result && typeof job.result === "object" ? job.result : {};
    const request = job.request ?? {
      cwd: result.cwd ?? job.workspaceRoot ?? null,
      sandbox: result.sandbox ?? (job.write ? "workspace-write" : null),
      worktree: result.worktree ?? null,
      mcp: (result.mcp ?? []).map((s) => s.name),
      addDirs: result.addDirs ?? [],
      mcpLookupCwd: result.mcpLookupCwd ?? null
    };
    return { threadId: job.threadId, request };
  }
  return { threadId: value, request: null };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "worktree", "base", "thread", "output-schema", "mcp", "add-dir"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const invocationCwd = resolveCommandCwd(options);
  const model = normalizeRequestedModel(options.model);
  let effort = normalizeReasoningEffort(options.effort);
  if ((effort === "none" || effort === "minimal") && NO_NONE_EFFORT_MODELS.test(model) && model !== "gpt-6-sol") {
    process.stderr.write(`[codex-worker] ${model} does not support effort "${effort}"; using "low".
`);
    effort = "low";
  }
  const prompt = readTaskPrompt(invocationCwd, options, positionals);
  const outputSchema = options["output-schema"]
    ? readOutputSchema(path.resolve(invocationCwd, options["output-schema"]))
    : null;

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if ((resumeLast || options.thread) && fresh) {
    throw new Error("Choose either --resume/--resume-last/--thread or --fresh.");
  }
  const threadRef = resolveThreadReference(invocationCwd, options.thread);

  // Continuing a job's thread keeps running in the same place it ran before.
  const priorRequest = threadRef?.request ?? null;
  let worktree = null;
  let cwd = invocationCwd;
  if (options.worktree) {
    worktree = ensureWorktree(invocationCwd, options.worktree, { base: options.base ?? null });
    cwd = worktree.path;
  } else if (priorRequest?.worktree?.path) {
    worktree = priorRequest.worktree;
    cwd = worktree.path;
  } else if (priorRequest?.cwd && options.thread) {
    cwd = priorRequest.cwd;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let sandbox = normalizeSandbox(options.sandbox);
  if (!sandbox && options.write) {
    sandbox = "workspace-write";
  }
  if (!sandbox && worktree) {
    sandbox = "workspace-write";
  }
  if (!sandbox && priorRequest?.sandbox) {
    sandbox = priorRequest.sandbox;
  }
  const write = sandbox === "workspace-write" || sandbox === "danger-full-access";
  const threadId = threadRef?.threadId ?? null;
  // --mcp a,b lends Claude's stdio MCP servers to this job; follow-ups keep them.
  const mcp = options.mcp
    ? String(options.mcp).split(",").map((s) => s.trim()).filter(Boolean)
    : priorRequest?.mcp ?? [];
  const mcpLookupCwd = options.mcp ? invocationCwd : priorRequest?.mcpLookupCwd ?? invocationCwd;
  if (mcp.length) {
    buildMcpConfig(mcpLookupCwd, mcp); // fail fast on unknown or remote servers
  }
  // --add-dir a,b gives this job write access to extra folders (workspace-write only).
  const addDirs = options["add-dir"]
    ? String(options["add-dir"])
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => path.resolve(invocationCwd, d.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)))
    : priorRequest?.addDirs ?? [];
  for (const dir of addDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(threadId)
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast || Boolean(threadId));

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      sandbox,
      threadId,
      outputSchema,
      worktree,
      mcp,
      mcpLookupCwd,
      addDirs
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        sandbox,
        threadId,
        outputSchema,
        worktree,
        mcp,
        mcpLookupCwd,
        addDirs,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

function defaultImagePath(cwd) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return path.join(cwd, `image-${stamp}.png`);
}

// TLS-inspecting antivirus or corporate proxies (Kaspersky, Zscaler, ...) sign
// HTTPS with a root that only the OS trusts. Node's fetch ignores the OS store
// unless started with --use-system-ca, so re-run this command once with it.
function rerunWithSystemCa(subcommand, argv) {
  if (process.execArgv.includes("--use-system-ca") || process.env.CODEX_WORKER_NO_SYSTEM_CA === "1") return null;
  if (!process.allowedNodeEnvironmentFlags?.has("--use-system-ca")) return null;
  const script = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, ["--use-system-ca", script, subcommand, ...argv], {
    stdio: "inherit",
    windowsHide: true
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve(true);
    });
  });
}

// image: one direct call to Codex's image backend; no Codex turn, no worker brief.
async function handleImage(argv) {
  if (await rerunWithSystemCa("image", argv)) return;
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "out", "ref", "size", "quality", "background", "prompt-file"],
    booleanOptions: ["json", "force"]
  });
  const cwd = resolveCommandCwd(options);
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();
  const refs = options.ref
    ? String(options.ref)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(cwd, p))
    : [];
  let out = path.resolve(cwd, options.out ?? defaultImagePath(cwd));
  if (!path.extname(out)) out += ".png";
  if (fs.existsSync(out) && !options.force) {
    throw new Error(`${out} already exists. Pass --force to replace it, or choose another --out.`);
  }

  const started = Date.now();
  const result = await generateImage({
    prompt,
    refs,
    size: options.size,
    quality: options.quality,
    background: options.background,
    cwd
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, result.buffer);
  fs.renameSync(tmp, out);

  const payload = {
    path: out,
    bytes: result.buffer.length,
    mode: result.mode,
    size: result.size,
    quality: result.quality,
    revisedPrompt: result.revisedPrompt,
    refs,
    seconds: Math.round((Date.now() - started) / 100) / 10
  };
  outputCommandResult(payload, `Saved ${out} (${result.mode}, ${payload.bytes} bytes, ${payload.seconds}s)\n`, options.json);
}

function handleBridge(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const action = positionals[0] ?? "start";
  const cwd = resolveCommandCwd(options);
  if (action === "path") {
    const bridge = resolveBridge(cwd);
    outputCommandResult(bridge, `${bridge.dir} (${bridge.source})\n`, options.json);
    return;
  }
  if (action !== "start" && action !== "status") {
    // The server is shared by every agent on the machine; stopping it is left to the user.
    throw new Error("Usage: bridge [start|status|path]. Stop the shared server yourself with `python <bridge dir>/server.py stop` if you really mean to.");
  }
  const run = runBridgeServer(cwd, [action]);
  const ready = run.stdout.split(/\r?\n/).find((line) => line.startsWith("READY")) ?? null;
  const root = ready?.match(/root=(.+?) pid=/)?.[1] ?? null;
  const payload = { ...run, ready, root, running: action === "status" ? run.exitCode === 0 : Boolean(ready) };
  const rendered =
    [run.stdout, run.stderr].filter(Boolean).join("\n") +
    `\n[bridge: ${run.bridge.source} copy at ${run.bridge.dir}${run.bridge.identicalToBundled ? "" : ", DIFFERS from the bundled copy"}]\n`;
  outputCommandResult(payload, rendered, options.json);
  if (action === "start" && !ready) process.exitCode = run.exitCode || 1;
  if (action === "status") process.exitCode = run.exitCode ?? 1;
}

function handleMcpList(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const servers = listClaudeMcpServers(resolveCommandCwd(options));
  const rendered = servers.length
    ? servers
        .map((s) => [s.name, s.transport, s.lendable ? `lendable (--mcp ${s.name})` : "not lendable", s.source].join("\t"))
        .join("\n") + "\n"
    : "No Claude MCP servers found.\n";
  outputCommandResult(servers, rendered, options.json);
}

function handleWorktrees(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const entries = listWorktrees(resolveCommandCwd(options));
  const rendered = entries.length
    ? entries.map((e) => `${e.name}\t${e.branch ?? "(detached)"}\t${e.dirty ? "dirty" : "clean"}\t${e.path}`).join("\n") + "\n"
    : "No codex-worker worktrees for this repository.\n";
  outputCommandResult(entries, rendered, options.json);
}

function handleWorktreeRemove(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "delete-branch", "force"]
  });
  if (!positionals[0]) {
    throw new Error("Usage: worktree-remove <name> [--delete-branch] [--force]");
  }
  const report = removeWorktree(resolveCommandCwd(options), positionals[0], {
    deleteBranch: Boolean(options["delete-branch"]),
    force: Boolean(options.force)
  });
  const rendered = (report.actions.length ? report.actions.join("\n") : `Nothing to remove for ${report.name}.`) + "\n";
  outputCommandResult(report, rendered, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "image":
      await handleImage(argv);
      break;
    case "bridge":
      handleBridge(argv);
      break;
    case "mcp-list":
      handleMcpList(argv);
      break;
    case "worktrees":
      handleWorktrees(argv);
      break;
    case "worktree-remove":
      handleWorktreeRemove(argv);
      break;
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
