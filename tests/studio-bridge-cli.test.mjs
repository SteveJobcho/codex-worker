import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "codex-worker", "scripts", "codex-companion.mjs");
const bundledServer = path.join(repoRoot, "codex-worker", "studio_bridge", "server.py");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function availablePython(t) {
  const marker = "studio-bridge-cli-test-python-ok";
  const candidates = process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];
  const failures = [];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c",
      `import sys; from http.server import ThreadingHTTPServer; assert sys.version_info >= (3, 7); print(${JSON.stringify(marker)})`],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (!result.error && result.status === 0 && result.stdout.trim() === marker) return { command, prefix };
    failures.push(`${command}: ${result.error?.code ?? result.status}`);
  }
  t.skip(`A working Python 3.7+ is unavailable (${failures.join(", ")}).`);
  return null;
}

async function listen(t, server) {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  } catch (error) {
    if (["EPERM", "EACCES", "EAFNOSUPPORT"].includes(error.code)) {
      t.skip(`Localhost socket tests are unavailable: ${error.code}: ${error.message}`);
      return null;
    }
    throw error;
  }
}

async function close(server) {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fixture(t, port, python = null, finalize = async () => {}) {
  const project = fs.mkdtempSync(path.join(repoRoot, ".studio-bridge-cli-"));
  const bridgeDir = path.join(project, "tools", "studio_bridge");
  const root = path.join(project, "copies with spaces");
  const serverPy = path.join(bridgeDir, "server.py");
  fs.mkdirSync(bridgeDir, { recursive: true });
  // The real server still launches its own bundled serve process. Only this
  // test project's command entry point adds an isolated port and copy root.
  fs.writeFileSync(serverPy, [
    "import runpy, sys",
    `sys.argv = [${JSON.stringify(bundledServer)}] + sys.argv[1:] + ` +
      JSON.stringify(["--port", String(port), "--root", root, "--idle-hours", "0.01"]),
    `runpy.run_path(${JSON.stringify(bundledServer)}, run_name="__main__")`,
    ""
  ].join("\n"));
  const runCli = (...args) => run(process.execPath, [cli, "bridge", ...args, "--cwd", project], project);
  const stop = () => run(python.command, [...python.prefix, serverPy, "stop"], project);
  t.after(async () => {
    try {
      if (python) {
        const result = await stop();
        assert.equal(result.status, 0, `Bridge cleanup failed: ${result.stdout}\n${result.stderr}`);
      }
    } finally {
      try {
        fs.rmSync(project, { recursive: true, force: true });
        assert.equal(fs.existsSync(project), false, "Temporary bridge project was not removed");
      } finally {
        await finalize();
      }
    }
  });
  return { project, bridgeDir, root, runCli, stop };
}

function payload(result, status) {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("bridge path preserves text and JSON output without starting Python", async (t) => {
  const f = fixture(t, 0);
  const text = await f.runCli("path");
  assert.equal(text.status, 0);
  assert.equal(text.stdout, `${f.bridgeDir} (project)\n`);
  assert.equal(text.stderr, "");
  const json = payload(await f.runCli("path", "--json"), 0);
  assert.equal(json.source, "project");
  assert.equal(json.dir, f.bridgeDir);
  assert.equal(json.serverPy, path.join(f.bridgeDir, "server.py"));
  assert.equal(json.identicalToBundled, false);
});

test("bridge start is idempotent and status preserves READY/NOT RUNNING and exit 3", { timeout: 60000 }, async (t) => {
  const python = availablePython(t);
  if (!python) return;
  const reservation = http.createServer();
  const port = await listen(t, reservation);
  if (port === null) return;
  await close(reservation);
  const f = fixture(t, port, python);

  const absent = payload(await f.runCli("status", "--json"), 3);
  assert.equal(absent.exitCode, 3);
  assert.equal(absent.stdout, `NOT RUNNING studio_bridge on port ${port}`);
  assert.equal(absent.running, false);
  assert.equal(absent.ready, null);
  assert.equal(absent.root, null);

  const started = payload(await f.runCli("start", "--json"), 0);
  assert.equal(started.exitCode, 0);
  assert.equal(started.running, true);
  assert.equal(started.bridge.source, "project");
  assert.equal(started.root, fs.realpathSync(f.root));
  assert.equal(started.ready, started.stdout);
  assert.ok(started.ready.startsWith(`READY studio_bridge http://127.0.0.1:${port} root=`));
  assert.equal(typeof started.python, "string");
  const pid = started.ready.match(/ pid=(\d+)/)?.[1];
  assert.ok(pid);

  const repeated = await f.runCli("start");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.ok(repeated.stdout.includes(`pid=${pid} (already running)`));
  assert.ok(repeated.stdout.includes(`[bridge: project copy at ${f.bridgeDir}, DIFFERS from the bundled copy]`));
  assert.equal(repeated.stderr, "");

  const running = payload(await f.runCli("status", "--json"), 0);
  assert.equal(running.exitCode, 0);
  assert.equal(running.running, true);
  assert.equal(running.root, started.root);
  assert.ok(running.ready.endsWith(`pid=${pid} (running)`));

  const stopped = await f.stop();
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(stopped.stdout.includes(`STOPPED studio_bridge pid=${pid}`));
  const text = await f.runCli("status");
  assert.equal(text.status, 3, text.stderr);
  assert.ok(text.stdout.startsWith(`NOT RUNNING studio_bridge on port ${port}\n`));
  assert.ok(text.stdout.includes(`[bridge: project copy at ${f.bridgeDir}`));
  assert.equal(text.stderr, "");
});

test("bridge start preserves server startup failures and exit 1", { timeout: 60000 }, async (t) => {
  const python = availablePython(t);
  if (!python) return;
  // Occupy a private port with an unrelated HTTP service. Async child processes
  // let this server answer health probes while the real bridge fails to bind.
  const occupied = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
    response.end('{"service":"unrelated-test-service"}');
  });
  const port = await listen(t, occupied);
  if (port === null) return;
  const f = fixture(t, port, python, () => close(occupied));

  const failed = payload(await f.runCli("start", "--json"), 1);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.running, false);
  assert.equal(failed.ready, null);
  assert.equal(failed.root, null);
  assert.ok(failed.stdout.startsWith(`ERROR bridge did not start on port ${port}. Log `));
  assert.ok(failed.stdout.includes(`ERROR port ${port} is in use or cannot be bound:`));

  const text = await f.runCli("start");
  assert.equal(text.status, 1, text.stderr);
  assert.ok(text.stdout.startsWith(`ERROR bridge did not start on port ${port}. Log `));
  assert.ok(text.stdout.includes(`[bridge: project copy at ${f.bridgeDir}`));
  assert.equal(text.stderr, "");
});
