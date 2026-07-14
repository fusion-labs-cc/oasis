# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

One-click bootstrap (installs system deps, creates the venv, runs `npm install`, starts both servers):

```bash
./oasis-portal.sh              # macOS / Linux
./oasis-portal.sh --backend-only   # skip the Next.js frontend
# Windows: double-click oasis-portal.bat (wraps oasis-portal.ps1)
```

The portal also runs `git pull --ff-only` on every start, so a source checkout self-updates.

Running the two halves by hand:

```bash
./oasis/bin/python -m uvicorn api:app --app-dir backend --reload --port 8000
cd web && npm run dev          # Next.js on :3000
```

Frontend checks and deploy (`web/`): `npm run lint`, `npm run build`, `npm run preview` / `npm run deploy` (Cloudflare Workers via OpenNext).

Frozen backend build — **two steps**, because the executable deliberately does not contain the backend's source (see *Source checkout vs. frozen build*):

```bash
pyinstaller --noconfirm oasis-backend.spec                      # → dist/oasis-backend/ (exe + _internal/)
python scripts/app_payload.py --build dist/oasis-backend/app --version v0.1.0   # → the source it runs
```

Must be built **on the target OS** (PyInstaller cannot cross-compile). Releasing is `git tag v0.1.0 && git push origin v0.1.0`, which triggers `.github/workflows/release.yml` to build Windows + macOS-arm64, bundle FFmpeg, and publish both full zips plus `oasis-app.zip`.

**There are no tests** — no pytest, no jest/vitest, no test files anywhere in `backend/` or `web/src/`. Verify changes by exercising the running app, not by running a suite.

## Architecture

Oasis is **not a hosted web app**. It is a public Next.js frontend (deployed to Cloudflare Workers at `oasis.fusion-labs.cc`) that talks to a **FastAPI backend each user runs on their own machine** at `127.0.0.1:8000`. The browser calls that local backend **directly** — there is no server-side proxy and no server-side data fetching, which is why the whole frontend is client components over `localhost`.

> `web/README.md` is stale: it describes Next.js route handlers proxying to FastAPI. That is no longer true (see `web/src/lib/backend.ts` and `api.ts`). Trust the code.

Because the page is HTTPS and the backend is plain HTTP on localhost (browsers exempt localhost from mixed-content blocking), three guards stand in for the usual same-origin protection. The first two are **CSRF** guards and bind *browsers only*; the third is **authentication** and is the one that holds when the backend is not on localhost at all:

- **CORS allowlist** — `ALLOWED_ORIGINS` (default: `localhost:3000` + the deployed site).
- **`X-Oasis-Client: 1` header** — required on every `/api/*` call by a middleware in `api.py`. It is a public, fixed value, not a secret: requiring a *custom* header forces a CORS preflight, which the backend only answers for allowed origins. That closes CSRF on side-effecting endpoints like `/api/videos/{id}/open` (which launches a local player). `/api/stream/*` is exempt, since `<video src>` cannot send custom headers.
- **Access code** (`auth.py`) — the actual authentication. Neither guard above survives contact with a non-browser: `curl -H 'X-Oasis-Client: 1'` ignores CORS entirely, which is a total compromise the moment a user tunnels the backend (ngrok & co.) to watch from their phone.

Any new `/api/*` endpoint inherits all three automatically; any new frontend call must go through `backendFetch()` in `web/src/lib/api.ts`, never a bare `fetch`.

The backend has **two modes**, and which one it is in depends solely on whether the user has set an access code:

- **No code (the default) → local-only.** Requests from this machine need no credential at all — the double-click-and-go experience is untouched — and every non-local request is refused outright. An unconfigured backend therefore *cannot* be used remotely, so tunnelling one before setting a code leaks nothing.
- **Code set → everyone authenticates, the owner's own browser included.** This is what opens remote access.

The code is user-chosen, so it is never stored: `oasis.auth.json` (next to the DB) holds only its scrypt hash plus the SHA-256 digests of live sessions, so neither the file nor a leaked copy of it is a usable credential. A device sends the code exactly once, to `/api/auth/login`, and gets a random **session token** back; everything after that presents the session. That keeps the password out of URLs — `<video src>` can carry a credential only as a query param (`/api/stream/*?token=…`) — and makes revocation possible: changing the code drops every session, which is how a phone (or a leaked pairing QR) gets cut off.

`is_local_request()` is only ever used to decide who may *manage* the code, never to hand out a secret — that is what makes it safe to rely on. It requires a loopback peer **and** no `X-Forwarded-*`/proxy header: both halves matter, because a tunnel agent runs on the user's own machine and so also connects from 127.0.0.1; what gives it away is the header it injects, which a client on the far side cannot strip. A raw TCP forward (`ssh -R`) adds no headers and is the known, accepted gap — but an attacker who exploits it still learns nothing, since there is no secret to be handed out and he still lacks the code.

