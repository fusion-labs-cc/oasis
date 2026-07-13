#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Oasis Download & Catalog Script

Usage:
    python catalog.py <URL> [<URL2> ...]
    python catalog.py --no-download <URL>
    python catalog.py --list
    python catalog.py --search-actress "小倉由菜"
    python catalog.py --search-code "START-344"
"""

import argparse
import os
import re
import sys

# Backend root (this folder) holds the code + DB; movies/ lives one level up
# at the repo root (MEDIA_ROOT).
PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
MEDIA_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, '..'))
sys.path.insert(0, PROJECT_ROOT)

import json
import sqlite3

DB_PATH = os.environ.get('DB_PATH') or os.path.join(PROJECT_ROOT, 'oasis.db')

# -- Metadata extraction -------------------------------------------------------

# Video code pattern: uppercase letters + hyphen + digits (e.g., START-344, SONE-228, ABF-362)
CODE_PATTERN = re.compile(r'\b([A-Z]{2,10}-\d{2,5})\b')

# Studio prefixes mapped from common code prefixes (for reference, not used in tags)
STUDIO_MAP = {
    'START': 'SODstar',
    'STARS': 'SODstar',
    'STAR': 'SODstar',
    'SONE': 'S1',
    'SSIS': 'S1',
    'SSNI': 'S1',
    'IPX': 'IDEAPOCKET',
    'IPZ': 'IDEAPOCKET',
    'CAWD': 'kawaii',
    'KAWD': 'kawaii',
    'JUL': 'Madonna',
    'JUR': 'Madonna',
    'JUQ': 'Madonna',
    'MIDE': 'MOODYZ',
    'MIAA': 'MOODYZ',
    'ABF': 'PRESTIGE',
    'ABP': 'PRESTIGE',
    'ABW': 'PRESTIGE',
    'PRED': 'PREMIUM',
    'PPPE': 'OPPAI',
    'FSDSS': 'FALENO',
    'DLDSS': 'DAHLIA',
    'MIDV': 'MOODYZ',
    'MVSD': 'M\'s video',
    'MEYD': 'TAMEIKE GORO',
    'SNOS': 'SNOOP',
    'HMN': 'HonnakaNaka',
    'CJOD': 'POPs',
    'WAAA': 'ワンズファクトリー',
    'ROE': 'Madonna',
    'DASS': 'DAS!',
}


def extract_code(title: str) -> str | None:
    """Extract the video code (片號) from the title. e.g. 'START-344'."""
    match = CODE_PATTERN.search(title)
    return match.group(1) if match else None


def extract_actress(title: str, code: str | None) -> str | None:
    """
    Extract actress name from the title.
    Typically the last segment of the title, after the last space or ' - '.
    """
    # Remove the code from the title for cleaner parsing
    cleaned = title
    if code:
        cleaned = cleaned.replace(code, '').strip()

    # Try splitting by ' - ' first (some sites use a ' - ' separated title)
    if ' - ' in cleaned:
        candidate = cleaned.rsplit(' - ', 1)[-1].strip()
        if candidate and _looks_like_name(candidate):
            return candidate

    # Split by spaces and take the last segment
    parts = cleaned.strip().split()
    if parts:
        candidate = parts[-1].strip()
        if _looks_like_name(candidate):
            return candidate

    return None


def _looks_like_name(text: str) -> bool:
    """
    Heuristic: a Japanese actress name is typically 2-8 characters,
    composed of kanji, hiragana, katakana, or middle dots.
    """
    if not text or len(text) < 2 or len(text) > 10:
        return False
    # Must contain at least one CJK character
    if not re.search(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]', text):
        return False
    # Should not contain too many non-name characters
    noise = re.sub(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff・\s]', '', text)
    return len(noise) <= 2


def extract_title(full_title: str, code: str | None, actress: str | None) -> str:
    """Extract the title portion (everything between code and actress)."""
    title = full_title
    if code:
        title = title.replace(code, '', 1).strip()
    if actress:
        # Remove actress from the end
        if title.endswith(actress):
            title = title[: -len(actress)].strip()
        # Remove trailing ' - ' separator
        title = title.rstrip(' -').strip()
    return title


def extract_tags(raw_tags: list, code: str | None) -> list[str]:
    """Combine crawled page tags with studio derived from code."""
    tags = set(t for t in raw_tags if t)

    if code:
        prefix = code.rsplit('-', 1)[0]
        studio = STUDIO_MAP.get(prefix)
        if studio:
            tags.add(studio)

    return sorted(tags)


def is_zh_tw(text: str) -> bool:
    """Return True if text is already Traditional Chinese (no hiragana/katakana)."""
    if not text:
        return False
    has_cjk = bool(re.search(r'[一-鿿]', text))
    has_japanese = bool(re.search(r'[぀-ゟ゠-ヿ]', text))
    return has_cjk and not has_japanese


def has_japanese_kana(text: str) -> bool:
    """True if the text contains hiragana or katakana (i.e. looks Japanese)."""
    return bool(re.search(r'[぀-ゟ゠-ヿ]', text or ''))


def translate_to_zh_tw(text: str) -> str:
    """Translate Japanese text to Traditional Chinese using deep-translator."""
    if not text:
        return ''
    try:
        from deep_translator import GoogleTranslator
        result = GoogleTranslator(source='ja', target='zh-TW').translate(text)
        return result or text
    except Exception as e:
        print(f'⚠️  翻譯失敗: {e}')
        return text


# -- Database operations --------------------------------------------------------

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d['tags'] = json.loads(d['tags'] or '[]')
    return d


def insert_video(record: dict):
    """Insert or update a video record in the database."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO videos (code, url, title, title_zh_tw, actress, tags, cover, video_path)
        VALUES (:code, :url, :title, :title_zh_tw, :actress, :tags, :cover, :video_path)
        ON CONFLICT(code) DO UPDATE SET
            url         = excluded.url,
            title       = excluded.title,
            title_zh_tw = excluded.title_zh_tw,
            actress     = excluded.actress,
            tags        = excluded.tags,
            cover       = excluded.cover,
            video_path  = COALESCE(excluded.video_path, videos.video_path)
    """, {**record, 'tags': json.dumps(record.get('tags') or []), 'video_path': record.get('video_path')})
    vid = cur.lastrowid
    conn.commit()
    conn.close()
    return vid


def list_all_videos():
    """List all videos in the catalog."""
    conn = get_connection()
    rows = [_row_to_dict(r) for r in conn.execute(
        "SELECT * FROM videos ORDER BY created_at DESC"
    )]
    conn.close()
    return rows


def search_by_actress(name: str):
    conn = get_connection()
    rows = [_row_to_dict(r) for r in conn.execute(
        "SELECT * FROM videos WHERE actress LIKE ? ORDER BY created_at DESC",
        (f'%{name}%',)
    )]
    conn.close()
    return rows


def search_by_code(code: str):
    conn = get_connection()
    rows = [_row_to_dict(r) for r in conn.execute(
        "SELECT * FROM videos WHERE code = ?", (code.upper(),)
    )]
    conn.close()
    return rows


def get_video_by_id(video_id: int):
    conn = get_connection()
    row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
    conn.close()
    if row:
        return _row_to_dict(row)
    return None


def delete_video(video_id: int):
    """Delete a video row. Returns the deleted record (or None if not found)."""
    record = get_video_by_id(video_id)
    if record is None:
        return None
    conn = get_connection()
    conn.execute("DELETE FROM videos WHERE id = ?", (video_id,))
    conn.commit()
    conn.close()
    return record


def clear_video_path(video_id: int):
    """Set the video_path of a video to None/NULL. Returns the updated record (or None)."""
    conn = get_connection()
    cur = conn.execute(
        "UPDATE videos SET video_path = NULL WHERE id = ?",
        (video_id,),
    )
    conn.commit()
    updated = cur.rowcount
    conn.close()
    if not updated:
        return None
    return get_video_by_id(video_id)


def set_download_pending(video_id: int, pending: bool):
    """Mark (or clear) a video as having a download queued/in-progress. Persisted
    so a server restart can resume it instead of dropping it silently."""
    conn = get_connection()
    conn.execute(
        "UPDATE videos SET download_pending = ? WHERE id = ?",
        (1 if pending else 0, video_id),
    )
    conn.commit()
    conn.close()


def get_pending_downloads() -> list:
    """Return (id, url) for every video whose download was requested but never
    completed (pending flag set and no local file recorded yet). Used on startup
    to rebuild the download queue."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, url FROM videos "
        "WHERE download_pending = 1 AND (video_path IS NULL OR video_path = '') "
        "ORDER BY id"
    ).fetchall()
    conn.close()
    return [(r['id'], r['url']) for r in rows]


