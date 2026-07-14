#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Access-code authentication for the local backend.

Why this exists: the CORS allowlist and the X-Oasis-Client header are *browser*
guards. They stop a random website the user visits from calling their localhost,
but they are worth nothing against a plain HTTP client — `curl -H 'X-Oasis-Client: 1'`
sails straight through both. That is fine while the backend only listens on
127.0.0.1, and it is a full compromise the moment the user tunnels it (ngrok,
cloudflared, …) so they can watch from their phone: anyone with the URL could
read the catalog, delete files, launch a player on the user's desktop, or trigger
a self-update.

The model:

  * **No access code set → local-only.** Everything from this machine works with
    no credential at all (the double-click-and-go experience is untouched), and
    every non-local request is refused outright. An un-configured backend simply
    cannot be used from anywhere else, so a user who tunnels one *before* setting
    a code exposes nothing.
  * **Access code set → everyone authenticates, local included.** The code is
    chosen by the user, so it is never stored: only its scrypt hash is. Devices
    exchange the code for a random **session token** once (/api/auth/login) and
    send that thereafter, which keeps the password out of URLs (the <video> tag
    can only carry a credential as a query param) and makes revocation possible.

`is_local_request()` is therefore only ever used to decide who may *set* the
code, never to hand out a secret. That is the whole reason it is safe: an
attacker who manages to look local (a raw `ssh -R` forward adds no proxy headers
and is indistinguishable from a loopback client) still learns nothing and gets
nowhere, because there is no secret to be handed and the code is what he lacks.
The one thing he could do is claim an *unclaimed* backend — which is exactly why
setting the first code is local-only too: a remote device is never shown the
setup form, so it cannot squat a code and lock the owner out of their own machine.
"""

import base64
import hashlib
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
# originate on this machine — no matter what the peer socket says. A tunnel agent
# runs on the user's own machine and therefore also connects from 127.0.0.1; what
# gives it away is the header it injects, which a client on the far side cannot
# strip.
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

# scrypt work factors. ~100 ms per verification on a typical machine — slow enough
# that a stolen oasis.auth.json is not worth grinding through, fast enough that a
# login doesn't feel stuck. Only ever paid on /api/auth/login, never per request:
# every other call presents a session token, which is a cheap digest compare.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32

MIN_CODE_LENGTH = 6

# Brute-force throttle, counted against *wrong access codes only*. An invalid
# session token is not throttled: it cannot be guessed (256 bits of randomness),
# and counting it would let a device whose session was just revoked lock itself —
# and the owner — out by doing nothing but polling /api/health in the background.
_FAIL_LIMIT = 5          # wrong codes tolerated before the lockout starts
_LOCK_BASE_S = 5         # first lockout, doubling with each further failure
_LOCK_MAX_S = 300

# key -> (consecutive failures, locked-until timestamp). The API is a single
# process with a single event loop, so a plain dict needs no locking.
_failures: dict[str, tuple[int, float]] = {}


# --------------------------------------------------------------------------- #
# Persistent state: the code's hash and the tokens of paired devices.
#
# Sessions are stored as *digests* of the tokens, not the tokens themselves, so
# this file cannot be replayed: whoever reads it still has no usable credential.
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
        print(f'⚠️ 無法讀取存取碼設定，將視為尚未設定: {e}')
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
        print(f'⚠️ 無法寫入存取碼設定: {e}')


def _derive(code: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        code.encode('utf-8'),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )


def has_code() -> bool:
    """True once the user has set an access code (i.e. remote access is enabled)."""
    data = _load()
    return bool(data.get('hash') and data.get('salt'))


def verify_code(code: str) -> bool:
    """Constant-time check of a candidate access code against the stored hash."""
    data = _load()
    stored, salt = data.get('hash'), data.get('salt')
    if not stored or not salt:
        return False
    try:
        expected = base64.b64decode(stored)
        derived = _derive(code, base64.b64decode(salt))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(derived, expected)


def set_code(code: str) -> None:
    """Set or replace the access code.

    Every existing session is dropped: changing the code is how a user cuts off a
    device (or a leaked pairing QR), so it has to actually cut them off. The
    caller gets a fresh session back so the browser that just changed it stays in.
    """
    if len(code) < MIN_CODE_LENGTH:
        raise ValueError(f'存取碼至少需要 {MIN_CODE_LENGTH} 個字元')
    salt = secrets.token_bytes(16)
    _save({
        'salt': base64.b64encode(salt).decode('ascii'),
        'hash': base64.b64encode(_derive(code, salt)).decode('ascii'),
        'sessions': [],
        'updated_at': int(time.time()),
    })
    _failures.clear()


def clear_code() -> None:
    """Remove the access code, returning the backend to local-only mode."""
    _save({})
    _failures.clear()


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def create_session() -> str:
    """Mint a session token for a device that has proved it knows the code.

    Also what a pairing QR carries: it is the code's *stand-in*, so a scanned
    phone is logged in without the password ever leaving the owner's screen, and
    can be cut off later without changing the password... (by changing it, which
    drops all sessions — a per-device revoke isn't worth the bookkeeping yet).
    """
    token = secrets.token_urlsafe(32)
    data = _load()
    sessions = data.get('sessions') or []
    sessions.append(_digest(token))
    data['sessions'] = sessions
    _save(data)
    return token


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    wanted = _digest(token)
    # compare_digest against each stored digest rather than a set lookup: the
    # token is high-entropy so timing is not a real threat here, but it costs
    # nothing to not leak a prefix match.
    return any(hmac.compare_digest(wanted, s) for s in (_load().get('sessions') or []))


# --------------------------------------------------------------------------- #
# Request classification and throttling
# --------------------------------------------------------------------------- #

def is_local_request(request) -> bool:
    """True only for a request that physically originated on this machine.

    Loopback peer AND no forwarding header — see the module docstring for why
    both are required, and for what this is (and is not) allowed to gate.
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


def extract_token(request) -> str | None:
    """Pull the session token from the Authorization header.

    <video src> can send neither a header nor a cookie, so /api/stream is also
    allowed to carry it as a `token` query parameter — see the caller.
    """
    header = request.headers.get('authorization', '')
    if header.lower().startswith('bearer '):
        return header[7:].strip()
    return None