- **Setting the first code is local-only too**, and that is load-bearing: a remote device must never be shown the setup form, or whoever found an unclaimed tunnel URL could squat a code and lock the owner out of their own machine.
- Some endpoints are refused to a remote caller **even with a valid session** (`_LOCAL_ONLY_PATHS` / `_LOCAL_ONLY_SUFFIXES`): `/api/videos/{id}/open` (launches a player on the owner's desktop), `/api/update/apply` (pushes code onto their PC), and everything under `/api/auth/` that manages the code or mints a pairing token.
- The **pairing QR** (settings → 遠端存取) encodes the backend URL plus a session token — never the code — in a URL *fragment*, which browsers never send to a server. The gate wipes it from the address bar on read and asks the user to confirm the destination first, so a link someone else sends can't silently repoint their browser at a backend of the sender's choosing.
- **Wrong access codes** are throttled per caller (rightmost `X-Forwarded-For` entry, since behind a tunnel every peer is 127.0.0.1) with an exponential lockout. Invalid *sessions* are deliberately **not** throttled: they are unguessable, and counting them would let a device whose session was just revoked lock the owner out by merely polling `/api/health`.

### Process model

Scraping and downloading are heavy and blocking (Selenium, network I/O, FFmpeg), so `api.py` spawns them as **separate OS processes**, not threads, to keep the event loop responsive.

- **Analyses** run in parallel, keyed by `task_id` in `active_analyses`.
- **Downloads are serialised** — exactly one at a time, FIFO through `download_queue`. `_pump_downloads()` reaps the finished one and starts the next; it is driven by `_bg_check_analyses()`, an asyncio loop that ticks every second.

Since worker processes cannot share memory with the API, IPC is done through the filesystem in `$TMPDIR/oasis_progress/`:

- `{id}.txt` — the worker writes whole-percent progress; the API reads it back. Progress only ever moves **forward** (seeded from the existing file on resume) so a resumed download's bar never dips back to the setup phase's low value.
- `{id}.cancel` — the API drops this marker *before* SIGTERMing a download. The worker's SIGTERM handler wipes partial segments **only if the marker is present**. A plain shutdown (Ctrl+C, restart) leaves no marker, so segments survive on disk and the download resumes from them.

In-memory queue state is volatile, so the durable source of truth is the **`download_pending` column** in SQLite. `_resume_pending_downloads()` rebuilds the queue from it on startup.

### Site adapters

The shipped code contains **no site-specific logic by design**. `site_config.py` is a generic engine driven entirely by JSON adapters (CSS selectors, m3u8 extraction rules, required headers, Selenium options). Adapters live in `backend/sites/*.json`; the schema is documented in `backend/sites.example.json`. Keep it that way — site-specific behaviour belongs in an adapter, not in Python.

Two details worth knowing:

- `detect_site()` matches on the host's **registrable-domain label**, never a bare substring, so a look-alike host (`example.com.evil.com`) is rejected before a browser navigates to it.
- Adapters in `backend/sites/` **are tracked in git and ship with releases** — `jable.json` and `missav.json` are committed, and `scripts/app_payload.py` copies the directory into the app payload (`app/sites/`). In a frozen build the adapters actually *loaded* come from a writable `sites/` next to the `.exe`: `run_backend.py` copies the shipped ones into it on every start and **leaves every other file alone**, so a release updates `jable.json`/`missav.json` while a user's own adapters survive updates. (The flip side: editing a shipped adapter in place is reverted on the next start — rename it to keep it.)

The download pipeline (`download.py`) is: `detect_site` → Selenium extracts the title and m3u8 URL → `resolve_m3u8_to_stream` picks the highest-bandwidth variant from a master playlist → `crawler.py` fetches TS segments across 16 threads (AES-CBC decrypt when keyed, with a **fresh cipher per segment** — CBC is stateful and must never be shared across threads) → merge → FFmpeg remux → move into `movies/`. Overall percent is mapped as: 1% setup, 3–95% segments, 96% merge, 98% encode, 100% done.

### Source checkout vs. frozen build

**The `.exe` is a launcher, not the app.** PyInstaller freezes only the Python runtime, the third-party packages, and `run_backend.py`. The backend's own source ships as **plain `.py` files in `app/` next to the executable** and is imported from disk — `oasis-backend.spec` strips those modules back out of the frozen archive (`a.pure`) precisely so the loose copies are the ones that get imported. PyInstaller's `FrozenImporter` outranks the path finder, so a module left in the archive would silently shadow the file on disk.

That split exists so shipping new backend code replaces **no file the OS has locked** — see *Versioning and self-update*. Analysis still walks the real source (`run_backend.py` imports `api`), which is the only reason the dependencies get discovered at all; don't "tidy" that import away.

Frozen layout — everything except `app/` and `_internal/` belongs to the user and survives updates:

```
oasis-backend.exe   launcher       _internal/  frozen Python + packages + PLATFORM, RUNTIME
app/                backend source + VERSION   ← the update payload; app/sites/ = shipped adapters
sites/              live adapters (shipped + the user's own)
bin/ffmpeg          oasis.db, movies/          .oasis-update/ (staging + logs)
```

The two layouts are reconciled purely through **environment variables**. Any code touching paths must honour them:

| Var | Purpose |
| --- | --- |
| `DB_PATH` | SQLite location (default `backend/oasis.db`) |
| `OASIS_MEDIA_ROOT` | Root that `movies/` and DB `video_path` values resolve against |
| `OASIS_SITES_DIR` | Adapter directory |
| `OASIS_APP_DIR` | The loose source dir (so `version.py`/`updater.py` can find `app/`) |

`run_backend.py` sets all of them so writable state (DB, `movies/`) lands **next to the `.exe`**, not inside PyInstaller's extraction dir. It also puts the bundled `bin/ffmpeg` on `PATH` (`encode.py` shells out to a bare `ffmpeg`), and two things about its ordering are load-bearing: it **must** call `multiprocessing.freeze_support()` first — without it every spawned worker re-launches the whole server, i.e. a fork bomb on Windows — and `app/` must go on `sys.path` at **module level, before that call**, because a spawned worker re-executes the `.exe` and unpickles its target (`api._analyze_worker`, `download.*`) by module name, which only resolves if the loose source is already importable.

`video_path` is stored **relative to `MEDIA_ROOT`**. Every endpoint that resolves it (`stream`, `delete`, `open`) re-checks that the absolute path stays under `MEDIA_ROOT` to block path traversal — preserve that guard.

### Versioning and self-update

Two stamps, and *where* each lives is the design:

- **`VERSION`** (the git tag) ships **inside the app payload**, `app/VERSION`. It names the code, and the code is what an update replaces — an `.exe` that never changes cannot report a new version. A source checkout has none, reports `"dev"`, and is deliberately treated as **never behind** so local builds are not nagged.
- **`RUNTIME`** ships **inside `_internal/`**. It fingerprints what the executable actually froze: the Python version, `requirements.txt`, and `run_backend.py` (`scripts/app_payload.py` computes it; CI stamps it). It changes only when the `.exe` must be rebuilt.

`PLATFORM` (this OS's full-install asset name) also lives in `_internal/`. `version.py` reads all three back.

`updater.py` (frozen build only) therefore has **two paths**, chosen by comparing the release's `RUNTIME` against the running build's:

- **Light — almost always.** Same `RUNTIME` ⇒ the new source runs on the `.exe` already installed. Download `oasis-app.zip` (~35 KB), stage it in `.oasis-update/pending-app`, relaunch **itself**, exit; the fresh process swaps `app/` in *before importing anything from it* (`_apply_pending_update`). Nothing that gets replaced is a file the OS has open, so there is no locked-file problem, no helper script, and no rollback to get right.
- **Full — only when `RUNTIME` differs** (a dependency was added, Python bumped). Download the OS's full zip and hand off to a detached OS-native helper (sh / PowerShell) that kills this backend, swaps every top-level entry, and relaunches. This path exists solely because **a running process cannot overwrite its own executable or loaded libraries** — hence the all-or-nothing rename-aside-then-install-with-rollback dance, and hence the backend never exiting on its own here. It is also why `DETACHED_PROCESS` must not be used to spawn the helper (PowerShell exits instantly without a console; use `CREATE_NO_WINDOW`).

A light update that can't be applied changes **nothing on disk** and falls back to the full path; a full update that fails rolls back and relaunches the old build. `oasis.db`, `movies/` and `sites/` are outside both payloads and are always preserved. Updates span multiple processes, so every step is logged to `.oasis-update/`, which no payload touches — `/api/update/logs` reads it back, and that is how a silently failed update gets diagnosed.

Releasing is `git tag v0.1.0 && git push origin v0.1.0`. CI publishes three assets: the two full installs, plus the OS-independent **`oasis-app.zip`** that the light path consumes.

### Frontend state

Three nested providers in `SiteChrome`, each depending on the one above:

1. **`BackendProvider`** — health polling (10s connected, 3s retrying), plus the `oasis:authorized` gate flag. An inline script in `layout.tsx` reads that flag before first paint to avoid flashing the entrance gate at returning users.
2. **`VideoProvider`** — the catalog store. The whole catalog is fetched once; **filtering and faceting happen client-side** (`computeFacets`).
3. **`TasksProvider`** — the analysis/download task list, driven by polling. There are no websockets or SSE anywhere; every live update in the UI is a poll.

Tags are stored as JSON text in SQLite, so tag filtering is done **in Python over decoded rows, not via SQL `LIKE`** (which would mishandle CJK). Metadata (code / actress / title) is regex-extracted from the scraped page title, then Japanese titles are machine-translated to zh-TW via `deep-translator`.

`AwakeMode` is a "boss key" that disguises the whole site as Google (default `⌘X` / `Alt+X`), including the tab title and favicon, persisted across reloads. It, and the keyboard shortcuts, are configured in `web/src/lib/settings.ts` (localStorage).

## Conventions

- **User-facing strings are zh-TW** — UI copy, `HTTPException` detail messages, and backend `print()` output. Code comments are English.
- `python/` and `bin/` at the repo root are a **vendored Windows runtime + FFmpeg** (gitignored, not part of the source). Ignore them when searching; they will otherwise flood results with `site-packages`.
- Comments in this codebase explain *why* (a constraint, a failure mode that was hit), not *what*. Match that.
