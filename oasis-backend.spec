# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the OASIS backend, onedir build. Produces
# dist/oasis-backend/ (oasis-backend.exe + _internal/). Must be built ON WINDOWS
# -- PyInstaller freezes for the host OS and cannot cross-compile a .exe.
#
#     pip install -r backend/requirements.txt pyinstaller
#     pyinstaller --noconfirm oasis-backend.spec
#
import os

from PyInstaller.utils.hooks import collect_submodules

# uvicorn[standard] resolves its loop/http/websocket implementations by dynamic
# import, so its submodules must be pulled in explicitly or the frozen server
# fails to start. anyio is FastAPI's async backend; the accelerators below are
# the optional [standard] extras.
hiddenimports = (
    collect_submodules('uvicorn')
    + collect_submodules('anyio')
    + ['websockets', 'httptools', 'h11']
)

# Read-only site adapters, loaded at runtime from OASIS_SITES_DIR (set by
# run_backend.py to this bundled copy).
datas = [
    ('backend/sites', 'sites'),
]

# CI writes VERSION (the git tag) and PLATFORM (the release asset name for this
# OS) at the repo root before building; bundle them at the app root so version.py
# can read the shipped build's version and pick the matching update asset. Absent
# in a plain source build, in which case the app reports "dev" and the updater
# falls back to a sys.platform guess.
for _stamp in ('VERSION', 'PLATFORM'):
    if os.path.exists(_stamp):
        datas.append((_stamp, '.'))

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
