"""Studio bridge: one shared localhost file server for Studio <-> local script copies.

Agents pull a script's source from Studio into a local file, edit it with the Edit
tool, test it with bridge.lua's load(), and push it back once. This server only
stores files; bridge.lua (served at /bridge.lua) does the Studio side.

Usage (Python stdlib only):
    python server.py            # same as "start": ensure a detached server is running
    python server.py start      # idempotent; prints a READY line and exits 0
    python server.py serve      # run in the foreground (what "start" launches)
    python server.py status     # exit 0 if running, 3 if not
    python server.py stop       # stop the server on the port

Options: --port N (default 47600), --root DIR (default %LOCALAPPDATA%\\Temp\\studio_bridge),
         --idle-hours H (serve/start: exit after H idle hours, default 6, 0 = never).

Endpoints (127.0.0.1 only):
    GET  /health                  JSON {"service": "studio_bridge", ...}
    GET  /bridge.lua              the Studio client, with its base URL filled in
    GET  /file?name=<rel>         file bytes (also GET /?name=<rel> or GET /<rel>)
    POST /file?name=<rel>         save the body to <root>/<rel>; JSON {ok, bytes, hash}
    POST /shutdown                stop the server
"""

import argparse
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

SERVICE = "studio_bridge"
VERSION = 1
DEFAULT_PORT = 47600
HOST = "127.0.0.1"
MAX_BODY = 32 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT_FILE = os.path.join(HERE, "bridge.lua")


def default_root():
    local = os.environ.get("LOCALAPPDATA")
    base = os.path.join(local, "Temp") if local else tempfile.gettempdir()
    return os.path.join(base, "studio_bridge")


def bridge_hash(data):
    """FNV-1a 32-bit + byte length. bridge.lua computes the same value."""
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return "%08x-%d" % (h, len(data))


class BadPath(ValueError):
    pass


def resolve(root, rel):
    """Map a relative name to a path inside root, or raise BadPath."""
    if not rel:
        raise BadPath("missing name")
    rel = rel.replace("\\", "/")
    if rel.startswith("/") or ":" in rel:
        raise BadPath("name must be a relative path: %r" % rel)
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        raise BadPath("name escapes the root: %r" % rel)
    full = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([full, root]) != root or full == root:
        raise BadPath("name escapes the root: %r" % rel)
    return full


def probe(port, timeout=1.5):
    """Return the health JSON of a bridge on the port, or None."""
    try:
        conn = http.client.HTTPConnection(HOST, port, timeout=timeout)
        conn.request("GET", "/health")
        res = conn.getresponse()
        body = res.read()
        conn.close()
        info = json.loads(body.decode("utf-8"))
        return info if res.status == 200 and info.get("service") == SERVICE else None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def ready_line(info, note=""):
    return "READY %s http://%s:%d root=%s pid=%s%s" % (
        SERVICE, HOST, info["port"], info["root"], info["pid"], note)


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # SO_REUSEADDR on Windows lets a 2nd server share the port

    def server_bind(self):
        import socket
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "studio_bridge/%d" % VERSION

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, status, msg):
        self._send(status, {"ok": False, "error": msg})

    def _target(self):
        parts = urlsplit(self.path)
        names = parse_qs(parts.query).get("name")
        if names:
            return parts.path, names[0]
        path = unquote(parts.path)
        if path in ("/", "/file"):
            return path, None
        return path, path.lstrip("/")

    def do_GET(self):
        st = self.server.state
        st["last"] = time.time()
        path, rel = self._target()
        if path == "/health":
            return self._send(200, st["info"])
        if path == "/bridge.lua":
            try:
                with open(CLIENT_FILE, "r", encoding="utf-8") as f:
                    src = f.read()
            except OSError as e:
                return self._fail(500, "cannot read bridge.lua: %s" % e)
            src = src.replace("__BRIDGE_BASE__", "http://%s:%d" % (HOST, st["info"]["port"]))
            return self._send(200, src, "text/plain; charset=utf-8")
        try:
            full = resolve(st["root"], rel)
        except BadPath as e:
            return self._fail(400, str(e))
        try:
            with open(full, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return self._fail(404, "no such file: %s" % rel)
        except OSError as e:
            return self._fail(500, "cannot read %s: %s" % (rel, e))
        self._send(200, data, "text/plain; charset=utf-8")

    def do_POST(self):
        st = self.server.state
        st["last"] = time.time()
        path, rel = self._target()
        if path == "/shutdown":
            self._send(200, {"ok": True, "stopping": st["info"]["pid"]})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._fail(400, "bad Content-Length")
        if length > MAX_BODY:
            return self._fail(413, "body too large (%d bytes)" % length)
        data = self.rfile.read(length) if length else b""
        try:
            full = resolve(st["root"], rel)
        except BadPath as e:
            return self._fail(400, str(e))
        try:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            tmp = "%s.%d.%d.tmp" % (full, os.getpid(), threading.get_ident())
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, full)
        except OSError as e:
            return self._fail(500, "cannot write %s: %s" % (rel, e))
        self._send(200, {"ok": True, "name": rel, "bytes": len(data), "hash": bridge_hash(data)})


