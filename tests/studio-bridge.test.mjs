import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { resolveBridge, runBridgeServer } from "../codex-worker/scripts/lib/studio-bridge.mjs";

const cwd = process.cwd();
const python3 = { status: 0, stdout: "codex-worker-python3\r\n", stderr: "" };
const ready = { status: 0, stdout: "READY studio_bridge\n", stderr: "" };
const missing = { status: null, error: Object.assign(new Error("not found"), { code: "ENOENT" }) };

// Patch the builtin binding so the public API and Windows candidate order are
// exercised unchanged, even when these tests run on Linux. Tests are sequential.
function stubPython(t, results, platform = "win32") {
  const originalSpawn = childProcess.spawnSync;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  t.after(() => {
    childProcess.spawnSync = originalSpawn;
    Object.defineProperty(process, "platform", originalPlatform);
    syncBuiltinESMExports();
  });
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  childProcess.spawnSync = (cmd, args, options) => {
    assert.ok(calls.length < results.length, "unexpected Python invocation");
    calls.push({ cmd, args, options });
    return results[calls.length - 1];
  };
  syncBuiltinESMExports();
  return calls;
}

function assertProbe(call, cmd, pre = []) {
  assert.equal(call.cmd, cmd);
  assert.deepEqual(call.args.slice(0, -1), [...pre, "-c"]);
  assert.match(call.args.at(-1), /sys\.version_info\[0\]/);
  assert.equal(call.options.cwd, cwd);
  assert.equal(call.options.encoding, "utf8");
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 5000);
  assert.equal(call.options.shell, undefined);
}

test("Windows recovers from an installed but failing python with py -3", (t) => {
  const calls = stubPython(t, [
    { status: 9009, stdout: "", stderr: "Python was not found; use the Microsoft Store" },
    python3,
    ready
  ]);
  const args = ["start", "--root", "a path with spaces"];
  const run = runBridgeServer(cwd, args);
  assertProbe(calls[0], "python");
  assertProbe(calls[1], "py", ["-3"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].cmd, "py");
  assert.deepEqual(calls[2].args, ["-3", run.bridge.serverPy, ...args]);
  assert.equal(calls[2].options.timeout, 30000);
  assert.equal(calls[2].options.windowsHide, true);
  assert.equal(calls[2].options.shell, undefined);
  assert.deepEqual(run, {
    bridge: resolveBridge(cwd), python: "py", exitCode: 0,
    stdout: "READY studio_bridge", stderr: ""
  });
});

test("Windows reports all failed candidates without executing the bridge", (t) => {
  const calls = stubPython(t, [
    { status: 9009, stderr: "broken alias" },
    { status: 103, stderr: "No suitable Python runtime found" },
    missing
  ]);
  assert.throws(() => runBridgeServer(cwd, ["start"]), (error) => {
    assert.match(error.message, /Python 3 is required.*no working python\/py\/python3/);
    assert.match(error.message, /python: broken alias; exit 9009/);
    assert.match(error.message, /py -3: No suitable Python runtime found; exit 103/);
    assert.match(error.message, /python3: not found/);
    return true;
  });
  assert.equal(calls.length, 3);
  assertProbe(calls[0], "python");
  assertProbe(calls[1], "py", ["-3"]);
  assertProbe(calls[2], "python3");
});

test("all missing executables retain the existing PATH error", (t) => {
  const calls = stubPython(t, [missing, missing, missing]);
  assert.throws(() => runBridgeServer(cwd, ["status"]), {
    message: "Python 3 is required for the Studio bridge, but no python/py/python3 was found on PATH."
  });
  assert.equal(calls.length, 3);
});

for (const [label, failure] of [
  ["an alias exiting zero without running the probe", { status: 0, stdout: "" }],
  ["Python 2", { status: 0, stdout: "codex-worker-python2\n" }],
  ["a missing executable", missing],
  ["an invalid executable", { status: null, error: Object.assign(new Error("invalid executable"), { code: "ENOEXEC" }) }],
  ["a denied executable", { status: null, error: Object.assign(new Error("permission denied"), { code: "EACCES" }) }],
  ["a timed out launcher", { status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }],
  ["a signalled launcher", { status: null, signal: "SIGTERM" }]
]) {
  test(`Windows skips ${label}`, (t) => {
    const calls = stubPython(t, [failure, python3, ready]);
    assert.equal(runBridgeServer(cwd, ["start"]).python, "py");
    assert.equal(calls.length, 3);
    assertProbe(calls[1], "py", ["-3"]);
  });
}

test("Windows can reach the final python3 candidate", (t) => {
  const calls = stubPython(t, [missing, { status: 1 }, python3, ready]);
  assert.equal(runBridgeServer(cwd, ["start"]).python, "python3");
  assert.equal(calls.length, 4);
  assertProbe(calls[2], "python3");
});

test("a working first candidate runs the bridge once", (t) => {
  const calls = stubPython(t, [python3, ready]);
  assert.equal(runBridgeServer(cwd, ["start"]).python, "python");
  assert.equal(calls.length, 2);
});

for (const [label, action, status, stdout, stderr] of [
  ["stopped status", "status", 3, "NOT RUNNING studio_bridge on port 47600\n", ""],
  ["startup failure", "start", 1, "ERROR bridge did not start on port 47600\n", ""],
  ["argument error", "start", 2, "", "usage: server.py: invalid arguments\n"],
  ["server exception", "start", 1, "", "Traceback: server error\n"]
]) {
  test(`${label} is returned without trying another Python`, (t) => {
    const calls = stubPython(t, [python3, { status, stdout, stderr }]);
    const run = runBridgeServer(cwd, [action]);
    assert.equal(calls.length, 2);
    assert.equal(run.exitCode, status);
    assert.equal(run.stdout, stdout.trim());
    assert.equal(run.stderr, stderr.trim());
  });
}

for (const code of ["ENOENT", "ETIMEDOUT"]) {
  test(`a server spawn ${code} after a successful probe is reported without retry`, (t) => {
    const error = Object.assign(new Error(`server spawn ${code}`), { code });
    const calls = stubPython(t, [python3, { status: null, stdout: "", stderr: "partial error\n", error }]);
    const run = runBridgeServer(cwd, ["start"]);
    assert.equal(calls.length, 2);
    assert.equal(run.exitCode, null);
    assert.equal(run.stderr, `partial error\nserver spawn ${code}`);
  });
}

test("POSIX preserves python3 then python order", (t) => {
  const calls = stubPython(t, [{ status: 1, stderr: "broken python3" }, python3, ready], "linux");
  assert.equal(runBridgeServer(cwd, ["status"]).python, "python");
  assert.equal(calls.length, 3);
  assertProbe(calls[0], "python3");
  assertProbe(calls[1], "python");
});