def update_video_tags(video_id: int, tags: list):
    """Replace the tag list for a video and return the updated record (or None)."""
    clean = []
    seen = set()
    for t in tags:
        t = (t or '').strip()
        if t and t not in seen:
            seen.add(t)
            clean.append(t)
    conn = get_connection()
    cur = conn.execute(
        "UPDATE videos SET tags = ? WHERE id = ?",
        (json.dumps(clean, ensure_ascii=False), video_id),
    )
    conn.commit()
    updated = cur.rowcount
    conn.close()
    if not updated:
        return None
    return get_video_by_id(video_id)


def update_video_details(video_id: int, code=None, title=None, actress=None, url=None, cover=None):
    """Update editable metadata (片號/標題/女優/原始網址/封面) for a video.

    Every argument is optional; only the fields that are not ``None`` are
    written. Returns the updated record, or None if the video does not exist.
    Raises ValueError on an empty required field or a duplicate code.
    """
    row = get_video_by_id(video_id)
    if row is None:
        return None

    updates: dict = {}

    if code is not None:
        code = (code or '').strip().upper()
        if not code:
            raise ValueError('片號不可為空')
        clash = search_by_code(code)
        if clash and clash[0]['id'] != video_id:
            raise ValueError(f'片號 {code} 已存在，請改用其他片號')
        updates['code'] = code

    if title is not None:
        title = (title or '').strip()
        if not title:
            raise ValueError('標題不可為空')
        updates['title_zh_tw'] = title
        # Keep the original title column in sync when it matched the displayed
        # title, so a manually managed title doesn't leave a stale "original"
        # line showing on the detail page.
        if (row.get('title') or '') == (row.get('title_zh_tw') or ''):
            updates['title'] = title

    if actress is not None:
        updates['actress'] = (actress or '').strip()

    if url is not None:
        url = (url or '').strip()
        if not url:
            raise ValueError('原始網址不可為空')
        updates['url'] = url

    if cover is not None:
        updates['cover'] = (cover or '').strip() or None

    if not updates:
        return row

    set_clause = ', '.join(f'{k} = ?' for k in updates)
    params = list(updates.values()) + [video_id]
    conn = get_connection()
    try:
        conn.execute(f"UPDATE videos SET {set_clause} WHERE id = ?", params)
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise ValueError(f'片號 {code} 已存在，請改用其他片號')
    conn.close()
    return get_video_by_id(video_id)


