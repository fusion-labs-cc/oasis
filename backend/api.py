#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FastAPI backend for the OASIS.

Wraps the existing scraping + SQLite logic (catalog.py) behind a small
HTTP API so the Next.js frontend can submit a URL, have it analysed, and read
back the stored catalog.

Run (from the project root):
    ./oasis/bin/python -m uvicorn api:app --app-dir backend --reload --port 8000
"""

import multiprocessing
import os
import sys
import asyncio

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
# movies/ lives at the repo root (one level above backend/); video_path values
# in the DB are relative to this MEDIA_ROOT.
MEDIA_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, '..'))

# All backend modules are co-located in this folder; make sure it is importable
# even when uvicorn is launched from a different working directory.
sys.path.insert(0, PROJECT_ROOT)
import catalog
import db_setup
import site_config

app = FastAPI(title='OASIS API')

# The frontend is a public website that calls this local backend directly from
# the browser, so only allow the deployed site's origin (plus localhost for dev).
# Override with ALLOWED_ORIGINS (comma-separated) when self-hosting the frontend.
_DEFAULT_ORIGINS = 'http://localhost:3000,https://oasis.fusion-labs.cc'
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get('ALLOWED_ORIGINS', _DEFAULT_ORIGINS).split(',')
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Every legitimate call from the frontend carries this header (see the web
# client's backendFetch). It is a CSRF guard, not a secret: the value is public
# and fixed. Requiring a *custom* header means any cross-origin request that
# tries to send it is no longer a "simple" request, so the browser must first
# run a CORS preflight — which this backend only answers for ALLOWED_ORIGINS.
# An arbitrary site the user happens to visit therefore can neither attach the
# header (preflight is denied) nor forge a header-less "simple" POST (rejected
# below), which closes CSRF on side-effecting endpoints such as open-in-player.
CLIENT_HEADER = 'x-oasis-client'


@app.middleware('http')
async def require_client_header(request: Request, call_next):
    path = request.url.path
    # Skip CORS preflight (handled by CORSMiddleware) and media that the browser
    # loads via <video>/<img> src, which cannot carry a custom header. /api/stream
    # only serves local files resolved by id and already guards against traversal.
    if (
        request.method == 'OPTIONS'
        or not path.startswith('/api/')
        or path.startswith('/api/stream/')
    ):
        return await call_next(request)
    if request.headers.get(CLIENT_HEADER) != '1':
        return JSONResponse(status_code=403, content={'detail': '缺少 Oasis 用戶端標頭'})
    return await call_next(request)


@app.on_event('startup')
def _init_db():
    """Ensure the SQLite database and tables exist (safe to call repeatedly)."""
    db_setup.create_tables()
    asyncio.create_task(_bg_check_analyses())


class AnalyzeRequest(BaseModel):
    url: str
    download: bool = False
    task_id: str | None = None


@app.get('/api/health')
def health():
    return {'status': 'ok'}


@app.get('/api/supported-sites')
def supported_sites():
    """List the sites the URL analyser currently supports (for the UI).

    Derived from the user-installed adapters (backend/sites/); empty when none
    are configured.
    """
    return {'sites': site_config.supported_sites()}

# Track currently active analysis task IDs -> dict containing metadata
active_analyses: dict[str, dict] = {}


async def _bg_check_analyses():
    while True:
        try:
            for task_id in list(active_analyses.keys()):
                item = active_analyses.get(task_id)
                if not item or item["status"] != "analyzing":
                    continue

                proc = item["process"]
                if not proc.is_alive():
                    result_queue = item["result_queue"]
                    if not result_queue.empty():
                        res = result_queue.get()
                        if res["status"] == "success":
                            record = res["record"]
                            item["status"] = "success"
                            item["record"] = record

                            # Start download if requested
                            if item["download"] and record and 'id' in record:
                                _start_download(record['id'], item["url"])
                                record['is_downloading'] = True
                                item["download_started"] = True
                        else:
                            item["status"] = "error"
                            item["error"] = res["message"]
                    else:
                        item["status"] = "error"
                        item["error"] = "分析已被取消或中斷"

                    # Clean up process
                    proc.join()
        except Exception as e:
            print(f"Error in background task check: {e}")
        await asyncio.sleep(1.0)

# Track currently downloading video IDs → Process objects (process-safe check)
active_downloads: dict[int, multiprocessing.Process] = {}


def _analyze_worker(url: str, result_queue: multiprocessing.Queue):
    """
    Runs in a completely separate OS process to isolate scraping/network work.
    """
    import signal
    import sys

    def sigterm_handler(signum, frame):
        import catalog as _cat
        # Quit driver if active
        dr = getattr(_cat, '_active_driver', None)
        if dr:
            try:
                dr.quit()
            except:
                pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, sigterm_handler)

    try:
        # Re-import inside subprocess — each process gets its own module state
        import os as _os
        import sys as _sys

        _root = _os.path.abspath(_os.path.dirname(__file__))
        _sys.path.insert(0, _root)

        import catalog as _cat
        print(f"[PID {_os.getpid()}] Starting analysis for {url}")
        record = _cat.process_url(url, skip_download=True)
        result_queue.put({"status": "success", "record": record})
    except Exception as e:
        result_queue.put({"status": "error", "message": str(e)})


def _download_worker(video_id: int, url: str):
    """
    Runs in a completely separate OS process.
    This isolates the heavy blocking work (Selenium, network I/O, ffmpeg) from
    the API event loop so the website remains responsive.
    """
    import signal
    import sys
    import shutil

    def sigterm_handler(signum, frame):
        import download as dl
        # Tell the crawler threads to stop first so they stop writing segments
        # (and stop spamming failures) before we delete the folder.
        try:
            import crawler
            crawler.request_stop()
        except Exception:
            pass
        # Quit the active Selenium driver in the download module
        dr = getattr(dl, '_active_driver', None)
        if dr:
            try:
                dr.quit()
            except:
                pass
        # Clean up temporary folder containing downloaded ts segments
        folder = getattr(dl, '_active_folder_path', None)
        if folder and os.path.exists(folder):
            try:
                shutil.rmtree(folder)
                print(f"🧹 [PID {os.getpid()}] Cleaned up temp download folder {folder}")
            except Exception as e:
                print(f"⚠️ Failed to remove temp folder {folder}: {e}")
        # os._exit terminates immediately without waiting for the non-daemon
        # ThreadPoolExecutor worker threads to drain (which would otherwise
        # flood the log with "No such file" errors and delay shutdown).
        os._exit(0)

    signal.signal(signal.SIGTERM, sigterm_handler)

    try:
        # Re-import inside subprocess — each process gets its own module state
        import os as _os
        import sys as _sys

        _root = _os.path.abspath(_os.path.dirname(__file__))
        _sys.path.insert(0, _root)

        import catalog as _cat
        import download
        print(f"[PID {_os.getpid()}] Starting download for {url}")
        download.download(url)

        # Update the DB with the new local file path
        record = _cat.get_video_by_id(video_id)
        if record:
            local_path = _cat.find_local_file(record['code'], record.get('title') or '')
            if local_path:
                conn = _cat.get_connection()
                conn.execute("UPDATE videos SET video_path = ? WHERE id = ?", (local_path, video_id))
                conn.commit()
                conn.close()
                print(f"✅ [PID {_os.getpid()}] Download finished, DB updated for {record['code']} → {local_path}")
            else:
                print(f"⚠️ [PID {_os.getpid()}] Download finished but could not locate file for {record['code']}")
    except Exception as e:
        print(f"⚠️ [PID {os.getpid()}] Download failed for {url}: {e}")


def _cleanup_finished():
    """Remove entries for processes that have already exited."""
    finished = [vid for vid, proc in active_downloads.items() if not proc.is_alive()]
    for vid in finished:
        active_downloads.pop(vid, None)


def _is_downloading(video_id: int) -> bool:
    """Check if a video is currently being downloaded."""
    proc = active_downloads.get(video_id)
    if proc is None:
        return False
    if proc.is_alive():
        return True
    # Process finished — clean up
    active_downloads.pop(video_id, None)
    return False


def _start_download(video_id: int, url: str):
    """Spawn a new download process (if not already running)."""
    _cleanup_finished()
    if _is_downloading(video_id):
        return  # already in progress
    proc = multiprocessing.Process(
        target=_download_worker,
        args=(video_id, url),
        daemon=True,
        name=f"download-{video_id}",
    )
    proc.start()
    active_downloads[video_id] = proc


@app.post('/api/analyze')
async def analyze(req: AnalyzeRequest):
    """Scrape metadata for a URL, store it in SQLite, and return immediately."""
    url = (req.url or '').strip()
    if not url:
        raise HTTPException(status_code=400, detail='URL 不可為空')

    # Generate task_id if not provided
    task_id = req.task_id
    if not task_id:
        import uuid
        task_id = str(uuid.uuid4())

    # If already running/finished, return its status
    if task_id in active_analyses:
        item = active_analyses[task_id]
        return {
            "status": item["status"],
            "task_id": task_id,
            "record": item.get("record"),
            "error": item.get("error")
        }

    result_queue = multiprocessing.Queue()
    proc = multiprocessing.Process(
        target=_analyze_worker,
        args=(url, result_queue),
        daemon=True,
        name=f"analyze-{task_id}",
    )
    proc.start()

    active_analyses[task_id] = {
        "process": proc,
        "result_queue": result_queue,
        "status": "analyzing",
        "record": None,
        "error": None,
        "download": req.download,
        "url": url,
        "download_started": False
    }

    return {"status": "analyzing", "task_id": task_id}


@app.get('/api/analyze/{task_id}/status')
def analyze_status(task_id: str):
    """Check the status of an active video analysis task."""
    item = active_analyses.get(task_id)
    if not item:
        return {"status": "not_found", "message": "任務已不存在或已完成"}

    if item["status"] == "success":
        rec = item.get("record") or {}
        return {"status": "success", "id": rec.get("id")}
    elif item["status"] == "error":
        return {"status": "error", "error": item["error"]}
    else:
        return {"status": "analyzing"}


@app.post('/api/analyze/cancel/{task_id}')
def cancel_analyze(task_id: str):
    """Cancel an ongoing video analysis task."""
    item = active_analyses.get(task_id)
    if not item:
        return {"status": "ignored", "message": "任務已不存在或已完成"}

    if item["status"] == "analyzing":
        proc = item["process"]
        if proc.is_alive():
            proc.terminate()
            proc.join()
        item["status"] = "error"
        item["error"] = "分析已取消"
        print(f"🛑 [PID {proc.pid}] Analysis task {task_id} terminated by client")
    return {"status": "cancelled", "message": "分析已取消"}


@app.post('/api/download/{video_id}/cancel')
def cancel_download(video_id: int):
    """Cancel an active background download."""
    _cleanup_finished()
    proc = active_downloads.pop(video_id, None)
    if not proc:
        record = catalog.get_video_by_id(video_id)
        if record and record.get('video_path'):
            raise HTTPException(status_code=400, detail="影片已下載完成，無法取消")
        raise HTTPException(status_code=404, detail="沒有正在下載的影片任務")

    if proc.is_alive():
        proc.terminate()
        proc.join()
        print(f"🛑 [PID {proc.pid}] Download task for video {video_id} terminated by client")
        
    return {"status": "cancelled", "message": "下載已取消"}


@app.post('/api/download/{video_id}')
def trigger_download(video_id: int):
    """Trigger a background download for an existing video."""
    record = catalog.get_video_by_id(video_id)
    if not record:
        raise HTTPException(status_code=404, detail='影片不存在')
    # Only block the download if the file actually exists on disk. A stale
    # video_path (record present but local file missing) should re-download.
    if _resolve_local_file(record.get('video_path')):
        raise HTTPException(status_code=400, detail='影片已下載')
    if record.get('video_path'):
        # Path recorded but the file is gone; clear it so the download can proceed.
        catalog.clear_video_path(video_id)
    if _is_downloading(video_id):
        raise HTTPException(status_code=409, detail='下載進行中')

    _start_download(video_id, record['url'])
    return {"status": "started", "message": "背景下載已啟動"}


@app.get('/api/download/{video_id}/status')
def download_status(video_id: int):
    """Check the status of a download."""
    if _is_downloading(video_id):
        return {"status": "downloading"}

    record = catalog.get_video_by_id(video_id)
    if record and record.get('video_path'):
        return {"status": "completed"}

    return {"status": "idle"}

def _resolve_local_file(video_path: str | None) -> str | None:
    """Resolve a DB video_path to an absolute path on disk, or None if the file
    is missing or escapes MEDIA_ROOT."""
    if not video_path:
        return None
    abs_path = os.path.abspath(os.path.join(MEDIA_ROOT, video_path))
    if abs_path.startswith(MEDIA_ROOT + os.sep) and os.path.isfile(abs_path):
        return abs_path
    return None


def _enrich_record(record: dict, with_size: bool = False) -> dict:
    if not record:
        return record
    video_id = record.get('id', -1)
    record['is_downloading'] = _is_downloading(video_id)

    abs_path = _resolve_local_file(record.get('video_path'))
    record['local_file_exists'] = abs_path is not None
    if abs_path and with_size:
        try:
            record['file_size'] = os.path.getsize(abs_path)
        except OSError:
            record['file_size'] = None
    return record


@app.get('/api/videos')
def videos(actress: str = '', code: str = '', tags: str = '', match: str = 'all'):
    """List catalog entries with optional filters.

    Query params:
        actress  case-insensitive substring match on actress name
        code     exact code match (takes precedence, uses the indexed lookup)
        tags     comma-separated tag list
        match    'all' (default) requires every tag; 'any' requires at least one

    Tags are stored as ASCII-escaped JSON, so filtering is done in Python on the
    decoded rows rather than via SQL LIKE (which would miss CJK characters).
    """
    if code:
        rows = catalog.search_by_code(code)
    else:
        rows = catalog.list_all_videos()

    if actress:
        needle = actress.strip().lower()
        rows = [r for r in rows if needle in (r.get('actress') or '').lower()]

    wanted = [t.strip() for t in tags.split(',') if t.strip()]
    if wanted:
        def has_tags(r):
            row_tags = set(r.get('tags') or [])
            if match == 'any':
                return any(t in row_tags for t in wanted)
            return all(t in row_tags for t in wanted)

        rows = [r for r in rows if has_tags(r)]

    return [_enrich_record(r) for r in rows]


class CreateVideoRequest(BaseModel):
    url: str
    title: str
    code: str | None = None
    actress: str | None = None
    tags: list[str] = []
    cover: str | None = None


@app.post('/api/videos')
def create_video(body: CreateVideoRequest):
    """Manually add a catalog entry from user-supplied fields (no scraping)."""
    try:
        record = catalog.create_manual_video(
            url=body.url,
            title=body.title,
            code=body.code,
            actress=body.actress,
            tags=body.tags,
            cover=body.cover,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f'新增失敗: {e}')
    return _enrich_record(record, with_size=True)


@app.get('/api/facets')
def facets():
    """Distinct actresses and tags (with counts) for building filter controls."""
    rows = catalog.list_all_videos()

    actresses: dict[str, int] = {}
    tags: dict[str, int] = {}
    for r in rows:
        name = r.get('actress')
        if name:
            actresses[name] = actresses.get(name, 0) + 1
        for t in r.get('tags') or []:
            tags[t] = tags.get(t, 0) + 1

    def sort_facet(d):
        # Most frequent first, then alphabetical for ties.
        return [
            {'name': k, 'count': v}
            for k, v in sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    return {'actresses': sort_facet(actresses), 'tags': sort_facet(tags)}


class TagsUpdate(BaseModel):
    tags: list[str]


@app.put('/api/videos/{video_id}/tags')
def update_tags(video_id: int, body: TagsUpdate):
    """Replace the tag list for a video (add/remove/edit tags on the detail page)."""
    record = catalog.update_video_tags(video_id, body.tags)
    if record is None:
        raise HTTPException(status_code=404, detail='影片不存在')
    return _enrich_record(record)


class DetailsUpdate(BaseModel):
    code: str | None = None
    title: str | None = None
    actress: str | None = None
    url: str | None = None
    cover: str | None = None


@app.put('/api/videos/{video_id}')
def update_details(video_id: int, body: DetailsUpdate):
    """Update editable metadata (片號/標題/女優/原始網址/封面) for a video."""
    try:
        record = catalog.update_video_details(
            video_id,
            code=body.code,
            title=body.title,
            actress=body.actress,
            url=body.url,
            cover=body.cover,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if record is None:
        raise HTTPException(status_code=404, detail='影片不存在')
    return _enrich_record(record, with_size=True)


@app.post('/api/videos/{video_id}/open')
def open_in_player(video_id: int):
    """Open the local video file in the OS default player (local app only)."""
    record = catalog.get_video_by_id(video_id)
    if not record:
        raise HTTPException(status_code=404, detail='影片不存在')

    rel_path = record.get('video_path')
    abs_path = os.path.abspath(os.path.join(MEDIA_ROOT, rel_path)) if rel_path else None
    if not abs_path or not abs_path.startswith(MEDIA_ROOT + os.sep) or not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail='本地影片檔案不存在')

    import subprocess
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', abs_path])
        elif sys.platform.startswith('win'):
            os.startfile(abs_path)  # type: ignore[attr-defined]
        else:
            subprocess.Popen(['xdg-open', abs_path])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f'無法開啟播放器: {e}')

    count = catalog.increment_play_count(video_id)
    return {'status': 'opened', 'play_count': count}


@app.post('/api/videos/{video_id}/play')
def log_play(video_id: int):
    """Increment the play counter for a video (called when playback starts)."""
    count = catalog.increment_play_count(video_id)
    if count is None:
        raise HTTPException(status_code=404, detail='影片不存在')
    return {'play_count': count}


@app.delete('/api/videos/{video_id}')
def delete_video(video_id: int, local_only: bool = False):
    """Delete a video: its local file (if any) and either its database record or just the path."""
    record = catalog.get_video_by_id(video_id)
    if not record:
        raise HTTPException(status_code=404, detail='影片不存在')
    if _is_downloading(video_id):
        raise HTTPException(status_code=409, detail='下載進行中，請待完成後再刪除')

    deleted_file = False
    rel_path = record.get('video_path')
    if rel_path:
        # Resolve under PROJECT_ROOT and guard against path traversal.
        abs_path = os.path.abspath(os.path.join(MEDIA_ROOT, rel_path))
        if abs_path.startswith(MEDIA_ROOT + os.sep) and os.path.isfile(abs_path):
            try:
                os.remove(abs_path)
                deleted_file = True
            except OSError as e:
                raise HTTPException(status_code=500, detail=f'刪除檔案失敗: {e}')

    if local_only:
        catalog.clear_video_path(video_id)
        return {'status': 'deleted_local', 'deleted_file': deleted_file}
    else:
        catalog.delete_video(video_id)
        return {'status': 'deleted', 'deleted_file': deleted_file}


@app.get('/api/videos/{video_id}')
def get_video(video_id: int):
    """Get a single video record by ID."""
    record = catalog.get_video_by_id(video_id)
    if not record:
        raise HTTPException(status_code=404, detail='影片不存在')
    return _enrich_record(record, with_size=True)


@app.get('/api/stream/{video_id}')
def stream_video(video_id: int, request: Request):
    """Stream a local video file by video ID."""
    record = catalog.get_video_by_id(video_id)
    if not record:
        raise HTTPException(status_code=404, detail='影片不存在')

    video_path = record.get('video_path')
    if video_path:
        video_path = os.path.join(MEDIA_ROOT, video_path)

    if not video_path or not os.path.isfile(video_path):
        raise HTTPException(status_code=404, detail='本地影片檔案不存在')

    file_size = os.path.getsize(video_path)
    filename = os.path.basename(video_path)
    import urllib.parse
    encoded_filename = urllib.parse.quote(filename)

    range_header = request.headers.get('range')
    if range_header:
        byte_range = range_header.replace('bytes=', '').split('-')
        start = int(byte_range[0]) if byte_range[0] else 0
        end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else file_size - 1
    else:
        start = 0
        end = file_size - 1

    length = end - start + 1

    def iterfile():
        with open(video_path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk_size = min(1024 * 1024, remaining)
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        'Content-Length': str(length),
        'Content-Disposition': f"inline; filename*=utf-8''{encoded_filename}",
        'Accept-Ranges': 'bytes',
    }

    if range_header:
        headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
        status_code = 206
    else:
        status_code = 200

    return StreamingResponse(
        iterfile(),
        media_type='video/mp4',
        headers=headers,
        status_code=status_code
    )

