#!/usr/bin/env python3
"""
CloudDrop Desktop Companion & Local Sync Server (Windows + Linux)
Zero third-party dependencies — pure Python 3 stdlib.

Features:
  - Serves the CloudDrop PWA on http://localhost:4173 (secure context for WebCrypto & OAuth)
  - Launches a native app-mode window via Edge/Chrome/Chromium (full workspace or --panel Edge-Drop side panel!)
  - Provides /api/local-sync/* for instant zero-config disk persistence & optional --lan Wi-Fi sync with Android/Linux
  - Supports --data-dir to store directly inside an existing synced folder (e.g. local OneDrive / Google Drive mount)
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"

# Ensure crisp MIME types across Windows/Linux registries
mimetypes.init()
EXTRA_MIMES = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def detect_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def validate_safe_filename(name: str) -> str | None:
    decoded = urllib.parse.unquote(name or "").strip()
    if not decoded or "/" in decoded or "\\" in decoded or decoded in (".", ".."):
        return None
    if ".." in decoded or "\x00" in decoded:
        return None
    if len(decoded) > 220:
        return None
    return decoded


class CloudDropServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address, data_dir: Path, lan_url: str | None):
        self.data_dir = data_dir
        self.events_dir = data_dir / "events"
        self.files_dir = data_dir / "files"
        self.events_dir.mkdir(parents=True, exist_ok=True)
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.lan_url = lan_url
        super().__init__(server_address, CloudDropHandler)


class CloudDropHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        # Keep console output clean and minimal
        pass

    def _send_common_headers(self) -> None:
        # Allow Google Identity Services & OneDrive OAuth popups to postMessage cleanly
        self.send_header("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
        self.send_header("X-Content-Type-Options", "nosniff")

    def _send_json(self, obj: dict, status: int = 200) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_status(self, status: int, message: str = "") -> None:
        self._send_json({"ok": status < 400, "error": message} if message else {"ok": status < 400}, status=status)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/local-sync/"):
            self._handle_api_get(path)
            return

        self._serve_static(path)

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        self._serve_static(parsed.path, head_only=True)

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/local-sync/"):
            self._handle_api_put(parsed.path)
            return
        self._send_status(405, "Method Not Allowed")

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/local-sync/"):
            self._handle_api_delete(parsed.path)
            return
        self._send_status(405, "Method Not Allowed")

    # ---- Local / LAN Sync REST API ----

    def _handle_api_get(self, path: str) -> None:
        srv: CloudDropServer = self.server  # type: ignore

        if path == "/api/local-sync/ping":
            usage = shutil.disk_usage(srv.data_dir)
            self._send_json(
                {
                    "ok": True,
                    "app": "CloudDrop",
                    "platform": platform.system().lower(),
                    "dataDir": str(srv.data_dir),
                    "lanUrl": srv.lan_url,
                    "diskUsed": usage.used,
                    "diskTotal": usage.total,
                }
            )
            return

        if path == "/api/local-sync/meta":
            meta_file = srv.data_dir / "meta.json"
            if not meta_file.is_file():
                self._send_status(404, "meta.json not found")
                return
            data = meta_file.read_bytes()
            self.send_response(200)
            self._send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/api/local-sync/events":
            items = []
            for f in sorted(srv.events_dir.glob("*.json")):
                st = f.stat()
                items.append(
                    {
                        "remoteId": f.name,
                        "name": f.name,
                        "modifiedTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                    }
                )
            self._send_json({"events": items})
            return

        if path.startswith("/api/local-sync/events/"):
            fname = validate_safe_filename(path[len("/api/local-sync/events/") :])
            if not fname or not fname.endswith(".json"):
                self._send_status(400, "Invalid event filename")
                return
            target = srv.events_dir / fname
            if not target.is_file():
                self._send_status(404, "Event not found")
                return
            data = target.read_bytes()
            self.send_response(200)
            self._send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if path.startswith("/api/local-sync/files/"):
            fname = validate_safe_filename(path[len("/api/local-sync/files/") :])
            if not fname:
                self._send_status(400, "Invalid file name")
                return
            target = srv.files_dir / fname
            if not target.is_file():
                self._send_status(404, "File not found")
                return
            size = target.stat().st_size
            mime = EXTRA_MIMES.get(target.suffix.lower()) or mimetypes.guess_type(fname)[0] or "application/octet-stream"
            self.send_response(200)
            self._send_common_headers()
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            with target.open("rb") as fp:
                while True:
                    chunk = fp.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        self._send_status(404, "Unknown API endpoint")

    def _handle_api_put(self, path: str) -> None:
        srv: CloudDropServer = self.server  # type: ignore
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0:
            self._send_status(400, "Invalid Content-Length")
            return

        if path == "/api/local-sync/meta":
            raw = self.rfile.read(length)
            try:
                json.loads(raw.decode("utf-8"))
            except Exception:
                self._send_status(400, "Invalid JSON")
                return
            tmp = srv.data_dir / f".meta.{os.getpid()}.{threading.get_ident()}.tmp"
            tmp.write_bytes(raw)
            os.replace(tmp, srv.data_dir / "meta.json")
            self._send_json({"ok": True})
            return

        if path.startswith("/api/local-sync/events/"):
            fname = validate_safe_filename(path[len("/api/local-sync/events/") :])
            if not fname or not fname.endswith(".json"):
                self._send_status(400, "Invalid event filename")
                return
            raw = self.rfile.read(length)
            try:
                json.loads(raw.decode("utf-8"))
            except Exception:
                self._send_status(400, "Invalid JSON event")
                return
            target = srv.events_dir / fname
            tmp = srv.events_dir / f".{fname}.{threading.get_ident()}.tmp"
            tmp.write_bytes(raw)
            os.replace(tmp, target)
            self._send_json({"ok": True, "remoteId": fname}, status=201)
            return

        if path.startswith("/api/local-sync/files/"):
            fname = validate_safe_filename(path[len("/api/local-sync/files/") :])
            if not fname:
                self._send_status(400, "Invalid file name")
                return
            target = srv.files_dir / fname
            tmp = srv.files_dir / f".{fname}.{threading.get_ident()}.tmp"
            remaining = length
            try:
                with tmp.open("wb") as fp:
                    while remaining > 0:
                        chunk = self.rfile.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            break
                        fp.write(chunk)
                        remaining -= len(chunk)
                os.replace(tmp, target)
            except Exception as exc:
                tmp.unlink(missing_ok=True)
                self._send_status(500, f"Write error: {exc}")
                return
            self._send_json({"ok": True, "remoteId": fname, "size": target.stat().st_size}, status=201)
            return

        self._send_status(404, "Unknown API endpoint")

    def _handle_api_delete(self, path: str) -> None:
        srv: CloudDropServer = self.server  # type: ignore
        if path.startswith("/api/local-sync/files/"):
            fname = validate_safe_filename(path[len("/api/local-sync/files/") :])
            if not fname:
                self._send_status(400, "Invalid file name")
                return
            target = srv.files_dir / fname
            target.unlink(missing_ok=True)
            self._send_json({"ok": True})
            return
        self._send_status(404, "Unknown API endpoint")

    # ---- Static PWA File Serving ----

    def _serve_static(self, req_path: str, head_only: bool = False) -> None:
        rel = urllib.parse.unquote(req_path.lstrip("/"))
        if not rel or rel.endswith("/"):
            rel = rel + "index.html"

        try:
            target = (WEB_DIR / rel).resolve()
            web_root = WEB_DIR.resolve()
            if not str(target).startswith(str(web_root)):
                self._send_status(403, "Forbidden")
                return
        except Exception:
            self._send_status(400, "Bad Path")
            return

        if not target.is_file():
            # SPA fallback for clean routes
            target = WEB_DIR / "index.html"

        ext = target.suffix.lower()
        mime = EXTRA_MIMES.get(ext) or mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()

        self.send_response(HTTPStatus.OK)
        self._send_common_headers()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)


def find_chromium_binary() -> str | None:
    sys_name = platform.system()
    candidates: list[str] = []
    if sys_name == "Windows":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local_app = os.environ.get("LOCALAPPDATA", "")
        candidates = [
            os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
            os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe"),
            os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
            os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
            os.path.join(local_app, r"Google\Chrome\Application\chrome.exe"),
            os.path.join(pf, r"BraveSoftware\Brave-Browser\Application\brave.exe"),
        ]
    elif sys_name == "Linux":
        for cmd in ("microsoft-edge", "google-chrome", "chromium", "chromium-browser", "brave-browser"):
            found = shutil.which(cmd)
            if found:
                candidates.append(found)
    elif sys_name == "Darwin":
        candidates = [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]

    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def launch_app_window(url: str, panel_mode: bool = False) -> None:
    browser = find_chromium_binary()
    if not browser:
        webbrowser.open(url)
        return

    profile_dir = Path.home() / ".clouddrop" / "app-window-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    width, height = (430, 840) if panel_mode else (1160, 780)
    cmd = [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile_dir}",
        f"--window-size={width},{height}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if platform.system() == "Windows" else 0
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
    except Exception:
        webbrowser.open(url)


def is_clouddrop_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/local-sync/ping", timeout=1.0) as resp:
            if resp.status == 200:
                info = json.loads(resp.read().decode("utf-8"))
                return bool(info.get("ok") and info.get("app") == "CloudDrop")
    except Exception:
        return False
    return False


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="CloudDrop — 跨端清爽云端投递箱 (Windows / Linux / Android)")
    parser.add_argument("--port", type=int, default=4173, help="本地服务端口（默认 4173）")
    parser.add_argument("--lan", action="store_true", help="开启局域网监听（0.0.0.0），允许 Android/Linux 同 Wi-Fi 直连")
    parser.add_argument("--panel", action="store_true", help="以 Edge Drop 风格窄侧栏窗口启动（430x840）")
    parser.add_argument("--no-browser", action="store_true", help="仅启动服务，不自动弹出应用窗口")
    parser.add_argument(
        "--data-dir",
        type=str,
        default=str(Path.home() / ".clouddrop" / "data"),
        help="本地同步数据目录（可指向本机 OneDrive/Google Drive 同步目录）",
    )
    args = parser.parse_args()

    if not WEB_DIR.is_dir():
        print(f"[CloudDrop] 未找到前端资源目录: {WEB_DIR}", file=sys.stderr)
        return 1

    local_url = f"http://localhost:{args.port}" + ("/?panel=1" if args.panel else "")

    # If CloudDrop is already running on this port, simply open a new window instead of failing
    if is_clouddrop_running(args.port):
        print(f"[CloudDrop] 检测到后台已在运行 ({local_url})，直接打开窗口...")
        if not args.no_browser:
            launch_app_window(local_url, args.panel)
        return 0

    bind_host = "0.0.0.0" if args.lan else "127.0.0.1"
    lan_ip = detect_lan_ip() if args.lan else None
    lan_url = f"http://{lan_ip}:{args.port}" if lan_ip else None

    data_dir = Path(args.data_dir).expanduser().resolve()
    try:
        server = CloudDropServer((bind_host, args.port), data_dir=data_dir, lan_url=lan_url)
    except OSError as exc:
        print(f"[CloudDrop] 端口 {args.port} 启动失败: {exc}", file=sys.stderr)
        print(f"[CloudDrop] 提示：可改用其他端口，例如 python desktop/clouddrop.py --port {args.port + 1}", file=sys.stderr)
        return 1

    print("============================================================")
    print("  CloudDrop 已启动 (DeepSeek HARNESS 清爽风格 · 三端互通)")
    print(f"  本机地址 : {local_url}")
    if lan_url:
        print(f"  局域网   : {lan_url}  (手机 Android / Linux 同 Wi-Fi 直接打开)")
    print(f"  数据目录 : {data_dir}")
    print("  按 Ctrl+C 停止服务")
    print("============================================================")

    if not args.no_browser:
        threading.Timer(0.35, launch_app_window, args=(local_url, args.panel)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[CloudDrop] 服务已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