def increment_play_count(video_id: int):
    """Bump the play counter for a video and return the new count (or None)."""
    conn = get_connection()
    cur = conn.execute(
        "UPDATE videos SET play_count = COALESCE(play_count, 0) + 1 WHERE id = ?",
        (video_id,),
    )
    conn.commit()
    updated = cur.rowcount
    row = conn.execute(
        "SELECT play_count FROM videos WHERE id = ?", (video_id,)
    ).fetchone()
    conn.close()
    if not updated or row is None:
        return None
    return row['play_count']


# -- Video title fetching (lightweight, no download) ----------------------------

_active_driver = None

def fetch_page_metadata(url: str) -> tuple:
    """
    Fetch the video title and tags from the page without downloading the video.
    Returns (title, raw_tags) where raw_tags is a list of tag strings from the DOM.
    """
    global _active_driver
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from site_config import detect_site, get_cover_url, get_video_name, get_video_tags, setup_driver_for_site, wait_for_page_load

    adapter = detect_site(url)

    options = Options()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-extensions')
    options.add_argument('--headless')
    options.add_argument(
        'user-agent=Mozilla/5.0 (Windows NT 6.1; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36'
    )
    options = setup_driver_for_site(options, adapter)

    dr = webdriver.Chrome(options=options)
    _active_driver = dr
    try:
        dr.get(url)
        wait_for_page_load(dr, adapter)

        video_name = get_video_name(dr, adapter)
        raw_tags = get_video_tags(dr, adapter)
        cover_url = get_cover_url(dr)
    finally:
        dr.quit()
        _active_driver = None
    return video_name, raw_tags, cover_url


# -- Main logic -----------------------------------------------------------------

