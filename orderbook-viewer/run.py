"""Run the public viewer and its isolated snapshot collector."""
import argparse
from importlib.util import find_spec
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from urllib.parse import urlsplit

APP = Path(__file__).resolve().parent
ALIASES = ('dfusion-limit-depth-live', 'dfusion-limit-depth', 'dfusion-eth-limit-depth')


def prepare_site(root):
    root = Path(root).resolve()
    public = root / 'public'
    site = root / 'site'
    if public.is_symlink() or site.is_symlink():
        raise ValueError('public cache and site must be dedicated directories')
    public.mkdir(parents=True, exist_ok=True)
    site.mkdir(parents=True, exist_ok=True)
    for name in ALIASES:
        link = site / name
        if link.is_symlink():
            if link.resolve() != public:
                raise ValueError('viewer alias points outside its public cache')
        elif link.exists():
            raise ValueError('viewer alias conflicts with an existing path')
        else:
            link.symlink_to(public, target_is_directory=True)
    (site / 'index.html').write_text(
        '<!doctype html><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=dfusion-limit-depth-live/">'
        '<a href="dfusion-limit-depth-live/">Open dfusion order book</a>\n'
    )
    return site


def stop_children(children):
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--cache', type=Path, default=APP / '.cache')
    args = parser.parse_args()
    rpc = os.environ.get('RPC_ETH', '')
    if not rpc or urlsplit(rpc).scheme not in ('http', 'https'):
        parser.error('set RPC_ETH to an Ethereum mainnet HTTP RPC endpoint')
    if find_spec('Crypto') is None:
        parser.error('install requirements.txt in the active Python environment')
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    os.umask(0o002)
    root = args.cache.resolve()
    try:
        site = prepare_site(root)
        from service import prepare_cache
        prepare_cache(root)
    except (OSError, ValueError):
        parser.error('cannot prepare the public cache; use a separate --cache directory')
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    commands = [
        [sys.executable, '-u', str(APP / 'service.py'), '--root', str(root)],
        [sys.executable, '-u', str(APP / 'http_server.py'), '--bind', args.bind,
         '--port', str(args.port), '--directory', str(site), '--cache-root', str(root)],
    ]
    children = []
    result = 0
    try:
        for command in commands:
            children.append(subprocess.Popen(command, cwd=APP))
        host = '127.0.0.1' if args.bind == '0.0.0.0' else args.bind
        print(f'dfusion order book: http://{host}:{args.port}/dfusion-limit-depth-live/?token=stusds', flush=True)
        print('Collecting a complete snapshot; cached data appears as soon as it is ready.', flush=True)
        while not stop.wait(0.25):
            if any(child.poll() is not None for child in children):
                print('A viewer process stopped; shutting down.', file=sys.stderr)
                result = 1
                break
    finally:
        stop_children(children)
    return result


if __name__ == '__main__':
    sys.exit(main())
