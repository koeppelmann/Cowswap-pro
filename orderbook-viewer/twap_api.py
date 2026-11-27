"""Public programmatic-order candidates; current chain state remains authoritative."""
import fcntl
from email.utils import parsedate_to_datetime
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request

SOURCE='https://programmatic-orders.cow.fi/graphql'
PAGE_SIZE=1000
MAX_PAGES=5
MAX_BODY=8*1024*1024
CACHE_SECONDS=300
QUERY='''query TwapCandidates($limit:Int!,$offset:Int!){programmaticOrders(where:{chainId:1,orderType:TWAP,status:Active},limit:$limit,offset:$offset,orderBy:"eventId",orderDirection:"desc"){items{eventId chainId hash txHash owner handler salt staticInput creationDate}totalCount}}'''
HEX_ADDRESS=re.compile(r'^0x[0-9a-fA-F]{40}$')
HEX_WORD=re.compile(r'^0x[0-9a-fA-F]{64}$')
HEX_BYTES=re.compile(r'^0x(?:[0-9a-fA-F]{2})*$')


class QueryFailure(Exception):
    def __init__(self,reason,retry_after=0):
        self.reason=reason;self.retry_after=retry_after
        super().__init__(reason)


def _read(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return None


def _atomic(path,value):
    descriptor,temporary=tempfile.mkstemp(prefix='.twap-api-',dir=path.parent)
    try:
        os.fchmod(descriptor,0o660)
        with os.fdopen(descriptor,'w') as stream:
            json.dump(value,stream,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        try:os.unlink(temporary)
        except FileNotFoundError:pass


def _retry_after(headers):
    value=headers.get('Retry-After') if headers else None
    try:
        seconds=float(value)
        if not math.isfinite(seconds):return 0
        return max(0,seconds)
    except (ValueError,TypeError):
        try:return max(0,parsedate_to_datetime(value).timestamp()-time.time())
        except (ValueError,TypeError,OverflowError):return 0


def _request_page(offset,deadline):
    remaining=deadline-time.monotonic()
    if remaining<=0:raise QueryFailure('query_deadline')
    payload=json.dumps({'query':QUERY,'variables':{'limit':PAGE_SIZE,'offset':offset}}).encode()
    request=urllib.request.Request(SOURCE,data=payload,headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'dfusion-orderbook-viewer/1.0'},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=min(10,remaining)) as response:raw=response.read(MAX_BODY+1)
    except urllib.error.HTTPError as error:
        status=error.code
        retry=_retry_after(error.headers) if status in (403,429,503) else 0
        error.close()
        raise QueryFailure('query_HTTP_'+str(status),retry) from None
    except (OSError,TimeoutError):raise QueryFailure('query_transport_failed') from None
    if len(raw)>MAX_BODY:raise QueryFailure('query_response_too_large')
    try:body=json.loads(raw)
    except (ValueError,UnicodeError):raise QueryFailure('query_invalid_json') from None
    if not isinstance(body,dict) or body.get('errors'):raise QueryFailure('query_graphql_error')
    data=body.get('data')
    page=data.get('programmaticOrders') if isinstance(data,dict) else None
    if not isinstance(page,dict) or not isinstance(page.get('items'),list) or type(page.get('totalCount')) is not int or page['totalCount']<0:raise QueryFailure('query_invalid_page')
    return page


def _record(item):
    if not isinstance(item,dict) or type(item.get('chainId')) is not int or item.get('chainId')!=1:return None
    for key in ('owner','handler'):
        if not isinstance(item.get(key),str) or not HEX_ADDRESS.fullmatch(item[key]) or int(item[key],16)==0:return None
    for key in ('hash','salt'):
        if not isinstance(item.get(key),str) or not HEX_WORD.fullmatch(item[key]):return None
    data=item.get('staticInput')
    if not isinstance(data,str) or len(data)>131074 or not HEX_BYTES.fullmatch(data):return None
    event=item.get('eventId')
    if not isinstance(event,str) or not 0<len(event)<=256 or any(ord(c)<32 for c in event):return None
    created=str(item.get('creationDate',''))
    if not created.isdigit() or len(created)>20:return None
    transaction=item.get('txHash')
    if transaction is not None and (not isinstance(transaction,str) or not HEX_WORD.fullmatch(transaction)):return None
    return {'chainId':1,'eventId':event,'owner':item['owner'].lower(),'hash':item['hash'].lower(),'handler':item['handler'].lower(),'salt':item['salt'].lower(),'staticInput':data.lower(),'txHash':transaction.lower() if transaction else None,'creationDate':created}


def _result(cache,status,reason=None):
    result={**cache,'status':status,'source':SOURCE,'fetched_count':len(cache.get('records',[]))}
    if status=='stale':result['complete_query']=False
    if reason:result['reason']=reason
    return result


def fetch_candidates(cache_root,*,deadline=None):
    """Fetch dated candidate metadata, never a declaration of live authorization."""
    deadline=min(deadline,time.monotonic()+30) if deadline is not None else time.monotonic()+30
    root=Path(cache_root)/'twap-api';root.mkdir(parents=True,exist_ok=True)
    cache=_read(root/'candidates.json')
    if not isinstance(cache,dict) or not isinstance(cache.get('records'),list) or not isinstance(cache.get('observed_at'),(int,float)):cache=None
    empty={'records':[],'total_count':None,'complete_query':False,'observed_at':None,'invalid_records':0}
    def fallback(reason,partial=None):
        if cache:return _result(cache,'stale',reason)
        return _result(partial or empty,'partial' if partial and partial['records'] else 'unavailable',reason)
    now=time.time()
    if cache and 0<=now-cache['observed_at']<(CACHE_SECONDS if cache.get('complete_query') else 60):return _result(cache,'available' if cache.get('complete_query') else 'partial')
    with (root/'fetch.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return fallback('query_refresh_in_progress')
        cache_now=_read(root/'candidates.json')
        if isinstance(cache_now,dict) and isinstance(cache_now.get('records'),list) and isinstance(cache_now.get('observed_at'),(int,float)):
            cache=cache_now
            if 0<=time.time()-cache['observed_at']<(CACHE_SECONDS if cache.get('complete_query') else 60):return _result(cache,'available' if cache.get('complete_query') else 'partial')
        state=_read(root/'pacing.json')
        if not isinstance(state,dict):state={}
        for key in ('cooldown_until','next_request','failures'):
            if not isinstance(state.get(key,0),(int,float)) or not math.isfinite(state.get(key,0)):state[key]=0
        if state.get('cooldown_until',0)>time.time():return fallback('query_cooldown')
        records=[];seen=set();total=None;invalid=0;complete=False
        try:
            for page_number in range(MAX_PAGES):
                wait=max(0,state.get('next_request',0)-time.time())
                if time.monotonic()+wait>=deadline:raise QueryFailure('query_deadline')
                if wait:time.sleep(wait)
                if time.monotonic()>=deadline:raise QueryFailure('query_deadline')
                state['next_request']=time.time()+1;_atomic(root/'pacing.json',state)
                page=_request_page(page_number*PAGE_SIZE,deadline)
                if total is None:total=page['totalCount']
                elif total!=page['totalCount']:raise QueryFailure('query_population_changed')
                items=page['items']
                if len(items)>PAGE_SIZE:raise QueryFailure('query_page_too_large')
                for item in items:
                    row=_record(item)
                    if row is None:invalid+=1;continue
                    if row['eventId'] in seen:raise QueryFailure('query_duplicate_event')
                    seen.add(row['eventId']);records.append(row)
                consumed=page_number*PAGE_SIZE+len(items)
                if consumed>total:raise QueryFailure('query_population_changed')
                if consumed==total:
                    complete=invalid==0
                    break
                if len(items)<PAGE_SIZE:raise QueryFailure('query_incomplete_page')
            value={'records':records,'total_count':total,'complete_query':complete,'observed_at':time.time(),'invalid_records':invalid}
            if not complete and cache:return fallback('query_invalid_records' if invalid else 'query_candidate_limit')
            _atomic(root/'candidates.json',value)
            state.update(cooldown_until=0,failures=0);_atomic(root/'pacing.json',state)
            return _result(value,'available' if complete else 'partial',None if complete else 'query_invalid_records' if invalid else 'query_candidate_limit')
        except QueryFailure as error:
            if error.reason in ('query_HTTP_403','query_HTTP_429','query_HTTP_503'):
                failures=min(5,int(state.get('failures',0))+1)
                state.update(failures=failures,cooldown_until=time.time()+max(error.retry_after,min(300,30*2**failures)))
                _atomic(root/'pacing.json',state)
            partial={'records':records,'total_count':total,'complete_query':False,'observed_at':time.time(),'invalid_records':invalid}
            return fallback(error.reason,partial)
