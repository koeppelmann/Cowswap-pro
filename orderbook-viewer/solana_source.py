"""Solana (non-EVM) collector.

CoW's Solana order book is EVM-incompatible: no eth_call / Multicall3 / ComposableCoW /
AMM reads, chain identity is a genesis hash (chain_id is null), and token mints are
case-sensitive base58. This module fetches the live auction, per-order details and token
metadata (Jupiter, with a getTokenSupply fallback) and emits the SAME intermediate files
the EVM pipeline (build.build_snapshot) consumes, with a synthetic fully-funded state:
Solana wallet funding is not verified here, so signed order depth is what's shown.

TWAP, AMM and the balance/allowance funding model are disabled for this network via config
flags (twap:false, amm:false, evm:false). Addresses are lowercased for the pipeline's
internal comparisons (safe: no realistic base58 case-fold collision within one auction);
the real-case mint rides along in metadata[...]['mint'] and owners in state['accounts'].
"""
import hashlib,json,time,urllib.request
from pathlib import Path
import networks

API='https://api.cow.fi/solana/api'
JUPITER='https://lite-api.jup.ag/tokens/v2/search?query='
SOL_RPC='https://api.mainnet-beta.solana.com'
NATIVE='11111111111111111111111111111111'   # native SOL sentinel (base58 of 32 zero bytes)
HUGE=str(2**120)                              # synthetic "fully funded" balance/allowance
UA={'User-Agent':'cowpro-orderbook-viewer/1.0','Accept':'application/json'}


def _get(url,timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=timeout) as r:
        return json.loads(r.read())


def _post(url,payload,timeout=20):
    body=json.dumps(payload).encode()
    with urllib.request.urlopen(urllib.request.Request(url,data=body,headers={**UA,'Content-Type':'application/json'}),timeout=timeout) as r:
        return json.loads(r.read())


def _jupiter(mints):
    out={}
    for i in range(0,len(mints),40):
        try:
            for t in _get(JUPITER+','.join(mints[i:i+40])):
                if t.get('id') and t.get('symbol') and t.get('decimals') is not None:
                    out[t['id']]={'symbol':str(t['symbol'])[:40],'decimals':int(t['decimals'])}
        except Exception:pass
    return out


def _supply_decimals(mint):
    try:return int(_post(SOL_RPC,{'jsonrpc':'2.0','id':1,'method':'getTokenSupply','params':[mint]})['result']['value']['decimals'])
    except Exception:return None


def _sha(raw):return hashlib.sha256(raw).hexdigest()


def collect(source_dir,funding_dir,network='solana'):
    cfg=networks.get(network)
    source_dir=Path(source_dir);funding_dir=Path(funding_dir)
    (source_dir/'raw').mkdir(parents=True,exist_ok=True);funding_dir.mkdir(parents=True,exist_ok=True)
    comp=_get(API+'/v2/solver_competition/latest')
    auction=comp.get('auction',{})
    uids=list(auction.get('orders',[]))
    prices={k:str(v) for k,v in auction.get('prices',{}).items()}
    details=[]
    for uid in uids:
        try:details.append(_get(API+'/v1/orders/'+uid))
        except Exception:continue
    # token metadata: Jupiter (symbol+decimals) with a getTokenSupply decimals fallback
    mints={m for o in details for m in (o.get('sellToken'),o.get('buyToken')) if m}|set(prices)
    mints.discard(NATIVE)
    meta_real=_jupiter(sorted(mints))
    for m in sorted(mints-set(meta_real)):
        d=_supply_decimals(m)
        if d is not None:meta_real[m]={'symbol':m[:6],'decimals':d}
    meta_real[NATIVE]={'symbol':cfg.get('native_symbol','SOL'),'decimals':9}
    # Pipeline compares addresses lowercased, so key metadata lowercased; keep the real mint.
    metadata={m.lower():{'symbol':v['symbol'],'decimals':v['decimals'],'mint':m,'source':'solana_token_metadata'} for m,v in meta_real.items()}
    accounts={}
    orders=[]
    for o in details:
        s,b=o.get('sellToken'),o.get('buyToken')
        if not s or not b or s.lower() not in metadata or b.lower() not in metadata:continue
        if o.get('status') not in (None,'open'):continue
        owner=o.get('owner') or '';accounts[owner.lower()]=owner
        sell,buy=str(o['sellAmount']),str(o['buyAmount'])
        orders.append({'uid':o['uid'],'sellToken':s.lower(),'buyToken':b.lower(),'sellAmount':sell,'buyAmount':buy,
            'kind':o.get('kind','sell'),'partiallyFillable':bool(o.get('partiallyFillable',False)),'validTo':int(o.get('validTo',2**31-1)),
            'owner':owner.lower(),'account':owner,'receiver':o.get('receiver'),'classification':'limit','feeAmount':'0',
            'sellTokenBalance':'erc20','buyTokenBalance':'erc20','signing_scheme':o.get('signingScheme','solana'),'validFrom':0,
            'pre_interaction_count':0,'post_interaction_count':0,'historical_executed_atoms':'0',
            'remaining_sell_atoms':sell,'remaining_buy_atoms':buy,'funding_condition':'none','invalidated':False,'valid_at_reference':True})
    # Synthetic fully-funded groups (one per owner+sell_token): Solana funding is not verified.
    keys=sorted({(o['owner'],o['sellToken']) for o in orders})
    groups=[{'owner':ow,'sell_token':tk,'group_id':ow+':'+tk,'read_success':True,'balance_atoms':HUGE,'allowance_atoms':HUGE} for ow,tk in keys]
    now=int(time.time())
    block_hash='0x'+_sha(('solana:'+str(comp.get('auctionId'))).encode())
    reference={'block_number':int(comp.get('auctionStartSlot') or 0),'block_hash':block_hash,'timestamp':now,'position':'solana_auction_snapshot'}
    sanitized={'orders':[{**{k:o[k] for k in ('uid','sellToken','buyToken','sellAmount','buyAmount','kind','partiallyFillable','validTo')},'strict_limit_order':True} for o in orders]}
    source_path=source_dir/'sanitized-orders.json';source_path.write_text(json.dumps(sanitized))
    (source_dir/'competition.private.json').write_text(json.dumps({'auctionId':comp.get('auctionId'),'auctionStartBlock':reference['block_number'],'auction':{'prices':prices,'orders':uids}}))
    state={'schema':'cowpro_solana_funding_v1','auction_id':comp.get('auctionId'),'reference_state':reference,'block_hash':block_hash,
        'groups':groups,'orders':orders,'metadata':metadata,'getter_errors':[],'source_orders_sha256':_sha(source_path.read_bytes()),
        'accounts':accounts,'endpoint_kind':'solana_orderbook','scope':'Solana order book; signed order depth, wallet funding not verified.'}
    (funding_dir/'funding-state.json').write_text(json.dumps(state))
    (funding_dir/'eth-conversions.json').write_text(json.dumps({'block_hash':block_hash,'tokens':{}}))
    return state
