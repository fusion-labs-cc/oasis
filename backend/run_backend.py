#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Frozen entry point for the OASIS backend (PyInstaller onedir build).

In a normal checkout the API is served with:
    uvicorn api:app --app-dir backend --port 8000

That does not work once frozen: there is no source tree to --app-dir into, and
the bundled modules live inside PyInstaller's extraction dir. This shim is the
packaged executable's __main__. It:

  * calls multiprocessing.freeze_support() FIRST -- without it, every worker the
    backend spawns would re-launch the whole server (a fork bomb) on Windows;
  * points the app's writable state (SQLite DB and movies/) at the folder that
    holds the .exe, so data survives across runs and app updates;
  * points the read-only site adapters at the copy bundled inside the app;
  * puts the bundled ffmpeg.exe on PATH (encode.py shells out to bare `ffmpeg`);
  * then serves api:app with uvicorn.

Every path is exported through the env vars the backend modules already honour
(DB_PATH, OASIS_MEDIA_ROOT, OASIS_SITES_DIR), so a normal
source checkout keeps its existing behaviour untouched.
"""

import multiprocessing
import os
import sys


def _base_dir() -> str:
    """Folder holding the executable -- writable, survives app updates."""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.dirname(__file__))


def _bundle_dir() -> str:
    """Folder holding read-only data bundled into the app."""
    return getattr(sys, '_MEIPASS', _base_dir())


def main() -> None:
    base = _base_dir()
    bundle = _bundle_dir()

    # Writable state next to the .exe.
    os.environ.setdefault('DB_PATH', os.path.join(base, 'oasis.db'))
    os.environ.setdefault('OASIS_MEDIA_ROOT', base)

    # Read-only site adapters bundled inside the app.
    bundled_sites = os.path.join(bundle, 'sites')
    if os.path.isdir(bundled_sites):
        os.environ.setdefault('OASIS_SITES_DIR', bundled_sites)

    # encode.py calls a bare `ffmpeg`; make the bundled binary findable.
    ffmpeg_dir = os.path.join(base, 'bin')
    if os.path.isdir(ffmpeg_dir):
        os.environ['PATH'] = ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '8000'))

    import uvicorn
    from api import app

    print(f'==> OASIS backend serving on http://{host}:{port}')
    print(f'    data dir: {base}')
    uvicorn.run(app, host=host, port=port)


if __name__ == '__main__':
    # Must be the very first thing to run in the frozen process.
    multiprocessing.freeze_support()
    main()
