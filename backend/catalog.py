#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Oasis scraping + SQLite catalog logic.

Importable module consumed by the FastAPI backend (api.py): URL analysis and
download (process_url), the video queries, and the manual/import/export helpers.
"""

import os
import re
import sys

# Backend root (this folder) holds the code + DB; movies/ lives one level up
# at the repo root (MEDIA_ROOT).
PROJECT_ROOT = os.path.abspath(os.path.dirname(__file__))
# In a source checkout movies/ sits one level up; a frozen build overrides this
# via OASIS_MEDIA_ROOT so media resolves next to the .exe rather than inside the
# read-only extraction dir.
MEDIA_ROOT = os.environ.get('OASIS_MEDIA_ROOT') or os.path.abspath(os.path.join(PROJECT_ROOT, '..'))
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


# Characters whose glyph exists only in Simplified Chinese (their traditional
# forms differ). Ambiguous glyphs shared by both scripts (里, 后, 面, 云…) are
# deliberately excluded — one hit must mean the text is Simplified.
_SIMPLIFIED_ONLY = set(
    '无码说体发记为这们买卖乐时门问闻见觉视观规览频线释认识译语请让谁谢诉读诞调谈证评词访设计许论'
    '译试诗诚话询该详误说课谊谋谜谅红纪约级纳纯纸纹纺练组细织终绍经绑绕绘给绝统继绩维绵综缘编缠缩'
    '钱铁银错钟钢销锁锦键镜饭饮饰馆马妈骂吗鸟鸡鸭鸣车轮转轻辆载页顶项顺须顾预领题颜贝财贫购贯贵费'
    '贴贸资赏赛质败货贪贮员圆爱达迁过运还边逻阴阳际陆队团园围图国华伟传优侠仅从众长东冻陈击刘剑办'
    '劝动务势医单卖压厅历厉参双变叠发叙叹后向吓吕启员响哑唤啸喷嘱严丧个丰临义乌乔习乡书争亏亚产亲'
    '亿仪价会伞妇学写实审宽宾对导将尔尘尝尽层属岁岛巅币师带帮干广庄庆库应庙废开异弃张弹归当录彻径'
    '恋恳恶悬惊惧愿态怀忆总离难电灵'
    '极术处备复够夹奋娇孙宁冲减凤刚创荡骚兽独汉泽湿温环现疯睁瞒确碍万与专丝两关兴养热恼润涨烂牵猎穷'
    '窝笔筹简类罚肠肤脑脏艳药触赶躯辞递选邻酱钻阅阵隐雾风'
)


def is_zh_tw(text: str) -> bool:
    """Return True if text is already Traditional Chinese — CJK with no
    hiragana/katakana and no simplified-only glyph. Simplified titles (supjav)
    must fail this check, or they skip translation entirely."""
    if not text:
        return False
    has_cjk = bool(re.search(r'[一-鿿]', text))
    has_japanese = bool(re.search(r'[぀-ゟ゠-ヿ]', text))
    has_simplified = any(c in _SIMPLIFIED_ONLY for c in text)
    return has_cjk and not has_japanese and not has_simplified


def has_japanese_kana(text: str) -> bool:
    """True if the text contains hiragana or katakana (i.e. looks Japanese)."""
    return bool(re.search(r'[぀-ゟ゠-ヿ]', text or ''))


def translate_to_zh_tw(text: str) -> str:
    """Translate to Traditional Chinese using deep-translator. Source is
    auto-detected: titles arrive in Japanese (jable/missav) or Simplified
    Chinese (supjav), and a hardcoded 'ja' source mistranslates the latter."""
    if not text:
        return ''
    try:
        from deep_translator import GoogleTranslator
        result = GoogleTranslator(source='auto', target='zh-TW').translate(text)
        return result or text
    except Exception as e:
        print(f'⚠️  翻譯失敗: {e}')
        return text


def translate_tags_to_zh_tw(tags: list[str]) -> list[str]:
    """Convert Simplified-Chinese tags to zh-TW; every other tag passes
    through untouched. The candidates go in one newline-joined request —
    per-tag calls would cost a round-trip each — falling back to per-tag
    only if the translator does not preserve the line structure."""
    todo = [t for t in tags if any(c in _SIMPLIFIED_ONLY for c in t)]
    if not todo:
        return tags
    parts = [p.strip() for p in translate_to_zh_tw('\n'.join(todo)).split('\n')]
    if len(parts) != len(todo):
        parts = [translate_to_zh_tw(t) for t in todo]
    mapping = dict(zip(todo, parts))
    return [mapping.get(t) or t for t in tags]


# -- Database operations --------------------------------------------------------

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# Columns returned to the API/UI. Deliberately excludes the cover_image BLOB:
# a `SELECT *` would pull every cover's bytes into memory on a full-catalog list.
# `has_cover` exposes only *whether* an image is cached; the bytes are served
# separately by /api/stream/cover.
_VIDEO_COLUMNS = (
    "v.id, v.code, v.url, v.title, v.title_zh_tw, v.actress, v.tags, v.cover, v.video_path, "
    "v.created_at, v.play_count, v.download_pending, v.series_id, v.episode, "
    "s.name AS series, s.cover AS series_cover, (s.cover_image IS NOT NULL) AS series_has_cover, "
    "(v.cover_image IS NOT NULL) AS has_cover"
)

# Every read joins the series name in rather than returning only series_id: the
# catalog UI shows the name on each card, and a bare id would force the frontend
# to load and hold a second list just to render one chip.
_VIDEO_SELECT = f"SELECT {_VIDEO_COLUMNS} FROM videos v LEFT JOIN series s ON s.id = v.series_id"


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d['tags'] = json.loads(d['tags'] or '[]')
    if 'has_cover' in d:
        d['has_cover'] = bool(d['has_cover'])
    if 'series_has_cover' in d:
        d['series_has_cover'] = bool(d['series_has_cover'])
    return d


def insert_video(record: dict):
    """Insert or update a video record in the database."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO videos (code, url, title, title_zh_tw, actress, tags, cover, video_path,
                            series_id, episode)
        VALUES (:code, :url, :title, :title_zh_tw, :actress, :tags, :cover, :video_path,
                :series_id, :episode)
        ON CONFLICT(code) DO UPDATE SET
            url         = excluded.url,
            title       = excluded.title,
            title_zh_tw = excluded.title_zh_tw,
            actress     = excluded.actress,
            tags        = excluded.tags,
            cover       = excluded.cover,
            video_path  = COALESCE(excluded.video_path, videos.video_path),
            -- COALESCE like video_path: a re-analysed season restates its series
            -- and updates it, while any other write leaves a hand-set series alone.
            series_id   = COALESCE(excluded.series_id, videos.series_id),
            episode     = COALESCE(excluded.episode, videos.episode)
    """, {
        **record,
        'tags': json.dumps(record.get('tags') or []),
        'video_path': record.get('video_path'),
        'series_id': record.get('series_id'),
        'episode': record.get('episode'),
    })
    # lastrowid is only meaningful on the INSERT branch; when the ON CONFLICT
    # UPDATE fires it still holds whatever the previous statement set, so read
    # the id back by the key we upserted on.
    row = cur.execute("SELECT id FROM videos WHERE code = ?", (record['code'],)).fetchone()
    vid = row['id'] if row else cur.lastrowid
    conn.commit()
    conn.close()
    return vid


def list_all_videos():
    """List all videos in the catalog."""
    conn = get_connection()
    rows = [_row_to_dict(r) for r in conn.execute(
        f"{_VIDEO_SELECT} ORDER BY v.created_at DESC, v.id DESC"
    )]
    conn.close()
    return rows


def search_by_code(code: str):
    conn = get_connection()
    rows = [_row_to_dict(r) for r in conn.execute(
        f"{_VIDEO_SELECT} WHERE v.code = ?", (code.upper(),)
    )]
    conn.close()
    return rows


def get_video_by_id(video_id: int):
    conn = get_connection()
    row = conn.execute(f"{_VIDEO_SELECT} WHERE v.id = ?", (video_id,)).fetchone()
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


def update_video_details(video_id: int, code=None, title=None, actress=None, url=None,
                         cover=None, series_id=..., episode=...):
    """Update editable metadata (片號/標題/女優/原始網址/封面/系列) for a video.

    Every argument is optional; only the fields that are not ``None`` are
    written. Returns the updated record, or None if the video does not exist.
    Raises ValueError on an empty required field or a duplicate code.

    ``series_id`` and ``episode`` default to a sentinel rather than None because
    None is a meaningful value for them — it is how the caller clears a video's
    series — so "not supplied" and "set to nothing" have to stay distinguishable.
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
        new_cover = (cover or '').strip() or None
        # Drop the cached bytes whenever the source URL changes so the next view
        # re-fetches from the new URL instead of serving the old image.
        if new_cover != (row.get('cover') or None):
            updates['cover'] = new_cover
            updates['cover_image'] = None
            updates['cover_type'] = None

    if series_id is not ...:
        sid = int(series_id) if series_id not in (None, '') else None
        if sid is not None and get_series_by_id(sid) is None:
            raise ValueError('系列不存在')
        updates['series_id'] = sid
        # Leaving a series must not strand an episode number behind: it would
        # keep sorting the video as if it were still part of one.
        if sid is None:
            updates['episode'] = None

    if episode is not ... and updates.get('series_id', row.get('series_id')) is not None:
        updates['episode'] = int(episode) if episode not in (None, '') else None

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


