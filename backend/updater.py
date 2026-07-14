#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Apply an in-app update for the frozen (PyInstaller onedir) build.

The settings page can already *check* GitHub Releases (see version.py). This
module performs the actual install, in one of two ways.

THE LIGHT PATH — replace app/, keep the executable. This is what almost every
release takes. The .exe is only a launcher: the backend's source lives in `app/`
as plain .py files (see run_backend.py), so installing a new version means
unzipping a few hundred KB over that one folder. Nothing that gets replaced is a
file the OS has open, so there is no locked-file problem, no helper script and no
rollback to get right — the backend stages the new source in `.oasis-update/`,
relaunches itself, and exits; the fresh process swaps the folder in before it
imports anything from it. Whether this is possible is decided by the RUNTIME stamp
(version.py): it fingerprints the Python + requirements.txt the executable was
frozen against, so a release stamped the same runs on the .exe already installed.

THE FULL PATH — replace everything, executable included. Taken only when the new
release's RUNTIME differs, i.e. a dependency was added or Python was bumped, so
the frozen packages in the running .exe are not the ones the new source needs.
This is the expensive, dangerous one, and everything below it exists because of a
single OS rule: a running process cannot overwrite its own executable or its
loaded libraries. Hence:

  * The swap has to happen *after* this process is gone, so it is done by a
    detached OS-native helper script (sh / PowerShell), which also gets us
    `ditto`/`unzip`/`Expand-Archive` — needed to preserve the macOS bundle's
    symlinks and exec bits, which Python's zipfile would flatten.
  * The backend does NOT exit on its own on this path: it stays up and serving
    through the download, and the *helper* kills it. That keeps the
    "downloading → installing → restarting" progress reachable to the handoff.
  * The swap is all-or-nothing: old entries are renamed aside, new ones installed
    only once every rename succeeded, any failure rolls back. A locked file
    leaves the previous version running and reports why, instead of half-deleting
    the install.

User data (oasis.db, movies/, sites/) lives next to the executable but is NOT part
of either payload, so both paths leave it untouched.

Every step is logged to `.oasis-update/` (see _LOG_FILES). That folder isn't part
of the release zip, so the logs survive the swap and the relaunched backend can
serve them back through /api/update/logs — which is what the settings page shows
when an update doesn't take. Without them the whole failure happens in processes
that no longer exist by the time the user sees it.

