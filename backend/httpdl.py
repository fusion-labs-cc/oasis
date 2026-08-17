"""Progressive (non-HLS) file downloader.

The second of the two download pipelines. crawler.py fetches an m3u8's TS
segments across 16 threads and merge.py stitches them; sites that serve one
plain MP4 per video have nothing to stitch, so they come through here instead:
a single streaming GET, resumable by byte range.
"""

import os

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from crawler import is_stop_requested, reset_stop

CHUNK_SIZE = 1024 * 256


def _make_session(headers: dict | None) -> requests.Session:
    session = requests.Session()
    adapter = HTTPAdapter(
        # 429 included: rate-limiting CDNs send it under load, and urllib3
        # honours their Retry-After before retrying.
        max_retries=Retry(total=3, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504]),
    )
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    if headers:
        session.headers.update(headers)
    return session


def download_file(url, dest, headers=None, cookies=None, progress_cb=None):
    """Download `url` to `dest`, resuming from whatever is already there.

    Resume mirrors the segment crawler's "skip what exists" behaviour, so a
    plain shutdown (Ctrl+C, a restart) leaves a partial file that the next run
    continues from rather than re-fetching. Returns the total bytes on disk.

    `progress_cb(done_bytes, total_bytes)` is best-effort; a failing sink must
    never abort the download.
    """
    reset_stop()

    existing = os.path.getsize(dest) if os.path.exists(dest) else 0
    session = _make_session(headers)
    request_headers = {'Range': f'bytes={existing}-'} if existing else {}

    response = session.get(
        url, headers=request_headers, cookies=cookies, stream=True, timeout=30
    )

    # A server that ignores the Range header answers 200 with the whole file;
    # appending that to the partial would silently corrupt it, so start over.
    if existing and response.status_code == 200:
        print('伺服器不支援續傳，重新下載...')
        existing = 0
    elif existing and response.status_code == 416:
        # Already have the whole file: the requested range starts past its end.
        response.close()
        if progress_cb:
            try:
                progress_cb(existing, existing)
            except Exception:
                pass
        return existing
    response.raise_for_status()

    remaining = int(response.headers.get('Content-Length') or 0)
    total = existing + remaining

    def _report(done):
        if not progress_cb or not total:
            return
        try:
            progress_cb(done, total)
        except Exception:
            pass

    size_mb = total / 1024 / 1024 if total else 0
    print(f'開始下載檔案 ({size_mb:.1f} MB)' + (f'，從 {existing / 1024 / 1024:.1f} MB 續傳' if existing else '...'))

    done = existing
    stopped = False
    _report(done)
    mode = 'ab' if existing else 'wb'
    try:
        with open(dest, mode) as f:
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                if is_stop_requested():
                    stopped = True
                    break
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f'\r已下載: {done / 1024 / 1024:.1f} / {size_mb:.1f} MB   ', end='', flush=True)
                _report(done)
    finally:
        response.close()

    print()
    # Raise rather than return short: the caller's next step is to move the file
    # into movies/, and a truncated file promoted there looks downloaded.
    if stopped:
        raise IOError('下載已取消')
    if total and done < total:
        raise IOError(f'下載未完成: 只取得 {done} / {total} bytes')
    return done