def serve(port, root, idle_hours):
    info = probe(port)
    if info:
        print(ready_line(info, " (already running)"), flush=True)
        return 0
    os.makedirs(root, exist_ok=True)
    try:
        httpd = BridgeServer((HOST, port), Handler)
    except OSError as e:
        info = probe(port)
        if info:  # another start won the race
            print(ready_line(info, " (already running)"), flush=True)
            return 0
        print("ERROR port %d is in use or cannot be bound: %s (try --port)" % (port, e), flush=True)
        return 1
    info = {"service": SERVICE, "version": VERSION, "port": port, "root": root, "pid": os.getpid(),
            "started": time.strftime("%Y-%m-%d %H:%M:%S"), "idle_hours": idle_hours}
    httpd.state = {"root": root, "info": info, "last": time.time()}

    if idle_hours > 0:
        def watchdog():
            while True:
                time.sleep(30)
                if time.time() - httpd.state["last"] > idle_hours * 3600:
                    print("idle for %g h, stopping" % idle_hours, flush=True)
                    httpd.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()

    print(ready_line(info), flush=True)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    print("STOPPED %s pid=%d" % (SERVICE, os.getpid()), flush=True)
    return 0


def start(port, root, idle_hours):
    info = probe(port)
    if info:
        print(ready_line(info, " (already running)"))
        return 0
    os.makedirs(root, exist_ok=True)
    log_path = os.path.join(root, "_server.log")
    cmd = [sys.executable, os.path.abspath(__file__), "serve", "--port", str(port),
           "--root", root, "--idle-hours", str(idle_hours)]
    log = open(log_path, "ab")
    kw = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=root, close_fds=True)
    try:
        if os.name == "nt":
            base = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            try:  # outlive the launching shell's job object when allowed
                proc = subprocess.Popen(cmd, creationflags=base | 0x01000000, **kw)
            except OSError:
                proc = subprocess.Popen(cmd, creationflags=base, **kw)
        else:
            proc = subprocess.Popen(cmd, start_new_session=True, **kw)
    finally:
        log.close()
    deadline = time.time() + 10
    while time.time() < deadline:
        info = probe(port, timeout=0.5)
        if info:
            note = "" if info["pid"] == proc.pid else " (already running)"
            print(ready_line(info, note))
            return 0
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            tail = f.read()[-800:]
    except OSError:
        tail = ""
    print("ERROR bridge did not start on port %d. Log %s:\n%s" % (port, log_path, tail))
    return 1


def stop(port):
    info = probe(port)
    if not info:
        print("NOT RUNNING %s on port %d" % (SERVICE, port))
        return 0
    try:
        conn = http.client.HTTPConnection(HOST, port, timeout=3)
        conn.request("POST", "/shutdown", body=b"")
        conn.getresponse().read()
        conn.close()
    except (OSError, http.client.HTTPException):
        pass
    deadline = time.time() + 5
    while time.time() < deadline and probe(port, timeout=0.5):
        time.sleep(0.2)
    if probe(port, timeout=0.5):
        print("ERROR %s pid=%s did not stop" % (SERVICE, info["pid"]))
        return 1
    print("STOPPED %s pid=%s" % (SERVICE, info["pid"]))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Shared Studio bridge file server")
    ap.add_argument("command", nargs="?", default="start", choices=["start", "serve", "status", "stop"])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--root", default=default_root())
    ap.add_argument("--idle-hours", type=float, default=6.0)
    a = ap.parse_args()
    root = os.path.realpath(a.root)
    if a.command == "serve":
        return serve(a.port, root, a.idle_hours)
    if a.command == "start":
        return start(a.port, root, a.idle_hours)
    if a.command == "stop":
        return stop(a.port)
    info = probe(a.port)
    if info:
        print(ready_line(info, " (running)"))
        return 0
    print("NOT RUNNING %s on port %d" % (SERVICE, a.port))
    return 3


if __name__ == "__main__":
    sys.exit(main())
