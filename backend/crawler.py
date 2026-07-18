import os
import re
import threading
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from config import headers as default_headers
from functools import partial
import concurrent.futures
import time
from Crypto.Cipher import AES

WORKERS = 16

# Cooperative cancellation flag. When set (e.g. on SIGTERM from a cancel
# request), in-flight and queued segment downloads short-circuit instead of
# hitting the network or writing to a folder that may already be deleted.
_stop_event = threading.Event()


def request_stop():
    """Signal all crawler threads to stop as soon as possible."""
    _stop_event.set()


def reset_stop():
    """Clear the stop flag before starting a fresh download."""
    _stop_event.clear()


def _make_session(dl_headers: dict) -> requests.Session:
    session = requests.Session()
    adapter = HTTPAdapter(
        pool_connections=WORKERS,
        pool_maxsize=WORKERS,
        # 429 included: rate-limiting CDNs (Google-backed hosts especially) send
        # it under load, and urllib3 honours their Retry-After before retrying.
        max_retries=Retry(total=3, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504]),
    )
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    session.headers.update(dl_headers)
    return session


def segment_filename(url):
    """On-disk name for a segment URL. Shared with merge.py — both sides must
    agree or the merge silently skips segments. Disguised-CDN segment URLs carry
    query strings with characters Windows forbids in filenames, so sanitize;
    keep the tail, where per-segment signatures live, for uniqueness."""
    name = re.sub(r'[^A-Za-z0-9._-]', '_', url.split('/')[-1][0:-3])
    return name[-100:] + '.mp4'


def _strip_fake_header(data):
    """Some CDNs disguise TS segments as images by prepending a fake header
    (e.g. PNG). Return the stream from the first valid MPEG-TS sync run
    (0x47 on a 188-byte stride); b'' when none exists — such a payload is an
    error page, and writing it would silently corrupt the merged output."""
    if data[:1] == b'\x47':
        return data
    limit = min(len(data) - 188 * 4 - 1, 8000)
    i = 0
    while 0 <= i <= limit:
        j = data.find(b'\x47', i)
        if j < 0 or j > limit:
            break
        if all(data[j + 188 * n] == 0x47 for n in range(5)):
            return data[j:]
        i = j + 1
    return b''


def scrape(key, iv, folderPath, remaining, lock, session, total, progress_cb, strip_header, url):
    # Bail out immediately if a cancel was requested — avoids network I/O and
    # writing into a folder that the cancel handler may already have removed.
    if _stop_event.is_set():
        return False
    saveName = os.path.join(folderPath, segment_filename(url))
    if os.path.exists(saveName):
        with lock:
            remaining.discard(url)
            left = len(remaining)
        _report_progress(progress_cb, total, left)
        return True
    try:
        response = session.get(url, timeout=15)
        if _stop_event.is_set():
            return False
        if response.status_code == 200:
            content_ts = response.content
            if key:
                # fresh cipher per segment — CBC is stateful, never share across threads
                content_ts = AES.new(key, AES.MODE_CBC, iv).decrypt(content_ts)
            if strip_header:
                content_ts = _strip_fake_header(content_ts)
                if not content_ts:
                    print(f'\n⚠️ 片段內容無效（非 TS）: {url.split("/")[-1][:60]}')
                    return False
            if _stop_event.is_set():
                return False
            with open(saveName, 'ab') as f:
                f.write(content_ts)
            with lock:
                remaining.discard(url)
                left = len(remaining)
            print(f'\r已完成: {url.split("/")[-1]}, 剩餘 {left} 個   ', end='', flush=True)
            _report_progress(progress_cb, total, left)
            return True
        print(f'\n⚠️ HTTP {response.status_code}: {url}')
    except Exception as e:
        # Suppress noise from the expected write/network failures that happen
        # while a cancel is tearing the download down.
        if not _stop_event.is_set():
            print(f'\n⚠️ 下載失敗 {url.split("/")[-1]}: {e}')
    return False


def _report_progress(progress_cb, total, left):
    """Invoke the caller's progress callback with (completed, total). Any
    failure inside the callback is swallowed so a flaky progress sink never
    breaks the download itself."""
    if not progress_cb or not total:
        return
    try:
        progress_cb(total - left, total)
    except Exception:
        pass


def prepareCrawl(key, iv, folderPath, tsList, dl_headers=None, progress_cb=None, strip_header=False):
    if dl_headers is None:
        dl_headers = default_headers
    reset_stop()
    remaining = set(tsList)
    start_time = time.time()
    print(f'開始下載 {len(tsList)} 個檔案 ({WORKERS} 執行緒)...')

    session = _make_session(dl_headers)
    lock = threading.Lock()
    _startCrawl(key, iv, folderPath, remaining, lock, session, tsList, progress_cb, strip_header)

    elapsed = (time.time() - start_time) / 60
    print(f'\n花費 {elapsed:.2f} 分鐘 爬取完成 !')


def _startCrawl(key, iv, folderPath, remaining, lock, session, tsList, progress_cb=None, strip_header=False):
    total = len(tsList)
    round_num = 0
    while remaining and not _stop_event.is_set():
        pending = list(remaining)
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
            executor.map(
                partial(scrape, key, iv, folderPath, remaining, lock, session, total, progress_cb, strip_header),
                pending,
            )
        round_num += 1
        if remaining:
            print(f', round {round_num} ({len(remaining)} 個重試)')
            # Growing pause between rounds: immediately re-hammering a
            # rate-limiting CDN keeps the 429s coming. wait() (not sleep) so a
            # cancel still tears the download down promptly.
            _stop_event.wait(min(3 * round_num, 30))
