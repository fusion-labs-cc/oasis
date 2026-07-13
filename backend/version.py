#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resolve this build's version and check GitHub Releases for a newer one.

The version string is the git tag that produced the release (e.g. "v0.1.3"),
written into a VERSION file by CI at build time and bundled into the frozen app
(see oasis-backend.spec). A plain source checkout has no VERSION file and reads
back "dev", which is deliberately treated as "never behind" so local dev builds
are not nagged to update.
"""

import json
import os
import sys
import urllib.request

# Public repo the releases are published to. Used only to build the read-only
# GitHub API / download URLs below.
GITHUB_REPO = "fusion-labs-cc/oasis"

# Fallback map from sys.platform to the release asset name, used only when the
# build carries no PLATFORM stamp (source checkout, or a build made before CI
# started stamping). The stamped value is authoritative — see _asset_name_for_os.
_ASSET_BY_PLATFORM = {
    "win32": "oasis-backend-win64.zip",
    "darwin": "oasis-backend-macos-arm64.zip",
}


def _bundled_file(name: str) -> str | None:
    """Read a CI-stamped file bundled into the build, or None if absent/empty.

    Looks in, in order: the frozen bundle root (_MEIPASS), the repo root (one
    level above backend/), and this package dir. CI writes these (VERSION,
    PLATFORM) at the repo root before freezing; oasis-backend.spec bundles them.
    """
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(os.path.join(meipass, name))
    here = os.path.abspath(os.path.dirname(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", name)))
    candidates.append(os.path.join(here, name))
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as f:
                value = f.read().strip()
        except OSError:
            continue
        if value:
            return value
    return None


def app_version() -> str:
    """This build's version string, or "dev" for an un-stamped source checkout."""
    return _bundled_file("VERSION") or "dev"


def _parse_version(value: str | None) -> tuple[int, ...] | None:
    """Parse a "vX.Y.Z" tag into a comparable tuple, or None if not numeric.

    Anything that is not a plain numeric version (e.g. "dev", a branch name on
    a manual build) returns None so it is never reported as behind or ahead.
    """
    if not value:
        return None
    cleaned = value.strip().lstrip("vV")
    parts = cleaned.split(".")
    try:
        return tuple(int(p) for p in parts[:3])
    except ValueError:
        return None


def _is_newer(latest: str | None, current: str | None) -> bool:
    latest_parsed = _parse_version(latest)
    current_parsed = _parse_version(current)
    if latest_parsed is None or current_parsed is None:
        return False
    return latest_parsed > current_parsed


def _asset_name_for_os() -> str | None:
    """The release asset to download when updating this build.

    Prefers the exact asset name CI stamped into the build (PLATFORM file), so
    the updater fetches the same variant it was installed as. Falls back to a
    sys.platform guess for un-stamped builds.
    """
    return _bundled_file("PLATFORM") or _ASSET_BY_PLATFORM.get(sys.platform)


def check_for_update(timeout: float = 6.0) -> dict:
    """Compare this build against the latest GitHub Release.

    Returns a dict the frontend renders on the settings page. Network/API
    failures are non-fatal: they resolve to update_available=False plus an
    `error` message so the UI can say "couldn't check" instead of breaking.
    """
    current = app_version()
    result: dict = {
        "current": current,
        "latest": None,
        "update_available": False,
        "release_url": f"https://github.com/{GITHUB_REPO}/releases/latest",
        "download_url": None,
    }

    api_url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    request = urllib.request.Request(
        api_url,
        headers={
            # GitHub rejects API requests without a User-Agent.
            "User-Agent": "oasis-updater",
            "Accept": "application/vnd.github+json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # network down, rate-limited, no releases yet, ...
        result["error"] = f"無法檢查更新：{exc}"
        return result

    latest = data.get("tag_name")
    result["latest"] = latest
    result["release_url"] = data.get("html_url") or result["release_url"]

    wanted = _asset_name_for_os()
    if wanted:
        for asset in data.get("assets", []):
            if asset.get("name") == wanted:
                result["download_url"] = asset.get("browser_download_url")
                break

    result["update_available"] = _is_newer(latest, current)
    return result
