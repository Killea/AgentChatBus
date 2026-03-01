"""
Image upload hardening tests (QW-01).

Covers:
- Extension allowlist: .php / .exe / .svg rejected
- Magic bytes validation: mismatched content rejected
- Size cap: file exceeding _MAX_IMAGE_BYTES returns 413
- Valid uploads: .jpg, .png, .gif, .webp accepted
"""
import io
import os

import httpx
import pytest

BASE_URL = os.getenv("AGENTCHATBUS_BASE_URL", "http://127.0.0.1:39766")

# Real magic bytes for each supported format
_JPEG_MAGIC = b"\xff\xd8\xff" + b"\x00" * 10
_PNG_MAGIC  = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10
_GIF_MAGIC  = b"GIF89a" + b"\x00" * 10
_WEBP_MAGIC = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 10


def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/threads")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


def _upload(client: httpx.Client, filename: str, content: bytes, content_type: str = "image/jpeg"):
    return client.post(
        "/api/upload/image",
        files={"file": (filename, io.BytesIO(content), content_type)},
    )


# ─── Extension allowlist ─────────────────────────────────────────────────────

def test_upload_php_rejected():
    """.php extension must be rejected regardless of content."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "shell.php", _JPEG_MAGIC, "image/jpeg")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        assert "Unsupported" in r.text or "type" in r.text.lower()


def test_upload_exe_rejected():
    """.exe extension must be rejected."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "malware.exe", b"MZ\x90\x00", "application/octet-stream")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


def test_upload_svg_rejected():
    """.svg is excluded — can embed scripts (XSS vector)."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "xss.svg", b"<svg><script>alert(1)</script></svg>", "image/svg+xml")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


# ─── Magic bytes validation ───────────────────────────────────────────────────

def test_upload_wrong_magic_bytes_rejected():
    """A .jpg file whose content starts with PNG magic bytes must be rejected."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "fake.jpg", _PNG_MAGIC, "image/jpeg")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        assert "content" in r.text.lower() or "match" in r.text.lower()


def test_upload_renamed_text_as_jpg_rejected():
    """A plain text file renamed to .jpg must be rejected (no valid magic bytes)."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "not-an-image.jpg", b"Hello world, I am definitely not a JPEG", "image/jpeg")
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


# ─── Size cap ────────────────────────────────────────────────────────────────

def test_upload_oversized_file_rejected():
    """File larger than MAX_IMAGE_BYTES must return 413."""
    with _build_client() as client:
        _require_server_or_skip(client)
        max_bytes = int(os.getenv("AGENTCHATBUS_MAX_IMAGE_BYTES", str(5 * 1024 * 1024)))
        # Build a fake JPEG that exceeds the limit
        oversized = _JPEG_MAGIC + b"\x00" * (max_bytes + 1024)
        r = _upload(client, "huge.jpg", oversized, "image/jpeg")
        assert r.status_code == 413, f"Expected 413, got {r.status_code}: {r.text}"


# ─── Valid uploads ────────────────────────────────────────────────────────────

def test_upload_valid_jpeg_accepted():
    """A valid JPEG (correct magic bytes, allowed ext) must return 200 with a URL."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "photo.jpg", _JPEG_MAGIC, "image/jpeg")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert "url" in data
        assert data["url"].startswith("/static/uploads/")
        assert data["url"].endswith(".jpg")


def test_upload_valid_png_accepted():
    """A valid PNG must be accepted."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "screenshot.png", _PNG_MAGIC, "image/png")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        assert r.json()["url"].endswith(".png")


def test_upload_valid_gif_accepted():
    """A valid GIF must be accepted."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "anim.gif", _GIF_MAGIC, "image/gif")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        assert r.json()["url"].endswith(".gif")


def test_upload_valid_webp_accepted():
    """A valid WebP must be accepted."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _upload(client, "modern.webp", _WEBP_MAGIC, "image/webp")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        assert r.json()["url"].endswith(".webp")


def test_upload_no_file_rejected():
    """POST without a file must return 400."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post("/api/upload/image")
        assert r.status_code in (400, 422), f"Expected 400/422, got {r.status_code}: {r.text}"
