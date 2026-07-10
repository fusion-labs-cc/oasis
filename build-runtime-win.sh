#!/usr/bin/env bash
#
# build-runtime-win.sh — Assemble a self-contained Windows runtime for Oasis.
#
# Runs on the maintainer's machine (macOS/Linux) and produces, inside the repo:
#
#   python/          A Python 3.11 "embeddable" interpreter with every backend
#                    dependency pre-installed (including native win_amd64 wheels
#                    such as pycryptodome / pydantic-core). No installer, no PATH
#                    edits, no venv on the user's machine.
#   bin/ffmpeg.exe   A static FFmpeg build.
#
# Both live under paths that .gitignore excludes, so `git pull` auto-updates only
# tracked source and never clobbers the bundled runtime. oasis-portal.ps1 just
# runs the bundled python.
#
# Finally it packages everything (source + .git + runtime) into a
# ready-to-ship oasis-portal-win64.zip — hand that single file to the end user.
#
# Why this exists: doing the install at runtime on the user's Windows box (winget,
# python.org installer, PATH refresh, run-twice) fails on too many machines. Here
# we resolve and fetch everything once, on a machine we control.
#
# Re-run any time deps or versions change. Idempotent: it rebuilds from scratch.
set -euo pipefail

# ---- Config -----------------------------------------------------------------
PY_VERSION="3.11.9"          # must match PY_ABI below
PY_ABI="311"                 # cp311 wheels
FFMPEG_URL="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
ZIP_NAME="oasis-portal-win64.zip"   # ready-to-ship artifact produced in step 5

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQ="$REPO_ROOT/backend/requirements.txt"
PY_EMBED_URL="https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Building Windows runtime for Oasis (Python ${PY_VERSION})"
echo "    repo: $REPO_ROOT"

# ---- 1. Resolve the exact dependency set, minus non-Windows-only packages ----
# We resolve normally first so pip picks a mutually-compatible version set, then
# strip uvloop. uvloop is marked "sys_platform != win32" and has no Windows wheel;
# pip's --platform flag does NOT override that marker, so it must be removed by
# hand or the cross-download below fails.
echo "==> [1/5] Resolving dependency lock..."
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q --upgrade pip
"$WORK/venv/bin/pip" install -q -r "$REQ"
"$WORK/venv/bin/pip" freeze | grep -viE '^uvloop==' > "$WORK/lock-win.txt"
echo "    locked $(wc -l < "$WORK/lock-win.txt" | tr -d ' ') packages"

# ---- 2. Download the Python embeddable interpreter ---------------------------
echo "==> [2/5] Downloading Python ${PY_VERSION} embeddable..."
curl -fsSL "$PY_EMBED_URL" -o "$WORK/python-embed.zip"
rm -rf "$REPO_ROOT/python"
mkdir -p "$REPO_ROOT/python"
unzip -q "$WORK/python-embed.zip" -d "$REPO_ROOT/python"

# The embeddable ships with an isolated sys.path. Enable site-packages and the
# `site` module so pip-installed packages import cleanly.
PTH="$REPO_ROOT/python/python${PY_ABI}._pth"
{
  echo "python${PY_ABI}.zip"
  echo "."
  echo "Lib\\site-packages"
  echo "import site"
} > "$PTH"

# ---- 3. Install all deps into the embeddable's site-packages -----------------
# pip only *unpacks* wheels here (no build, no code execution), so cross-platform
# install from macOS works: native packages land as their win_amd64 .pyd files.
echo "==> [3/5] Installing dependencies into the bundled interpreter..."
SITE="$REPO_ROOT/python/Lib/site-packages"
mkdir -p "$SITE"
"$WORK/venv/bin/pip" install \
  --no-deps --only-binary=:all: \
  --platform win_amd64 --python-version "$PY_ABI" --abi "cp${PY_ABI}" --implementation cp \
  --target "$SITE" \
  -r "$WORK/lock-win.txt"

# ---- 4. Bundle a static FFmpeg -----------------------------------------------
# ffmpeg rarely changes and the archive is ~100MB, so reuse an already-bundled
# copy instead of re-downloading. Delete bin/ffmpeg.exe to force a fresh fetch.
# The gyan.dev "essentials" build is GPL-3.0 (it links libx264/x265), so its
# LICENSE ships alongside the binary; see THIRD-PARTY-LICENSES.txt.
mkdir -p "$REPO_ROOT/bin"
if [ -f "$REPO_ROOT/bin/ffmpeg.exe" ]; then
  echo "==> [4/6] FFmpeg already bundled — skipping download."
  if [ ! -f "$REPO_ROOT/bin/ffmpeg-LICENSE.txt" ]; then
    echo "    [WARN] bin/ffmpeg-LICENSE.txt is missing. Delete bin/ffmpeg.exe and"
    echo "           re-run to re-fetch it, or drop the build's LICENSE there by hand"
    echo "           (GPL-3.0 requires the license to accompany the binary)."
  fi
else
  echo "==> [4/6] Downloading FFmpeg static build..."
  curl -fsSL "$FFMPEG_URL" -o "$WORK/ffmpeg.zip"
  unzip -q "$WORK/ffmpeg.zip" -d "$WORK/ffmpeg"
  FFMPEG_EXE="$(find "$WORK/ffmpeg" -name 'ffmpeg.exe' | head -1)"
  cp "$FFMPEG_EXE" "$REPO_ROOT/bin/ffmpeg.exe"
  # Ship the build's own license text (full GPL-3.0 + component notices) so the
  # redistributed binary stays GPL-compliant.
  FFMPEG_LICENSE="$(find "$WORK/ffmpeg" -iname 'LICENSE*' | head -1)"
  if [ -n "$FFMPEG_LICENSE" ]; then
    cp "$FFMPEG_LICENSE" "$REPO_ROOT/bin/ffmpeg-LICENSE.txt"
  else
    echo "    [WARN] No LICENSE file found in the FFmpeg archive; add it manually."
  fi
fi

# ---- 5. Package the ready-to-ship zip ----------------------------------------
# Stage the whole repo (source + .git + bundled runtime) into a clean copy,
# dropping only dev cruft. .git is kept ON PURPOSE so the delivered folder is a
# working repo that auto-updates from the public origin via `git pull`.
echo "==> [5/6] Packaging $ZIP_NAME ..."
STAGE="$WORK/stage/oasis"
mkdir -p "$STAGE"
rsync -a \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude 'oasis/' \
  --exclude 'movies/' \
  --exclude '*.mp4' --exclude '*.jpg' --exclude '*.m3u8' \
  --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '*.db' \
  --exclude '.DS_Store' \
  --exclude "$ZIP_NAME" \
  "$REPO_ROOT/" "$STAGE/"
rm -f "$REPO_ROOT/$ZIP_NAME"
( cd "$WORK/stage" && zip -rqX "$REPO_ROOT/$ZIP_NAME" oasis )

# ---- 6. Report ---------------------------------------------------------------
echo "==> [6/6] Done."
echo ""
echo "    python/          $(du -sh "$REPO_ROOT/python" | cut -f1)"
echo "    bin/ffmpeg.exe   $(du -h "$REPO_ROOT/bin/ffmpeg.exe" | cut -f1)"
echo "    $ZIP_NAME   $(du -h "$REPO_ROOT/$ZIP_NAME" | cut -f1)"
echo ""
echo "    Hand $ZIP_NAME to users. They extract it and double-click"
echo "    oasis-portal.bat — no Python, pip, or FFmpeg install happens on their"
echo "    machine. (Google Chrome is still required; the portal checks for it.)"