def find_local_file(code: str, title: str) -> str | None:
    """Try to find the downloaded video file in the movies folder."""
    movies_dir = os.path.join(MEDIA_ROOT, 'movies')
    if not os.path.isdir(movies_dir):
        return None

    # Search for files that start with the code
    for item in os.listdir(movies_dir):
        if item.startswith(code) or (title and item.startswith(title[:20])):
            full = os.path.join(movies_dir, item)
            if os.path.isfile(full) and full.lower().endswith('.mp4'):
                return os.path.relpath(full, MEDIA_ROOT)
            elif os.path.isdir(full):
                # Check for mp4 inside the folder
                for f in os.listdir(full):
                    if f.lower().endswith('.mp4'):
                        return os.path.relpath(os.path.join(full, f), MEDIA_ROOT)
    return None


def process_url(url: str, skip_download: bool = False):
    """Process a single URL: extract metadata + store in DB first, then download."""
    print(f'\n{"=" * 60}')
    print(f'🎬 處理 URL: {url}')
    print(f'{"=" * 60}')

    # Step 1: Fetch the title and tags from the page
    print('\n📡 正在取得影片資訊...')
    full_title, raw_tags, cover_url = fetch_page_metadata(url)
    print(f'   標題: {full_title}')

    # Step 2: Extract metadata
    code = extract_code(full_title)
    actress = extract_actress(full_title, code)
    title = extract_title(full_title, code, actress)
    tags = extract_tags(raw_tags, code)

    print(f'\n📋 解析結果:')
    print(f'   片號:     {code or "（未偵測到）"}')
    print(f'   女優:     {actress or "（未偵測到）"}')
    print(f'   標題:     {title}')
    print(f'   標籤:     {", ".join(tags) if tags else "（無）"}')

    # Step 3: Translate to zh-TW (skip if already zh-TW)
    if is_zh_tw(title):
        print('\n🌐 標題已是繁體中文，略過翻譯')
        title_zh_tw = title
    else:
        print('\n🌐 翻譯標題為繁體中文...')
        title_zh_tw = translate_to_zh_tw(title)
    print(f'   ZH 標題:  {title_zh_tw}')

    # Step 4: Store metadata in DB IMMEDIATELY (before download)
    # Try to find an existing local video file
    local_path = find_local_file(code or full_title[:20], title)
    if local_path:
        print(f'   本地檔案: {local_path}')

    record = {
        'code': code or full_title[:20],
        'url': url,
        'title': title,
        'title_zh_tw': title_zh_tw,
        'actress': actress,
        'tags': tags,
        'cover': cover_url,
        'video_path': local_path,
    }

    print('\n💾 寫入資料庫...')
    try:
        vid = insert_video(record)
        record['id'] = vid
        print(f'✅ 已儲存至資料庫 (ID: {vid})')
    except Exception as e:
        print(f'❌ 資料庫寫入失敗: {e}')
        print('   提示: 請確認已執行 db_setup.py 初始化資料庫')
        return None

    # Step 5: Download video (optional) — runs AFTER DB insert
    if not skip_download:
        print('\n⬇️  開始下載影片...')
        try:
            from download import download
            download(url)
            print('✅ 下載完成')

        except Exception as e:
            print(f'⚠️  下載過程中發生錯誤: {e}')
    else:
        print('\n⏭️  跳過下載（--no-download）')

    return record


def next_manual_code() -> str:
    """Next sequential placeholder code for manual entries without a real code.

    Format is ``MANUAL-<n>`` where n is a pure number of at most 5 digits
    (max 99999). Derived from the highest existing MANUAL-<n> so it stays unique
    and never collides with the UNIQUE code column.
    """
    conn = get_connection()
    rows = conn.execute("SELECT code FROM videos WHERE code LIKE 'MANUAL-%'").fetchall()
    conn.close()
    max_n = 0
    for row in rows:
        m = re.match(r'^MANUAL-(\d{1,5})$', row['code'])
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f'MANUAL-{max_n + 1}'


