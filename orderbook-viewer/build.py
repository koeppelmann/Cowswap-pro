"""Build a fresh public depth book from one captured auction and canonical state."""
import hashlib,json,re,time
from fractions import Fraction
from pathlib import Path
from allocator import build_depth,text,ETH,WETH,USDC,STABLES
from source import collect
from funding import read_funding
from amm import collect_markers
from twap import collect_twap_schedules
from twap_normalize import attach_schedules
import networks
BASE=Path(__file__).parent/'config'/'mainnet'/'book.json'

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

# USD-stable symbols without "USD" in the ticker. Combined with a "USD" substring test,
# this folds a chain's many stablecoins into the quote set so stable-vs-stable pairs are
# not surfaced as bases (yield-bearing sDAI is intentionally excluded, like mainnet).
STABLE_SYMBOLS={'DAI','GHO','FRAX','LUSD','MIM','DOLA','TUSD','GUSD'}
def looks_stable(symbol):
    u=(symbol or '').upper()
    return 'USD' in u or u in STABLE_SYMBOLS

def slugify(symbol,address,seen):
    base=re.sub(r'[^a-z0-9]','',symbol.lower()) or 'tok'
    slug=base
    if slug in seen:slug=base+address[2:6]
    i=0
    while slug in seen:
        i+=1;slug=base+address[2:6]+str(i)
    seen.add(slug);return slug

def derive_pairs(orders,metadata,stables,prices,limit=50):
    """Non-mainnet networks have no curated book: rank every non-stable token that
    trades against a stable by its funded USD-equivalent size and expose the top ones
    as base pairs. Symbol/decimals come from the same-block on-chain reads. 'eth' is
    reserved so a token symboled 'ETH' can't collide with the mainnet family id."""
    meta={a.lower():v for a,v in metadata.items()}
    stables={s.lower() for s in stables}
    size={}
    for o in orders:
        s,b=o['sellToken'].lower(),o['buyToken'].lower()
        if (s in stables)==(b in stables):continue
        base,stable=(b,s) if s in stables else (s,b)
        if base not in meta or prices.get(base,0)<=0 or stable not in meta:continue
        stable_rem=int(o['remaining_sell_atoms'] if stable==s else o['remaining_buy_atoms'])
        size[base]=size.get(base,0.0)+stable_rem/10**int(meta[stable]['decimals'])
    ranked=sorted((b for b,usd in size.items() if usd>=1.0),key=lambda b:-size[b])[:limit]
    pairs=[];seen={'eth'}
    for base in ranked:
        sym=meta[base]['symbol']
        pairs.append({'id':slugify(sym,base,seen),'label':sym,'base_symbol':sym,'base_decimals':int(meta[base]['decimals']),'base_token':base})
    return pairs

