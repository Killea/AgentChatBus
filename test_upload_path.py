#!/usr/bin/env python3
"""Quick test for URL-to-local-path conversion."""
from pathlib import Path

def _url_to_local_upload_path(url: str) -> Path | None:
    """Map '/static/uploads/...' URLs to local files under src/static/uploads."""
    if not isinstance(url, str):
        return None
    if not url.startswith("/static/uploads/"):
        return None

    rel = url[len("/static/uploads/"):]
    print(f"  URL: {url}")
    print(f"  Relative path: {rel}")

    # dispatch.py is in src/tools/.
    # So Path(__file__).resolve().parent is src/tools/
    # parent[0] is src/, parent[1] is project root
    tools_dir = Path(__file__).resolve().parent
    src_dir = tools_dir / "src"  # In project root, so src/ is direct child
    uploads_root = src_dir / "static" / "uploads"
    
    print(f"  Tools dir: {tools_dir}")
    print(f"  Src dir: {src_dir}")
    print(f"  Uploads root: {uploads_root}")
    
    candidate = (uploads_root / rel).resolve()
    print(f"  Candidate path: {candidate}")
    print(f"  Candidate exists: {candidate.exists()}")

    # Validate that candidate is within uploads_root
    try:
        candidate.relative_to(uploads_root)
        print(f"  Relative check: OK")
    except ValueError as e:
        print(f"  Relative check FAILED: {e}")
        return None

    return candidate


if __name__ == "__main__":
    test_url = "/static/uploads/c954190b-5fb0-4c63-9e34-1deb6cfa0ae4.png"
    print(f"Testing URL: {test_url}")
    result = _url_to_local_upload_path(test_url)
    if result:
        print(f"Result: {result}")
        print(f"File exists: {result.exists()}")
        if result.exists():
            print(f"File size: {result.stat().st_size}")
    else:
        print("Result: None")
