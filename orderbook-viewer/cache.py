"""Atomic last-good depth snapshots with one paced background refresh."""
import fcntl,hashlib,json,os,re,shutil,threading,time,uuid
from decimal import Decimal
from pathlib import Path


def validate_snapshot(book):
    assert isinstance(book,dict) and int(book['auction_id'])>0 and int(book['block'])>0
    assert re.fullmatch(r'0x[0-9a-fA-F]{64}',book['block_hash'])
    assert int(book['as_of_timestamp'])>0 and book['metadata'] and book['pairs']
    evidence=book['snapshot_evidence']
    for key in ('auction_id','block','block_hash'):assert evidence[key]==book[key]
    for key in ('source_sha256','funding_sha256','conversions_sha256'):assert re.fullmatch('[0-9a-f]{64}',evidence[key])
    ids=set()
    for pair in book['pairs']:
        assert pair['id'] not in ids;ids.add(pair['id'])
        assert pair['modes']['enriched']['block_hash']==book['block_hash']
        if pair['id']=='eth':assert pair.get('conversions')
        parents=set()
        for row in pair.get('twap_schedules',[]):
            assert row['id'] not in parents;parents.add(row['id'])
            assert row['block']==book['block'] and row['block_hash']==book['block_hash']
            count=int(row['remaining_parts']);assert count>0
            price=Decimal(row['normalized_price']);assert price.is_finite() and price>0
            for total,slice_ in [('remaining_base_atoms','slice_base_atoms'),('remaining_quote_atoms','slice_quote_atoms')]:
                assert int(row[slice_])>0 and int(row[total])==int(row[slice_])*count
            assert row['volume_kind']=='Scheduled at signed limit, not funded executable depth'
        for mode in [pair['modes']['enriched'],*pair.get('quote_modes',{}).values()]:
            assert mode['block_hash']==book['block_hash']
            seen=set();spend={}
            for row in mode['normalized_orders']:
                assert row['uid'] not in seen;seen.add(row['uid'])
                amount=int(row['allocated_sell_atoms']);assert amount>=0
                if row['funding_status']=='conditional':assert amount==0
                key=(row['owner'].lower(),row['base_token'].lower() if row['side']=='ask' else row['quote_token'].lower())
                spend[key]=spend.get(key,0)+amount
            for group in mode['funding_groups']:
                key=(group['owner'].lower(),group['sell_token'].lower())
                assert spend.pop(key,0)<=int(group['capacity_atoms'])
            assert not any(spend.values())
    return book


class RefreshRequests:
    def __init__(self,root,cooldown_seconds=60):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.cooldown_seconds=cooldown_seconds

    def request(self):
        with (self.root/'request.lock').open('a') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX)
            with (self.root/'refresh.lock').open('a') as active:
                try:fcntl.flock(active,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:return 202,{'status':'refreshing'}
                fcntl.flock(active,fcntl.LOCK_UN)
            pending=self.root/'refresh-request.json'
            if pending.exists():return 202,{'status':'queued'}
            state=self.root/'request-state.json'
            last=json.loads(state.read_bytes()).get('last_request',0) if state.exists() else 0
            now=time.time();remaining=self.cooldown_seconds-(now-last)
            if remaining>0:return 429,{'status':'cooldown','retry_after':max(1,int(remaining+0.999))}
            raw=(json.dumps({'last_request':now})+'\n').encode()
            for destination in (state,pending):
                temporary=destination.with_name(destination.name+'.'+uuid.uuid4().hex+'.tmp')
                with temporary.open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
                os.replace(temporary,destination)
            return 202,{'status':'queued'}

    def consume(self):
        with (self.root/'request.lock').open('a') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX)
            try:(self.root/'refresh-request.json').unlink();return True
            except FileNotFoundError:return False


class SnapshotCache:
    def __init__(self,builder,refresh_seconds=300,*,root):
        self.builder=builder;self.refresh_seconds=refresh_seconds;self.root=Path(root)
        self.public=self.root/'public';self.public.mkdir(parents=True,exist_ok=True)
        (self.root/'snapshots').mkdir(exist_ok=True)
        self.requests=RefreshRequests(self.root)
        self._lock=threading.Lock();self._stop=threading.Event();self._thread=None
        self._state={'refreshing':False,'last_error':None,'last_success':None,'snapshot_id':None,'refresh_seconds':refresh_seconds}
        state=self.root/'state.json'
        if state.exists():
            old=json.loads(state.read_bytes());self._state.update({k:old.get(k)for k in ('last_success','snapshot_id')})
        self._write_state()

    def _atomic(self,path,raw):
        temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
        with temporary.open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)

    def status(self):
        state=dict(self._state)
        state['stale']=state['last_success'] is None or bool(state['last_error']) or time.time()-state['last_success']>self.refresh_seconds*2
        return state

    def _write_state(self):
        raw=(json.dumps(self.status(),sort_keys=True)+'\n').encode()
        self._atomic(self.root/'state.json',raw);self._atomic(self.public/'status.json',raw)

    def snapshot(self):
        path=self.public/'dfusion-eth-book.json'
        return json.loads(path.read_bytes()) if path.exists() else None

    def refresh(self):
        if not self._lock.acquire(blocking=False):return False
        lock=(self.root/'refresh.lock').open('a');work=None;locked=False
        try:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return False
            locked=True
            self.requests.consume()
            self._state.update(refreshing=True,last_error=None);self._write_state()
            work=self.root/('work-'+uuid.uuid4().hex);work.mkdir()
            book=validate_snapshot(self.builder(work))
            raw=(json.dumps(book,separators=(',',':'))+'\n').encode();digest=hashlib.sha256(raw).hexdigest()
            target=self.root/'snapshots'/(str(int(time.time()))+'-'+digest[:16]+'.json')
            self._atomic(target,raw)
            link=self.public/('book-'+uuid.uuid4().hex+'.tmp');link.symlink_to(target.resolve());os.replace(link,self.public/'dfusion-eth-book.json')
            self._state.update(last_success=time.time(),snapshot_id=digest,last_error=None)
            for path in sorted((self.root/'snapshots').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[24:]:path.unlink()
            return True
        except Exception as error:
            self._state['last_error']=type(error).__name__
            return False
        finally:
            if work is not None:shutil.rmtree(work)
            if locked:self._state['refreshing']=False;self._write_state()
            lock.close();self._lock.release()

    def start(self):
        if self._thread and self._thread.is_alive():return
        self._stop.clear()
        def run():
            while not self._stop.is_set():
                started=time.monotonic();self.refresh()
                deadline=started+self.refresh_seconds
                while not self._stop.is_set() and time.monotonic()<deadline:
                    if (self.root/'refresh-request.json').exists():break
                    self._stop.wait(min(1,max(0,deadline-time.monotonic())))
        self._thread=threading.Thread(target=run,name='dfusion-depth-refresh',daemon=True);self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:self._thread.join(timeout=660)
