#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resolve this build's version and check GitHub Releases for a newer one.

The version string is the git tag that produced the release (e.g. "v0.1.3"),
written into a VERSION file by CI at build time. A plain source checkout has no
VERSION file and reads back "dev", which is deliberately treated as "never
behind" so local dev builds are not nagged to update.

Two stamps, and *where* they live is the whole point:

  VERSION — ships inside the app payload (`app/`, the loose backend source). It
    identifies the code, and the code is what a light update replaces, so the
    version has to travel with it.
  RUNTIME — ships inside the frozen bundle (`_internal/`). It fingerprints what
    the .exe actually froze: the Python version and requirements.txt. It only
    changes when the executable has to be rebuilt.

That split is what lets a release ship as a few hundred KB of .py files: if a new
release's RUNTIME matches the running executable's, its source runs on the
executable the user already has, and only `app/` needs replacing. If it doesn't
(a dependency was added, Python was bumped), updater.py falls back to swapping the
whole install. See run_backend.py.
"""

import json
import os
import sys
import urllib.request

# Public repo the releases are published to. Used only to build the read-only
# GitHub API / download URLs below.
GITHUB_REPO = "fusion-labs-cc/oasis"

# The OS-independent release asset holding just the backend source: the payload of
# a light update. Carries its own VERSION and the RUNTIME it was built against.
APP_ASSET_NAME = "oasis-app.zip"

# Fallback map from sys.platform to the full-install release asset name, used only
# when the build carries no PLATFORM stamp (source checkout, or a build made
# before CI started stamping). The stamped value is authoritative — see
# _asset_name_for_os.
_ASSET_BY_PLATFORM = {
    "win32": "oasis-backend-win64.zip",
    "darwin": "oasis-backend-macos-arm64.zip",
}


def _read_stamp(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _bundled_file(name: str) -> str | None:
    """Read a stamp frozen into the executable (_internal/), or None if absent.

    This is for stamps that describe *the executable* — PLATFORM (which release
    asset this build was installed from) and RUNTIME. Falls back to the repo root
    for a source checkout, where nothing is frozen.
    """
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(os.path.join(meipass, name))
    here = os.path.abspath(os.path.dirname(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", name)))
    candidates.append(os.path.join(here, name))
    for path in candidates:
        value = _read_stamp(path)
        if value:
            return value
    return None


def _app_file(name: str) -> str | None:
    """Read a stamp shipped in the app payload (next to the backend source).

    VERSION lives here rather than in the frozen bundle: a light update replaces
    only the source, and the new source has to report the new version — an .exe
    that never changes cannot carry it.
    """
    here = os.path.abspath(os.path.dirname(__file__))
    candidates = [os.path.join(here, name)]
    app_dir = os.environ.get("OASIS_APP_DIR")
    if app_dir:
        candidates.insert(0, os.path.join(app_dir, name))
    for path in candidates:
        value = _read_stamp(path)
        if value:
            return value
    return None


def app_version() -> str:
    """This build's version string, or "dev" for an un-stamped source checkout."""
    # _bundled_file is the fallback for installs made before VERSION moved into
    # the app payload — they still have it in _internal/, and reading "dev" there
    # would make the app look downgraded and refuse to update.
    return _app_file("VERSION") or _bundled_file("VERSION") or "dev"


def runtime_stamp() -> str | None:
    """Fingerprint of the frozen runtime (Python version + requirements.txt).

    Compared against the RUNTIME a release was built with to decide whether that
    release's source can run on the executable the user already has. None for a
    source checkout, and for frozen builds made before this stamp existed — both
    of which are treated as "can't do a light update".
    """
    return _bundled_file("RUNTIME")


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
        # The full install (exe + runtime + source), and the source-only payload.
        # updater.py prefers the latter and falls back to the former; see there.
        "download_url": None,
        "app_download_url": None,
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
    for asset in data.get("assets", []):
        name = asset.get("name")
        if wanted and name == wanted:
            result["download_url"] = asset.get("browser_download_url")
        elif name == APP_ASSET_NAME:
            result["app_download_url"] = asset.get("browser_download_url")

    result["update_available"] = _is_newer(latest, current)
    return result
