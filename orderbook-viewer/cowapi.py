"""Public CoW reads with process-shared pacing and server-directed cooldown."""
import contextlib
from email.utils import parsedate_to_datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = 'cowpro-orderbook-viewer/1.0'
MAX_BODY_BYTES = 16 * 1024 * 1024


class DeadlineExceeded(RuntimeError):
    def __init__(self):
        super().__init__('cow_api_deadline_exceeded')


class Throttled(RuntimeError):
    def __init__(self, retry_after):
        self.retry_after = max(1, math.ceil(retry_after))
        super().__init__('cow_api_cooling_down')


def root():
    configured = os.environ.get('COW_API_CACHE')
    if configured:
        return Path(configured).expanduser()
    return Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'cowpro-cow-api'


def _atomic(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


@contextlib.contextmanager
def _state(deadline=None):
    directory = root()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'limiter.lock').open('a') as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if deadline is not None and time.monotonic() + .05 >= deadline:
                    raise DeadlineExceeded() from None
                time.sleep(.05)
        path = directory / 'limiter.json'
        try:
            state = json.loads(path.read_text()) if path.exists() else {}
            yield state
            _atomic(path, state)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def acquire(*, deadline):
    """Reserve one request; separate processes share at most one per second."""
    while True:
        if time.monotonic() >= deadline:
            raise DeadlineExceeded()
        with _state(deadline) as state:
            now = time.time()
            cooldown_remaining = float(state.get('cooldown_until', 0)) - now
            if cooldown_remaining > 0:
                raise Throttled(cooldown_remaining)
            wait = max(0, float(state.get('next_request', 0)) - now)
            if wait == 0:
                state['next_request'] = now + 1
                return
        if time.monotonic() + wait >= deadline:
            raise DeadlineExceeded()
        time.sleep(min(wait, 1))


def cooldown(headers):
    """Honor both Retry-After formats; a server's longer wait is not shortened."""
    now = time.time()
    retry = 0
    value = headers.get('Retry-After') if headers is not None else None
    if value:
        try:
            retry = max(0, float(value))
            if not math.isfinite(retry):
                retry = 0
        except (ValueError, TypeError):
            try:
                retry = max(0, parsedate_to_datetime(value).timestamp() - now)
            except (ValueError, TypeError, OverflowError):
                retry = 0
    with _state(time.monotonic() + 2) as state:
        delay = min(300, max(60, float(state.get('backoff_seconds', 30)) * 2))
        state['backoff_seconds'] = delay
        state['cooldown_until'] = max(float(state.get('cooldown_until', 0)), now + delay, now + retry)


def get_json(url, *, refresh=False, deadline=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'api.cow.fi':
        raise ValueError('unsupported_cow_api_url')
    deadline = time.monotonic() + 30 if deadline is None else deadline
    cache = root() / ('body-' + hashlib.sha256(url.encode()).hexdigest() + '.json')
    if not refresh and cache.exists():
        try:
            stored = json.loads(cache.read_text())
            if time.time() - stored['at'] < 15:
                return stored['body']
        except (OSError, ValueError, KeyError, TypeError):
            pass
    acquire(deadline=deadline)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise DeadlineExceeded()
    request = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=min(30, remaining)) as response:
            body = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            if status in (403, 429, 503):
                cooldown(error.headers)
        finally:
            error.close()
        raise RuntimeError(f'cow_api_HTTP_{status}') from None
    except (OSError, TimeoutError):
        raise RuntimeError('cow_api_transport_failed') from None
    if len(body) > MAX_BODY_BYTES:
        raise RuntimeError('cow_api_response_too_large')
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError):
        raise RuntimeError('cow_api_invalid_json') from None
    _atomic(cache, {'at': time.time(), 'body': result})
    return result
