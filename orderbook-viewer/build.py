"""Build a fresh public depth book from one captured auction and canonical state."""
import hashlib,json,time
from fractions import Fraction
from pathlib import Path
from allocator import build_depth,text,ETH,WETH,USDC
from source import collect
from funding import read_funding
from amm import collect_markers
from twap import collect_twap_schedules
from twap_normalize import attach_schedules
BASE=Path(__file__).parent/'config-book.json'

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def build_snapshot(work,*,source_dir=None,funding_dir=None):
    work=Path(work);source_dir=Path(source_dir) if source_dir else work/'source'
    if not source_dir.exists():collect(source_dir)
    if funding_dir is None:
        funding_dir=work/'funding';state,conversions=read_funding(source_dir,funding_dir)
    else:
        funding_dir=Path(funding_dir);state=json.loads((funding_dir/'funding-state.json').read_bytes());conversions=json.loads((funding_dir/'eth-conversions.json').read_bytes())
    assert not state['getter_errors']
    competition=json.loads((source_dir/'competition.private.json').read_bytes())
    source=json.loads((source_dir/'sanitized-orders.json').read_bytes())
    assert state['auction_id']==competition['auctionId'] and state['source_orders_sha256']==digest(source_dir/'sanitized-orders.json')
    template=json.loads(BASE.read_bytes());metadata={**template['metadata'],**state['metadata']}
    prices={a.lower():int(v)for a,v in competition['auction']['prices'].items()}
    try:
        twaps=collect_twap_schedules(metadata, state['reference_state']['block_number'], state['block_hash'], work/'twap', cache_root=work.parent)
    except Exception:
        twaps={'schedules':[], 'metadata':{}, 'coverage':{'status':'unavailable'}}
    metadata.update(twaps.get('metadata',{}))
    assert prices.get(USDC,0)>0 and prices.get(WETH,0)>0
    families={v['token']for v in template['pairs'][0]['conversions']}
    rates={ETH:Fraction(1),WETH:Fraction(1)};details=[dict(token=t,symbol=s,eth_per_token='1',source='1:1 ETH denomination')for t,s in [(ETH,'ETH'),(WETH,'WETH')]]
    assert conversions['block_hash']==state['block_hash']
    for token,value in conversions['tokens'].items():
        if token not in families or token in (ETH,WETH):continue
        rate=value['eth_per_token'];assert rate is not None
        rate=Fraction(int(rate['numerator']),int(rate['denominator']));assert rate>0
        rates[token]=rate;details.append(dict(token=token,symbol=metadata[token]['symbol'],eth_per_token=text(rate),source=value['conversion_label']))
    groups=[{k:g[k]for k in ('owner','sell_token','balance_atoms','allowance_atoms')}for g in state['groups']]
    funding=dict(block_hash=state['block_hash'],groups=groups)
    orders=state['orders']
    def mode(selected,base,is_family):
        result=build_depth(selected,metadata,prices,funding,block_hash=state['block_hash'],mode='enriched',base_token=base,base_conversion=rates if is_family else None)
        result['approval_setup_from_unallocated_orders']=0
        return result
    pairs=[]
    for prior in template['pairs']:
        base=prior['base_token'];family=prior['id']=='eth';base=WETH if family else base
        reference_available=prices.get(base,0)>0
        assets=families if family else {base}
        selected=[o for o in orders if o['sellToken'].lower()in assets or o['buyToken'].lower()in assets]
        for o in selected:
            actual=o['sellToken'].lower()if o['sellToken'].lower()in assets else o['buyToken'].lower()
            if family:assert actual in rates
        aggregate=mode(selected,base,family)
        quote_modes={q:mode([o for o in selected if q in (o['sellToken'].lower(),o['buyToken'].lower())],base,family)for q in aggregate['quote_usdc_equivalent_rates']}
        p={k:prior[k]for k in ('id','label','base_symbol','base_decimals','base_token')}
        p.update(reference_available=reference_available,reference_usdc_equivalent=text(Fraction(prices[base]*10**p['base_decimals'],prices[USDC]*10**6))if reference_available else '1',order_count=len(aggregate['normalized_orders']),modes={'enriched':aggregate},quote_modes=quote_modes)
        if family:p['conversions']=details
        pairs.append(p)
    assert pairs and pairs[0]['id']=='eth'
    stable_tokens=set(json.loads((Path(__file__).parent/'config-catalog.json').read_bytes())['stable_tokens'])
    twap_coverage=attach_schedules(pairs,twaps,metadata,prices,stable_tokens,rates,lambda base,family:mode([],base,family))
    try:
        markers=collect_markers(metadata,prices,pairs,state['reference_state']['block_number'],state['block_hash'],work/'amm')
    except Exception:
        markers={}
    for pair in pairs:
        pair['amm_marker']=markers.get(pair['id'],{'status':'unavailable','reason':'AMM snapshot unavailable','block':state['reference_state']['block_number'],'block_hash':state['block_hash']})
    ref=state['reference_state'];assert -60<=time.time()-ref['timestamp']<=900
    evidence=dict(auction_id=state['auction_id'],block=ref['block_number'],block_hash=state['block_hash'],source_sha256=digest(source_dir/'sanitized-orders.json'),funding_sha256=digest(funding_dir/'funding-state.json'),conversions_sha256=digest(funding_dir/'eth-conversions.json'))
    return dict(schema='dfusion_live_depth_v1',auction_id=state['auction_id'],block=ref['block_number'],block_hash=state['block_hash'],as_of_timestamp=ref['timestamp'],native_eth=ETH,metadata=metadata,verified_limit_orders=len(orders),classification_excluded=sum(source.get('classification_summary',{}).get('excluded_candidates',{}).values()),pairs=pairs,twap_coverage=twap_coverage,modes=pairs[0]['modes'],scope='Live cached auction limits; canonical same-block wallet/approval budgets allocated once per view. Hook-conditional funding excluded. ETH conversion provenance in asset details. TWAP overlays are scheduled flow, not funded executable depth. No full settlement guarantee.',snapshot_evidence=evidence,generated_at=time.time(),refresh_seconds=300)
