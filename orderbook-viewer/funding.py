"""Canonical, bounded reads of limit-order funding; private hook bytes never printed."""
import argparse
import hashlib
import json
import os
import re
import urllib.request
from dfusion_crypto import function_selector
from fractions import Fraction
from pathlib import Path
import time
import networks

SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'
RELAYER = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110'
MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11'
NATIVE = '0x'+'ee'*20


def sha(raw): return hashlib.sha256(raw).hexdigest()
def word(value): return int(value).to_bytes(32, 'big')
def addr(value): return bytes.fromhex(value[2:]).rjust(32, b'\0')
def blob(value): return word(len(value))+value+b'\0'*((-len(value))%32)
def simple(selector, *values): return bytes.fromhex(selector)+b''.join(addr(v) if isinstance(v,str) and v.startswith('0x') and len(v)==42 else word(v) for v in values)
def aggregate(calls):
    tuples = [addr(target)+word(1)+word(96)+blob(data) for target,data in calls]
    offset = 32*len(tuples); heads=[]
    for value in tuples: heads.append(word(offset)); offset += len(value)
    return bytes.fromhex('82ad56cb')+word(32)+word(len(tuples))+b''.join(heads)+b''.join(tuples)
def decode(raw_hex, expected):
    assert 0 <= expected <= 180
    assert isinstance(raw_hex,str) and re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',raw_hex)
    raw=bytes.fromhex(raw_hex[2:])
    def at(offset):
        assert 0 <= offset <= len(raw)-32 and offset%32==0
        return int.from_bytes(raw[offset:offset+32],'big')
    array=at(0);count=at(array);assert count==expected
    heads=array+32;result=[]
    for i in range(count):
        start=heads+at(heads+32*i);assert start>=heads+32*count
        success=at(start);assert success in (0,1)
        ptr=start+at(start+32);assert ptr>=start+64
        size=at(ptr);assert size<=4096 and ptr+32+size<=len(raw)
        result.append((success==1,raw[ptr+32:ptr+32+size]))
    return result
WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
CONVERSIONS={
 '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0':('stEthPerToken()',None,'stETH','nominal_stETH_denomination'),
 '0xae78736cd615f374d3085123a210448e74fc6393':('getExchangeRate()',None,'ETH','protocol_exchange_rate'),
 '0xbe9895146f7af43049ca1c1ae358b0541ea49704':('exchangeRate()',None,'ETH','protocol_exchange_rate'),
 '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee':('getEETHByWeETH(uint256)',10**18,'eETH','nominal_eETH_denomination'),
 '0xac3e018457b222d93114458476f3e3416abbe38f':('convertToAssets(uint256)',10**18,'frxETH','underlying_share_conversion'),
 '0xf951e335afb289353dc249e82926178eac7ded78':('swETHToETHRate()',None,'ETH','protocol_exchange_rate')}

def endpoint(name='RPC_ETH'):
    if name not in ('RPC_ETH','RPC_ETH_ARCHIVE'):
        raise ValueError('unsupported_rpc_environment')
    value=os.environ.get(name)
    if value:return value
    raise RuntimeError('configured_rpc_unavailable')

# mainnet keeps the RPC_ETH path above (env + test-patchable); other networks resolve
# their own RPC (RPC_GNOSIS, … with public-node defaults) via networks.py.
def primary_endpoint(network):
    return endpoint() if network=='mainnet' else networks.rpc_url(network)
def archive_endpoint(network):
    return endpoint('RPC_ETH_ARCHIVE') if network=='mainnet' else networks.rpc_url(network,archive=True)

class PrunedState(Exception):pass

