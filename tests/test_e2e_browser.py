"""End-to-end real Chromium/Edge browser test & visual screenshot verification via CDP."""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))

import clouddrop  # noqa: E402


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CdpClient:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self.next_id = 1
        self.console_errors: list[str] = []
        self.exceptions: list[str] = []

    def send(self, method: str, params: dict | None = None) -> dict:
        cid = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
        while True:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if "method" in msg:
                m = msg["method"]
                p = msg.get("params", {})
                if m == "Runtime.exceptionThrown":
                    self.exceptions.append(json.dumps(p, ensure_ascii=False))
                elif m == "Runtime.consoleAPICalled" and p.get("type") == "error":
                    self.console_errors.append(json.dumps(p.get("args", []), ensure_ascii=False))
                continue
            if msg.get("id") == cid:
                if "error" in msg:
                    raise RuntimeError(f"CDP error in {method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expr: str, await_promise: bool = True):
        res = self.send(
            "Runtime.evaluate",
            {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
        )
        if "exceptionDetails" in res:
            raise RuntimeError(f"JS exception: {res['exceptionDetails']}")
        return res.get("result", {}).get("value")

    def set_viewport(self, width: int, height: int, mobile: bool = False):
        self.send(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": 2,
                "mobile": mobile,
            },
        )

    def screenshot(self, out_path: Path):
        res = self.send("Page.captureScreenshot", {"format": "png"})
        out_path.write_bytes(base64.b64decode(res["data"]))

    def close(self):
        self.ws.close()


def run_e2e(screenshot_dir: Path | None = None) -> None:
    browser = clouddrop.find_chromium_binary()
    assert browser, "No Edge/Chrome browser found for E2E verification"

    tmp_root = Path(tempfile.mkdtemp(prefix="clouddrop_e2e_"))
    data_dir = tmp_root / "data"
    profile_dir = tmp_root / "profile"

    srv = clouddrop.CloudDropServer(("127.0.0.1", 0), data_dir=data_dir, lan_url=None)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    cdp_port = find_free_port()
    proc = subprocess.Popen(
        [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={profile_dir}",
            f"http://localhost:{port}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    cdp = None
    try:
        # Wait for CDP target
        ws_url = None
        for _ in range(40):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json", timeout=1) as r:
                    targets = json.loads(r.read())
                for tgt in targets:
                    if tgt.get("type") == "page" and "webSocketDebuggerUrl" in tgt:
                        ws_url = tgt["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                time.sleep(0.25)
        assert ws_url, "Failed to connect to browser CDP endpoint"

        cdp = CdpClient(ws_url)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.set_viewport(1280, 820)
        cdp.send("Page.navigate", {"url": f"http://localhost:{port}"})

        # Wait for app hydration
        for _ in range(40):
            ready = cdp.eval("Boolean(document.querySelector('#composer-input') && document.querySelector('#cloud-status-card')?.textContent?.trim())")
            if ready:
                break
            time.sleep(0.15)
        assert ready, "App failed to initialize"

        # 1. Seed a multi-device Android & Linux event directly on disk to verify conflict-free pull sync!
        now_ms = int(time.time() * 1000)
        android_ev = {
            "opId": "op_android_seed_1",
            "itemId": "drop_android_1",
            "type": "create",
            "createdAt": now_ms - 180_000,
            "deviceId": "dev_android_pixel",
            "deviceName": "Android · Pixel 9",
            "platform": "android",
            "payload": {
                "text": "手机端随手分享一个技术链接，晚上回到 Windows 上看 #阅读 #工具\nhttps://github.com/deepseek-ai",
                "tags": ["阅读", "工具"],
                "pinned": True,
                "attachments": [],
            },
        }
        linux_ev = {
            "opId": "op_linux_seed_2",
            "itemId": "drop_linux_2",
            "type": "create",
            "createdAt": now_ms - 90_000,
            "deviceId": "dev_linux_arch",
            "deviceName": "Linux · Arch Workstation",
            "platform": "linux",
            "payload": {
                "text": "### 常用 Docker 清理命令 #linux #运维\n```bash\ndocker system prune -af --volumes\n```\n另外附带了一份部署清单文件：",
                "tags": ["linux", "运维"],
                "pinned": False,
                "attachments": [
                    {
                        "fileId": "file_seed_pdf_1",
                        "name": "Q4-架构迁移部署清单.pdf",
                        "remoteName": "file_seed_pdf_1_checklist.pdf",
                        "remoteId": "file_seed_pdf_1_checklist.pdf",
                        "mimeType": "application/pdf",
                        "size": 2483920,
                        "encrypted": False,
                    }
                ],
            },
        }
        (data_dir / "events" / f"{now_ms - 180_000:014d}_op_android_seed_1.json").write_text(
            json.dumps(android_ev, ensure_ascii=False), encoding="utf-8"
        )
        (data_dir / "events" / f"{now_ms - 90_000:014d}_op_linux_seed_2.json").write_text(
            json.dumps(linux_ev, ensure_ascii=False), encoding="utf-8"
        )
        (data_dir / "files" / "file_seed_pdf_1_checklist.pdf").write_bytes(b"%PDF-1.4\n%Mock PDF content\n")

        # Trigger manual sync button to pull Android & Linux events!
        cdp.eval("document.getElementById('btn-sync').click()")
        for _ in range(30):
            cnt = cdp.eval("document.querySelectorAll('.drop-card').length")
            if cnt == 2:
                break
            time.sleep(0.15)
        assert cnt == 2, f"Expected 2 synced cards from Android & Linux, got {cnt}"

        # 2. Send a new Windows note + code block + attach a real PNG image directly via UI!
        cdp.eval(
            """
            (async () => {
              const ta = document.getElementById('composer-input');
              ta.value = '刚在 Windows 截了一张架构图，顺手记一段同步脚本 #开发\\n```python\\ndef sync_cloud_drop(provider="gdrive"):\\n    return f"Synced cleanly via {provider}"\\n```';
              ta.dispatchEvent(new Event('input', { bubbles: true }));

              // Create a crisp synthetic canvas PNG to simulate Ctrl+V pasted screenshot
              const canvas = document.createElement('canvas');
              canvas.width = 640;
              canvas.height = 300;
              const ctx = canvas.getContext('2d');
              const grad = ctx.createLinearGradient(0, 0, 640, 300);
              grad.addColorStop(0, '#eef2ff');
              grad.addColorStop(1, '#dbe4ff');
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, 640, 300);
              ctx.fillStyle = '#4d6bfe';
              ctx.font = 'bold 28px sans-serif';
              ctx.fillText('CloudDrop  Windows ↔ Android ↔ Linux', 48, 130);
              ctx.fillStyle = '#525c6d';
              ctx.font = '18px sans-serif';
              ctx.fillText('Google Drive · OneDrive · Conflict-Free Event Log · E2EE', 48, 175);

              const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
              const file = new File([blob], 'clouddrop-architecture.png', { type: 'image/png' });
              const dt = new DataTransfer();
              dt.items.add(file);
              const picker = document.getElementById('file-picker');
              picker.files = dt.files;
              picker.dispatchEvent(new Event('change', { bubbles: true }));

              document.getElementById('btn-send').click();
            })()
            """
        )

        # Wait for 3rd card + image hydration + disk write
        for _ in range(40):
            state = cdp.eval(
                """({
                    cards: document.querySelectorAll('.drop-card').length,
                    imgs: document.querySelectorAll('.image-tile img').length,
                    links: document.querySelectorAll('.link-card').length,
                    codeBlocks: document.querySelectorAll('.code-block').length,
                    devices: document.querySelectorAll('#device-nav .nav-item').length
                })"""
            )
            if state["cards"] == 3 and state["imgs"] == 1:
                break
            time.sleep(0.15)

        assert state["cards"] == 3, f"Expected 3 cards, got {state}"
        assert state["imgs"] == 1, f"Expected hydrated image preview, got {state}"
        assert state["links"] == 1, f"Expected link preview card, got {state}"
        assert state["codeBlocks"] == 2, f"Expected 2 syntax-highlighted code blocks, got {state}"
        assert state["devices"] == 3, f"Expected 3 platforms (Windows/Android/Linux) in sidebar, got {state}"
        # Regression check: syntax highlighter must preserve string literals intact
        code_text = cdp.eval("Array.from(document.querySelectorAll('.code-block pre')).map(e => e.innerText).join('\\n')")
        assert '"gdrive"' in code_text and 'Synced cleanly via {provider}' in code_text, f"Code block corrupted: {code_text}"

        # Wait briefly for disk sync push
        time.sleep(0.5)
        event_files = list((data_dir / "events").glob("*.json"))
        assert len(event_files) == 3, f"Expected 3 persisted event JSONs on disk, found {len(event_files)}"

        # Capture Light Mode Workspace screenshot
        if screenshot_dir:
            screenshot_dir.mkdir(parents=True, exist_ok=True)
            cdp.eval("document.documentElement.setAttribute('data-theme', 'light')")
            time.sleep(0.25)
            cdp.screenshot(screenshot_dir / "01_light_workspace.png")

            # Capture Dark Mode Workspace screenshot
            cdp.eval("document.documentElement.setAttribute('data-theme', 'dark')")
            time.sleep(0.25)
            cdp.screenshot(screenshot_dir / "02_dark_workspace.png")

            # Open Settings -> Cloud Drive setup modal (Google Drive & OneDrive)
            cdp.eval("document.getElementById('cloud-status-card').click()")
            time.sleep(0.25)
            cdp.eval("document.querySelector('[data-pick-provider=\"gdrive\"]').click()")
            time.sleep(0.25)
            cdp.screenshot(screenshot_dir / "03_cloud_setup_gdrive.png")

            # Switch modal to OneDrive view & verify PKCE UI renders cleanly
            cdp.eval("document.querySelector('[data-pick-provider=\"onedrive\"]').click()")
            time.sleep(0.25)
            od_text = cdp.eval("document.getElementById('settings-body').innerText")
            assert "Microsoft Entra" in od_text and "OneDrive" in od_text

            # Switch modal to built-in Runtime Logs tab & capture screenshot
            cdp.eval("document.querySelector('[data-modal-tab=\"logs\"]').click()")
            time.sleep(0.3)
            log_text = cdp.eval("document.getElementById('log-console')?.innerText || ''")
            assert "Sync" in log_text or "Init" in log_text, f"Expected runtime logs in console, got: {log_text}"
            cdp.screenshot(screenshot_dir / "05_runtime_logs_modal.png")

            # Close modal and test E2EE encryption round-trip!
            cdp.eval("document.getElementById('settings-close').click()")
            time.sleep(0.15)

            # Capture Compact Edge-Drop Side-Panel / Android Mobile viewport (430x840)
            cdp.eval("document.documentElement.setAttribute('data-theme', 'light')")
            cdp.set_viewport(430, 840, mobile=True)
            time.sleep(0.3)
            cdp.screenshot(screenshot_dir / "04_compact_panel_mobile.png")

        # 3. Verify Search filter works accurately
        cdp.set_viewport(1280, 820, mobile=False)
        cdp.eval(
            """
            const si = document.getElementById('search-input');
            si.value = 'Docker';
            si.dispatchEvent(new Event('input', { bubbles: true }));
            """
        )
        time.sleep(0.15)
        assert cdp.eval("document.querySelectorAll('.drop-card').length") == 1

        # Clear search
        cdp.eval("document.getElementById('search-clear').click()")
        time.sleep(0.15)
        assert cdp.eval("document.querySelectorAll('.drop-card').length") == 3

        # 4. Verify WebCrypto E2EE round-trip directly in browser!
        e2ee_ok = cdp.eval(
            """
            (async () => {
              const mod = await import('/src/crypto/e2ee.js');
              const salt = mod.generateSaltBase64();
              const key = await mod.deriveKey('my-super-secret-pass', salt);
              const canary = await mod.createCanary(key);
              const good = await mod.verifyCanary(canary, key);
              const wrongKey = await mod.deriveKey('wrong-pass', salt);
              const bad = await mod.verifyCanary(canary, wrongKey);
              const enc = await mod.encryptJson({ msg: '绝密跨端笔记' }, key);
              const dec = await mod.decryptJson(enc, key);
              const blobIn = new Blob([new Uint8Array([1, 2, 3, 4, 99, 255])], { type: 'application/octet-stream' });
              const encBlob = await mod.encryptBlob(blobIn, key);
              const decBlob = await mod.decryptBlob(encBlob, key, 'application/octet-stream');
              const decBytes = Array.from(new Uint8Array(await decBlob.arrayBuffer()));
              return good === true && bad === false && enc.__e2ee === 1 && dec.msg === '绝密跨端笔记' && decBytes.join(',') === '1,2,3,4,99,255';
            })()
            """
        )
        assert e2ee_ok is True, "WebCrypto E2EE round-trip failed!"

        assert not cdp.exceptions, f"Uncaught JS exceptions: {cdp.exceptions}"
        assert not cdp.console_errors, f"Console errors: {cdp.console_errors}"
        print("E2E BROWSER VERIFICATION PASSED (0 JS errors, multi-device sync OK, E2EE OK)!")
    finally:
        if cdp:
            try:
                cdp.close()
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_e2e_browser():
    run_e2e(screenshot_dir=None)


if __name__ == "__main__":
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    run_e2e(screenshot_dir=out_dir)
