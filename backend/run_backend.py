#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Frozen entry point for the OASIS backend (PyInstaller onedir build).

In a normal checkout the API is served with:
    uvicorn api:app --app-dir backend --port 8000

That does not work once frozen: there is no source tree to --app-dir into. This
shim is the packaged executable's __main__.

THE EXECUTABLE IS A LAUNCHER, NOT THE APP. Only this file, the Python runtime
and the third-party packages are frozen into the .exe / _internal/. The backend's
own source (api.py, download.py, ... and the site adapters) ships as plain files
in `app/` next to the executable and is imported from disk at runtime — see
oasis-backend.spec, which strips those modules back out of the frozen archive so
the loose copies are the ones that get imported.

That split is what makes updates cheap: shipping new backend code means replacing
a few hundred KB of .py files, and *nothing that is replaced is a file Windows has
locked* (a running process cannot overwrite its own .exe or its loaded DLLs — the
entire kill-swap-rollback helper in updater.py exists to work around that). The
.exe only has to be replaced when the frozen runtime itself changes, i.e. when
requirements.txt or the Python version changes. version.py's RUNTIME stamp is what
detects that; updater.py falls back to the full swap when it does.

Layout of a frozen install (everything except `app/` and `_internal/` is the
user's, and survives every update):

    oasis-backend.exe     the launcher (this file, frozen)
    _internal/            frozen Python + third-party packages + RUNTIME stamp
    app/                  the backend source + VERSION  ← the update payload
      sites/              the site adapters shipped with this release
    sites/                the live adapter dir (shipped ones + the user's own)
    bin/ffmpeg.exe        bundled FFmpeg
    oasis.db, movies/     user data
    .oasis-update/        update staging + logs

This shim:

  * puts `app/` on sys.path BEFORE multiprocessing.freeze_support(), so a spawned
    worker (which re-launches this executable) can unpickle its target out of the
    loose modules;
  * calls multiprocessing.freeze_support() FIRST -- without it, every worker the
    backend spawns would re-launch the whole server (a fork bomb) on Windows;
  * applies a pending update staged by updater.py, before any of it is imported;
  * points the app's writable state (SQLite DB and movies/) at the folder that
    holds the .exe, so data survives across runs and app updates;
  * syncs the shipped site adapters into the writable sites/ dir;
  * puts the bundled ffmpeg.exe on PATH (encode.py shells out to bare `ffmpeg`);
  * then serves api:app with uvicorn.

Every path is exported through the env vars the backend modules already honour
(DB_PATH, OASIS_MEDIA_ROOT, OASIS_SITES_DIR), so a normal source checkout keeps
its existing behaviour untouched.
"""

import multiprocessing
import os
import shutil
import sys
import time

# Staged by updater.py: a fully extracted new `app/` waiting to be swapped in, and
# the pid of the backend that staged it (which is exiting as we start). Kept in
# sync with the names in updater.py.
_WORK_DIRNAME = '.oasis-update'
_PENDING_DIRNAME = 'pending-app'
_WAIT_PID_ENV = 'OASIS_UPDATE_WAIT_PID'


def _base_dir() -> str:
    """Folder holding the executable -- writable, survives app updates."""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.dirname(__file__))


def _app_dir() -> str:
    """Folder holding the backend source -- `app/` when frozen, else this dir."""
    if getattr(sys, 'frozen', False):
        return os.path.join(_base_dir(), 'app')
    return os.path.abspath(os.path.dirname(__file__))


def _wait_for_pid(pid: int, timeout: float = 60.0) -> bool:
    """Block until `pid` is gone. True if it exited, False on timeout.

    The updater relaunches us and *then* exits, so on a light update we start
    while the old backend is still holding port 8000 and still has the old app
    modules imported. Swapping app/ under it, or binding the port before it lets
    go, both race — so wait it out first.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.2)
    return False


def _pid_alive(pid: int) -> bool:
    if sys.platform == 'win32':
        # No signal 0 on Windows; ask the OS whether the handle still opens.
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _apply_pending_update(base: str, app: str) -> None:
    """Swap in an update staged by updater.py, if one is waiting.

    Runs before anything from app/ is imported, so the process never ends up with
    half the old modules and half the new ones.

    Only plain .py/.json files move here — the executable and _internal/ are the
    same build we are already running, so nothing that is locked gets touched and
    the swap cannot half-brick the install the way a full replace can. If it fails
    anyway (permissions, a stray file handle), the old app/ is left in place and we
    simply serve the old version: the user sees "still on the old version" plus a
    log, not a backend that won't start.
    """
    pending = os.path.join(base, _WORK_DIRNAME, _PENDING_DIRNAME)
    if not os.path.isdir(pending):
        return

    # The staging backend relaunched us and is on its way out; let it finish
    # exiting before we move the directory its modules were imported from.
    wait_pid = os.environ.pop(_WAIT_PID_ENV, '')
    if wait_pid.isdigit():
        if _wait_for_pid(int(wait_pid)):
            print(f'==> 舊的後端 (pid {wait_pid}) 已結束，套用更新')
        else:
            print(f'==> 舊的後端 (pid {wait_pid}) 逾時未結束，仍嘗試套用更新')

    old = os.path.join(base, _WORK_DIRNAME, 'previous-app')
    try:
        shutil.rmtree(old, ignore_errors=True)
        if os.path.isdir(app):
            os.replace(app, old)      # atomic; same filesystem (both under base)
        try:
            os.replace(pending, app)
        except OSError:
            # Put the old app back rather than leave the install with no app/.
            if os.path.isdir(old):
                os.replace(old, app)
            raise
        shutil.rmtree(old, ignore_errors=True)
        print('==> 已套用更新')
    except OSError as exc:
        print(f'==> 更新套用失敗，沿用舊版本: {exc}')
        return

    # The downloaded payload has served its purpose. The logs next to it have not:
    # they are what /api/update/logs serves back when an update doesn't take.
    work = os.path.join(base, _WORK_DIRNAME)
    for leftover in ('app.zip', 'staging-app'):
        path = os.path.join(work, leftover)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

    # A swapped-in app/ carries .py files whose mtimes may be older than the
    # __pycache__ the previous version left behind; Python keys .pyc validity on
    # (mtime, size), so a stale-but-plausible cache could shadow the new source.
    for root, dirs, _ in os.walk(app):
        for name in list(dirs):
            if name == '__pycache__':
                shutil.rmtree(os.path.join(root, name), ignore_errors=True)
                dirs.remove(name)


def _sync_site_adapters(app: str, live: str) -> None:
    """Copy the adapters shipped in app/sites into the writable sites/ dir.

    The user's own adapters live in the same folder and must survive updates, so
    this only ever *overwrites the files this release ships* — anything else in
    sites/ is left alone. (Which also means a user's edit to a shipped adapter is
    reverted on the next start; adapters they want to keep get a new filename.)
    """
    shipped = os.path.join(app, 'sites')
    if not os.path.isdir(shipped):
        return
    os.makedirs(live, exist_ok=True)
    for name in os.listdir(shipped):
        if not name.endswith('.json'):
            continue
        try:
            shutil.copyfile(os.path.join(shipped, name), os.path.join(live, name))
        except OSError as exc:
            print(f'==> 無法更新站台設定 {name}: {exc}')


def main() -> None:
    base = _base_dir()
    app = _app_dir()
    frozen = getattr(sys, 'frozen', False)

    if frozen:
        _apply_pending_update(base, app)

        # Writable state next to the .exe.
        os.environ.setdefault('DB_PATH', os.path.join(base, 'oasis.db'))
        os.environ.setdefault('OASIS_MEDIA_ROOT', base)

        # Adapters load from the writable sites/ dir, seeded from the shipped ones.
        live_sites = os.path.join(base, 'sites')
        _sync_site_adapters(app, live_sites)
        os.environ.setdefault('OASIS_SITES_DIR', live_sites)

        # encode.py calls a bare `ffmpeg`; make the bundled binary findable.
        ffmpeg_dir = os.path.join(base, 'bin')
        if os.path.isdir(ffmpeg_dir):
            os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '8000'))

    import uvicorn
    from api import app as fastapi_app

    print(f'==> OASIS backend serving on http://{host}:{port}')
    print(f'    data dir: {base}')
    print(f'    app  dir: {app}')
    uvicorn.run(fastapi_app, host=host, port=port)


# The backend source is imported from disk, not from the frozen archive, so it has
# to be importable before *anything* below runs. In particular before
# freeze_support(): a spawned worker re-launches this executable, and it unpickles
# its target (api._analyze_worker, download.*) by module name — which only resolves
# if app/ is already on the path when the module-level code of this file runs.
_APP_DIR = _app_dir()
if _APP_DIR not in sys.path:
    sys.path.insert(0, _APP_DIR)
# updater.py needs the app dir too, and it is imported from within api.py where
# sys.path is no longer the obvious source of truth.
os.environ['OASIS_APP_DIR'] = _APP_DIR

if __name__ == '__main__':
    # Must be the very first thing to run in the frozen process.
    multiprocessing.freeze_support()
    main()
