#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Access code for remote use of the local backend.

Why this exists: the CORS allowlist and the X-Oasis-Client header are *browser*
guards. They stop a random website the user visits from calling their localhost,
but they are worth nothing against a plain HTTP client — `curl -H 'X-Oasis-Client: 1'`
sails straight through both. That is fine while the backend only listens on
127.0.0.1, and it is a full compromise the moment the user tunnels it (ngrok,
cloudflared, …) so they can watch from their phone: anyone with the URL could
read the catalog, delete files, launch a player on the user's desktop, or trigger
a self-update.

The model, in one line: **this machine is always trusted; remote access is a
switch, and the switch mints a code.**

  * **Remote access off (the default).** Requests from this machine need no
    credential at all — double-click and go — and every non-local request is
    refused outright. There is nothing to configure and nothing to leak, so
    tunnelling an un-configured backend exposes nothing.
  * **Remote access on.** The backend *generates* a random code and prints it to
    its own console window. Remote devices must present it; this machine still
    needs nothing. Turning the switch off deletes the code, which is also how
    every paired device is cut off at once.

The code being machine-generated (not a user's password) is what lets the rest
be so small. It is unique to this backend and reused nowhere, so it is stored in
plain text — which is the whole point: the owner can ask for it to be printed
again when they forget it. And because it is already a high-entropy random
string, it *is* the bearer credential: there are no sessions to mint, track or
revoke, and `<video src>` (which can carry a credential only as a query param)
simply carries the code. Rotating it is "switch off, switch on".

`is_local_request()` decides who is trusted, so its two halves are both
load-bearing: a loopback peer **and** no `X-Forwarded-*`/proxy header. A tunnel
agent runs on the user's own machine and therefore also connects from 127.0.0.1;
what gives it away is the header it injects, which a client on the far side
cannot strip. A raw TCP forward (`ssh -R`) adds no headers and is the known,
accepted gap: someone who exposes their backend that way hands out local trust
along with it, and should use a tunnel that sets the headers instead.
"""

import hmac
import ipaddress
import json
import os
import secrets
import time

# Live next to the database, i.e. next to the .exe in a frozen build (run_backend
# sets DB_PATH there) and in backend/ for a source checkout.
_DB_PATH = os.environ.get('DB_PATH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'oasis.db')
AUTH_PATH = os.path.join(os.path.dirname(os.path.abspath(_DB_PATH)), 'oasis.auth.json')

# Any of these means the request passed through a proxy or tunnel, so it did not
# originate on this machine — no matter what the peer socket says.
_PROXY_HEADERS = (
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'x-original-forwarded-for',
    'forwarded',
    'via',
    'cf-connecting-ip',
)

# The code is read off a console window and typed into a phone, so the alphabet
# drops the characters people mistake for each other (I/1, O/0) and the code is
# grouped for legibility. 8 chars over 32 symbols = 40 bits — unguessable at the
# handful of tries per minute the throttle below allows.
_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
_CODE_LEN = 8
_GROUP = 4

# Brute-force throttle. Counted only against a *wrong* code: a request with no
# code at all is just an un-paired device (or a poll from a phone whose code was
# revoked), and counting those would let such a device lock the owner out by
# doing nothing but retrying in the background.
_FAIL_LIMIT = 5          # wrong codes tolerated before the lockout starts
_LOCK_BASE_S = 5         # first lockout, doubling with each further failure
_LOCK_MAX_S = 300

# key -> (consecutive failures, locked-until timestamp). The API is a single
# process with a single event loop, so a plain dict needs no locking.
_failures: dict[str, tuple[int, float]] = {}


# --------------------------------------------------------------------------- #
# The code itself
# --------------------------------------------------------------------------- #

def _load() -> dict:
    try:
        with open(AUTH_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as e:
        print(f'⚠️ 無法讀取遠端存取設定，將視為未開啟: {e}')
    return {}


def _save(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(AUTH_PATH), exist_ok=True)
        with open(AUTH_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        # Best effort: keep it out of other local accounts' reach. No-op on
        # Windows, which ignores POSIX modes.
        os.chmod(AUTH_PATH, 0o600)
    except OSError as e:
        print(f'⚠️ 無法寫入遠端存取設定: {e}')


def normalize(code: str | None) -> str:
    """Canonical form of a code as typed: grouping and case are cosmetic."""
    if not code:
        return ''
    return ''.join(c for c in code.upper() if c.isalnum())


def get_code() -> str | None:
    """The current access code, or None when remote access is off."""
    code = _load().get('code')
    return code if isinstance(code, str) and code else None


def has_code() -> bool:
    return get_code() is not None


def enable() -> str:
    """Turn remote access on with a freshly minted code (replacing any existing
    one, which is what cuts every already-paired device off)."""
    raw = ''.join(secrets.choice(_ALPHABET) for _ in range(_CODE_LEN))
    code = '-'.join(raw[i:i + _GROUP] for i in range(0, _CODE_LEN, _GROUP))
    _save({'code': code, 'updated_at': int(time.time())})
    _failures.clear()
    return code


def disable() -> None:
    """Turn remote access off: the code is deleted and every remote caller is
    refused outright again. This machine is unaffected — it never needed one."""
    _save({})
    _failures.clear()


def verify(candidate: str | None) -> bool:
    """Constant-time check of a presented code against the stored one."""
    code = get_code()
    if not code:
        return False
    return hmac.compare_digest(normalize(candidate), normalize(code))


def print_code() -> None:
    """Print the code to the backend's own console — the only place it is ever
    shown. The web UI never displays it, so a settings page left open (or a
    screenshot of it) gives the code away to nobody."""
    code = get_code()
    if not code:
        print('🔓 遠端存取未開啟：僅限本機使用，所有遠端連線一律拒絕。')
        return
    # No box: CJK glyphs are double-width and would never line up with the frame.
    rule = '═' * 40
    print(f'\n{rule}')
    print('🔐 遠端存取已開啟')
    print(f'   存取碼： {code}')
    print('   其他裝置連線時需輸入此存取碼（本機不需要）。')
    print('   忘記了可到「設定 → 遠端存取」再顯示一次。')
    print(f'{rule}\n')


# --------------------------------------------------------------------------- #
# Request classification and throttling
# --------------------------------------------------------------------------- #

def is_local_request(request) -> bool:
    """True only for a request that physically originated on this machine.

    Loopback peer AND no forwarding header — see the module docstring for why
    both are required, and for the one gap this knowingly leaves open.
    """
    if any(h in request.headers for h in _PROXY_HEADERS):
        return False
    client = request.client
    if client is None or not client.host:
        return False
    try:
        return ipaddress.ip_address(client.host).is_loopback
    except ValueError:
        return False


def client_key(request) -> str:
    """Throttle key: the real caller, as best we can tell.

    Behind a tunnel every request arrives from 127.0.0.1, so the peer address
    alone would lump all remote attackers into one bucket (and the owner with
    them). The tunnel appends the true client to X-Forwarded-For, so the
    *rightmost* entry — the one our nearest proxy wrote, not one the client made
    up — identifies them.
    """
    xff = request.headers.get('x-forwarded-for')
    if xff:
        parts = [p.strip() for p in xff.split(',') if p.strip()]
        if parts:
            return parts[-1]
    client = request.client
    return client.host if client and client.host else 'unknown'


def lockout_remaining(key: str) -> int:
    """Seconds this key must wait before it may try again (0 = may proceed)."""
    entry = _failures.get(key)
    if not entry:
        return 0
    _, until = entry
    remaining = until - time.time()
    return int(remaining) + 1 if remaining > 0 else 0


def register_failure(key: str) -> None:
    """Count a wrong access code and extend the lockout once past the limit."""
    count = _failures.get(key, (0, 0.0))[0] + 1
    if count > _FAIL_LIMIT:
        backoff = min(_LOCK_BASE_S * (2 ** (count - _FAIL_LIMIT - 1)), _LOCK_MAX_S)
        until = time.time() + backoff
        print(f'🔒 存取碼驗證失敗 {count} 次（{key}），暫時鎖定 {backoff} 秒')
    else:
        until = 0.0
    _failures[key] = (count, until)


def clear_failures(key: str) -> None:
    _failures.pop(key, None)


def extract_code(request) -> str | None:
    """Pull the access code from the Authorization header.

    <video src> can send neither a header nor a cookie, so /api/stream is also
    allowed to carry it as a `token` query parameter — see the caller.
    """
    header = request.headers.get('authorization', '')
    if header.lower().startswith('bearer '):
        return header[7:].strip() or None
    return None
