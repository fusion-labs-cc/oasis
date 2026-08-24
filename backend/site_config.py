# Site-adapter engine.
#
# Each supported site is described by a JSON "adapter" in the adapters directory
# (backend/sites/ by default, or $OASIS_SITES_DIR). The engine loads those
# adapters and drives Selenium/scraping from their configuration. See
# sites.example.json for the adapter schema.
import json
import os
import re
import time
from urllib.parse import unquote, urlparse, urljoin

# Where adapters live. The shipped ones are tracked in git and travel with a
# release; in a frozen build OASIS_SITES_DIR points at a writable copy next to
# the executable, so a user's own adapters survive an update.
ADAPTERS_DIR = os.environ.get('OASIS_SITES_DIR') or os.path.join(
    os.path.abspath(os.path.dirname(__file__)), 'sites'
)

_DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)


def load_adapters() -> list[dict]:
    """Load every *.json adapter from the adapters directory (best-effort)."""
    adapters: list[dict] = []
    try:
        names = sorted(os.listdir(ADAPTERS_DIR))
    except OSError:
        return adapters
    for name in names:
        if not name.endswith('.json') or name.endswith('.example.json'):
            continue
        path = os.path.join(ADAPTERS_DIR, name)
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            print(f'⚠️  略過無法解析的 adapter {name}: {e}')
            continue
        if isinstance(data, dict) and data.get('id') and data.get('name'):
            adapters.append(data)
    return adapters


# Public registry consumed by /api/supported-sites. Derived entirely from the
# adapters the user has installed; empty when none are configured.
def supported_sites() -> list[dict]:
    out = []
    for a in load_adapters():
        domain = a.get('display_domain')
        if not domain and a.get('domains'):
            domain = a['domains'][0]
        elif not domain and a.get('domain_prefixes'):
            domain = a['domain_prefixes'][0]
        cat = a.get('category')
        if not cat:
            cat = 'general' if a.get('id') in ('youtube', 'anime1') else 'av'
        out.append({'id': a['id'], 'name': a['name'], 'domain': domain or '', 'category': cat})
    return out


def detect_site(url: str) -> dict:
    """Return the adapter whose domain rules match the URL, else raise.

    Matching is on the host's registrable-domain label, never a bare substring,
    so a look-alike host (e.g. example.com.evil.com) is rejected before a browser
    ever navigates to it. Two rule kinds are supported per adapter:
      - "domains":         exact host or subdomain suffix (e.g. "example.tv").
      - "domain_prefixes": the label left of the TLD starts with this token,
                           for sites that rotate their TLD (e.g. "examplecdn").
    """
    hostname = (urlparse(url).hostname or '').lower()
    labels = hostname.split('.')
    sld = labels[-2] if len(labels) >= 2 else ''

    adapters = load_adapters()
    for a in adapters:
        for dom in a.get('domains', []):
            dom = dom.lower().lstrip('.')
            if hostname == dom or hostname.endswith('.' + dom):
                return a
        for prefix in a.get('domain_prefixes', []):
            if sld.startswith(prefix.lower()):
                return a

    supported = ', '.join(
        s['domain'] for s in supported_sites() if s['domain']
    ) or '（尚未設定任何站台 adapter，請見 backend/sites.example.json）'
    raise ValueError(f'不支援的網站: {hostname}\n目前支援: {supported}')


