"""Background refresh workers (one per network); HTTP readers see only sanitized cache."""
import argparse,hashlib,json,os,signal,threading,uuid
from pathlib import Path
from build import build_snapshot
from cache import SnapshotCache
import networks

ASSETS=('depth.css','depth.js','plotly.min.js','book-model.js','take-model.js','take-ui.js')

def write_manifest(public,order):
    manifest=[]
    for net in order:
        cfg=networks.get(net);cow,token=networks.EXPLORERS.get(net,('',''))
        manifest.append({'key':net,'label':cfg['label'],'slug':cfg['slug'],'chain_id':cfg['chain_id'],'cow_explorer':cow,'token_explorer':token})
    _atomic(public/'networks.json',(json.dumps(manifest)+'\n').encode())


def _atomic(path,raw):
    tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with tmp.open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    os.replace(tmp,path)


def install_assets(public):
    """Publish the content-hashed frontend assets + rewritten index.html into the shared
    public dir (once; per-network books/status land in public/<network>/)."""
    public.mkdir(parents=True,exist_ok=True)
    assets=Path(__file__).parent/'assets'
    html=(assets/'index.html').read_text()
    for name in ASSETS:
        raw=(assets/name).read_bytes();p=Path(name)
        target=p.stem+'.'+hashlib.sha256(raw).hexdigest()[:12]+p.suffix
        destination=public/target
        if not destination.exists():_atomic(destination,raw)
        html=html.replace(name,target)
    _atomic(public/'index.html',html.encode())


class Collectors:
    """Owns one SnapshotCache per network under a shared public dir. Assets install at
    construction (cold-start safe); no collection runs until start()."""
    def __init__(self,root,refresh_seconds=300,enabled=None):
        self.root=Path(root);self.public=self.root/'public'
        install_assets(self.public)
        self._thread=None
        order=enabled or networks.ORDER
        write_manifest(self.public,order)
        self.caches={net:SnapshotCache((lambda work,n=net:build_snapshot(work,network=n)),
                                       root=self.root/net,public=self.public,subdir=net,
                                       refresh_seconds=refresh_seconds) for net in order}

    def start(self):
        # Stagger first collections so seven networks don't hit RPCs + the shared CoW API
        # limiter all at once (which caused transient first-load failures).
        for index,cache in enumerate(self.caches.values()):cache.start(initial_delay=index*8)

    def stop(self):
        for cache in self.caches.values():cache.stop()


def prepare_cache(root):
    return Collectors(root)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);args=parser.parse_args();os.umask(0o002)
    collectors=prepare_cache(args.root)
    stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *unused:stop.set())
    collectors.start();stop.wait();collectors.stop()


if __name__=='__main__':main()
