# 影片分類器 Web UI

Next.js + Tailwind frontend for the Oasis media catalog. Paste a supported
video URL, the Python backend scrapes its metadata (code, actress, tags, cover,
translated title) and stores it in `oasis.db`. Videos can also be added
manually.

## Architecture

```
Browser ──▶ Next.js (:3000)
              └─ /api/analyze, /api/videos  (route handlers, proxy)
                     └─▶ FastAPI (:8000, api.py)
                            └─▶ catalog.py  ──▶ oasis.db (SQLite)
```

The Next route handlers proxy to the Python API, so there are no CORS issues and
the backend URL stays server-side (configurable via `BACKEND_URL` in `.env.local`).

## Run

Start the Python backend (from the project root):

```bash
./oasis/bin/python -m uvicorn api:app --reload --port 8000
```

Then start the frontend (from `web/`):

```bash
npm install   # first time only
npm run dev
```

Open http://localhost:3000.

> Analysing a real URL launches headless Chrome via Selenium, so it can take
> tens of seconds and needs a working `chromedriver`.
