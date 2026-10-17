// codex-worker: locate and drive the Roblox Studio bridge server. A project's
// own tools/studio_bridge wins; otherwise the copy bundled with this plugin is
// used. Both copies are byte-identical, so they share one server on :47600.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_DIR = path.resolve(fileURLToPath(new URL("../../studio_bridge", import.meta.url)));
const PYTHON_PROBE = 'import sys; print("codex-worker-python%d" % sys.version_info[0])';

function sha256(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function findProjectBridge(cwd) {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, "tools", "studio_bridge", "server.py");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveBridge(cwd) {
  const projectDir = findProjectBridge(cwd);
  const dir = projectDir ?? BUNDLED_DIR;
  const identical =
    sha256(path.join(dir, "server.py")) === sha256(path.join(BUNDLED_DIR, "server.py")) &&
    sha256(path.join(dir, "bridge.lua")) === sha256(path.join(BUNDLED_DIR, "bridge.lua"));
  return {
    dir,
    source: projectDir ? "project" : "bundled",
    serverPy: path.join(dir, "server.py"),
    readme: path.join(dir, "README.md"),
    identicalToBundled: identical
  };
}

function pythonCandidates() {
  return process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];
}

export function runBridgeServer(cwd, args) {
  const bridge = resolveBridge(cwd);
  const failures = [];
  let allMissing = true;
  for (const [cmd, pre] of pythonCandidates()) {
    // Probe without running server.py: a failed launcher can be skipped, but a
    // bridge error (including status's normal exit 3) must never start a retry.
    const probe = spawnSync(cmd, [...pre, "-c", PYTHON_PROBE], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
    if (probe.error || probe.signal || probe.status !== 0 || (probe.stdout ?? "").trim() !== "codex-worker-python3") {
      if (probe.error?.code !== "ENOENT") allMissing = false;
      const detail = probe.error?.message ?? [
        (probe.stderr ?? "").trim(),
        (probe.stdout ?? "").trim(),
        probe.signal ? `signal ${probe.signal}` : `exit ${probe.status}`
      ].filter(Boolean).join("; ");
      failures.push(`${[cmd, ...pre].join(" ")}: ${detail}`);
      continue;
    }
    const result = spawnSync(cmd, [...pre, bridge.serverPy, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000
    });
    return {
      bridge,
      python: cmd,
      exitCode: result.status,
      stdout: (result.stdout ?? "").trim(),
      stderr: [(result.stderr ?? "").trim(), result.error?.message].filter(Boolean).join("\n")
    };
  }
  const reason = allMissing
    ? "no python/py/python3 was found on PATH."
    : `no working python/py/python3 was found on PATH.\n${failures.join("\n")}`;
  throw new Error(`Python 3 is required for the Studio bridge, but ${reason}`);
}