def _clean_filename(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', '', name or '').strip()


def get_video_name(driver, adapter: dict) -> str:
    """Extract the video title via the adapter's ordered CSS selectors."""
    for selector in adapter.get('title_selectors', []):
        try:
            text = driver.find_element('css selector', selector).text
            if text and text.strip():
                return _clean_filename(text)
        except Exception:
            continue

    # Fallback: the page <title>, with any configured suffixes stripped.
    title = driver.title or ''
    for suffix in adapter.get('title_suffix_strip', []):
        if suffix in title:
            title = title.split(suffix)[0]
    return _clean_filename(title) or 'video'


def get_video_actress(driver, adapter: dict) -> str | None:
    """Scrape the cast name(s) via the adapter's actress selectors. Sites that
    label the cast on the page beat the title-tail heuristic in catalog.py,
    which cannot split an unspaced CJK title from the name."""
    names: list[str] = []
    for selector in adapter.get('actress_selectors', []):
        try:
            for el in driver.find_elements('css selector', selector):
                t = el.text.strip()
                if t and t not in names:
                    names.append(t)
        except Exception:
            continue
    return '、'.join(names) or None


def get_video_tags(driver, adapter: dict) -> list:
    """Scrape tag labels via the adapter's tag selectors."""
    tags: list[str] = []
    for selector in adapter.get('tag_selectors', []):
        try:
            for el in driver.find_elements('css selector', selector):
                t = el.text.strip()
                if t:
                    tags.append(t)
        except Exception:
            continue
    return tags


def get_cover_url(driver, adapter: dict | None = None) -> str | None:
    """Scrape the cover image URL. Defaults to the standard og:image meta tag;
    adapters whose pages lack it can point at any element/attribute instead
    (cover.selectors). The first http(s) URL inside the attribute value is
    taken, so a style="background-image: url(…)" works as-is."""
    entries = ((adapter or {}).get('cover') or {}).get('selectors') or [
        {'css': 'meta[property="og:image"]', 'attr': 'content'},
    ]
    for entry in entries:
        try:
            el = driver.find_element('css selector', entry['css'])
            value = el.get_attribute(entry.get('attr', 'src')) or ''
        except Exception:
            continue
        m = re.search(r'https?://[^\s"\')]+', value)
        if m:
            return m.group(0)
    return None


def derive_code(url: str, adapter: dict, title: str = '') -> str | None:
    """Build the catalog's unique code from the URL (or title) per the adapter.

    catalog.py's own heuristic looks for a studio code (AAA-123) and otherwise
    falls back to the title's first 20 characters. That fallback collides across
    episodes of one series — every episode of a long-named show shares its
    opening 20 characters, and videos.code is UNIQUE, so a season's episodes
    would upsert over each other. Sites whose URLs carry a stable per-item id
    say so here instead of losing episodes to that collision.
    """
    cfg = adapter.get('code') or {}
    pattern = cfg.get('pattern')
    if not pattern:
        return None
    source = title if cfg.get('from') == 'title' else url
    m = re.search(pattern, source or '')
    if not m:
        return None
    out = cfg.get('template') or '{1}'
    for i, group in enumerate(m.groups(), start=1):
        out = out.replace('{%d}' % i, group or '')
    return out.strip() or None


def is_listing_url(url: str, adapter: dict) -> bool:
    """Does this URL point at a listing of many videos rather than a single one?

    The adapter names the URL shapes that list (a season's episodes, a playlist)
    because the engine cannot tell from the DOM: a listing and a single video are
    served by the same host and usually the same page template.
    """
    cfg = adapter.get('listing') or {}
    return any(re.search(p, url) for p in cfg.get('url_patterns', []))


def listing_max_pages(adapter: dict) -> int:
    """How many listing pages to follow at most. A hard stop, not a preference:
    the same URL shape that lists one show's episodes usually also lists a whole
    season's worth of shows, and a mistyped URL must not enumerate thousands."""
    return max(1, int((adapter.get('listing') or {}).get('max_pages') or 1))


def get_listing_entries(driver, adapter: dict) -> list[dict]:
    """Enumerate the listing page the driver is on: one dict per item, in page
    order. Returns [{url, title, tags}]."""
    cfg = adapter.get('listing') or {}
    item_selector = cfg.get('item_selector')
    if not item_selector:
        return []
    link_cfg = cfg.get('link') or {}
    title_css = (cfg.get('title') or {}).get('css')

    entries: list[dict] = []
    for item in driver.find_elements('css selector', item_selector):
        try:
            href = item.find_element(
                'css selector', link_cfg.get('css', 'a')
            ).get_attribute(link_cfg.get('attr', 'href'))
        except Exception:
            continue
        if not href or not href.strip():
            continue

        title = ''
        if title_css:
            try:
                title = item.find_element('css selector', title_css).text.strip()
            except Exception:
                title = ''

        tags: list[str] = []
        for selector in cfg.get('tag_selectors', []):
            try:
                for el in item.find_elements('css selector', selector):
                    t = el.text.strip()
                    if t and t not in tags:
                        tags.append(t)
            except Exception:
                continue

        entries.append({
            'url': _absolutize(driver, href.strip()),
            'title': title,
            'tags': tags,
        })
    return entries


def get_listing_series_name(driver, adapter: dict) -> str | None:
    """The name the listing gives itself — used to group its items into a series."""
    cfg = (adapter.get('listing') or {}).get('series_name') or {}
    css = cfg.get('css')
    if not css:
        return None
    try:
        el = driver.find_element('css selector', css)
        text = (el.get_attribute(cfg['attr']) if cfg.get('attr') else el.text) or ''
    except Exception:
        return None
    return text.strip() or None


def get_next_page_url(driver, adapter: dict) -> str | None:
    """The listing's link to its next page, or None when this is the last one."""
    cfg = (adapter.get('listing') or {}).get('next_page') or {}
    css = cfg.get('css')
    if not css:
        return None
    try:
        value = driver.find_element('css selector', css).get_attribute(
            cfg.get('attr', 'href')
        )
    except Exception:
        return None
    return _absolutize(driver, value.strip()) if value and value.strip() else None


def _match_first(regexes, text):
    for pattern in regexes:
        m = re.search(pattern, text)
        if m:
            # Use the first capturing group when present, else the whole match.
            return m.group(1) if m.groups() else m.group(0)
    return None


def _intercept_m3u8_from_logs(driver):
    """Find an m3u8 URL in the browser's performance (network) logs."""
    try:
        for entry in driver.get_log('performance'):
            m = re.search(r'https?://[^\s"\\]+\.m3u8[^\s"\\]*', entry.get('message', ''))
            if m:
                return m.group(0)
    except Exception:
        pass
    return None


def _absolutize(driver, url):
    """A playlist URL scraped out of player state may be relative — resolve it
    against the document it came from, not the top page."""
    if url.startswith('http'):
        return url
    try:
        return urljoin(driver.execute_script('return location.href'), url)
    except Exception:
        return url


def _match_in_document(driver, regexes, scripts):
    """Match the current document: its DOM first, then the adapter's JS probes
    (frame_scripts) — players like JWPlayer hold the playlist URL only in JS
    state, never in markup."""
    found = _match_first(regexes, driver.page_source)
    if found:
        return _absolutize(driver, found)
    for script in scripts:
        try:
            text = driver.execute_script(script)
        except Exception:
            continue
        if text:
            found = _match_first(regexes, str(text))
            if found:
                return _absolutize(driver, found)
    return None


def _scan_frames_for_m3u8(driver, regexes, scripts, depth=0):
    """Search nested iframes — page_source only covers the top document,
    but embed players (JWPlayer et al.) keep the playlist URL in their own frame."""
    if depth >= 3:
        return None
    count = len(driver.find_elements('css selector', 'iframe'))
    for i in range(count):
        # Re-find each time: switching frames staled the previous references.
        frames = driver.find_elements('css selector', 'iframe')
        if i >= len(frames):
            break
        try:
            driver.switch_to.frame(frames[i])
        except Exception:
            continue
        try:
            found = _match_in_document(driver, regexes, scripts) \
                or _scan_frames_for_m3u8(driver, regexes, scripts, depth + 1)
        except Exception:
            found = None
        driver.switch_to.parent_frame()
        if found:
            return found
    return None


def _click_selector(driver, selector):
    """click_selectors entries are CSS, or XPath behind an "xpath:" prefix —
    needed to pick an element by its text (e.g. one server button of several),
    which CSS cannot express."""
    if selector.startswith('xpath:'):
        driver.find_element('xpath', selector[len('xpath:'):]).click()
    else:
        driver.find_element('css selector', selector).click()


def get_m3u8_url(driver, adapter: dict):
    """Extract the stream playlist URL using the adapter's configuration."""
    cfg = adapter.get('m3u8', {})
    regexes = cfg.get('regexes', [r'https?://[^\s"\']+\.m3u8[^\s"\']*'])
    scripts = cfg.get('frame_scripts', [])

    def attempt():
        found = _match_in_document(driver, regexes, scripts)
        if not found and cfg.get('scan_iframes'):
            try:
                found = _scan_frames_for_m3u8(driver, regexes, scripts)
            finally:
                # Callers assume the driver is left on the top document.
                driver.switch_to.default_content()
        if not found and cfg.get('use_performance_log'):
            found = _intercept_m3u8_from_logs(driver)
        return found

    found = attempt()
    if found:
        return found

    retry = cfg.get('retry')
    if retry:
        print('等待頁面載入影片播放器...')
        time.sleep(retry.get('wait_seconds', 5))
        # Multiple attempts: popunder ads routinely swallow the first click.
        for _ in range(retry.get('attempts', 1)):
            for selector in retry.get('click_selectors', []):
                try:
                    _click_selector(driver, selector)
                    time.sleep(retry.get('click_wait_seconds', 3))
                    break
                except Exception:
                    continue
            found = attempt()
            if found:
                return found

    raise ValueError(f'無法找到 m3u8 網址（{adapter.get("name", adapter.get("id"))}），請確認網址是否正確')


def get_request_headers(adapter: dict, video_page_url: str = ''):
    """Build the CDN request headers, templating {page_url} from the adapter."""
    headers = {'User-Agent': adapter.get('user_agent') or _DEFAULT_USER_AGENT}
    for key, value in (adapter.get('headers') or {}).items():
        headers[key] = value.replace('{page_url}', video_page_url)
    return headers


def media_mode(adapter: dict) -> str:
    """Which download pipeline the site needs: 'hls' (an m3u8 playlist fetched as
    TS segments, the default) or 'http' (one progressive file, downloaded whole)."""
    return ((adapter.get('media') or {}).get('mode') or 'hls').lower()


def _json_path(data, path: str):
    """Walk a dotted path through decoded JSON; a numeric step indexes a list."""
    cur = data
    for step in path.split('.'):
        if not step:
            continue
        try:
            cur = cur[int(step)] if step.isdigit() else cur[step]
        except (KeyError, IndexError, TypeError, ValueError):
            return None
    return cur


def get_media_source(driver, adapter: dict, page_url: str = ''):
    """Resolve a progressive media URL for the page the driver is on.

    Returns (url, headers, cookies). Players of this shape keep no media URL in
    the page at all: the markup carries only an opaque, time-limited token, and
    the real URL is minted by an API call that *also* sets the cookies the CDN
    then demands — which is why the cookies have to travel with the download and
    not just the URL, and why the token is read fresh at download time rather
    than remembered from the analysis pass.
    """
    cfg = adapter.get('media') or {}
    headers = get_request_headers(adapter, video_page_url=page_url)
    name = adapter.get('name', adapter.get('id'))

    attr_cfg = cfg.get('attr') or {}
    token = ''
    if attr_cfg.get('css'):
        try:
            token = driver.find_element('css selector', attr_cfg['css']).get_attribute(
                attr_cfg.get('attr', 'src')
            ) or ''
        except Exception:
            token = ''
        if not token:
            raise ValueError(f'無法取得影片參數（{name}），請確認網址是否正確')

    post = cfg.get('post') or {}
    cookies: dict = {}
    if post.get('url'):
        import requests as req

        post_headers = dict(headers)
        for key, value in (post.get('headers') or {}).items():
            post_headers[key] = value.replace('{page_url}', page_url)
        body = token
        if post.get('decode_value'):
            # The attribute already holds a percent-encoded value; form-encoding
            # it again escapes the escapes, and a signed token arrives corrupt.
            body = unquote(token)
        response = req.post(
            post['url'],
            data={post.get('field', 'd'): body},
            headers=post_headers,
            timeout=15,
        )
        response.raise_for_status()
        cookies = response.cookies.get_dict()
        source = _json_path(response.json(), cfg.get('json_path', ''))
    else:
        source = token

    if not isinstance(source, str) or not source:
        raise ValueError(f'無法解析影片來源（{name}），請確認網址是否正確')

    if source.startswith('//'):
        # Protocol-relative: the page's scheme is gone by the time we leave the
        # browser, so the adapter states which one the CDN wants.
        source = (cfg.get('url_prefix') or 'https:') + source
    elif not source.startswith('http'):
        source = _absolutize(driver, source)

    if not cfg.get('carry_cookies', True):
        cookies = {}
    return source, headers, cookies


def resolve_m3u8_to_stream(m3u8url, request_headers):
    """
    If m3u8url is a master playlist (contains variant streams),
    resolve it to the highest quality stream playlist URL.
    If it's already a stream playlist (contains segments), return as-is.
    """
    import requests as req
    import m3u8 as m3u8lib

    response = req.get(m3u8url, headers=request_headers, timeout=15)
    response.raise_for_status()
    m3u8obj = m3u8lib.loads(response.text)

    if m3u8obj.playlists:
        print(f'偵測到主播放清單，共 {len(m3u8obj.playlists)} 個畫質選項')
        best = max(m3u8obj.playlists, key=lambda p: p.stream_info.bandwidth or 0)
        bandwidth_mbps = (best.stream_info.bandwidth or 0) / 1_000_000
        resolution = best.stream_info.resolution
        res_str = f'{resolution[0]}x{resolution[1]}' if resolution else '未知'
        print(f'選擇最高畫質: {res_str}, {bandwidth_mbps:.1f} Mbps')

        stream_url = best.uri
        if not stream_url.startswith('http'):
            base = m3u8url.rsplit('/', 1)[0] + '/'
            stream_url = urljoin(base, stream_url)

        print(f'串流播放清單: {stream_url}')
        return stream_url
    else:
        return m3u8url


def build_ts_url(seg_uri, download_base_url):
    """Build a full segment URL, handling both relative and absolute URIs."""
    if seg_uri.startswith('http'):
        return seg_uri
    return download_base_url + '/' + seg_uri


def setup_driver_for_site(options, adapter: dict):
    """Apply the adapter's Selenium driver options."""
    driver_cfg = adapter.get('driver', {})
    if driver_cfg.get('performance_log'):
        options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
    if driver_cfg.get('stealth'):
        options.add_argument('--disable-blink-features=AutomationControlled')
        options.add_experimental_option('excludeSwitches', ['enable-automation', 'enable-logging'])
        options.add_experimental_option('useAutomationExtension', False)
    lang = driver_cfg.get('accept_language')
    if lang:
        # Sites that machine-translate their own metadata choose the language
        # from Accept-Language. Left at Chrome's default the scraper reads a
        # title already rendered into English, and catalog.py then translates
        # that translation — so the adapter states which language it wants the
        # page served in. The pref is what sets the header; --lang aligns the
        # renderer's locale with it for pages that read navigator.language.
        options.add_experimental_option('prefs', {'intl.accept_languages': lang})
        options.add_argument('--lang=' + lang.split(',')[0])
    return options


def wait_for_page_load(driver, adapter: dict):
    """Wait for the page per the adapter's wait configuration."""
    wait = adapter.get('wait', {})
    time.sleep(wait.get('seconds', 2))
    css = wait.get('css')
    if css:
        try:
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            WebDriverWait(driver, wait.get('timeout', 15)).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, css))
            )
        except Exception:
            print('等待頁面載入超時，繼續嘗試...')