# -- Series -------------------------------------------------------------------

def list_series() -> list:
    """Every series with its member count, cover, and has_cover."""
    conn = get_connection()
    rows = [dict(r) for r in conn.execute(
        "SELECT s.id, s.name, s.cover, (s.cover_image IS NOT NULL) AS has_cover, s.created_at, COUNT(v.id) AS count "
        "FROM series s LEFT JOIN videos v ON v.series_id = s.id "
        "GROUP BY s.id ORDER BY count DESC, s.name"
    )]
    conn.close()
    return rows


def get_series_by_id(series_id: int):
    conn = get_connection()
    row = conn.execute(
        "SELECT id, name, cover, (cover_image IS NOT NULL) AS has_cover, created_at FROM series WHERE id = ?",
        (series_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def create_series(name: str, cover: str | None = None) -> dict:
    """Create a series, or return the existing one with that name.

    Idempotent on purpose: re-analysing a season must rejoin its series rather
    than grow a second one with an identical name.
    """
    name = (name or '').strip()
    if not name:
        raise ValueError('系列名稱不可為空')
    cover_val = cover.strip() if isinstance(cover, str) and cover.strip() else None
    conn = get_connection()
    conn.execute("INSERT OR IGNORE INTO series (name, cover) VALUES (?, ?)", (name, cover_val))
    conn.commit()
    row = conn.execute(
        "SELECT id, name, cover, (cover_image IS NOT NULL) AS has_cover, created_at FROM series WHERE name = ?",
        (name,)
    ).fetchone()
    conn.close()
    return dict(row)


def update_series(series_id: int, name: str | None = None, cover: str | None = ...) -> dict | None:
    """Update editable series fields (name and/or cover)."""
    if get_series_by_id(series_id) is None:
        return None

    conn = get_connection()
    updates = []
    params = []

    if name is not None:
        clean_name = name.strip()
        if not clean_name:
            conn.close()
            raise ValueError('系列名稱不可為空')
        updates.append("name = ?")
        params.append(clean_name)

    if cover is not ...:
        clean_cover = cover.strip() if isinstance(cover, str) and cover.strip() else None

        # If clean_cover is a local video cover URL, extract video_id and copy its cover image directly
        m = re.search(r'/api/stream/cover/(\d+)', clean_cover or '')
        if m:
            v_id = int(m.group(1))
            v_row = conn.execute("SELECT cover, cover_image, cover_type FROM videos WHERE id = ?", (v_id,)).fetchone()
            if v_row:
                clean_cover = v_row['cover'] or clean_cover
                if v_row['cover_image']:
                    conn.execute(
                        "UPDATE series SET cover = ?, cover_image = ?, cover_type = ? WHERE id = ?",
                        (clean_cover, v_row['cover_image'], v_row['cover_type'], series_id)
                    )
                    if name is not None:
                        conn.execute("UPDATE series SET name = ? WHERE id = ?", (name.strip(), series_id))
                    conn.commit()
                    conn.close()
                    return get_series_by_id(series_id)

        updates.append("cover = ?")
        params.append(clean_cover)
        updates.append("cover_image = NULL")
        updates.append("cover_type = NULL")

    if updates:
        params.append(series_id)
        sql = f"UPDATE series SET {', '.join(updates)} WHERE id = ?"
        try:
            conn.execute(sql, params)
            conn.commit()
        except sqlite3.IntegrityError:
            conn.close()
            raise ValueError(f'系列「{name}」已存在')

    conn.close()
    return get_series_by_id(series_id)


def rename_series(series_id: int, name: str):
    return update_series(series_id, name=name)


def delete_series(series_id: int) -> bool:
    """Delete a series. Its videos are kept — they just become unclassified."""
    if get_series_by_id(series_id) is None:
        return False
    conn = get_connection()
    # One transaction: a series row that vanished while its members still
    # pointed at it would leave every one of them with a dangling series_id,
    # and nothing in SQLite is enforcing that reference for us.
    conn.execute("UPDATE videos SET series_id = NULL, episode = NULL WHERE series_id = ?", (series_id,))
    conn.execute("DELETE FROM series WHERE id = ?", (series_id,))
    conn.commit()
    conn.close()
    return True


def assign_videos_to_series(series_id: int, video_ids: list) -> int:
    """Put videos into a series, numbering them after its current last episode.

    Numbering continues rather than restarting so a second batch appends
    instead of colliding with the first. Videos already in this series keep
    their episode number; moving one in from elsewhere gives it a new one.
    Returns how many rows changed.
    """
    if get_series_by_id(series_id) is None:
        raise ValueError('系列不存在')
    if not video_ids:
        return 0

    conn = get_connection()
    row = conn.execute(
        "SELECT MAX(episode) AS m FROM videos WHERE series_id = ?", (series_id,)
    ).fetchone()
    next_ep = (row['m'] or 0) + 1

    changed = 0
    for vid in video_ids:
        current = conn.execute(
            "SELECT series_id, episode FROM videos WHERE id = ?", (vid,)
        ).fetchone()
        if current is None:
            continue
        if current['series_id'] == series_id and current['episode'] is not None:
            continue  # already placed — don't renumber it
        conn.execute(
            "UPDATE videos SET series_id = ?, episode = ? WHERE id = ?",
            (series_id, next_ep, vid),
        )
        next_ep += 1
        changed += 1
    conn.commit()
    conn.close()
    return changed


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


# -- Cover images ---------------------------------------------------------------

# Refuse to buffer an unbounded response body into the DB. Covers are small
# posters; anything larger is almost certainly not a cover.
_COVER_MAX_BYTES = 15 * 1024 * 1024


def fetch_cover_image(url: str, referer: str | None = None) -> tuple[bytes, str] | None:
    """Download a cover image's raw bytes + MIME type from its origin URL."""
    url = (url or '').strip()

    # If URL is a local video stream endpoint, fetch bytes directly from DB
    m = re.search(r'/api/stream/cover/(\d+)', url)
    if m:
        v_src = get_cover_source(int(m.group(1)))
        if v_src and v_src['data']:
            return bytes(v_src['data']), v_src['mime'] or 'image/jpeg'
        if v_src and v_src['cover_url'] and not ('127.0.0.1' in v_src['cover_url'] or 'localhost' in v_src['cover_url']):
            url = v_src['cover_url']

    if not url.lower().startswith(('http://', 'https://')):
        return None

    # Refuse loopback HTTP requests to backend itself to prevent deadlock
    if '127.0.0.1' in url or 'localhost' in url:
        return None

    try:
        import requests
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) '
                          'Chrome/120.0.0.0 Safari/537.36',
        }
        if referer:
            headers['Referer'] = referer
        resp = requests.get(url, headers=headers, timeout=15, stream=True)
        resp.raise_for_status()
        ctype = (resp.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if not ctype.startswith('image/'):
            return None
        data = bytearray()
        for chunk in resp.iter_content(64 * 1024):
            data.extend(chunk)
            if len(data) > _COVER_MAX_BYTES:
                return None
        if not data:
            return None
        return bytes(data), ctype
    except Exception:
        return None


def store_cover_image(video_id: int, data: bytes, mime: str):
    """Persist the fetched cover bytes + MIME for a video."""
    conn = get_connection()
    conn.execute(
        "UPDATE videos SET cover_image = ?, cover_type = ? WHERE id = ?",
        (sqlite3.Binary(data), mime, video_id),
    )
    conn.commit()
    conn.close()


def get_cover_source(video_id: int) -> dict | None:
    """Return everything the cover endpoint needs to serve (or lazily fetch) a
    cover. If video has no cover of its own, falls back to its series cover if present."""
    conn = get_connection()
    row = conn.execute(
        "SELECT v.cover_image, v.cover_type, v.cover, v.url, v.series_id, "
        "s.cover AS s_cover, s.cover_image AS s_cover_image, s.cover_type AS s_cover_type "
        "FROM videos v LEFT JOIN series s ON s.id = v.series_id WHERE v.id = ?",
        (video_id,),
    ).fetchone()
    conn.close()
    if row is None:
        return None

    # If video has its own cover image or URL
    if row['cover_image'] or (row['cover'] and row['cover'].strip()):
        return {
            'data': row['cover_image'],
            'mime': row['cover_type'],
            'cover_url': row['cover'],
            'page_url': row['url'],
        }

    # Fallback to series cover if video has no cover of its own
    if row['series_id'] and (row['s_cover_image'] or (row['s_cover'] and row['s_cover'].strip())):
        return {
            'data': row['s_cover_image'],
            'mime': row['s_cover_type'],
            'cover_url': row['s_cover'],
            'page_url': row['url'],
        }

    return {
        'data': None,
        'mime': None,
        'cover_url': None,
        'page_url': row['url'],
    }


def store_series_cover_image(series_id: int, data: bytes, mime: str):
    """Persist the fetched cover bytes + MIME for a series."""
    conn = get_connection()
    conn.execute(
        "UPDATE series SET cover_image = ?, cover_type = ? WHERE id = ?",
        (sqlite3.Binary(data), mime, series_id),
    )
    conn.commit()
    conn.close()


def get_series_cover_source(series_id: int) -> dict | None:
    """Return cover image bytes/MIME and URL for a series, falling back to first episode cover if no series cover set."""
    conn = get_connection()
    row = conn.execute(
        "SELECT cover_image, cover_type, cover FROM series WHERE id = ?",
        (series_id,),
    ).fetchone()
    if row is None:
        conn.close()
        return None

    result = {
        'data': row['cover_image'],
        'mime': row['cover_type'],
        'cover_url': row['cover'],
    }

    # If series has cover_url but no cached bytes, check if any video in this series shares this cover URL and has cached bytes!
    if not result['data'] and result['cover_url']:
        ep_row = conn.execute(
            "SELECT cover_image, cover_type, url FROM videos "
            "WHERE series_id = ? AND cover = ? AND cover_image IS NOT NULL LIMIT 1",
            (series_id, result['cover_url'])
        ).fetchone()
        if ep_row:
            result['data'] = ep_row['cover_image']
            result['mime'] = ep_row['cover_type']
            result['page_url'] = ep_row['url']

    if not result['data'] and not result['cover_url']:
        ep_row = conn.execute(
            "SELECT cover_image, cover_type, cover, url FROM videos "
            "WHERE series_id = ? AND (cover_image IS NOT NULL OR (cover IS NOT NULL AND cover != '')) "
            "ORDER BY episode ASC, id ASC LIMIT 1",
            (series_id,)
        ).fetchone()
        if ep_row:
            result = {
                'data': ep_row['cover_image'],
                'mime': ep_row['cover_type'],
                'cover_url': ep_row['cover'],
                'page_url': ep_row['url'],
            }
    conn.close()
    return result


def get_covers_needing_backfill() -> list[tuple[int, str, str]]:
    """Return (id, cover_url, page_url) for every row that carries an origin
    cover URL but no cached image yet.

    Drives the startup backfill: entries created before covers were stored (and
    every manual/import entry, which only carries the URL) get their real image
    fetched proactively, instead of waiting to be viewed."""
    conn = get_connection()
    rows = conn.execute(
        "SELECT id, cover, url FROM videos "
        "WHERE cover_image IS NULL AND cover IS NOT NULL AND cover != '' "
        "ORDER BY id"
    ).fetchall()
    conn.close()
    return [(r['id'], r['cover'], r['url']) for r in rows]


# -- Video title fetching (lightweight, no download) ----------------------------

_active_driver = None

def _start_scrape_driver(adapter: dict):
    """The headless Chrome the scraping paths share."""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from site_config import setup_driver_for_site

    options = Options()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-extensions')
    options.add_argument('--headless')
    options.add_argument(
        'user-agent=Mozilla/5.0 (Windows NT 6.1; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36'
    )
    return webdriver.Chrome(options=setup_driver_for_site(options, adapter))


def fetch_page_metadata(url: str) -> tuple:
    """
    Fetch the video title and tags from the page without downloading the video.
    Returns (title, raw_tags) where raw_tags is a list of tag strings from the DOM.
    """
    global _active_driver
    from site_config import detect_site, get_cover_url, get_video_actress, get_video_name, get_video_tags, wait_for_page_load

    adapter = detect_site(url)

    dr = _start_scrape_driver(adapter)
    _active_driver = dr
    try:
        dr.get(url)
        wait_for_page_load(dr, adapter)

        video_name = get_video_name(dr, adapter)
        raw_tags = get_video_tags(dr, adapter)
        cover_url = get_cover_url(dr, adapter)
        page_actress = get_video_actress(dr, adapter)
    finally:
        dr.quit()
        _active_driver = None
    return video_name, raw_tags, cover_url, page_actress


# -- Main logic -----------------------------------------------------------------

def find_local_file(code: str, title: str) -> str | None:
    """Try to find the downloaded video file in the movies folder."""
    movies_dir = os.path.join(MEDIA_ROOT, 'movies')
    if not os.path.isdir(movies_dir):
        return None

    # Match the code anywhere in the name, not just as a prefix: some sites
    # (supjav) title their videos with a leading bracket tag, and the stored
    # title has the code stripped out of it, so neither field prefix-matches.
    # A code is unique per video, so a substring hit is the same video.
    code_l = (code or '').lower()
    for item in os.listdir(movies_dir):
        if (code_l and code_l in item.lower()) or (title and item.startswith(title[:20])):
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
    full_title, raw_tags, cover_url, page_actress = fetch_page_metadata(url)
    print(f'   標題: {full_title}')

    # Step 2: Extract metadata. The page's own cast label, when the adapter
    # scrapes one, beats guessing the name off the title's tail.
    code = extract_code(full_title)
    actress = page_actress or extract_actress(full_title, code)
    title = extract_title(full_title, code, actress)
    tags = translate_tags_to_zh_tw(extract_tags(raw_tags, code))

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


def _fetch_listing_entries(url: str) -> tuple[dict, list[dict], str | None]:
    """Walk a listing and its following pages in one browser session, returning
    (adapter, entries, series_name) with entries in page order."""
    global _active_driver
    from site_config import (
        detect_site, get_listing_entries, get_listing_series_name,
        get_next_page_url, listing_max_pages, wait_for_page_load,
    )

    adapter = detect_site(url)
    max_pages = listing_max_pages(adapter)

    dr = _start_scrape_driver(adapter)
    _active_driver = dr
    entries: list[dict] = []
    seen: set[str] = set()
    series_name: str | None = None
    try:
        page_url = url
        visited: set[str] = set()
        for page in range(max_pages):
            visited.add(page_url)
            dr.get(page_url)
            wait_for_page_load(dr, adapter)
            # Read from the first page only: later pages are the same listing,
            # and page 1 is the one the user actually pasted.
            if page == 0:
                series_name = get_listing_series_name(dr, adapter)
            found = get_listing_entries(dr, adapter)
            print(f'   第 {page + 1} 頁: {len(found)} 個項目')
            for entry in found:
                if entry['url'] in seen:
                    continue
                seen.add(entry['url'])
                entries.append(entry)

            next_url = get_next_page_url(dr, adapter)
            # A last page whose pager links back to a page already read would
            # otherwise loop until max_pages, re-reading the same items.
            if not next_url or next_url in visited:
                break
            page_url = next_url
        else:
            print(f'⚠️  已達分頁上限 {max_pages} 頁，停止列舉')
    finally:
        dr.quit()
        _active_driver = None
    return adapter, entries, series_name


def process_listing_url(url: str) -> list[dict]:
    """Process a listing page (a season's episodes, a playlist) into one catalog
    record per item. Returns the records, oldest first.

    The individual item pages are never opened: the listing already carries every
    title, and a site that lists this way has no per-item cover or cast to go
    back for — so a 12-episode season costs one page load, not thirteen. The
    media URL is resolved later, by the download worker, on the item's own page.
    """
    from site_config import derive_code

    print(f'\n{"=" * 60}')
    print(f'📚 處理列表頁: {url}')
    print(f'{"=" * 60}')

    print('\n📡 正在列舉項目...')
    adapter, entries, series_name = _fetch_listing_entries(url)
    if not entries:
        raise ValueError('此頁面沒有找到任何影片，請確認網址是否為列表頁')
    print(f'   共 {len(entries)} 個項目')

    # Group the whole listing under a series so episode order survives. Failing
    # to create it is not worth losing the episodes over — they just land
    # unclassified, and the user can group them by hand.
    series_id = None
    if series_name:
        try:
            series_id = create_series(series_name)['id']
            print(f'   系列: {series_name}')
        except Exception as e:
            print(f'⚠️  建立系列失敗（{series_name}）: {e}')

    records = []
    # Listings run newest-first; insert oldest-first so ascending ids and
    # episode numbers both match the real episode order.
    for episode_no, entry in enumerate(reversed(entries), start=1):
        full_title = (entry.get('title') or '').strip()
        if not full_title:
            print(f'⚠️  略過沒有標題的項目: {entry["url"]}')
            continue

        # A derived code is what keeps a season's episodes apart: the studio-code
        # heuristic never matches these titles, and its 20-character fallback is
        # identical across every episode of a long-named series.
        code = derive_code(entry['url'], adapter, full_title) \
            or extract_code(full_title) or full_title[:20]
        tags = translate_tags_to_zh_tw(extract_tags(entry.get('tags') or [], None))
        title_zh_tw = full_title if is_zh_tw(full_title) else translate_to_zh_tw(full_title)

        record = {
            'code': code,
            'url': entry['url'],
            'title': full_title,
            'title_zh_tw': title_zh_tw,
            'actress': None,
            'tags': tags,
            'cover': None,
            'video_path': find_local_file(code, full_title),
            'series_id': series_id,
            'episode': episode_no if series_id else None,
        }
        try:
            record['id'] = insert_video(record)
        except Exception as e:
            print(f'❌ 寫入失敗 ({code}): {e}')
            continue
        print(f'   ✅ {code}  {full_title}')
        records.append(record)

    if not records:
        raise ValueError('列表頁的項目都無法解析')
    print(f'\n💾 已寫入 {len(records)} 筆記錄')
    return records


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
# Series travels as its *name*, not its id: ids are local to one database, and a
# round-trip through another one would otherwise silently drop the grouping.
EXPORT_FIELDS = ('code', 'url', 'title', 'title_zh_tw', 'actress', 'tags', 'cover',
                 'series', 'episode')


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

        # Re-create the series by name in this database; its id there is
        # meaningless here. create_series is idempotent, so a whole exported
        # season lands in one series.
        series_name = (rec.get('series') or '').strip()
        series_id = create_series(series_name)['id'] if series_name else None
        try:
            episode = int(rec['episode']) if rec.get('episode') not in (None, '') else None
        except (TypeError, ValueError):
            episode = None

        insert_video({
            'code': code,
            'url': url,
            'title': title,
            'title_zh_tw': (rec.get('title_zh_tw') or '').strip() or title,
            'actress': (rec.get('actress') or '').strip() or None,
            'tags': tags,
            'cover': (rec.get('cover') or '').strip() or None,
            'video_path': None,  # preserved on existing rows via COALESCE upsert
            'series_id': series_id,
            'episode': episode if series_id else None,
        })
        imported += 1

    return {'imported': imported, 'skipped': skipped}