def create_manual_video(url, title, code=None, actress=None, tags=None, cover=None):
    """Create a catalog entry from user-supplied fields (manual add, no scraping).

    Only ``url`` and ``title`` are required. When ``code`` is omitted it is
    auto-extracted from the title (e.g. 'START-344'); if none can be detected a
    unique placeholder is generated so the NOT NULL / UNIQUE code column holds.
    Tags accept either a list or a comma-separated string.
    """
    url = (url or '').strip()
    title = (title or '').strip()
    if not url:
        raise ValueError('URL 不可為空')
    if not title:
        raise ValueError('標題不可為空')

    # Prefer an explicit code, then auto-extract from the title, else fall back
    # to a unique placeholder so we never violate the NOT NULL/UNIQUE column.
    code = (code or '').strip().upper() or extract_code(title)
    if not code:
        code = next_manual_code()

    # Block duplicates on manual add: insert_video upserts on code, which would
    # silently overwrite an existing entry. next_manual_code() is already unique,
    # so this only rejects a real/explicit code that already exists.
    if search_by_code(code):
        raise ValueError(f'片號 {code} 已存在，請勿重複新增')

    actress = (actress or '').strip() or None
    cover = (cover or '').strip() or None

    # Clean the title before storing: the code and actress live in their own
    # columns, so remove the code (with any wrapping brackets, e.g. '[START-344]')
    # and a trailing actress name. A MANUAL-<n> placeholder isn't in the title,
    # so nothing is removed in that case. Keep the original title if cleaning
    # would leave it empty (e.g. the title was just the code).
    _seps = ' -–—・\t'
    cleaned = re.sub(r'[\[\(（【]?' + re.escape(code) + r'[\]\)）】]?', '', title, count=1)
    if actress and cleaned.rstrip(_seps).endswith(actress):
        cleaned = cleaned.rstrip(_seps)[: -len(actress)]
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip(_seps)
    title = cleaned or title

    # Accept a comma-separated string or a list; strip + de-duplicate.
    if isinstance(tags, str):
        tags = tags.split(',')
    clean_tags = []
    seen = set()
    for t in tags or []:
        t = (t or '').strip()
        if t and t not in seen:
            seen.add(t)
            clean_tags.append(t)

    # Only machine-translate titles that actually look Japanese; leave titles the
    # user already typed in Chinese or English untouched.
    title_zh_tw = translate_to_zh_tw(title) if has_japanese_kana(title) else title

    record = {
        'code': code,
        'url': url,
        'title': title,
        'title_zh_tw': title_zh_tw,
        'actress': actress,
        'tags': clean_tags,
        'cover': cover,
        'video_path': find_local_file(code, title),
    }
    vid = insert_video(record)
    record['id'] = vid
    return record


# -- Import / Export ------------------------------------------------------------

# Portable metadata fields carried in an export. Deliberately excludes the local
# video_path, play_count, download_pending and created_at — those are specific to
# one machine/session and are re-derived (or reset) on the importing side.
EXPORT_FIELDS = ('code', 'url', 'title', 'title_zh_tw', 'actress', 'tags', 'cover')


def export_videos() -> list[dict]:
    """Return the whole catalog as plain dicts holding only the portable
    metadata fields (see EXPORT_FIELDS), ready to be serialised to JSON."""
    return [{k: r.get(k) for k in EXPORT_FIELDS} for r in list_all_videos()]


def import_videos(records: list) -> dict:
    """Insert/update videos from previously exported JSON.

    Only the portable metadata fields are honoured; video_path/play_count/
    download_pending/created_at are ignored (video_path on an existing row is
    preserved by insert_video's COALESCE upsert). An entry with the same code as
    an existing one updates it; a new code inserts a fresh row.

    Records missing a code/url/title are skipped. Returns a summary dict with the
    number of records imported and skipped.
    """
    if not isinstance(records, list):
        raise ValueError('匯入資料必須是影片陣列')

    imported = 0
    skipped = 0
    for rec in records:
        if not isinstance(rec, dict):
            skipped += 1
            continue
        code = (rec.get('code') or '').strip().upper()
        url = (rec.get('url') or '').strip()
        title = (rec.get('title') or '').strip()
        if not code or not url or not title:
            skipped += 1
            continue

        # Accept tags as a list or a comma-separated string; strip + de-duplicate.
        raw_tags = rec.get('tags') or []
        if isinstance(raw_tags, str):
            raw_tags = raw_tags.split(',')
        tags = []
        seen = set()
        for t in raw_tags:
            t = (t or '').strip()
            if t and t not in seen:
                seen.add(t)
                tags.append(t)

        insert_video({
            'code': code,
            'url': url,
            'title': title,
            'title_zh_tw': (rec.get('title_zh_tw') or '').strip() or title,
            'actress': (rec.get('actress') or '').strip() or None,
            'tags': tags,
            'cover': (rec.get('cover') or '').strip() or None,
            'video_path': None,  # preserved on existing rows via COALESCE upsert
        })
        imported += 1

    return {'imported': imported, 'skipped': skipped}