def rpc(url,method,params,evidence):
    raw=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params},separators=(',',':')).encode()
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(url,data=raw,headers={'Content-Type':'application/json'}),timeout=60) as response:
            body=response.read(8*1024*1024+1)
        assert len(body)<=8*1024*1024
        decoded=json.loads(body)
    except Exception:raise RuntimeError('rpc_transport_failed') from None
    evidence.append({'method':method,'request_sha256':sha(raw),'response_sha256':sha(body)})
    if 'error'in decoded:
        # Inspect only in-process; neither server bodies nor endpoint URLs leave this boundary.
        message=str(decoded['error'].get('message','')).lower()
        if any(text in message for text in ('missing trie node','historical state','state is not available','state unavailable','pruned')):raise PrunedState()
        raise RuntimeError('rpc_result_unavailable')
    assert decoded.get('id')==1 and decoded.get('jsonrpc')=='2.0'
    return decoded['result']

def selector(signature):
    return function_selector(signature)

def symbol_value(raw):
    if len(raw)==32:return raw.rstrip(b'\0').decode()
    assert len(raw)>=64 and int.from_bytes(raw[:32],'big')==32
    size=int.from_bytes(raw[32:64],'big');assert 0<size<=64 and len(raw)>=64+size
    value=raw[64:64+size].decode();assert all(ord(c)>=32 for c in value);return value

def rational(value):return {'numerator':str(value.numerator),'denominator':str(value.denominator)}

