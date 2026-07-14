# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the OASIS backend, onedir build. Produces
# dist/oasis-backend/ (oasis-backend.exe + _internal/). Must be built ON WINDOWS
# -- PyInstaller freezes for the host OS and cannot cross-compile a .exe.
#
#     pip install -r backend/requirements.txt pyinstaller
#     pyinstaller --noconfirm oasis-backend.spec
#
# WHAT THIS DOES *NOT* BUNDLE: the backend's own source. The executable is a
# launcher -- the frozen Python runtime and the third-party packages, nothing
# else. api.py, download.py & co. ship as plain files in `app/` next to the .exe
# and are imported from disk (run_backend.py puts app/ on sys.path). Releasing new
# backend code is then a few hundred KB of .py files, and replaces no file that
# Windows has locked -- unlike a running .exe and its loaded DLLs, which is what
# the whole kill-swap-rollback helper in updater.py exists to work around.
#
# The app payload is assembled by CI (see .github/workflows/release.yml), not
# here: in PyInstaller 6 everything in `datas` lands inside _internal/, which is
# precisely the replaced-wholesale directory the source must stay out of.
#
import os

from PyInstaller.utils.hooks import collect_submodules

# Every module the backend owns -- i.e. everything this spec must NOT freeze.
# Derived from the source tree, so a new backend module is handled automatically.
# run_backend.py is exempt: it is the frozen launcher (a.scripts), not app code.
OWN_MODULES = {
    os.path.splitext(f)[0]
    for f in os.listdir('backend')
    if f.endswith('.py') and f != 'run_backend.py'
}

# uvicorn[standard] resolves its loop/http/websocket implementations by dynamic
# import, so its submodules must be pulled in explicitly or the frozen server
# fails to start. anyio is FastAPI's async backend; the accelerators below are
# the optional [standard] extras.
hiddenimports = (
    collect_submodules('uvicorn')
    + collect_submodules('anyio')
    + ['websockets', 'httptools', 'h11']
)

# CI writes these at the repo root before building. They describe *the executable*,
# so they belong in the frozen bundle (version.py reads them back from _MEIPASS):
#
#   PLATFORM -- the release asset this build was installed from, so the updater
#               fetches the same variant if a full reinstall is ever needed.
#   RUNTIME  -- fingerprint of the Python version + requirements.txt this was
#               frozen against. A release stamped with the same RUNTIME runs on
#               this executable, so installing it means replacing app/ and nothing
#               else; a mismatch means the packages baked in here are not the ones
#               the new source needs, and updater.py falls back to swapping the
#               whole install.
#
# VERSION is deliberately NOT bundled here: it travels with the source in
# app/VERSION, because the source is what an update replaces and an executable
# that never changes cannot report a new version.
datas = [(stamp, '.') for stamp in ('PLATFORM', 'RUNTIME') if os.path.exists(stamp)]

a = Analysis(
    ['backend/run_backend.py'],
    pathex=['backend'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

# Analysis just walked the *real* backend source (run_backend.py imports api, which
# reaches everything else), and that is exactly how the dependencies get found --
# selenium, sqlite3, pycryptodome and the rest are in this build only because
# api.py & co. were followed into. Now drop the backend's own modules back out of
# the archive, keeping everything they pulled in.
#
# This is the line that makes the loose source authoritative. PyInstaller's
# FrozenImporter sits ahead of the normal path finder on sys.meta_path, so any of
# these modules left in the archive would win over the copy in app/ -- and an
# update would then swap in new .py files that are silently never imported.
a.pure = [entry for entry in a.pure if entry[0].split('.')[0] not in OWN_MODULES]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='oasis-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='oasis-backend',
)
