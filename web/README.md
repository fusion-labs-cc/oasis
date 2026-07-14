# 影片分類器 Web UI

Next.js + Tailwind frontend for the Oasis media catalog. Paste a supported
video URL, the Python backend scrapes its metadata (code, actress, tags, cover,
translated title) and stores it in `oasis.db`. Videos can also be added
manually.

## Architecture

The browser calls the FastAPI backend **directly** — there is no Next.js proxy
or server-side data fetching. The frontend is entirely client components, and
the backend runs on the user's own machine:

```
Browser ──▶ FastAPI (:8000, api.py)   ← called directly from client JS
                └─▶ catalog.py  ──▶ oasis.db (SQLite)

Next.js (:3000) only serves the static UI to the browser.
```

The backend URL is resolved client-side (`web/src/lib/backend.ts`): a
localStorage override, else the build-time `NEXT_PUBLIC_BACKEND_URL`, else
`http://localhost:8000`. Since the target is always the user's own machine, this
holds both ways:

- **Deployed frontend** (`oasis.fusion-labs.cc`, HTTPS): the HTTPS page calls
  `http://localhost:8000` — browsers exempt localhost from mixed-content
  blocking, so it works without a proxy.
- **Local frontend** (`npm run dev` on `:3000`): same thing, just served from
  your own machine instead of Cloudflare.

Because the browser talks cross-origin to the local backend, two guards replace
same-origin protection (see `../CLAUDE.md` for the full rationale): a CORS
allowlist (`ALLOWED_ORIGINS`) and a required `X-Oasis-Client: 1` header on every
`/api/*` call. Always go through `backendFetch()` in `src/lib/api.ts`, never a
bare `fetch`.

## Run

Start the Python backend (from the project root):

```bash
./oasis/bin/python -m uvicorn api:app --app-dir backend --reload --port 8000
```

Then start the frontend (from `web/`):

```bash
npm install   # first time only
npm run dev
```

Open http://localhost:3000.

> To point the frontend at a backend on a different host or port, create
> `web/.env.local` with `NEXT_PUBLIC_BACKEND_URL=http://…`, or set it at runtime
> from the settings page (stored in localStorage).

> Analysing a real URL launches headless Chrome via Selenium, so it can take
> tens of seconds and needs a working `chromedriver`.