def build_snapshot(work,*,source_dir=None,funding_dir=None,network='mainnet'):
    cfg=networks.get(network);fam=cfg['eth_family']
    usdc=cfg['usdc'].lower();weth=cfg.get('weth',WETH).lower()
    work=Path(work);source_dir=Path(source_dir) if source_dir else work/'source'
    if not cfg.get('evm',True):
        # Solana (non-EVM): a dedicated collector emits the same intermediate files with a
        # synthetic fully-funded state — no eth_call funding, TWAP or AMM machinery applies.
        import solana_source
        funding_dir=Path(funding_dir) if funding_dir else work/'funding'
        if not (funding_dir/'funding-state.json').exists():solana_source.collect(source_dir,funding_dir,network)
        state=json.loads((funding_dir/'funding-state.json').read_bytes());conversions=json.loads((funding_dir/'eth-conversions.json').read_bytes())
    elif funding_dir is None:
        if not source_dir.exists():collect(source_dir,network)
        funding_dir=work/'funding';state,conversions=read_funding(source_dir,funding_dir,network)
    else:
        if not source_dir.exists():collect(source_dir,network)
        funding_dir=Path(funding_dir);state=json.loads((funding_dir/'funding-state.json').read_bytes());conversions=json.loads((funding_dir/'eth-conversions.json').read_bytes())
    # Mainnet's token set is curated, so any getter error is a real problem. Dynamic
    # networks read arbitrary user-chosen tokens, where a single non-standard token's
    # reverting getter must not fail the whole network's book — such orders/groups are
    # filtered out below instead (the allocator already excludes missing-metadata orders).
    if network=='mainnet':assert not state['getter_errors']
    competition=json.loads((source_dir/'competition.private.json').read_bytes())
    source=json.loads((source_dir/'sanitized-orders.json').read_bytes())
    assert state['auction_id']==competition['auctionId'] and state['source_orders_sha256']==digest(source_dir/'sanitized-orders.json')
    prices={a.lower():int(v)for a,v in competition['auction']['prices'].items()}
    assert prices.get(usdc,0)>0 and (not fam or prices.get(weth,0)>0)
    assert conversions['block_hash']==state['block_hash']
    # Freshness guard: the auction's reference block must be recent. Checked here, before
    # the slower TWAP/AMM collection, so build latency doesn't count against the auction's
    # age (testnets get a wider window via max_staleness).
    ref=state['reference_state']
    if cfg.get('evm',True):assert -60<=time.time()-ref['timestamp']<=cfg.get('max_staleness',900)
    orders=state['orders']
    # Mainnet keeps its curated static book + allocator's built-in constants (unchanged);
    # other networks derive ranked pairs and pass their own stables + USD anchor with the
    # ETH-family aggregation turned off.
    if network=='mainnet':
        stables=STABLES;extra={}
        template=json.loads(BASE.read_bytes())
    else:
        stables={s.lower() for s in networks.stable_metadata(network)}
        for address,meta in state['metadata'].items():
            if address.lower()!=ETH and looks_stable(meta.get('symbol','')):stables.add(address.lower())
        extra=dict(usdc=usdc,stables=stables,weth=weth,eth_family=False)
        # Keep only fully-readable orders: both tokens have on-chain metadata and (unless
        # it's a native sell, which the allocator excludes anyway) the sell-token funding
        # read succeeded. A single reverting/garbage token is dropped, not fatal.
        readable={(g['owner'].lower(),g['sell_token'].lower()) for g in state['groups'] if g.get('balance_atoms') is not None and g.get('allowance_atoms') is not None}
        orders=[o for o in orders if o['sellToken'].lower() in state['metadata'] and o['buyToken'].lower() in state['metadata'] and (o['sellToken'].lower()==ETH or (o['owner'].lower(),o['sellToken'].lower()) in readable)]
        template={'metadata':{},'pairs':derive_pairs(orders,state['metadata'],stables,prices)}
    metadata={**template.get('metadata',{}),**state['metadata']}
    # TWAP overlay: active TWAP parents are discovered per chainId from CoW's
    # programmatic-orders index and revalidated on-chain (ComposableCoW + the TWAP
    # handler are at the same address on every CoW network). Runs on every network;
    # defensively wrapped so a TWAP failure degrades to no schedules, never a failed book.
    if cfg.get('twap',True):
        try:
            twaps=collect_twap_schedules(metadata,state['reference_state']['block_number'],state['block_hash'],work/'twap',cache_root=work.parent,network=network)
        except Exception:
            twaps={'schedules':[],'metadata':{},'coverage':{'status':'unavailable'}}
    else:
        twaps={'schedules':[],'metadata':{},'coverage':{'status':'not_applicable'}}
    metadata.update(twaps.get('metadata',{}))
    families=set();rates={ETH:Fraction(1),weth:Fraction(1)} if fam else {}
    details=[dict(token=t,symbol=s,eth_per_token='1',source='1:1 ETH denomination')for t,s in [(ETH,'ETH'),(weth,'WETH')]]
    if fam:
        families={v['token']for v in template['pairs'][0]['conversions']}
        for token,value in conversions['tokens'].items():
            if token not in families or token in (ETH,weth):continue
            rate=value['eth_per_token'];assert rate is not None
            rate=Fraction(int(rate['numerator']),int(rate['denominator']));assert rate>0
            rates[token]=rate;details.append(dict(token=token,symbol=metadata[token]['symbol'],eth_per_token=text(rate),source=value['conversion_label']))
    # Mainnet asserts all reads succeed (above), so every group has concrete atoms and this
    # filter is a no-op; off mainnet it drops groups whose balance/allowance read reverted
    # (their orders were already filtered out), keeping None atoms out of the allocator.
    groups=[{k:g[k]for k in ('owner','sell_token','balance_atoms','allowance_atoms')}for g in state['groups'] if g.get('balance_atoms') is not None and g.get('allowance_atoms') is not None]
    funding=dict(block_hash=state['block_hash'],groups=groups)
    def mode(selected,base,is_family):
        result=build_depth(selected,metadata,prices,funding,block_hash=state['block_hash'],mode='enriched',base_token=base,base_conversion=rates if is_family else None,**extra)
        result['approval_setup_from_unallocated_orders']=0
        return result
    pairs=[]
    for prior in template['pairs']:
        base=prior['base_token'].lower();family=fam and prior['id']=='eth'
        if family:base=weth
        reference_available=prices.get(base,0)>0
        assets=families if family else {base}
        selected=[o for o in orders if o['sellToken'].lower()in assets or o['buyToken'].lower()in assets]
        for o in selected:
            actual=o['sellToken'].lower()if o['sellToken'].lower()in assets else o['buyToken'].lower()
            if family:assert actual in rates
        aggregate=mode(selected,base,family)
        quote_modes={q:mode([o for o in selected if q in (o['sellToken'].lower(),o['buyToken'].lower())],base,family)for q in aggregate['quote_usdc_equivalent_rates']}
        p={k:prior[k]for k in ('id','label','base_symbol','base_decimals','base_token')}
        p.update(reference_available=reference_available,reference_usdc_equivalent=text(Fraction(prices[base]*10**p['base_decimals'],prices[usdc]*10**int(metadata[usdc]['decimals'])))if reference_available else '1',order_count=len(aggregate['normalized_orders']),modes={'enriched':aggregate},quote_modes=quote_modes)
        if family:p['conversions']=details
        pairs.append(p)
    if fam:assert pairs and pairs[0]['id']=='eth'
    # Attach schedules to their pairs (all networks). Isolate like the collector: a
    # normalize-side error degrades to no schedules rather than stalling the whole book
    # refresh (validate_snapshot would else reject a partially-attached book). Mainnet
    # keeps its curated stable set; other networks pass the derived one.
    try:
        stable_tokens=set(json.loads((networks.config_dir('mainnet')/'catalog.json').read_bytes())['stable_tokens']) if network=='mainnet' else stables
        twap_coverage=attach_schedules(pairs,twaps,metadata,prices,stable_tokens,rates,lambda base,family:mode([],base,family),usdc,weth)
    except Exception:
        for p in pairs:p.pop('twap_schedules',None)
        twap_coverage={'status':'unavailable'}
    assert pairs, 'No priced limit or TWAP markets'
    if cfg['amm']:
        try:markers=collect_markers(metadata,prices,pairs,state['reference_state']['block_number'],state['block_hash'],work/'amm',network)
        except Exception:markers={}
    else:
        markers={}
    for pair in pairs:
        pair['amm_marker']=markers.get(pair['id'],{'status':'unavailable','reason':'AMM snapshot unavailable' if cfg['amm'] else 'AMM survey not configured for this network','block':state['reference_state']['block_number'],'block_hash':state['block_hash']})
    # Per-network summary for the network picker: funded buy/sell volume (the same
    # allocated-USD the token picker shows per pair, totalled), unique limit-order count,
    # and active TWAP parents. Cross-base orders can count on both sides (rare: most trade
    # a base against a stable), so these are indicative network totals.
    buy_vol=sell_vol=0.0
    for p in pairs:
        emode=p['modes']['enriched'];pref=float(p['reference_usdc_equivalent']) if p.get('reference_available') is not False else None;qrates=emode['quote_usdc_equivalent_rates']
        for o in emode['normalized_orders']:
            if int(o['allocated_sell_atoms'])<=0:continue
            if o['side']=='bid':buy_vol+=int(o['allocated_quote_atoms'])/10**int(metadata[o['quote_token']]['decimals'])*float(qrates.get(o['quote_token'],0) or 0)
            elif pref is not None:sell_vol+=int(o['allocated_base_atoms'])/10**int(p['base_decimals'])*pref
    summary={'limit_orders':len(orders),'buy_volume_usd':buy_vol,'sell_volume_usd':sell_vol,'twaps':twap_coverage.get('active_schedule_count') or twap_coverage.get('plotted_schedule_count') or 0,'pair_count':len(pairs)}
    evidence=dict(auction_id=state['auction_id'],block=ref['block_number'],block_hash=state['block_hash'],source_sha256=digest(source_dir/'sanitized-orders.json'),funding_sha256=digest(funding_dir/'funding-state.json'),conversions_sha256=digest(funding_dir/'eth-conversions.json'))
    return dict(schema='cowpro_live_depth_v1',network=network,chain_id=cfg['chain_id'],auction_id=state['auction_id'],block=ref['block_number'],block_hash=state['block_hash'],as_of_timestamp=ref['timestamp'],native_eth=ETH,metadata=metadata,verified_limit_orders=len(orders),classification_excluded=sum(source.get('classification_summary',{}).get('excluded_candidates',{}).values()),pairs=pairs,twap_coverage=twap_coverage,modes=pairs[0]['modes'],scope='Live cached auction limits; canonical same-block wallet/approval budgets allocated once per view. Hook-conditional funding excluded. '+('ETH conversion provenance in asset details. ' if fam else '')+('TWAP overlays are scheduled flow, not funded executable depth. ' if twap_coverage.get('status')=='available' else '')+'No full settlement guarantee.',snapshot_evidence=evidence,generated_at=time.time(),refresh_seconds=300,evm=cfg.get('evm',True),accounts=state.get('accounts',{}),summary=summary)
