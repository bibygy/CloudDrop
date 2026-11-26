"""Automated unit & integration tests for CloudDrop desktop companion server."""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))

import clouddrop  # noqa: E402


@pytest.fixture()
def server(tmp_path: Path):
    srv = clouddrop.CloudDropServer(("127.0.0.1", 0), data_dir=tmp_path, lan_url="http://192.168.1.99:4173")
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}", tmp_path
    srv.shutdown()
    srv.server_close()


def req(url: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_static_assets_and_headers(server):
    base, _ = server
    status, headers, body = req(f"{base}/")
    assert status == 200
    assert "CloudDrop" in body.decode("utf-8")
    assert headers.get("Cross-Origin-Opener-Policy") == "same-origin-allow-popups"

    status, headers, _ = req(f"{base}/src/main.js")
    assert status == 200
    assert "javascript" in headers.get("Content-Type", "")

    status, headers, body = req(f"{base}/manifest.webmanifest")
    assert status == 200
    manifest = json.loads(body.decode("utf-8"))
    assert manifest["name"] == "CloudDrop"
    assert "share_target" in manifest


def test_local_sync_crud_events_and_files(server):
    base, data_dir = server

    # Ping
    status, _, body = req(f"{base}/api/local-sync/ping")
    assert status == 200
    info = json.loads(body)
    assert info["ok"] is True
    assert info["lanUrl"] == "http://192.168.1.99:4173"

    # Meta read (404 initially) -> write -> read
    status, _, _ = req(f"{base}/api/local-sync/meta")
    assert status == 404
    meta = {"version": 1, "e2ee": {"enabled": False}}
    status, _, _ = req(f"{base}/api/local-sync/meta", "PUT", json.dumps(meta).encode("utf-8"))
    assert status == 200
    status, _, body = req(f"{base}/api/local-sync/meta")
    assert status == 200
    assert json.loads(body) == meta

    # Event PUT -> LIST -> GET
    ev = {"opId": "op_test_1", "itemId": "drop_1", "type": "create", "payload": {"text": "hello drop"}}
    fname = "00001763710000_op_test_1.json"
    status, _, _ = req(f"{base}/api/local-sync/events/{fname}", "PUT", json.dumps(ev).encode("utf-8"))
    assert status == 201
    assert (data_dir / "events" / fname).is_file()

    status, _, body = req(f"{base}/api/local-sync/events")
    assert status == 200
    listed = json.loads(body)["events"]
    assert len(listed) == 1
    assert listed[0]["name"] == fname

    status, _, body = req(f"{base}/api/local-sync/events/{fname}")
    assert status == 200
    assert json.loads(body)["payload"]["text"] == "hello drop"

    # Binary File PUT -> GET -> DELETE
    payload = bytes(range(256)) * 64
    status, _, _ = req(f"{base}/api/local-sync/files/file_1_sample.bin", "PUT", payload)
    assert status == 201

    status, _, body = req(f"{base}/api/local-sync/files/file_1_sample.bin")
    assert status == 200
    assert body == payload

    status, _, _ = req(f"{base}/api/local-sync/files/file_1_sample.bin", "DELETE")
    assert status == 200
    status, _, _ = req(f"{base}/api/local-sync/files/file_1_sample.bin")
    assert status == 404


def test_path_traversal_rejected(server):
    base, _ = server
    for bad in ("%2e%2e%2fsecret.json", "..%5csecret.json", "sub%2ffile.json"):
        status, _, _ = req(f"{base}/api/local-sync/events/{bad}")
        assert status == 400
        status, _, _ = req(f"{base}/api/local-sync/files/{bad}")
        assert status == 400


def test_windows_batch_launchers_valid_crlf_ascii():
    for name in ("start-windows.bat", "start-windows-panel.bat"):
        raw = (ROOT / "desktop" / name).read_bytes()
        # Must be pure ASCII with CRLF line endings so cmd.exe never breaks on codepage seek
        raw.decode("ascii")
        assert b"\r\n" in raw
        assert b"\n" not in raw.replace(b"\r\n", b"")


def test_onedrive_proxy_strict_host_allowlist(server):
    base, _ = server
    for bad_url in (
        "http://127.0.0.1:4173/api/local-sync/ping",
        "https://evil.example.com/file.json",
        "https://1drv.com.evil.com/x",
        "file:///etc/passwd",
    ):
        q = urllib.parse.quote(bad_url, safe="")
        status, _, _ = req(f"{base}/api/onedrive-proxy?url={q}")
        assert status == 403
        status_put, _, _ = req(f"{base}/api/onedrive-upload-proxy?url={q}", method="PUT", data=b"abc")
        assert status_put == 403
    assert clouddrop.is_allowed_onedrive_url("https://my.microsoftpersonalcontent.com/personal/abc/item") is True
    assert clouddrop.is_allowed_onedrive_url("https://public.dm.files.1drv.com/y4mTest") is True
    assert clouddrop.is_allowed_onedrive_url("https://bn02pap001files.storage.live.com/upload/session") is True
    assert clouddrop.is_allowed_onedrive_url("https://api.onedrive.live.com/v1.0/upload") is True


def test_onedrive_proxy_streaming_and_retry_after(server, monkeypatch):
    import io

    base, _ = server
    sample_payload = b"V" * (600 * 1024)  # > 256 KB to exercise multi-chunk streaming
    captured_reqs: list[urllib.request.Request] = []

    class FakeResp:
        def __init__(self, status: int, body: bytes, headers: dict[str, str]):
            self.status = status
            self._buf = io.BytesIO(body)
            self.headers = headers

        def read(self, n: int = -1) -> bytes:
            return self._buf.read(n)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    real_urlopen = urllib.request.urlopen

    def fake_urlopen(request_obj, timeout=None):
        url = request_obj.full_url if isinstance(request_obj, urllib.request.Request) else str(request_obj)
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(request_obj, timeout=timeout)
        captured_reqs.append(request_obj)
        assert timeout == 120
        if request_obj.get_method() == "GET":
            return FakeResp(
                200,
                sample_payload,
                {"Content-Type": "video/mp4", "Content-Length": str(len(sample_payload))},
            )
        if "retry-429" in url:
            raise urllib.error.HTTPError(
                url,
                429,
                "Too Many Requests",
                {"Retry-After": "7", "Content-Type": "application/json"},
                io.BytesIO(b'{"error":"throttled"}'),
            )
        return FakeResp(
            202,
            b'{"nextExpectedRanges":["6553600-"]}',
            {"Content-Type": "application/json"},
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    # 1. Streaming GET preserves Content-Length & exact bytes
    dl_q = urllib.parse.quote("https://my.microsoftpersonalcontent.com/personal/big.mp4", safe="")
    status, headers, body = req(f"{base}/api/onedrive-proxy?url={dl_q}")
    assert status == 200
    assert headers.get("Content-Length") == str(len(sample_payload))
    assert body == sample_payload

    # 2. Chunked PUT forwards Content-Range + Content-Length and returns 202 JSON
    up_q = urllib.parse.quote("https://my.microsoftpersonalcontent.com/upload/session1", safe="")
    status, _, body = req(
        f"{base}/api/onedrive-upload-proxy?url={up_q}",
        method="PUT",
        data=b"chunk-data-1234",
        headers={"Content-Range": "bytes 0-14/100"},
    )
    assert status == 202
    assert json.loads(body)["nextExpectedRanges"] == ["6553600-"]
    put_req = captured_reqs[-1]
    assert put_req.get_header("Content-range") == "bytes 0-14/100"
    assert put_req.get_header("Content-length") == "15"

    # 3. 429 forwards Retry-After header cleanly
    up_429 = urllib.parse.quote("https://my.microsoftpersonalcontent.com/upload/retry-429", safe="")
    status, headers, _ = req(
        f"{base}/api/onedrive-upload-proxy?url={up_429}",
        method="PUT",
        data=b"chunk",
    )
    assert status == 429
    assert headers.get("Retry-After") == "7"


def test_logs_api_read_and_clear(tmp_path: Path):
    log_file = tmp_path / "clouddrop.log"
    clouddrop.setup_logging(log_file)
    clouddrop.logger.info("测试日志条目 alpha")

    srv = clouddrop.CloudDropServer(("127.0.0.1", 0), data_dir=tmp_path, lan_url=None, log_file=log_file)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        base = f"http://127.0.0.1:{port}"
        status, _, body = req(f"{base}/api/logs?tail=50")
        assert status == 200
        data = json.loads(body)
        assert data["ok"] is True
        assert any("测试日志条目 alpha" in line for line in data["lines"])

        status, _, _ = req(f"{base}/api/logs/clear", method="POST")
        assert status == 200

        status, _, body = req(f"{base}/api/logs?tail=50")
        assert status == 200
        data2 = json.loads(body)
        assert not any("测试日志条目 alpha" in line for line in data2["lines"])
    finally:
        srv.shutdown()
        srv.server_close()



