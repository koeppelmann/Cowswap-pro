"""Public, pinned TWAP schedule discovery; future amounts are planned flow."""
from pathlib import Path
import fcntl
import hashlib
import json
import os
import time
import urllib.request
import uuid
from ethereum_crypto import keccak256
from twap_api import fetch_candidates
from funding import endpoint, selector, simple, aggregate, decode, word, addr, blob, symbol_value, MULTICALL, SETTLEMENT, RELAYER, NATIVE

COMPOSABLE='0xfdafc9d1902f4e0b84f65f49f244b32b31013b74'
HANDLER='0x6cf1e9ca41f7611def408122793c358a3d11e5a5'
CREATED='0x'+keccak256(b'ConditionalOrderCreated(address,(address,bytes32,bytes))').hex()
ORDER_TYPE=keccak256(b'Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)')
MAX_VALID_TO=2**32-1


def schedule_state(schedule, now, *, authorized=True, effective_start=None, current_filled_atoms=0):
    n=int(schedule.get('total_parts',schedule.get('parts',0)))
    interval=int(schedule.get('interval_seconds',0));span=int(schedule.get('span_seconds',0))
    start=int(schedule.get('start_time',schedule.get('start',0)) or 0)
    if effective_start is not None:start=int(effective_start)
    sell=int(schedule.get('part_sell_atoms',0));buy=int(schedule.get('min_buy_atoms',0))
    result={'start_time':start,'end_time':None,'current_index':None,'current_valid_to':None,'valid_to':None,'next_slice_at':None,'remaining_parts':None,'remaining_sell_atoms':None,'remaining_min_buy_atoms':None,'state_complete':False,'status':'state_unknown'}
    if not (1<n<=MAX_VALID_TO and 0<interval<=365*86400 and 0<=span<=interval and sell>0 and buy>0 and 0<=start<MAX_VALID_TO):
        result['status']='invalid_schedule';return result
    if start==0 and effective_start is None:return result
    width=span or interval
    # GPv2 validTo is uint32 even if a parent advertises more future parts.
    last_usable=min(n-1,(MAX_VALID_TO-start-width+1)//interval)
    eligible=max(0,last_usable+1)
    result['end_time']=start+(eligible-1)*interval+width if eligible else start
    count=0;next_at=None;index=None;valid_to=None;status='expired'
    if not authorized:status='cancelled'
    elif now<start:
        count=eligible;next_at=start if count else None;status='scheduled' if count else 'expired'
    elif now<start+n*interval:
        index=(int(now)-start)//interval
        valid_to=start+index*interval+width-1
        current_open=index<eligible and now<=valid_to
        future=max(0,eligible-index-1)
        available=current_open and current_filled_atoms is not None and int(current_filled_atoms)==0
        if current_open and current_filled_atoms is None:
            result.update(current_index=index,current_valid_to=valid_to,valid_to=valid_to);return result
        count=future+int(available)
        if available:next_at=int(now);status='current_slice'
        elif future:next_at=start+(index+1)*interval;status='waiting_next_slice'
    result.update(current_index=index,current_valid_to=valid_to,valid_to=valid_to,next_slice_at=next_at,remaining_parts=count,remaining_sell_atoms=str(count*sell),remaining_min_buy_atoms=str(count*buy),state_complete=True,status=status)
    return result


def decode_created(log):
    raw=bytes.fromhex(log['data'][2:])
    def at(offset):
        if offset<0 or offset+32>len(raw) or offset%32:raise ValueError('invalid_event_encoding')
        return int.from_bytes(raw[offset:offset+32],'big')
    offset=at(0)
    handler='0x'+raw[offset+12:offset+32].hex()
    if handler!=HANDLER:return None
    location=offset+at(offset+64);size=at(location)
    if size!=320 or location+32+size>len(raw):raise ValueError('unsupported_twap_encoding')
    data=raw[location+32:location+32+size];words=[data[i:i+32] for i in range(0,len(data),32)]
    if any(any(value[:12]) for value in words[:3]):raise ValueError('noncanonical_twap_address')
    number=lambda i:int.from_bytes(words[i],'big')
    address=lambda i:'0x'+words[i][-20:].hex()
    sell,buy=address(0),address(1)
    if sell==buy or int(sell,16)==0 or int(buy,16)==0 or sell==NATIVE:raise ValueError('invalid_twap_tokens')
    if not (number(3)>0 and number(4)>0 and number(5)<MAX_VALID_TO and 1<number(6)<=MAX_VALID_TO and 0<number(7)<=365*86400 and number(8)<=number(7)):raise ValueError('invalid_twap_parameters')
    owner='0x'+log['topics'][1][-40:];digest='0x'+keccak256(raw).hex()
    return {'id':owner+':'+digest,'owner':owner,'schedule_hash':digest,'handler':handler,'sell_token':address(0),'buy_token':address(1),'receiver':address(2),'part_sell_atoms':str(number(3)),'min_buy_atoms':str(number(4)),'start_time':number(5),'total_parts':number(6),'interval_seconds':number(7),'span_seconds':number(8),'creation_tx':log['transactionHash'],'creation_block':int(log['blockNumber'],16),'event_index':int(log['logIndex'],16),'_app_data':'0x'+words[9].hex()}


def decode_api_parent(record):
    if type(record.get('chainId')) is not int or record['chainId']!=1:raise ValueError('wrong_api_chain')
    def raw(key,size):
        value=record[key]
        if not isinstance(value,str) or not value.startswith('0x') or len(value)!=2+size*2:raise ValueError('invalid_api_encoding')
        return bytes.fromhex(value[2:])
    owner=raw('owner',20);handler=raw('handler',20);salt=raw('salt',32);static=raw('staticInput',320)
    claimed=raw('hash',32)
    if not any(owner):raise ValueError('invalid_api_owner')
    if '0x'+handler.hex()!=HANDLER:return None
    encoded=word(32)+b'\0'*12+handler+salt+word(96)+blob(static)
    if keccak256(encoded)!=claimed:raise ValueError('api_parent_hash_mismatch')
    transaction=record.get('txHash')
    if transaction is not None:
        if not isinstance(transaction,str) or len(transaction)!=66 or not transaction.startswith('0x'):raise ValueError('invalid_api_transaction')
        bytes.fromhex(transaction[2:])
    row=decode_created({'data':'0x'+encoded.hex(),'topics':[CREATED,'0x'+(b'\0'*12+owner).hex()],
                        'transactionHash':transaction,'blockNumber':'0x0','logIndex':'0x0'})
    row.update(creation_block=None,event_index=None,discovery_source='public_programmatic_index')
    return row


def merge_candidates(retained,events,candidates):
    latest={r['id']:r for r in retained};invalid_api=0
    for candidate in candidates:
        try:row=decode_api_parent(candidate)
        except (ValueError,TypeError,KeyError,IndexError,OverflowError):
            invalid_api+=1;continue
        if row:latest.setdefault(row['id'],row)
    invalid_events=0
    for log in events:
        if log.get('removed') or log.get('address','').lower()!=COMPOSABLE:continue
        try:row=decode_created(log)
        except (ValueError,IndexError,KeyError,OverflowError):
            invalid_events+=1;continue
        if row:latest[row['id']]=row
    return list(latest.values()),invalid_events,invalid_api


def child_uid(schedule, valid_to, domain_separator):
    if not 0<=valid_to<=MAX_VALID_TO:raise ValueError('invalid_child_expiry')
    encoded=(ORDER_TYPE+addr(schedule['sell_token'])+addr(schedule['buy_token'])+addr(schedule['receiver'])+word(schedule['part_sell_atoms'])+word(schedule['min_buy_atoms'])+word(valid_to)+bytes.fromhex(schedule['_app_data'][2:])+word(0)+keccak256(b'sell')+word(0)+keccak256(b'erc20')+keccak256(b'erc20'))
    digest=keccak256(b'\x19\x01'+domain_separator+keccak256(encoded))
    return '0x'+(digest+bytes.fromhex(schedule['owner'][2:])+valid_to.to_bytes(4,'big')).hex()


def _atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('x') as stream:json.dump(value,stream,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if temporary.exists():temporary.unlink()


def collect_twap_schedules(metadata,block_number,block_hash,workdir,cache_root=None):
    workdir=Path(workdir);workdir.mkdir(parents=True,exist_ok=True)
    store=Path(cache_root)/'twap-index' if cache_root is not None else workdir/'index'
    store.mkdir(parents=True,exist_ok=True)
    evidence=[];deadline=time.monotonic()+30
    unavailable={'schedules':[],'metadata':{},'coverage':{'status':'unavailable','reason':'TWAP state unavailable','block':block_number,'block_hash':block_hash}}
    def rpc(url,method,params):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('twap_collection_budget')
        body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params},separators=(',',':')).encode()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(url,data=body,headers={'Content-Type':'application/json'}),timeout=min(5,remaining)) as response:raw=response.read(16*1024*1024+1)
        if len(raw)>16*1024*1024:raise ValueError('twap_rpc_size')
        result=json.loads(raw)
        evidence.append({'method':method,'request_sha256':hashlib.sha256(body).hexdigest(),'response_sha256':hashlib.sha256(raw).hexdigest()})
        if result.get('error') or result.get('id')!=1:raise RuntimeError('twap_rpc_failed')
        return result['result']
    try:
        url=endpoint();pin={'blockHash':block_hash,'requireCanonical':True}
        header=rpc(url,'eth_getBlockByNumber',[hex(block_number),False])
        if not header or header['hash'].lower()!=block_hash.lower():raise ValueError('twap_pin_changed')
        timestamp=int(header['timestamp'],16)
        if int(rpc(url,'eth_chainId',[]),16)!=1:raise ValueError('wrong_twap_chain')
        try:api=fetch_candidates(Path(cache_root) if cache_root is not None else workdir,deadline=min(deadline,time.monotonic()+8))
        except Exception:api={'records':[],'status':'unavailable','reason':'optional_source_failed'}
        guard=(store/'index.lock').open('a')
        try:
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
            path=store/'index.json';index=json.loads(path.read_text()) if path.exists() else None
            if index:
                anchor=rpc(url,'eth_getBlockByNumber',[hex(min(index['through_block'],block_number)),False])
                if index['through_block']>block_number or not anchor or anchor['hash'].lower()!=index['through_hash'].lower():index=None
            start=max(0,block_number-2048) if index is None else max(index['from_block'],index['through_block']-64)
            gaps=list(index.get('gaps',[])) if index else []
            log_url=url
            if block_number-start>2048:
                if os.environ.get('TWAP_LOG_RPC'):log_url=os.environ['TWAP_LOG_RPC']
                else:
                    gaps.append({'from_block':start,'to_block':block_number-2049});start=block_number-2048
            retained=[r for r in index['records'] if r.get('creation_block') is None or r['creation_block']<start] if index else []
            if log_url!=url:
                if int(rpc(log_url,'eth_chainId',[]),16)!=1:raise ValueError('wrong_twap_log_chain')
                archive_pin=rpc(log_url,'eth_getBlockByNumber',[hex(block_number),False])
                if not archive_pin or archive_pin['hash'].lower()!=block_hash.lower():raise ValueError('wrong_twap_log_pin')
            logs=rpc(log_url,'eth_getLogs',[{'address':COMPOSABLE,'fromBlock':hex(start),'toBlock':hex(block_number),'topics':[CREATED]}])
            if not isinstance(logs,list) or len(logs)>10000:raise ValueError('twap_log_count')
            records,invalid_events,invalid_api=merge_candidates(retained,logs,api.get('records',[]))
            index={'schema':1,'from_block':index['from_block'] if index else start,'through_block':block_number,'through_hash':block_hash,'gaps':gaps,'records':records}
            end=rpc(url,'eth_getBlockByNumber',[hex(block_number),False])
            if end['hash'].lower()!=block_hash.lower():raise ValueError('twap_reorg')
            _atomic(path,index)
        finally:guard.close()
        rows=[];answers={}
        def batch(calls):
            unique=list(dict.fromkeys(calls));unique=[c for c in unique if c not in answers]
            for offset in range(0,len(unique),160):
                part=unique[offset:offset+160]
                raw=rpc(url,'eth_call',[{'to':MULTICALL,'data':'0x'+aggregate(part).hex(),'gas':'0x1c9c380'},pin])
                answers.update(zip(part,decode(raw,len(part))))
        def read(target,data):
            ok,raw=answers.get((target,data),(False,b''));return raw if ok and len(raw)>=32 else None
        def number(target,data):
            raw=read(target,data);return int.from_bytes(raw[:32],'big') if raw is not None else None
        calls=[(SETTLEMENT,selector('domainSeparator()'))]
        for row in records:
            digest=bytes.fromhex(row['schedule_hash'][2:]);owner=addr(row['owner'])
            calls.extend([(COMPOSABLE,selector('singleOrders(address,bytes32)')+owner+digest),(COMPOSABLE,selector('cabinet(address,bytes32)')+owner+digest)])
        batch(calls);domain=read(SETTLEMENT,selector('domainSeparator()'))
        if domain is None:raise ValueError('missing_twap_domain')
        calls=[];keep_ids=set();unknown_states=0
        for original in records:
            row=dict(original);digest=bytes.fromhex(row['schedule_hash'][2:]);owner=addr(row['owner'])
            authorized=number(COMPOSABLE,selector('singleOrders(address,bytes32)')+owner+digest)
            context=number(COMPOSABLE,selector('cabinet(address,bytes32)')+owner+digest)
            if authorized is None or context is None:
                keep_ids.add(row['id']);unknown_states+=1;continue
            if not authorized:continue
            start=int(row['start_time']) or context
            preliminary=schedule_state(row,timestamp,authorized=True,effective_start=start,current_filled_atoms=0)
            if not preliminary['state_complete']:
                if preliminary['status']=='state_unknown':keep_ids.add(row['id']);unknown_states+=1
                continue
            if preliminary['remaining_parts']==0:continue
            keep_ids.add(row['id'])
            row.update(preliminary);row['registered']=True;row['block']=block_number;row['block_hash']=block_hash;row['current_child_uid']=None
            if preliminary['current_index'] is not None and preliminary['current_valid_to'] is not None:
                uid=child_uid(original,preliminary['current_valid_to'],domain);row['current_child_uid']=uid
                calls.append((SETTLEMENT,selector('filledAmount(bytes)')+word(32)+blob(bytes.fromhex(uid[2:]))))
            token=row['sell_token']
            calls.extend([(token,simple('70a08231',row['owner'])),(token,simple('dd62ed3e',row['owner'],RELAYER))])
            rows.append((row,original,start))
        tokens={t for row,_,_ in rows for t in [row['sell_token'],row['buy_token']]}-{NATIVE}
        for token in tokens:
            if token not in metadata:calls.extend([(token,selector('symbol()')),(token,selector('decimals()'))])
        batch(calls)
        extra={NATIVE:{'symbol':'ETH','decimals':18,'source':'native_asset_identity'}}
        for token in tokens:
            if token in metadata:continue
            raw=read(token,selector('symbol()'));decimals=number(token,selector('decimals()'))
            if raw is None or decimals is None or not 0<=decimals<=36:continue
            try:symbol=symbol_value(raw)
            except (ValueError,AssertionError,UnicodeError):continue
            extra[token]={'symbol':symbol,'decimals':decimals,'source':'canonical_twap_getters'}
        output=[]
        for row,original,start in rows:
            uid=row['current_child_uid'];filled=number(SETTLEMENT,selector('filledAmount(bytes)')+word(32)+blob(bytes.fromhex(uid[2:]))) if uid else 0
            state=schedule_state(original,timestamp,authorized=True,effective_start=start,current_filled_atoms=filled)
            if not state['state_complete']:unknown_states+=1;continue
            if state['remaining_parts']==0:
                keep_ids.discard(row['id']);continue
            row.update(state);row['current_child_invalidated']=filled==2**256-1 if filled is not None else None;row['current_child_filled']=0<filled<2**256-1 if filled is not None else None;row['current_filled_atoms']=str(filled) if filled is not None else None
            balance=number(row['sell_token'],simple('70a08231',row['owner']));allowance=number(row['sell_token'],simple('dd62ed3e',row['owner'],RELAYER))
            row['balance_atoms']=str(balance) if balance is not None else None;row['allowance_atoms']=str(allowance) if allowance is not None else None
            row['funding_status']='unknown' if balance is None or allowance is None else 'balance_covers_next_slice' if min(balance,allowance)>=int(row['part_sell_atoms']) else 'requires_funding'
            row['funding_note']='Observed wallet budget may be shared with other orders; future funding or hooks are not guaranteed.'
            row['explorer_url']='https://explorer.cow.fi/address/'+row['owner'];row['creation_url']='https://etherscan.io/tx/'+row['creation_tx'] if row['creation_tx'] else None;row['current_child_posted']=True if row['current_child_filled'] else None
            output.append({k:v for k,v in row.items() if not k.startswith('_')})
        end=rpc(url,'eth_getBlockByNumber',[hex(block_number),False])
        if end['hash'].lower()!=block_hash.lower():raise ValueError('twap_reorg')
        with (store/'index.lock').open('a') as pruning_guard:
            try:
                fcntl.flock(pruning_guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
                current=json.loads((store/'index.json').read_text())
                if current['through_block']==block_number and current['through_hash']==block_hash:
                    current['records']=[row for row in current['records'] if row['id'] in keep_ids]
                    _atomic(store/'index.json',current)
            except BlockingIOError:pass
        coverage={'status':'available','from_block':index['from_block'],'to_block':block_number,'block':block_number,'block_hash':block_hash,'gaps':index.get('gaps',[]),'indexed_parents':len(records),'invalid_event_count':invalid_events,'ongoing_parents':len(output),'pending_state_parents':unknown_states,'metadata_unavailable_tokens':sorted(tokens-set(metadata)-set(extra)),'api_status':api.get('status','unavailable'),'api_source':api.get('source'),'api_total_count':api.get('total_count'),'api_fetched_count':api.get('fetched_count',len(api.get('records',[]))),'api_observed_at':api.get('observed_at'),'api_complete_query':api.get('complete_query',False),'api_reason':api.get('reason'),'invalid_api_parent_count':invalid_api,'complete_census':False,'scope':'Public index candidates plus recent canonical events, revalidated on-chain; private, Merkle and custom handlers not enumerated.'}
        result={'schedules':output,'coverage':coverage,'metadata':extra}
    except Exception:
        result=unavailable
    _atomic(workdir/'twap-schedules.json',{'result':result,'rpc_evidence':evidence})
    return result