def remaining(order,executed):
    total=int(order['sellAmount']if order['kind']=='sell'else order['buyAmount']);assert total>0
    left=max(0,total-executed)
    return str(int(order['sellAmount'])*left//total),str(int(order['buyAmount'])*left//total)

def read_funding(source_dir,outdir,network='mainnet'):
    cfg=networks.get(network)
    source_dir=Path(source_dir);outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
    source_path=source_dir/'sanitized-orders.json';source=json.loads(source_path.read_bytes())
    competition=json.loads((source_dir/'competition.private.json').read_bytes())
    selected={o['uid']:o for o in source['orders']if o['strict_limit_order']is True};assert selected
    evidence=[];url=primary_endpoint(network);endpoint_kind='own_node'
    header=rpc(url,'eth_getBlockByNumber',[hex(competition['auctionStartBlock']),False],evidence)
    assert header and int(header['number'],16)==competition['auctionStartBlock']
    assert re.fullmatch(r'0x[0-9a-fA-F]{64}',header['hash'])
    assert int(rpc(url,'eth_chainId',[],evidence),16)==cfg['chain_id']
    pin={'blockHash':header['hash'],'requireCanonical':True};timestamp=int(header['timestamp'],16)
    orders=[];batch_evidence=[]
    for path in sorted((source_dir/'raw').glob('batch-*.private.json')):
        raw=path.read_bytes();batch_evidence.append({'path':str(path),'sha256':sha(raw)})
        for entry in json.loads(raw):
            order=entry.get('order',entry);d=order.get('data',order);m=order.get('metadata',order);uid=m.get('uid',order.get('uid'))
            if uid not in selected:continue
            owner=m['owner'].lower();assert uid[66:106].lower()==owner[2:]
            for field in ('sellToken','buyToken','sellAmount','buyAmount','kind','partiallyFillable','validTo'):assert d[field]==selected[uid][field]
            interactions=m.get('interactions',d.get('interactions',{}))or{};assert set(interactions)<={'pre','post'}
            for phase in ('pre','post'):
                assert len(interactions.get(phase,[]))==selected[uid].get(phase+'_interaction_count',len(interactions.get(phase,[])))
                assert len(order.get('interactions',{}).get(phase,[]))<=len(interactions.get(phase,[]))
            row={k:selected[uid][k]for k in ('uid','sellToken','buyToken','sellAmount','buyAmount','kind','partiallyFillable','validTo')}
            row.update(owner=owner,receiver=d.get('receiver'),classification='limit',feeAmount=str(d.get('feeAmount','0')),sellTokenBalance=d.get('sellTokenBalance','erc20'),buyTokenBalance=d.get('buyTokenBalance','erc20'),signing_scheme=m.get('signingScheme',d.get('signingScheme','unknown')),validFrom=d.get('validFrom',0),pre_interaction_count=len(interactions.get('pre',[])),post_interaction_count=len(interactions.get('post',[])))
            orders.append(row)
    assert len(orders)==len(selected) and {o['uid']for o in orders}==set(selected)
    keys=sorted({(o['owner'],o['sellToken'].lower())for o in orders if o['sellToken'].lower()!=NATIVE})
    tokens=sorted({o[k].lower()for o in orders for k in ('sellToken','buyToken')}-{NATIVE})
    calls=[(SETTLEMENT,selector('vaultRelayer()'))];labels=[('relayer',None)]
    for o in orders:calls.append((SETTLEMENT,selector('filledAmount(bytes)')+word(32)+blob(bytes.fromhex(o['uid'][2:]))));labels.append(('fill',o['uid']))
    for owner,token in keys:
        calls.extend([(token,simple('70a08231',owner)),(token,simple('dd62ed3e',owner,RELAYER))]);labels.extend([('balance',(owner,token)),('allowance',(owner,token))])
    for token in tokens:
        calls.extend([(token,simple('313ce567')),(token,simple('95d89b41'))]);labels.extend([('decimals',token),('symbol',token)])
        if token in CONVERSIONS:
            sig,arg,_,_=CONVERSIONS[token];calls.append((token,selector(sig)+(word(arg)if arg is not None else b'')));labels.append(('conversion',token))
    def acquire(endpoint_url):
        values=[]
        for offset in range(0,len(calls),180):
            part=calls[offset:offset+180]
            # Retry transient RPC failures per batch (public nodes are flaky on large
            # pinned-block multicalls, especially under multi-network load). PrunedState
            # propagates immediately so the archive fallback can take over.
            for attempt in range(3):
                try:
                    response=rpc(endpoint_url,'eth_call',[{'to':MULTICALL,'data':'0x'+aggregate(part).hex(),'gas':'0x1c9c380'},pin],evidence)
                    break
                except PrunedState:raise
                except RuntimeError:
                    if attempt==2:raise
                    time.sleep(0.6)
            values.extend(decode(response,len(part)))
        return values
    try:values=acquire(url)
    except PrunedState:
        endpoint_kind='archive_pruned_fallback';values=acquire(archive_endpoint(network))
    mapping={label:value for label,(ok,value)in zip(labels,values)if ok}
    errors=[{'kind':label[0],'identity':label[1],'reason':'getter_reverted'}for label,(ok,_)in zip(labels,values)if not ok]
    assert ('relayer',None)in mapping and '0x'+mapping[('relayer',None)][-20:].hex()==RELAYER
    groups=[]
    for owner,token in keys:
        ok=all(len(mapping.get((kind,(owner,token)),b''))==32 for kind in ('balance','allowance'))
        groups.append({'owner':owner,'sell_token':token,'group_id':owner+':'+token,'read_success':ok,'balance_atoms':str(int.from_bytes(mapping[('balance',(owner,token))],'big'))if ok else None,'allowance_atoms':str(int.from_bytes(mapping[('allowance',(owner,token))],'big'))if ok else None})
    for o in orders:
        raw=mapping[('fill',o['uid'])];assert len(raw)==32;executed=int.from_bytes(raw,'big');sell,buy=remaining(o,executed)
        o.update(historical_executed_atoms=str(executed),remaining_sell_atoms=sell,remaining_buy_atoms=buy,funding_condition='pre_interaction'if o['pre_interaction_count']or o['post_interaction_count']else'none',invalidated=executed==2**256-1,valid_at_reference=int(o['validFrom'])<=timestamp<=int(o['validTo']))
    metadata={NATIVE:{'symbol':cfg['native_symbol'],'decimals':18,'source':'native_asset_identity'}}
    for token in tokens:
        if ('decimals',token)in mapping and ('symbol',token)in mapping:
            # A non-standard token can satisfy the getters yet return garbage (bad decimals,
            # non-UTF8/over-long symbol). On curated mainnet this never fires; on dynamic
            # networks we drop such a token from metadata so it is excluded downstream rather
            # than crashing the whole network's build.
            try:
                raw=mapping[('decimals',token)];assert len(raw)==32;decimals=int.from_bytes(raw,'big');assert decimals<=36
                metadata[token]={'symbol':symbol_value(mapping[('symbol',token)]),'decimals':decimals,'source':'canonical_block_getters'}
            except (AssertionError,UnicodeDecodeError,ValueError):
                pass
    reference={'block_number':competition['auctionStartBlock'],'block_hash':header['hash'],'timestamp':timestamp,'position':'end_of_auction_start_block'}
    output={'schema':'dfusion_eth_limit_funding_static_v1','auction_id':competition['auctionId'],'reference_state':reference,'block_hash':header['hash'],'groups':groups,'orders':orders,'metadata':metadata,'getter_errors':errors,'source_orders_sha256':sha(source_path.read_bytes()),'source_batches':batch_evidence,'reader_sha256':sha(Path(__file__).read_bytes()),'rpc_evidence':evidence,'endpoint_kind':endpoint_kind,'scope':'Canonical signed terms, kind-denominated fills, balances and existing relayer allowance. Every pre/post-hook order remains conditional; historical permit execution is never reused. No signature or settlement validation claim.'}
    prices={k.lower():int(v)for k,v in competition['auction']['prices'].items()};converted={}
    # ETH-family conversions are a mainnet-only enrichment (LST exchange rates feed the
    # aggregated "ETH, all forms" pair). Off mainnet there is no such family, so the
    # conversions file is emitted with no tokens — only its reference/block_hash matters
    # (build.py asserts it matches, then ignores it for non-family pairs).
    if cfg['eth_family']:
        for token,meta in metadata.items():
            row={'address':token,**meta}
            if token in (NATIVE,WETH):row.update(eth_per_token=rational(Fraction(1)),conversion_kind='native_ETH_identity',conversion_label='ETH denomination')
            elif token in prices and WETH in prices:
                rate=Fraction(prices[token]*10**meta['decimals'],prices[WETH]*10**18);row.update(cow_reference_eth_per_token=rational(rate),eth_per_token=rational(rate),conversion_kind='cow_reference_valuation',conversion_label='CoW reference ETH equivalent; not a redemption guarantee')
            else:row.update(eth_per_token=None,conversion_kind='unavailable',conversion_label='No canonical ETH conversion or CoW reference price')
            if token=='0xae7ab96520de3a18e5e111b5eaab095312d7fe84':
                row.update(eth_per_token=rational(Fraction(1)),conversion_kind='nominal_stETH_denomination',conversion_label='1 stETH nominally denominated as 1 ETH; market value may differ')
            if token in CONVERSIONS:
                sig,arg,underlying,kind=CONVERSIONS[token];raw=mapping.get(('conversion',token),b'');ok=len(raw)==32 and int.from_bytes(raw,'big')>0
                row['getter']={'signature':sig,'argument_atoms':str(arg)if arg is not None else None,'success':ok,'underlying_symbol':underlying}
                if ok:
                    rate=Fraction(int.from_bytes(raw,'big'),10**18);row['getter']['underlying_per_token']=rational(rate)
                    if underlying!='frxETH':row.update(eth_per_token=rational(rate),conversion_kind=kind,conversion_label=sig+'; '+underlying+' denomination')
            converted[token]=row
    conversions={'schema':'dfusion_eth_family_conversions_v1',**reference,'tokens':converted,'rpc_evidence':evidence,'reader_sha256':sha(Path(__file__).read_bytes()),'scope':'Canonical getter denominations where explicit; otherwise labeled CoW valuation. No executable redemption or peg guarantee.'}
    for name,value in [('funding-state.json',output),('eth-conversions.json',conversions)]:
        with (outdir/name).open('x')as handle:json.dump(value,handle,indent=2);handle.write('\n')
    return output,conversions

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    funding,conversions=read_funding(args.source,args.out)
    print(json.dumps({'orders':len(funding['orders']),'groups':len(funding['groups']),'tokens':len(conversions['tokens']),'getter_errors':len(funding['getter_errors']),'block_number':funding['reference_state']['block_number']}))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'failed':True,'error_class':type(error).__name__,'reason':'canonical_funding_acquisition_stopped'}));raise SystemExit(1)from None