Only meaningful for a frozen build; a source checkout updates via `git pull`
(the portal launcher already does this) and returns an error here.
"""

import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import zipfile
from datetime import datetime

import version

# Folder (next to the executable) that holds the downloaded zip, the generated
# helper script, and its log. Kept out of the way with a leading dot.
_WORK_DIRNAME = ".oasis-update"

# Where the light path leaves the extracted new source for run_backend.py to swap
# in on the next start. Both names are duplicated there — keep them in sync.
_PENDING_DIRNAME = "pending-app"
_WAIT_PID_ENV = "OASIS_UPDATE_WAIT_PID"

# Log files written under _WORK_DIRNAME, in the order they are produced. They are
# the only trace left once the helper kills this backend, and /api/update/logs
# serves them back to the settings page (see collect_logs) so a failed update can
# be diagnosed without the user digging through the install folder.
#   updater.log      — this module (download, helper spawn, failures)
#   update.log       — the helper script itself (kill, extract, swap, relaunch)
#   helper-output.log— the helper's raw stdout/stderr (Windows; catches a
#                      powershell that dies before reaching its own log)
#   backend.log      — the relaunched backend's console output (POSIX)
_LOG_FILES = ("updater.log", "update.log", "helper-output.log", "backend.log")

# Roll updater.log over at this size so a repeatedly-retried update can't grow it
# without bound (one previous generation is kept as updater.log.1).
_LOG_MAX_BYTES = 512 * 1024

# How long the helper waits after being spawned before it kills this backend.
# The gap lets the "installing" phase reach the polling UI and the last HTTP
# response flush before this process's files unlock for the swap.
_HANDOFF_GRACE_S = 1.5

# Shared state for the in-flight update, polled by /api/update/progress. Guarded
# by _lock since the download runs in a background thread. Phases:
#   idle        — nothing started
#   downloading — streaming the zip; `percent` is 0..100 (or -1 if the server
#                 sent no Content-Length so the size is unknown)
#   installing  — download done, helper spawned; this process is about to be
#                 killed by the helper (so this is the last phase we can report)
#   error       — download/spawn failed; the backend keeps running unchanged
_lock = threading.Lock()
_progress = {
    "phase": "idle",
    "percent": 0,
    "received": 0,
    "total": 0,
    "latest": None,
    "error": None,
}


def _set(**kw) -> None:
    with _lock:
        _progress.update(kw)


def get_progress() -> dict:
    """Snapshot of the current update progress (for /api/update/progress)."""
    with _lock:
        return dict(_progress)


def _base_dir() -> str:
    """Install folder holding the executable (and the user's data)."""
    return os.path.dirname(sys.executable)


def _log(message: str) -> None:
    """Append a timestamped line to updater.log (and the console).

    This is the *only* record of what this process did: once the download
    finishes, the helper kills the backend, so anything held in memory (an
    exception, the progress dict) is gone. The file lives next to the executable
    and survives the swap, so the relaunched build can serve it back — that is
    what turns "更新未生效" from a dead end into something diagnosable.

    Never raises: a broken log must not take the update down with it.
    """
    line = f"{datetime.now().isoformat(timespec='seconds')} [updater] {message}"
    print(line, flush=True)
    if not getattr(sys, "frozen", False):
        return  # source checkout: console only, don't litter the interpreter dir
    try:
        work = os.path.join(_base_dir(), _WORK_DIRNAME)
        os.makedirs(work, exist_ok=True)
        path = os.path.join(work, "updater.log")
        if os.path.exists(path) and os.path.getsize(path) > _LOG_MAX_BYTES:
            os.replace(path, path + ".1")
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _log_environment() -> None:
    """Record what this build is and where it lives, before touching anything.

    A surprising amount of update failures are explained by these lines alone:
    the wrong asset (PLATFORM stamp), a non-writable install dir (Program Files,
    read-only mount), or an install dir that isn't what we think it is.
    """
    base = _base_dir()
    app = _app_dir()
    _log(f"--- update run start (pid={os.getpid()}) ---")
    _log(f"version={version.app_version()} platform_stamp={version._bundled_file('PLATFORM')}")
    _log(f"runtime={version.runtime_stamp()}")
    _log(f"sys.platform={sys.platform} frozen={getattr(sys, 'frozen', False)}")
    _log(f"executable={sys.executable}")
    _log(f"base={base} writable={os.access(base, os.W_OK)}")
    _log(f"app={app} writable={os.access(app, os.W_OK)}")
    try:
        usage = __import__("shutil").disk_usage(base)
        _log(f"disk free={usage.free / (1 << 20):.0f} MiB")
    except OSError as exc:
        _log(f"disk usage unavailable: {exc}")


def _download(url: str, dest: str) -> None:
    """Stream the release asset to `dest`, updating `_progress` as bytes arrive.

    Raises on any network/HTTP error (the caller flips the phase to "error").
    """
    _log(f"download start url={url}")
    _log(f"download dest={dest}")
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": "oasis-updater"})
    with urllib.request.urlopen(request, timeout=30) as response, open(dest, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        _log(f"download http={response.status} content-length={total or 'unknown'}")
        received = 0
        # -1 percent signals "size unknown" to the UI (indeterminate progress).
        _set(received=0, total=total, percent=0 if total else -1)
        while True:
            chunk = response.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            received += len(chunk)
            # Cap at 99 until the file is fully written and closed below, so the
            # UI never shows 100% before the download has actually finished.
            if total:
                _set(received=received, percent=min(99, received * 100 // total))
            else:
                _set(received=received)
    size = os.path.getsize(dest)
    elapsed = time.monotonic() - started
    _log(f"download done bytes={size} expected={total or 'unknown'} in {elapsed:.1f}s")
    if size == 0:
        raise OSError("下載的更新檔為空")
    # A truncated zip extracts to a broken/partial build — catch it here, while
    # the backend is still alive and can report the error, rather than letting the
    # helper swap in rubble.
    if total and size != total:
        raise OSError(f"下載的更新檔不完整（{size}/{total} bytes）")
    _set(received=received, percent=100)


def _app_dir() -> str:
    """The loose backend source the executable runs (set by run_backend.py)."""
    return os.environ.get("OASIS_APP_DIR") or os.path.join(_base_dir(), "app")


def _extract_app(zip_path: str, dest: str) -> str:
    """Unpack the source-only payload; return the folder that holds api.py.

    Python's zipfile is enough here (the full path needs ditto/unzip): the payload
    is .py and .json text files, with no symlinks or exec bits to flatten.
    """
    shutil.rmtree(dest, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(dest)
    if os.path.isfile(os.path.join(dest, "api.py")):
        return dest
    # Tolerate a zip that wraps everything in a single folder.
    for name in sorted(os.listdir(dest)):
        inner = os.path.join(dest, name)
        if os.path.isfile(os.path.join(inner, "api.py")):
            return inner
    raise OSError("更新檔內容不正確（找不到 api.py）")


def _read_file(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _light_update(app_url: str, base: str, work: str) -> bool:
    """Install the new release by replacing app/ alone, and relaunch. Usually this.

    Returns False *having changed nothing on disk* when this release cannot be
    installed onto the running executable — no RUNTIME stamp to compare, or a
    RUNTIME that differs, meaning the new source wants packages this .exe did not
    freeze. The caller then falls back to the full swap.

    On success this function does not return: the process relaunches itself and
    exits, and the fresh one applies the staged folder before importing from it
    (run_backend.py). It is deliberately the *new* process that moves the
    directory — doing it here would pull the source out from under a running
    backend that may still lazily import from it.
    """
    installed_runtime = version.runtime_stamp()
    if not installed_runtime:
        _log("light update unavailable: this build carries no RUNTIME stamp")
        return False

    zip_path = os.path.join(work, "app.zip")
    _download(app_url, zip_path)

    staging = os.path.join(work, "staging-app")
    root = _extract_app(zip_path, staging)
    release_runtime = _read_file(os.path.join(root, "RUNTIME"))
    _log(f"runtime installed={installed_runtime} release={release_runtime}")
    if release_runtime != installed_runtime:
        _log("runtime differs — this release needs a rebuilt executable; using the full install")
        shutil.rmtree(staging, ignore_errors=True)
        return False

    pending = os.path.join(work, _PENDING_DIRNAME)
    shutil.rmtree(pending, ignore_errors=True)
    os.replace(root, pending)          # same filesystem: both live under base/
    shutil.rmtree(staging, ignore_errors=True)
    _log(f"staged new source at {pending} (version {_read_file(os.path.join(pending, 'VERSION'))})")

    # Announce "installing" before relaunching, so a poll landing in the handoff
    # grace sees it — this is the last phase this process can report.
    _set(phase="installing", percent=100)
    _relaunch_self(base, work)
    _log(f"relaunched; exiting in {_HANDOFF_GRACE_S}s so the new backend can take port and swap app/")
    time.sleep(_HANDOFF_GRACE_S)
    _log("=== handing over ===")
    # Hard exit, not a graceful uvicorn shutdown: we are on a worker thread with no
    # handle on the server, and the new backend is already blocked waiting for this
    # pid to disappear before it can bind the port. The full path is killed with
    # SIGKILL/Stop-Process at the same point, so nothing new is skipped here.
    os._exit(0)


def _relaunch_self(base: str, work: str) -> None:
    """Start a fresh copy of this executable, which will apply the staged update.

    The child is handed this pid: it waits for us to exit before touching app/ or
    binding port 8000 (see run_backend.py). Unlike the full path's helper this is
    our own console app, not powershell, so it needs no console hand-holding — but
    it does need CREATE_NEW_CONSOLE, since the console it inherits from us belongs
    to the launcher that is about to close, and CREATE_BREAKAWAY_FROM_JOB, since a
    child stays in the parent's job object and some launchers kill the job on
    close, which would take the new backend down with the old one.
    """
    env = dict(os.environ)
    env[_WAIT_PID_ENV] = str(os.getpid())

    if sys.platform == "win32":
        CREATE_NEW_CONSOLE = 0x00000010
        CREATE_BREAKAWAY_FROM_JOB = 0x01000000
        kwargs = dict(cwd=base, env=env, close_fds=True)
        try:
            proc = subprocess.Popen(
                [sys.executable],
                creationflags=CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB,
                **kwargs,
            )
            _log(f"relaunch spawned pid={proc.pid} (breakaway from job)")
        except OSError as exc:
            _log(f"breakaway spawn refused ({exc}); retrying without CREATE_BREAKAWAY_FROM_JOB")
            proc = subprocess.Popen(
                [sys.executable], creationflags=CREATE_NEW_CONSOLE, **kwargs
            )
            _log(f"relaunch spawned pid={proc.pid} (no breakaway)")
    else:
        out = open(os.path.join(work, "backend.log"), "ab")
        proc = subprocess.Popen(
            [sys.executable],
            cwd=base,
            env=env,
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=out,
            close_fds=True,
        )
        _log(f"relaunch spawned pid={proc.pid}")

    # If it died on the spot (blocked by antivirus, a broken install), nobody will
    # ever swap app/ in or serve the API again — and we are about to exit. Say so
    # in the log, which is the only thing that will still be around to say it.
    time.sleep(0.3)
    if proc.poll() is not None:
        _log(f"ERROR: relaunched backend exited immediately with code {proc.returncode}")


def _write_helper(base: str, work: str, zip_path: str, exe: str) -> str:
    """Write the OS-native updater script and return its path."""
    if sys.platform == "win32":
        return _write_helper_windows(base, work, zip_path, exe)
    return _write_helper_posix(base, work, zip_path, exe)


def _write_helper_posix(base: str, work: str, zip_path: str, exe: str) -> str:
    script = f"""#!/bin/sh
# Auto-generated by oasis updater.py — safe to delete.
BASE='{base}'
WORK='{work}'
ZIP='{zip_path}'
OLDPID={os.getpid()}
EXENAME='{os.path.basename(exe)}'
STAGING="$WORK/staging"
LOG="$WORK/update.log"
exec >>"$LOG" 2>&1
log() {{ echo "$(date '+%Y-%m-%dT%H:%M:%S') [helper] $*"; }}
log "=== oasis update start (helper pid $$) ==="
log "base=$BASE"
log "zip=$ZIP ($(wc -c <"$ZIP" 2>/dev/null) bytes)"
log "exe=$EXENAME  old backend pid=$OLDPID"
log "version before swap: $(cat "$BASE/_internal/VERSION" 2>/dev/null || echo '(none)')"

# 1. Stop the old backend ourselves — it does NOT exit on its own. The short
#    grace first lets the UI show "installing" and the last response flush.
#    SIGTERM, then escalate to SIGKILL if it hasn't unlocked its files (cap ~120s).
sleep {_HANDOFF_GRACE_S}
kill "$OLDPID" 2>/dev/null || true
i=0
while kill -0 "$OLDPID" 2>/dev/null; do
  sleep 0.5; i=$((i+1))
  [ "$i" -eq 20 ] && {{ log "backend still alive after 10s — escalating to SIGKILL"; kill -9 "$OLDPID" 2>/dev/null; }}
  [ "$i" -ge 240 ] && {{ log "ERROR: backend $OLDPID never exited (120s) — swapping anyway"; break; }}
done
sleep 1
log "old backend stopped after $((i / 2))s"

# 2. Extract the fresh build (native tools preserve symlinks + exec bits).
rm -rf "$STAGING"; mkdir -p "$STAGING"
if command -v ditto >/dev/null 2>&1; then
  log "extracting with ditto"
  ditto -x -k "$ZIP" "$STAGING" || log "ERROR: ditto exited $?"
else
  log "extracting with unzip"
  unzip -q -o "$ZIP" -d "$STAGING" || log "ERROR: unzip exited $?"
fi
log "staging top level: $(ls -A "$STAGING" 2>/dev/null | tr '\\n' ' ')"

# 3. Locate the app root (some zips wrap everything in a single folder).
ROOT="$STAGING"
if [ ! -e "$ROOT/$EXENAME" ]; then
  inner=$(find "$STAGING" -maxdepth 2 -name "$EXENAME" -print 2>/dev/null | head -n 1)
  [ -n "$inner" ] && ROOT=$(dirname "$inner")
fi
log "app root=$ROOT (new version: $(cat "$ROOT/_internal/VERSION" 2>/dev/null || echo '(none)'))"

if [ ! -e "$ROOT/$EXENAME" ]; then
  log "ERROR: new build is missing $EXENAME — aborting swap, relaunching old build"
else
  # 4. Swap the top-level entries into the install dir. oasis.db / movies/ aren't
  #    in the zip, so they're left in place.
  #
  #    All-or-nothing, in two passes, because a *partial* swap is the worst
  #    outcome available: the exe and _internal/ are one build (PyInstaller pairs
  #    them), so replacing one without the other leaves an app that won't start.
  #    Worse, the obvious implementation — `rm -rf old && mv new` — half-deletes
  #    the old build before it discovers it can't finish, so a locked file
  #    doesn't just fail the update, it destroys the working install.
  #
  #    So: rename every old entry aside first (a rename is atomic — it either
  #    works or nothing moved), and only once they've *all* moved do we install
  #    the new ones. Any failure in either pass rolls back to the old build,
  #    which then relaunches unchanged: "更新未生效" with a log, not a brick.
  #    BACKUP sits inside WORK (same filesystem as BASE) so no rename crosses a
  #    device boundary. Entry names come from our own release zip — no spaces.
  BACKUP="$WORK/backup"
  rm -rf "$BACKUP"; mkdir -p "$BACKUP"
  names=""
  for src in "$ROOT"/* "$ROOT"/.[!.]*; do
    [ -e "$src" ] || continue
    names="$names $(basename "$src")"
  done
  log "entries to swap:$names"

  # 4a. Move the old entries aside.
  moved=""
  failed=""
  for name in $names; do
    [ -e "$BASE/$name" ] || continue
    if mv "$BASE/$name" "$BACKUP/$name"; then
      moved="$moved $name"
    else
      failed="$name"
      log "ERROR: cannot move aside $name (locked by another process, or permission denied)"
      break
    fi
  done

  # 4b. Install the new entries — only if every old one moved.
  installed=""
  if [ -z "$failed" ]; then
    for name in $names; do
      if mv "$ROOT/$name" "$BASE/$name"; then
        installed="$installed $name"
        log "swapped $name"
      else
        failed="$name"
        log "ERROR: cannot install $name"
        break
      fi
    done
  fi

  # 4c. Roll back on any failure, so the old build is left runnable.
  if [ -n "$failed" ]; then
    log "ABORTING swap ($failed failed) — rolling back to the old build"
    for name in $installed; do rm -rf "$BASE/$name"; done
    for name in $moved; do
      if mv "$BACKUP/$name" "$BASE/$name"; then
        log "restored $name"
      else
        log "ERROR: could not restore $name — the install is now incomplete, reinstall manually"
      fi
    done
  else
    log "swap complete"
  fi
fi
log "version after swap: $(cat "$BASE/_internal/VERSION" 2>/dev/null || echo '(none)')"

# 5. Clear the download quarantine + ensure the exec bit, then relaunch.
xattr -dr com.apple.quarantine "$BASE" 2>/dev/null || true
chmod +x "$BASE/$EXENAME" 2>/dev/null || true
cd "$BASE"
"$BASE/$EXENAME" >"$WORK/backend.log" 2>&1 &
log "relaunched $EXENAME (pid $!)"

# 6. Cleanup (BACKUP holds the previous build's files — only the swapped-in ones,
#    since any restored entry was moved back out).
rm -rf "$STAGING" "$WORK/backup" "$ZIP"
log "=== done ==="
"""
    path = os.path.join(work, "apply-update.sh")
    with open(path, "w", encoding="utf-8") as f:
        f.write(script)
    os.chmod(path, 0o755)
    return path


def _write_helper_windows(base: str, work: str, zip_path: str, exe: str) -> str:
    exe_name = os.path.basename(exe)
    script = f"""# Auto-generated by oasis updater.py — safe to delete.
$Base   = '{base}'
$Work   = '{work}'
$Zip    = '{zip_path}'
$OldPid = {os.getpid()}
$ExeName = '{exe_name}'
$Staging = Join-Path $Work 'staging'
$Log     = Join-Path $Work 'update.log'
function Log($m) {{ Add-Content -LiteralPath $Log -Value ("{{0}} [helper] {{1}}" -f (Get-Date -Format o), $m) }}
function StampedVersion($dir) {{
  $f = Join-Path $dir '_internal\\VERSION'
  if (Test-Path -LiteralPath $f) {{ (Get-Content -LiteralPath $f -Raw).Trim() }} else {{ '(none)' }}
}}
function MoveEntry($src, $dst) {{
  # A real rename via .NET, NOT Move-Item: PowerShell's Move-Item copies a
  # directory and then deletes the source, so a file it can't read mid-way leaves
  # a half-copied destination *and* a half-deleted source. Directory.Move /
  # File.Move are single rename ops — they either succeed outright or throw with
  # both sides untouched, which is what makes the rollback below trustworthy.
  if (Test-Path -LiteralPath $src -PathType Container) {{ [IO.Directory]::Move($src, $dst) }}
  else {{ [IO.File]::Move($src, $dst) }}
}}
Log '=== oasis update start ==='
Log "base=$Base"
Log ("zip=$Zip ({{0}} bytes)" -f (Get-Item -LiteralPath $Zip -ErrorAction SilentlyContinue).Length)
Log "exe=$ExeName  old backend pid=$OldPid"
Log ("version before swap: " + (StampedVersion $Base))

# 1. Stop the old backend ourselves — it does NOT exit on its own. The short
#    grace first lets the UI show "installing" and the last response flush, then
#    force-stop it and wait for its files to unlock (cap ~120s).
Start-Sleep -Seconds {_HANDOFF_GRACE_S}
Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Process -Id $OldPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {{
  Start-Sleep -Milliseconds 500
}}
if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {{
  Log "ERROR: backend $OldPid still running after 120s - its files are still locked, swap will likely fail"
}} else {{
  Log "old backend stopped"
}}
Start-Sleep -Seconds 1

try {{
  # 2. Extract the fresh build.
  if (Test-Path -LiteralPath $Staging) {{ Remove-Item -LiteralPath $Staging -Recurse -Force }}
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null
  Expand-Archive -LiteralPath $Zip -DestinationPath $Staging -Force
  Log ("staging top level: " + ((Get-ChildItem -LiteralPath $Staging -Force | ForEach-Object {{ $_.Name }}) -join ', '))

  # 3. Locate the app root (some zips wrap everything in a single folder).
  $Root = $Staging
  if (-not (Test-Path -LiteralPath (Join-Path $Root $ExeName))) {{
    $found = Get-ChildItem -LiteralPath $Staging -Recurse -Filter $ExeName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {{ $Root = $found.DirectoryName }}
  }}
  Log ("app root=$Root (new version: " + (StampedVersion $Root) + ")")

  if (-not (Test-Path -LiteralPath (Join-Path $Root $ExeName))) {{
    Log "ERROR: new build is missing $ExeName - aborting swap"
  }} else {{
    # 4. Swap the top-level entries into the install dir. oasis.db / movies\\
    #    aren't in the zip, so they're left in place.
    #
    #    All-or-nothing, in two passes, because a *partial* swap is the worst
    #    outcome available: the .exe and _internal\\ are one build (PyInstaller
    #    pairs them), so replacing one without the other leaves an app that won't
    #    start. And the obvious implementation — Remove-Item the old, Move-Item
    #    the new — half-deletes the old build before it discovers it can't
    #    finish, so one locked file (antivirus still scanning the fresh .exe, an
    #    Explorer window open in _internal\\) doesn't just fail the update, it
    #    destroys the working install.
    #
    #    So: rename every old entry aside first, and only once they've *all*
    #    moved do we install the new ones. Any failure in either pass rolls back
    #    to the old build, which then relaunches unchanged — "更新未生效" with a
    #    log that says why, rather than a brick. Each move is retried a few
    #    times first, since the usual culprit is a transient antivirus handle.
    $Backup = Join-Path $Work 'backup'
    if (Test-Path -LiteralPath $Backup) {{ Remove-Item -LiteralPath $Backup -Recurse -Force }}
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null

    $names = @(Get-ChildItem -LiteralPath $Root -Force | ForEach-Object {{ $_.Name }})
    Log ("entries to swap: " + ($names -join ', '))

    # Rename with a few retries; returns $true on success, logs each attempt.
    function TryMove($src, $dst, $what) {{
      foreach ($attempt in 1..3) {{
        try {{
          MoveEntry $src $dst
          return $true
        }} catch {{
          Log ("$what attempt $attempt failed: " + $_.Exception.Message)
          Start-Sleep -Seconds 2
        }}
      }}
      return $false
    }}

    # 4a. Move the old entries aside.
    $moved = @()
    $failed = $null
    foreach ($name in $names) {{
      $dst = Join-Path $Base $name
      if (-not (Test-Path -LiteralPath $dst)) {{ continue }}
      if (TryMove $dst (Join-Path $Backup $name) "move aside $name") {{
        $moved += $name
      }} else {{
        $failed = $name
        Log "ERROR: cannot move aside $name (locked by another process?)"
        break
      }}
    }}

    # 4b. Install the new entries — only if every old one moved.
    $installed = @()
    if (-not $failed) {{
      foreach ($name in $names) {{
        if (TryMove (Join-Path $Root $name) (Join-Path $Base $name) "install $name") {{
          $installed += $name
          Log "swapped $name"
        }} else {{
          $failed = $name
          Log "ERROR: cannot install $name"
          break
        }}
      }}
    }}

    # 4c. Roll back on any failure, so the old build is left runnable.
    if ($failed) {{
      Log "ABORTING swap ($failed failed) - rolling back to the old build"
      foreach ($name in $installed) {{
        Remove-Item -LiteralPath (Join-Path $Base $name) -Recurse -Force -ErrorAction SilentlyContinue
      }}
      foreach ($name in $moved) {{
        if (TryMove (Join-Path $Backup $name) (Join-Path $Base $name) "restore $name") {{
          Log "restored $name"
        }} else {{
          Log "ERROR: could not restore $name - the install is now incomplete, reinstall manually"
        }}
      }}
    }} else {{
      Log 'swap complete'
    }}
  }}
}} catch {{
  Log ("EXCEPTION: " + $_.Exception.ToString())
}}
Log ("version after swap: " + (StampedVersion $Base))

# 5. Relaunch (new build if swapped, otherwise the old one is still in place).
try {{
  $p = Start-Process -FilePath (Join-Path $Base $ExeName) -WorkingDirectory $Base -PassThru
  Log ("relaunched $ExeName (pid " + $p.Id + ")")
}} catch {{
  Log ("ERROR: relaunch failed: " + $_.Exception.Message)
}}

# 6. Cleanup (the backup dir holds the previous build's files — only the ones that
#    were actually swapped out, since a restored entry was moved back).
$Trash = Join-Path $Work 'backup'
foreach ($path in @($Staging, $Trash, $Zip)) {{
  if (Test-Path -LiteralPath $path) {{ Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }}
}}
Log '=== done ==='
"""
    path = os.path.join(work, "apply-update.ps1")
    # utf-8-sig (BOM), not plain utf-8: PowerShell 5.1 decodes a BOM-less .ps1 as
    # the system ANSI codepage (cp950 on a Chinese Windows, etc.), which mangles
    # the non-ASCII text in this script — and mojibake that happens to contain a
    # quote or backtick turns a comment into a syntax error. The BOM makes it read
    # the file as UTF-8.
    with open(path, "w", encoding="utf-8-sig") as f:
        f.write(script)
    return path


def _spawn_detached(script: str) -> None:
    """Launch the helper so it outlives this process.

    Two Windows flags matter here, and getting the first one wrong is what made
    the auto-update silently do nothing:

      * CREATE_NO_WINDOW, *not* DETACHED_PROCESS. DETACHED_PROCESS gives the child
        no console at all, and powershell.exe simply will not run without one: it
        exits immediately with code 0, having executed not a single line of the
        -File script. No update.log, no swap, no relaunch, no error — the backend
        just sat there on "installing" and came back on the old version, which is
        exactly the "更新未生效" the user saw. CREATE_NO_WINDOW gives the helper a
        console but no visible window, which is what we actually wanted: invisible
        *and* running. (Verified with a spawn probe on Windows PowerShell 5.1.)
      * CREATE_BREAKAWAY_FROM_JOB, because the backend may be running inside a Job
        object (some launchers and terminals create one with KILL_ON_JOB_CLOSE).
        A child stays in the parent's job, so the instant this backend is killed
        the job closes and takes the helper with it. Breakaway pulls it out. If
        the job forbids breakaway (no JOB_OBJECT_LIMIT_BREAKAWAY_OK) CreateProcess
        fails with that flag, so we retry without it.

    The helper outliving this process needs neither flag — a Windows child is not
    killed when its parent dies — only the job and the console are hazards.
    """
    if sys.platform == "win32":
        CREATE_NO_WINDOW = 0x08000000
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_BREAKAWAY_FROM_JOB = 0x01000000
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
        base_flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        # Capture the helper's own stdout/stderr to a file (not DEVNULL): if
        # powershell is blocked or killed the instant it launches (e.g. antivirus
        # objecting to a spawned `-ExecutionPolicy Bypass -File` helper), it never
        # reaches its own update.log, so this is the only trace of what happened.
        out = open(os.path.join(os.path.dirname(script), "helper-output.log"), "ab")
        kwargs = dict(stdin=subprocess.DEVNULL, stdout=out, stderr=out, close_fds=True)
        try:
            proc = subprocess.Popen(
                cmd, creationflags=base_flags | CREATE_BREAKAWAY_FROM_JOB, **kwargs
            )
            _log(f"helper spawned pid={proc.pid} (breakaway from job)")
        except OSError as exc:
            _log(f"breakaway spawn refused ({exc}); retrying without CREATE_BREAKAWAY_FROM_JOB")
            proc = subprocess.Popen(cmd, creationflags=base_flags, **kwargs)
            _log(f"helper spawned pid={proc.pid} (no breakaway — may die with this process)")
    else:
        proc = subprocess.Popen(
            ["/bin/sh", script],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        _log(f"helper spawned pid={proc.pid}")
    # If the helper dies immediately (blocked by policy/antivirus, bad interpreter)
    # nothing will ever kill this backend or swap the files, and the UI would just
    # sit on "installing" until it times out. Give it a moment and say so.
    time.sleep(0.3)
    if proc.poll() is not None:
        _log(f"ERROR: helper exited immediately with code {proc.returncode} — no swap will happen")


def _full_update(download_url: str, base: str, work: str) -> None:
    """Download the whole install and hand off to the swap+relaunch helper.

    The fallback path, for when the executable itself has to be replaced. This
    process keeps serving progress right up to the handoff and is then killed by
    the helper — it never exits on its own, because it cannot overwrite the .exe
    and libraries it is running from.
    """
    zip_path = os.path.join(work, "download.zip")
    _download(download_url, zip_path)
    # Download done. Announce "installing" *before* spawning the helper so a
    # poll landing in the handoff grace sees it; the helper then kills us.
    _set(phase="installing", percent=100)
    script = _write_helper(base, work, zip_path, sys.executable)
    _log(f"helper written to {script}; handing off (this process is about to be killed)")
    _spawn_detached(script)
    _log("handoff done — waiting to be killed by the helper")


def _run_update(info: dict, base: str) -> None:
    """Background worker: install the release, preferring the light path.

    Runs off the request thread so the backend stays up and serving progress while
    the download streams. Any failure flips the phase to "error" and leaves the
    running backend untouched.
    """
    work = os.path.join(base, _WORK_DIRNAME)
    try:
        os.makedirs(work, exist_ok=True)

        app_url = info.get("app_download_url")
        if app_url and _light_update(app_url, base, work):
            return  # unreachable: _light_update exits the process on success

        download_url = info.get("download_url")
        if not download_url:
            raise OSError("這個版本需要重新安裝，但找不到適用於此系統的安裝檔")
        _log("installing the full build (executable included)")
        _full_update(download_url, base, work)
    except Exception as exc:  # download failed, disk full, spawn blocked, ...
        _log(f"ERROR: update failed: {exc!r}\n{traceback.format_exc()}")
        _set(phase="error", error=f"更新失敗：{exc}")


def apply_update(timeout: float = 6.0) -> dict:
    """Kick off an in-app update and return immediately; the backend stays up.

    Validates the request (frozen build, an update is actually available), then
    starts the download in a background thread and returns
    `{"status": "updating", "latest": <tag>}`. The frontend should poll
    /api/update/progress for the download percent and the "installing" phase,
    then poll /api/health for the relaunched backend. The download and the file
    swap run in the background; a helper — not this process — kills the backend
    once the download is done. Failures to *start* return
    `{"status": "error", "error": <msg>}` and leave the running backend intact;
    failures *during* the download surface via the progress "error" phase.
    """
    if not getattr(sys, "frozen", False):
        _log("apply_update refused: not a frozen build")
        return {
            "status": "error",
            "error": "自動更新僅適用於打包版。原始碼版本請用 git pull（啟動腳本會自動更新）。",
        }

    _log_environment()

    with _lock:
        if _progress["phase"] in ("downloading", "installing"):
            _log(f"apply_update ignored: already {_progress['phase']}")
            return {"status": "updating", "latest": _progress["latest"]}

    info = version.check_for_update(timeout)
    _log(
        f"check: current={info.get('current')} latest={info.get('latest')} "
        f"update_available={info.get('update_available')} "
        f"app_download_url={info.get('app_download_url')} "
        f"download_url={info.get('download_url')} error={info.get('error')}"
    )
    if info.get("error"):
        return {"status": "error", "error": info["error"]}
    if not info.get("update_available"):
        return {"status": "error", "error": "已是最新版本，沒有可用的更新。"}

    if not info.get("app_download_url") and not info.get("download_url"):
        return {"status": "error", "error": "找不到適用於此系統的更新下載檔。"}

    latest = info.get("latest")
    base = _base_dir()
    # Set "downloading" up front so a poll racing the thread start sees progress.
    _set(phase="downloading", percent=0, received=0, total=0, latest=latest, error=None)
    threading.Thread(target=_run_update, args=(info, base), daemon=True).start()
    _log(f"update to {latest} started in background")
    return {"status": "updating", "latest": latest}


def _read_tail(path: str, max_bytes: int) -> str | None:
    """Last `max_bytes` of a text file, or None if it isn't there / can't be read."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            data = f.read()
    except OSError:
        return None
    text = data.decode("utf-8", errors="replace")
    if size > max_bytes:
        text = f"…（略過前 {size - max_bytes} bytes）\n{text}"
    return text


def collect_logs(max_bytes: int = 64 * 1024) -> dict:
    """Everything needed to diagnose a failed update, for /api/update/logs.

    The update spans two processes and a helper script, and by the time the user
    sees "更新未生效" the interesting parts have all happened in processes that no
    longer exist. Their logs *do* survive in `.oasis-update/` (it isn't part of
    the release zip, so the swap leaves it alone), so the relaunched backend can
    read them back out — which beats telling the user to go find a dotfolder.

    Alongside the log tails, report what the install dir actually looks like now:
    a swap that failed on a locked file shows up as an old mtime on the exe or
    on `_internal/`, which is the difference between "the download failed" and
    "the files couldn't be replaced".
    """
    base = _base_dir()
    work = os.path.join(base, _WORK_DIRNAME)

    files = []
    for name in _LOG_FILES:
        path = os.path.join(work, name)
        text = _read_tail(path, max_bytes)
        try:
            modified = datetime.fromtimestamp(os.path.getmtime(path)).isoformat(
                timespec="seconds"
            )
        except OSError:
            modified = None
        files.append({"name": name, "modified": modified, "text": text})

    entries = []
    try:
        for name in sorted(os.listdir(base)):
            path = os.path.join(base, name)
            try:
                modified = datetime.fromtimestamp(os.path.getmtime(path)).isoformat(
                    timespec="seconds"
                )
            except OSError:
                modified = None
            entries.append({"name": name, "modified": modified})
    except OSError as exc:
        entries.append({"name": f"（無法列出安裝資料夾：{exc}）", "modified": None})

    return {
        "version": version.app_version(),
        "platform": sys.platform,
        "platform_stamp": version._bundled_file("PLATFORM"),
        # Which install path an update will take, and why: a light update swaps
        # app/ only, and needs the release's RUNTIME to match this one.
        "runtime": version.runtime_stamp(),
        "app": _app_dir(),
        "frozen": bool(getattr(sys, "frozen", False)),
        "pid": os.getpid(),
        "base": base,
        "work": work,
        "progress": get_progress(),
        "install_entries": entries,
        "files": files,
    }