def print_video_table(rows):
    """Pretty-print a list of video records."""
    if not rows:
        print('（無資料）')
        return

    print(f'\n{"片號":<12} {"女優":<12} {"標籤":<30} {"標題":<40}')
    print('-' * 94)
    for r in rows:
        code = r.get('code', '')
        actress = r.get('actress', '') or ''
        tags_str = ', '.join(r.get('tags', []) or [])
        title = (r.get('title', '') or '')[:38]
        print(f'{code:<12} {actress:<12} {tags_str:<30} {title:<40}')
    print(f'\n共 {len(rows)} 筆資料')


QUEUE_FILE = os.path.join(PROJECT_ROOT, 'queue.txt')


def queue_add(urls: list[str]):
    with open(QUEUE_FILE, 'a', encoding='utf-8') as f:
        for url in urls:
            f.write(url.strip() + '\n')
    print(f'✅ 已加入佇列 {len(urls)} 個 URL（{QUEUE_FILE}）')


def queue_load() -> list[str]:
    if not os.path.exists(QUEUE_FILE):
        return []
    with open(QUEUE_FILE, encoding='utf-8') as f:
        return [line.strip() for line in f if line.strip()]


def queue_remove(url: str):
    urls = queue_load()
    with open(QUEUE_FILE, 'w', encoding='utf-8') as f:
        for u in urls:
            if u != url.strip():
                f.write(u + '\n')


# -- CLI entry point ------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Oasis 影片下載 & 分類入庫工具'
    )
    parser.add_argument('urls', nargs='*', help='影片 URL(s)')
    parser.add_argument('--no-download', action='store_true',
                        help='僅取得資訊並入庫，不下載影片')
    parser.add_argument('--all', action='store_true',
                        help='重新爬取資料庫中所有影片的資訊（需配合 --no-download）')
    parser.add_argument('-q', '--queue', action='store_true',
                        help='將 URL 加入佇列，不立即處理')
    parser.add_argument('--install', action='store_true',
                        help='處理並下載佇列中的所有影片')
    parser.add_argument('--list', action='store_true',
                        help='列出所有已入庫影片')
    parser.add_argument('--search-actress', type=str, default='',
                        help='依女優名稱搜尋')
    parser.add_argument('--search-code', type=str, default='',
                        help='依片號搜尋')

    args = parser.parse_args()

    if args.queue:
        if not args.urls:
            print('❌ 請提供至少一個影片 URL')
            sys.exit(1)
        queue_add(args.urls)
        return

    if args.install:
        urls = queue_load()
        if not urls:
            print('（佇列為空）')
            return
        print(f'\n📦 開始處理佇列中的 {len(urls)} 部影片...')
        results = []
        for url in urls:
            result = process_url(url, skip_download=False)
            if result:
                queue_remove(url)
                results.append(result)
        if results:
            print(f'\n\n{"=" * 60}')
            print(f'🎉 佇列處理完成！共 {len(results)} 部影片已入庫')
            print(f'{"=" * 60}')
            for r in results:
                print(f'  • {r["code"]} - {r["actress"] or "?"} - {r["title"][:40]}')
        return

    if args.list:
        print('\n📚 所有已入庫影片:')
        rows = list_all_videos()
        print_video_table(rows)
        return

    if args.search_actress:
        print(f'\n🔍 搜尋女優: {args.search_actress}')
        rows = search_by_actress(args.search_actress)
        print_video_table(rows)
        return

    if args.search_code:
        print(f'\n🔍 搜尋片號: {args.search_code}')
        rows = search_by_code(args.search_code)
        print_video_table(rows)
        return

    if args.all:
        rows = list_all_videos()
        if not rows:
            print('（資料庫無影片）')
            return
        urls = [r['url'] for r in rows]
        print(f'\n🔄 重新爬取 {len(urls)} 部影片資訊（不下載）...')
    elif args.urls:
        urls = args.urls
    else:
        parser.print_help()
        print('\n❌ 請提供至少一個影片 URL，或使用 --all 重新爬取所有影片')
        sys.exit(1)

    results = []
    for url in urls:
        result = process_url(url, skip_download=True if args.all else args.no_download)
        if result:
            results.append(result)

    # Summary
    if results:
        print(f'\n\n{"=" * 60}')
        print(f'🎉 處理完成！共 {len(results)} 部影片已入庫')
        print(f'{"=" * 60}')
        for r in results:
            print(f'  • {r["code"]} - {r["actress"] or "?"} - {r["title"][:40]}')


if __name__ == '__main__':
    main()
