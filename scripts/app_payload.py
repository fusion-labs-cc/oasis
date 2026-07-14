#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Assemble the app payload — the part of a release that is *not* the executable.

The .exe is only a launcher (frozen Python + the third-party packages); the
backend's own source runs from `app/` next to it as plain .py files. That folder
is what this script builds, and it is both:

  * shipped inside every full install (dist/oasis-backend/app/), and
  * published on its own as oasis-app.zip — the payload of a light update, which
    is why a normal release is a ~35 KB download that replaces no locked file.

Used by .github/workflows/release.yml in three jobs (windows, macos, release), so
all of them must produce byte-identical output — hence one script rather than
three copies of a copy loop.

    python scripts/app_payload.py --runtime                    # print the stamp
    python scripts/app_payload.py --build dist/oasis-backend/app --version v0.1.4

THE RUNTIME STAMP fingerprints everything that is baked into the executable and
therefore cannot be changed by shipping new source:

  * the Python version it was frozen with, and
  * requirements.txt — the packages inside _internal/, and
  * run_backend.py — the launcher, which IS the frozen __main__.

A release whose stamp matches the installed one can be applied by replacing app/
alone. Any change to those three forces a full reinstall instead (updater.py
compares the stamps and picks the path), so forgetting to bump something cannot
silently produce an install whose source and executable disagree.
"""

import argparse
import hashlib
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, 'backend')

# Frozen into the .exe rather than shipped as source, so it must NOT go into the
# payload: a stale copy on disk would be dead code that looks live.
LAUNCHER = 'run_backend.py'

# Inputs to the RUNTIME stamp (relative to backend/). See the module docstring.
RUNTIME_INPUTS = ('requirements.txt', LAUNCHER)


def runtime_stamp() -> str:
    """Fingerprint of the frozen runtime: "py3.11-<12 hex>"."""
    digest = hashlib.sha256()
    for name in RUNTIME_INPUTS:
        with open(os.path.join(BACKEND, name), 'rb') as f:
            content = f.read()
        # Normalise line endings before hashing: the Windows runner checks out
        # with core.autocrlf=true, so the same commit would otherwise stamp a
        # different runtime there than on macOS/Linux and every update would take
        # the full path.
        digest.update(content.replace(b'\r\n', b'\n'))
    return f'py{sys.version_info.major}.{sys.version_info.minor}-{digest.hexdigest()[:12]}'


def build(dest: str, app_version: str) -> None:
    """Write the app payload (backend source + adapters + stamps) into `dest`."""
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)

    for name in sorted(os.listdir(BACKEND)):
        if name.endswith('.py') and name != LAUNCHER:
            shutil.copyfile(os.path.join(BACKEND, name), os.path.join(dest, name))

    # The adapters this release ships. run_backend.py copies them into the
    # writable sites/ dir at startup, leaving the user's own adapters alone.
    shutil.copytree(os.path.join(BACKEND, 'sites'), os.path.join(dest, 'sites'))

    # VERSION lives here, not in the .exe: the source is what an update replaces,
    # so it has to be the thing that reports the version. RUNTIME rides along so
    # the updater can tell, before installing, whether this source will actually
    # run on the executable the user already has.
    _write(os.path.join(dest, 'VERSION'), app_version)
    _write(os.path.join(dest, 'RUNTIME'), runtime_stamp())

    print(f'app payload: {dest} (version {app_version}, runtime {runtime_stamp()})')
    for entry in sorted(os.listdir(dest)):
        print(f'  {entry}')


def _write(path: str, value: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', action='store_true', help='print the RUNTIME stamp and exit')
    parser.add_argument('--build', metavar='DEST', help='assemble the app payload into DEST')
    parser.add_argument('--version', default='dev', help='version string to stamp (the git tag)')
    args = parser.parse_args()

    if args.runtime:
        print(runtime_stamp())
        return
    if args.build:
        build(args.build, args.version)
        return
    parser.error('one of --runtime or --build is required')


if __name__ == '__main__':
    main()
