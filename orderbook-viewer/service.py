"""Background refresh worker; HTTP readers use only sanitized cached assets."""
import argparse,hashlib,json,os,signal,threading
from pathlib import Path
from build import build_snapshot
from cache import SnapshotCache


def install_assets(cache,assets):
    html=(assets/'index.html').read_text()
    for name in ('dfusion-depth.css','dfusion-eth-depth.js','dfusion-plotly.min.js','book-model.js','take-model.js','take-ui.js'):
        raw=(assets/name).read_bytes();p=Path(name)
        target=p.stem+'.'+hashlib.sha256(raw).hexdigest()[:12]+p.suffix
        destination=cache.public/target
        if not destination.exists():cache._atomic(destination,raw)
        html=html.replace(name,target)
    cache._atomic(cache.public/'index.html',html.encode())


def prepare_cache(root):
    cache=SnapshotCache(build_snapshot,root=root,refresh_seconds=300)
    install_assets(cache,Path(__file__).parent/'assets')
    return cache


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);parser.add_argument('--seed',type=Path)
    args=parser.parse_args();os.umask(0o002)
    cache=prepare_cache(args.root)
    if cache.snapshot() is None and args.seed:
        cache.builder=lambda work:json.loads(args.seed.read_bytes())
        assert cache.refresh();cache.builder=build_snapshot
    stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *unused:stop.set())
    cache.start();stop.wait();cache.stop()


if __name__=='__main__':main()
