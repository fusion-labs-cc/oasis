#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# oasis-portal.sh — Single entry point for the Oasis project.
#
# Usage:  ./oasis-portal.sh
#
# This script will:
#   1. Check all required system dependencies
#   2. Create a Python virtual environment (if needed)
#   3. Install Python packages from requirements.txt
#   4. Install Node.js packages for the frontend
#   5. Create necessary directories
#   6. Start the FastAPI backend + Next.js frontend
# ─────────────────────────────────────────────────────────────

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

# Run only the backend (for users of the public website who host the API
# locally and don't need the frontend on their machine): ./oasis-portal.sh --backend-only
BACKEND_ONLY=0
if [ "$1" = "--backend-only" ]; then
    BACKEND_ONLY=1
fi

VENV_DIR="./oasis"
PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

# ── Progress console helpers ─────────────────────────────────
# Run a long, otherwise-silent command with a live spinner so the
# terminal never looks frozen. On success, collapse to a ✅ line.
# On failure, print the captured output and stop the script.

STEP=0
TOTAL=6

step() {                       # step "Message"
    STEP=$((STEP + 1))
    printf "\n\033[1m[%d/%d] %s\033[0m\n" "$STEP" "$TOTAL" "$1"
}

run_spin() {                   # run_spin "Doing thing…" cmd arg1 arg2 …
    local msg=$1; shift
    local log; log="$(mktemp)"
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local start; start=$SECONDS

    "$@" >"$log" 2>&1 &
    local pid=$!
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        i=$(((i + 1) % ${#frames}))
        printf "\r  %s %s (%ds)" "${frames:$i:1}" "$msg" "$((SECONDS - start))"
        sleep 0.1
    done

    if wait "$pid"; then
        printf "\r  \033[32m✅\033[0m %s (%ds)%20s\n" "$msg" "$((SECONDS - start))" ""
        rm -f "$log"
    else
        local rc=$?
        printf "\r  \033[31m❌\033[0m %s — failed%20s\n" "$msg" ""
        echo "     ─── output ───────────────────────────────"
        sed 's/^/     /' "$log"
        echo "     ──────────────────────────────────────────"
        rm -f "$log"
        exit $rc
    fi
}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  🎬 Oasis — Project Setup            ║"
echo "╚══════════════════════════════════════╝"

# ── 0. Keep the project up to date ──────────────────────────
# Pull the latest code from the public repo before doing anything else.
# Failures here (offline, no network) must not stop startup, so they're
# handled softly. --ff-only never creates a merge commit or clobbers local edits.
if command -v git >/dev/null 2>&1 && [ -d "$PROJECT_ROOT/.git" ]; then
    echo ""
    echo "🔄 Checking for updates..."
    export GIT_TERMINAL_PROMPT=0          # never hang on a credential prompt
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    if OUT="$(git pull --ff-only origin "$BRANCH" 2>&1)"; then
        echo "$OUT" | sed "s/^/  /"
        echo "  ✅ Project is up to date"
    else
        echo "$OUT" | sed "s/^/  /"
        echo "  ⚠️  Update skipped (couldn't reach GitHub) — continuing with local copy"
    fi
fi

# ── 1. Check system dependencies ────────────────────────────

step "Checking system dependencies"

MISSING=()

# Python 3
if command -v python3 &>/dev/null; then
    echo "  ✅ $(python3 --version 2>&1)"
else
    MISSING+=("python3  — https://www.python.org/downloads/")
fi

# Node.js
if command -v node &>/dev/null; then
    echo "  ✅ Node.js $(node --version 2>&1)"
else
    MISSING+=("node     — https://nodejs.org/")
fi

# npm
if command -v npm &>/dev/null; then
    echo "  ✅ npm $(npm --version 2>&1)"
else
    MISSING+=("npm      — comes with Node.js")
fi

# ffmpeg (needed for video encoding)
# Note: presence check only — don't run `ffmpeg -version`. Some builds
# (e.g. the imageio-ffmpeg bundled binary) read stdin and hang on -version.
if command -v ffmpeg &>/dev/null; then
    echo "  ✅ ffmpeg ($(command -v ffmpeg))"
elif [[ "$OSTYPE" != "darwin"* ]] && command -v apt-get &>/dev/null; then
    echo "  ⚠️  ffmpeg not found — it's needed for video encoding."
    echo "  🔐 Installing it requires sudo. Please enter your password if prompted:"
    if sudo -v; then
        run_spin "Updating apt package lists" sudo apt-get update
        run_spin "Installing ffmpeg"          sudo apt-get install -y ffmpeg
        hash -r
        echo "  ✅ ffmpeg ($(command -v ffmpeg))"
    else
        MISSING+=("ffmpeg   — sudo apt install ffmpeg")
    fi
else
    MISSING+=("ffmpeg   — brew install ffmpeg (macOS) / apt install ffmpeg (Linux)")
fi

# Google Chrome / Chromium (needed for Selenium — a Linux-side browser is
# required on WSL; the Windows chrome.exe won't work with a Linux driver)
CHROME_FOUND=false
if [[ "$OSTYPE" == "darwin"* ]]; then
    if [ -d "/Applications/Google Chrome.app" ]; then
        CHROME_FOUND=true
        CHROME_VERSION=$("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>/dev/null | awk '{print $NF}')
        echo "  ✅ Google Chrome $CHROME_VERSION"
    fi
else
    for chrome_bin in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$chrome_bin" &>/dev/null; then
            CHROME_FOUND=true
            echo "  ✅ $chrome_bin $("$chrome_bin" --version 2>/dev/null | awk '{print $NF}')"
            break
        fi
    done
fi

# On Linux/WSL, offer to install Chrome automatically instead of aborting.
if [ "$CHROME_FOUND" = false ] && [[ "$OSTYPE" != "darwin"* ]] && command -v apt-get &>/dev/null; then
    echo "  ⚠️  Google Chrome not found — it's needed for video downloads."
    echo "  🔐 Installing it requires sudo. Please enter your password if prompted:"
    if sudo -v; then
        TMP_DEB="$(mktemp --suffix=.deb)"
        run_spin "Downloading Google Chrome" \
            curl -fsSL -o "$TMP_DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
        run_spin "Installing Google Chrome" \
            sudo apt-get install -y "$TMP_DEB"
        rm -f "$TMP_DEB"
        CHROME_FOUND=true
        echo "  ✅ Google Chrome $(google-chrome --version 2>/dev/null | awk '{print $NF}')"
    fi
fi

if [ "$CHROME_FOUND" = false ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        MISSING+=("chrome   — https://www.google.com/chrome/ (needed for video downloads)")
    else
        MISSING+=("chrome   — sudo apt install ./google-chrome-stable_current_amd64.deb (needed for video downloads)")
    fi
fi

# Abort if anything is missing
if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    echo "❌ Missing required dependencies:"
    echo ""
    for dep in "${MISSING[@]}"; do
        echo "   • $dep"
    done
    echo ""
    echo "Please install the above and run this script again."
    exit 1
fi

# ── 2. Python virtual environment ───────────────────────────

step "Python virtual environment"

# Treat the venv as ready only if pip exists inside it (a half-created venv
# from a previous failed run leaves bin/python but no pip).
if [ -x "$PIP" ]; then
    echo "  ✅ Already exists at $VENV_DIR/"
else
    # On Debian/Ubuntu, `python3 -m venv` needs the python3-venv package
    # (ensurepip). Install it automatically if it's missing.
    if [[ "$OSTYPE" != "darwin"* ]] && command -v apt-get &>/dev/null \
       && ! python3 -c "import ensurepip" &>/dev/null; then
        PYVER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        echo "  ⚠️  python3-venv is missing — it's needed to create the virtualenv."
        echo "  🔐 Installing it requires sudo. Please enter your password if prompted:"
        if sudo -v; then
            run_spin "Installing python${PYVER}-venv" sudo apt-get install -y "python${PYVER}-venv"
            hash -r
        else
            echo "  ❌ Cannot create the virtualenv without python3-venv." >&2
            exit 1
        fi
    fi

    # Remove any partial venv left by a previous failed attempt, then create.
    rm -rf "$VENV_DIR"
    run_spin "Creating virtual environment at $VENV_DIR/" python3 -m venv "$VENV_DIR"
fi

# ── 3. Install Python dependencies ──────────────────────────

step "Installing Python dependencies"

run_spin "Upgrading pip"               "$PIP" install -q --upgrade pip
run_spin "Installing requirements.txt" "$PIP" install -q -r backend/requirements.txt

# ── 4. Install Node.js dependencies ─────────────────────────

step "Installing Node.js dependencies"

# Check if we need to run npm install. We run it if:
#   1. The next binary is missing (interrupted/failed install).
#   2. The node_modules .package-lock.json does not exist.
#   3. package.json or package-lock.json is newer than node_modules/.package-lock.json.
NEED_INSTALL=false
if [ ! -x "web/node_modules/.bin/next" ] || [ ! -f "web/node_modules/.package-lock.json" ]; then
    NEED_INSTALL=true
elif [ "web/package.json" -nt "web/node_modules/.package-lock.json" ] || [ "web/package-lock.json" -nt "web/node_modules/.package-lock.json" ]; then
    NEED_INSTALL=true
fi

if [ "$NEED_INSTALL" = true ]; then
    run_spin "Running npm install" \
        bash -c 'cd web && (npm install || (echo "⚠️ npm install failed. Retrying with --legacy-peer-deps..." && npm install --legacy-peer-deps))'
else
    echo "  ✅ node_modules already present and up to date"
fi

# ── 5. Create required directories ──────────────────────────

step "Preparing directories"

mkdir -p movies
echo "  ✅ movies/ ready"

# ── 6. Start servers ────────────────────────────────────────

step "Starting services"

echo "  🟢 FastAPI backend  → http://localhost:8000"
# No --reload: this is the end-user launcher, and auto-reload restarts the
# server (wiping the in-memory download queue) whenever a .py file changes,
# which orphans the active download and drops queued ones. The Windows launcher
# omits it too. (Interrupted downloads still resume from the DB on the next
# start via the download_pending flag; for live code editing run uvicorn with
# --reload manually — see README.)
"$PYTHON" -m uvicorn api:app --app-dir backend --port 8000 &
API_PID=$!

if [ "$BACKEND_ONLY" = "1" ]; then
    trap 'echo -e "\n🛑 Shutting down backend..."; kill $API_PID 2>/dev/null; exit' SIGINT SIGTERM
    echo ""
    echo "══════════════════════════════════════"
    echo "  ✅ Backend is running (backend-only mode)!"
    echo ""
    echo "  Backend:   http://localhost:8000"
    echo "  Open the public website in your browser; it will connect here."
    echo ""
    echo "  Press Ctrl+C to stop."
    echo "══════════════════════════════════════"
    echo ""
    wait $API_PID
    exit 0
fi

# Wait a moment for the API to bind
sleep 2

echo "  🟢 Next.js frontend → http://localhost:3000"
(cd web && npm run dev) &
WEB_PID=$!

# Graceful shutdown on Ctrl+C
trap 'echo -e "\n🛑 Shutting down servers..."; kill $API_PID $WEB_PID 2>/dev/null; exit' SIGINT SIGTERM

echo ""
echo "══════════════════════════════════════"
echo "  ✅ Both servers are running!"
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:8000"
echo ""
echo "  Press Ctrl+C to stop both."
echo "══════════════════════════════════════"
echo ""

# Wait for both processes
wait $API_PID $WEB_PID
