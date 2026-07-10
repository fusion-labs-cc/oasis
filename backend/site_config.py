# Generic site-adapter engine.
#
# This module contains NO site-specific logic. Each site the user wants to use
# is described by a JSON "adapter" file the user supplies in the adapters
# directory (backend/sites/ by default, or $OASIS_SITES_DIR). The engine loads
# those adapters and drives Selenium/scraping purely from their configuration,
# so the shipped code stays a neutral, general-purpose page reader. See
# sites.example.json for the adapter schema.
import json
import os
import re
import time
from urllib.parse import urlparse, urljoin

# Where user-supplied adapters live. Kept out of version control so the shipped
# tool carries no built-in site definitions.
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
        out.append({'id': a['id'], 'name': a['name'], 'domain': domain or ''})
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


def get_cover_url(driver) -> str | None:
    """Scrape the cover image from the standard og:image meta tag."""
    try:
        el = driver.find_element('css selector', 'meta[property="og:image"]')
        return el.get_attribute('content') or None
    except Exception:
        return None


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


def get_m3u8_url(driver, adapter: dict):
    """Extract the stream playlist URL using the adapter's configuration."""
    cfg = adapter.get('m3u8', {})
    regexes = cfg.get('regexes', [r'https?://[^\s"\']+\.m3u8[^\s"\']*'])

    found = _match_first(regexes, driver.page_source)
    if found:
        return found

    if cfg.get('use_performance_log'):
        found = _intercept_m3u8_from_logs(driver)
        if found:
            return found

    retry = cfg.get('retry')
    if retry:
        print('等待頁面載入影片播放器...')
        time.sleep(retry.get('wait_seconds', 5))
        for selector in retry.get('click_selectors', []):
            try:
                driver.find_element('css selector', selector).click()
                time.sleep(retry.get('click_wait_seconds', 3))
                break
            except Exception:
                continue
        found = _match_first(regexes, driver.page_source)
        if found:
            return found
        if cfg.get('use_performance_log'):
            found = _intercept_m3u8_from_logs(driver)
            if found:
                return found

    raise ValueError(f'無法找到 m3u8 網址（{adapter.get("name", adapter.get("id"))}），請確認網址是否正確')


def get_request_headers(adapter: dict, video_page_url: str = ''):
    """Build the CDN request headers, templating {page_url} from the adapter."""
    headers = {'User-Agent': adapter.get('user_agent') or _DEFAULT_USER_AGENT}
    for key, value in (adapter.get('headers') or {}).items():
        headers[key] = value.replace('{page_url}', video_page_url)
    return headers


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
