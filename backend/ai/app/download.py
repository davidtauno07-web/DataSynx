"""Fetches originals from object storage via short-lived presigned URLs."""

from __future__ import annotations

import contextlib
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import httpx

from .config import settings
from .errors import EngineFailed


@contextlib.contextmanager
def download(url: str | None, suffix: str = "") -> Iterator[Path]:
    if not url:
        raise EngineFailed("No source file URL was supplied for this item")

    cfg = settings()
    fd, name = tempfile.mkstemp(suffix=suffix, prefix="datasynx-")
    path = Path(name)
    written = 0
    try:
        with os.fdopen(fd, "wb") as handle, httpx.stream(
            "GET", url, timeout=cfg.download_timeout, follow_redirects=True
        ) as response:
            if response.status_code >= 400:
                raise EngineFailed(f"Source file could not be downloaded (HTTP {response.status_code})")
            for chunk in response.iter_bytes(1024 * 1024):
                written += len(chunk)
                if written > cfg.max_download_bytes:
                    raise EngineFailed("Source file exceeds the AI service download limit")
                handle.write(chunk)
        yield path
    except httpx.HTTPError as exc:
        raise EngineFailed(f"Source file could not be downloaded: {exc}") from exc
    finally:
        path.unlink(missing_ok=True)


def suffix_for(name: str) -> str:
    ext = Path(name).suffix
    return ext if len(ext) <= 10 else ""
