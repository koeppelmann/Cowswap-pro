"""Pinned pool spot markers from a frozen surveyed catalog; no execution claims."""
from decimal import Decimal, localcontext
from fractions import Fraction
import json
import hashlib
import time
import urllib.request
from pathlib import Path
from funding import endpoint, selector, simple, aggregate, decode, MULTICALL, WETH, addr, word, symbol_value

from ethereum_crypto import keccak256

STATE_VIEW='0x7ffe42c4a5deea5b0fec41c94c136cf115597227'
BALANCER_VAULT='0xba1333333333a1ba1108e8412f11850a5c319ba9'

USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
ETH='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
CATALOG=Path(__file__).with_name('amm-catalog.json')
FACTORIES={'0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f':'Uniswap v2','0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac':'SushiSwap v2','0x115934131916c8b277dd010ee02de363c09d037c':'ShibaSwap v2'}

# These FXSwap fees can change after Pyth report delivery; plain getters do not model it.
# Source: crates/market/src/curve_crypto/yb_policy.rs::REVIEWED_POOLS.
EXTERNAL_ORACLE_POOLS={
 '0x313698667d7fdd6789a9bc70821309ff891e729a',
 '0x862cb4e988fb66e72f128d1183829f8c05b6c6a0',
 '0x4f52c3a81e33521e5a9a47fd9d3be475d2279c2e',
 '0x656341ef90b622c6634e0573772ffb7f3669b9f3'}

def choose_marker(options):
    eligible=[m for m in options if m['pool'].lower() not in EXTERNAL_ORACLE_POOLS]
    if not eligible:return None
    if any(Decimal(str(m.get('volume_24h_usd') or 0))>0 for m in eligible):
        return max(eligible,key=lambda m:(Decimal(str(m.get('volume_24h_usd') or 0)),-(Decimal(m['ask_usdc_equivalent'])/Decimal(m['bid_usdc_equivalent'])-1),Decimal(m['liquidity_usd'])))
    return max(eligible,key=lambda m:Decimal(m['liquidity_usd']))

def text(n):
    with localcontext() as c:
        c.prec=60
        return format(Decimal(n.numerator)/Decimal(n.denominator),'f') if isinstance(n,Fraction) else format(n,'f')

def spot_v2(reserve0,reserve1,decimals0,decimals1,base_index):
    p=Fraction(reserve1*10**decimals0,reserve0*10**decimals1)
    return p if base_index==0 else 1/p

def spot_v3(sqrt_price_x96,decimals0,decimals1,base_index):
    p=Fraction(sqrt_price_x96**2*10**decimals0,2**192*10**decimals1)
    return p if base_index==0 else 1/p

def fee_band(mid,fee):
    if not 0<=fee<1:raise ValueError('invalid_pool_fee')
    return mid*(1-fee),mid/(1-fee)

def v4_key(candidate):
    tokens=candidate['tokens']
    if len(tokens)!=2 or tokens!=sorted(tokens) or candidate.get('hooks')!='0x'+'00'*20:raise ValueError('unsupported_v4_key')
    fee=int(candidate['fee']);spacing=int(candidate['tick_spacing'])
    if not 0<=fee<1000000 or not 0<spacing<32768:raise ValueError('unsupported_v4_fee')
    encoded=addr(tokens[0])+addr(tokens[1])+word(fee)+word(spacing)+word(0)
    if '0x'+keccak256(encoded).hex()!=candidate['address']:raise ValueError('v4_pool_id_mismatch')
    return tokens


def v4_state(candidate,answers):
    v4_key(candidate);pool_id=bytes.fromhex(candidate['address'][2:])
    ok,raw=answers.get((STATE_VIEW,selector('getSlot0(bytes32)')+pool_id),(False,b''))
    lok,lraw=answers.get((STATE_VIEW,selector('getLiquidity(bytes32)')+pool_id),(False,b''))
    if not ok or len(raw)<128 or not lok or len(lraw)<32:raise ValueError('v4_state_unavailable')
    sqrt=int.from_bytes(raw[:32],'big');liquidity=int.from_bytes(lraw[:32],'big')
    protocol=int.from_bytes(raw[64:96],'big');lp=int.from_bytes(raw[96:128],'big')
    directional=[protocol&4095,protocol>>12]
    if not sqrt or not liquidity or lp!=int(candidate['fee']) or any(p>1000 for p in directional):raise ValueError('v4_state_invalid')
    fees=[Fraction(p+lp-p*lp//1000000,1000000) for p in directional]
    return sqrt,liquidity,fees


def abi_array(raw,index):
    offset=int.from_bytes(raw[index*32:(index+1)*32],'big')
    if offset%32 or offset+32>len(raw):raise ValueError('invalid_pool_array')
    count=int.from_bytes(raw[offset:offset+32],'big')
    if not 0<count<=8 or offset+32+count*32>len(raw):raise ValueError('invalid_pool_array')
    return [int.from_bytes(raw[offset+32+n*32:offset+64+n*32],'big') for n in range(count)]


def collect_markers(metadata,prices,pairs,block_number,block_hash,workdir):
    workdir=Path(workdir);workdir.mkdir(parents=True,exist_ok=True)
    unavailable=lambda reason:{'status':'unavailable','reason':reason,'block':block_number,'block_hash':block_hash}
    result={p['id']:unavailable('No verified AMM in surveyed venues') for p in pairs}
    evidence=[];deadline=time.monotonic()+25
    def rpc(url,method,params,evidence):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('amm_collection_budget')
        raw=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params},separators=(',',':')).encode()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(url,data=raw,headers={'Content-Type':'application/json'}),timeout=min(5,remaining)) as response:
            body=response.read(8*1024*1024+1)
        if len(body)>8*1024*1024:raise ValueError('amm_response_size')
        decoded=json.loads(body)
        evidence.append({'method':method,'request_sha256':hashlib.sha256(raw).hexdigest(),'response_sha256':hashlib.sha256(body).hexdigest()})
        if decoded.get('error') or decoded.get('id')!=1 or decoded.get('jsonrpc')!='2.0':raise RuntimeError('amm_rpc_unavailable')
        return decoded['result']
    try:
        url=endpoint();catalog=json.loads(CATALOG.read_bytes());pin=hex(block_number)
        for pid,survey in catalog.get('survey',{}).items():
            if pid in result and survey.get('unavailable_reason'):result[pid]=unavailable(survey['unavailable_reason'])
        header=rpc(url,'eth_getBlockByNumber',[pin,False],evidence)
        if not header or header['hash'].lower()!=block_hash.lower():raise ValueError('noncanonical_pool_state')
        candidates={}
        for pair in pairs:
            for candidate in catalog['pairs'].get(pair['id'],[]):
                if candidate['address'] not in EXTERNAL_ORACLE_POOLS:candidates[candidate['address']]=candidate
        for reference in catalog.get('quote_references',[]):candidates[reference['address']]=reference
        answers={};selectors={}
        def data(sig,*args):
            if sig not in selectors:selectors[sig]=selector(sig).hex()
            return simple(selectors[sig],*args)
        def batch(calls):
            calls=list(dict.fromkeys(calls))
            calls=[v for v in calls if v not in answers]
            for start in range(0,len(calls),160):
                chunk=calls[start:start+160]
                raw=rpc(url,'eth_call',[{'to':MULTICALL,'data':'0x'+aggregate(chunk).hex()},pin],evidence)
                answers.update(zip(chunk,decode(raw,len(chunk))))
        def get(target,sig,*args):
            ok,raw=answers.get((target,data(sig,*args)),(False,b''))
            return raw if ok and len(raw)>=32 else None
        def integer(target,sig,*args):
            raw=get(target,sig,*args)
            return int.from_bytes(raw[:32],'big') if raw else None
        def address(target,sig,*args):
            raw=get(target,sig,*args)
            return '0x'+raw[:32][-20:].hex() if raw else None
        calls=[]
        for a,c in candidates.items():
            sigs=[('token0()',()),('token1()',())]
            if c['kind']=='v4':
                v4_key(c)
                calls += [(STATE_VIEW,selector('getSlot0(bytes32)')+bytes.fromhex(a[2:])),(STATE_VIEW,selector('getLiquidity(bytes32)')+bytes.fromhex(a[2:]))]
                continue
            if c['kind']=='weighted-v3':
                calls += [(BALANCER_VAULT,data('getPoolTokenInfo(address)',a)),(BALANCER_VAULT,data('getStaticSwapFeePercentage(address)',a)),(BALANCER_VAULT,data('getHooksConfig(address)',a)),(a,data('getNormalizedWeights()'))]
                continue
            if c['kind']=='v2':sigs += [('getReserves()',()),('factory()',())]
            elif c['kind']=='v3':sigs += [('slot0()',()),('fee()',()),('liquidity()',())]
            else:sigs=[('coins(uint256)',(i,)) for i in range(4)]+[('balances(uint256)',(i,)) for i in range(4)]+[('fee()',())]
            calls += [(a,data(sig,*args)) for sig,args in sigs]
        batch(calls)
        decoded={};tokens=set()
        for a,c in candidates.items():
            if c['kind']=='v4':coins=v4_key(c)
            elif c['kind']=='weighted-v3':
                raw=get(BALANCER_VAULT,'getPoolTokenInfo(address)',a)
                if raw is None:continue
                coins=['0x'+n.to_bytes(20,'big').hex() for n in abi_array(raw,0)]
            else:coins=[address(a,'coins(uint256)',i) for i in range(4)] if c['kind']=='curve' else [address(a,'token0()'),address(a,'token1()')]
            coins=[x for x in coins if x and int(x,16)]
            if len(coins)<2:continue
            decoded[a]=coins;tokens.update(coins)
        calls=[(t,data(sig)) for t in tokens if t not in metadata and t!=ETH for sig in ['decimals()','symbol()']]
        for a,coins in decoded.items():
            if candidates[a]['kind']=='v3':calls += [(t,data('balanceOf(address)',a)) for t in coins]
        batch(calls)
        decimals={t:int(metadata[t]['decimals']) if t in metadata else 18 if t==ETH else integer(t,'decimals()') for t in tokens}
        derived_rates={}
        def token_symbol(t):
            if t in metadata:return metadata[t]['symbol']
            try:return symbol_value(get(t,'symbol()'))
            except (ValueError,AssertionError,TypeError,UnicodeError):return t[:8]
        def rate(t):
            if t in derived_rates:return derived_rates[t]
            ref=prices.get(t,prices.get(WETH) if t==ETH else None)
            if ref is None or decimals.get(t) is None:return None
            return Fraction(int(ref)*10**decimals[t],int(prices[USDC])*10**6)
        for reference in catalog.get('quote_references',[]):
            try:
                base=reference['base_token'];coins=v4_key(reference);i=coins.index(base);quote=coins[1-i]
                if quote!=USDC:continue
                sqrt,_,_=v4_state(reference,answers)
                derived_rates[base]=spot_v3(sqrt,decimals[coins[0]],decimals[coins[1]],i)
            except (ValueError,KeyError,TypeError):continue
        prepared=[];calls=[]
        for pair in pairs:
            base=pair['base_token'].lower()
            for c in catalog['pairs'].get(pair['id'],[]):
                a=c['address'];coins=decoded.get(a,[])
                if base not in coins or any(decimals.get(t) is None for t in coins):continue
                i=coins.index(base)
                # A chart marker is a direct pool price; unsupported cross-coin compositions are not synthesized.
                for j,quote in enumerate(coins):
                    if j==i or rate(quote) is None:continue
                    item=dict(candidate=c,coins=coins,pair=pair,i=i,j=j,base=base,quote=quote)
                    if c['kind']=='curve':
                        base_rate=rate(base)
                        if not base_rate:continue
                        dx=max(10, int(Fraction(10**decimals[base],1)/base_rate))
                        dy=max(10, int(Fraction(10**decimals[quote],1)/rate(quote)))
                        item.update(dx=dx,dy=dy)
                        for sig in ['get_dy(int128,int128,uint256)','get_dy(uint256,uint256,uint256)']:
                            calls += [(a,data(sig,i,j,dx)),(a,data(sig,j,i,dy))]
                    prepared.append(item)
        batch(calls)
        markers={p['id']:[] for p in pairs}
        for item in prepared:
            try:
                c=item['candidate'];a=c['address'];coins=item['coins'];i=item['i'];j=item['j'];base=item['base'];quote=item['quote'];kind=c['kind'];qr=rate(quote)
                if kind=='v4':
                    sqrt,liquidity,fees=v4_state(c,answers)
                    mid=spot_v3(sqrt,decimals[coins[0]],decimals[coins[1]],i)*qr
                    fee=max(fees);bid=mid*(1-fees[i]);ask=mid/(1-fees[j])
                    amounts=[liquidity*2**96//sqrt,liquidity*sqrt//2**96]
                    fee_method='Hookless static-fee PoolKey hash verified; StateView slot0; directional protocol fees included. Inventory is active virtual reserves, not total deposits.';venue='Uniswap v4'
                elif kind=='weighted-v3':
                    info=get(BALANCER_VAULT,'getPoolTokenInfo(address)',a);weights=get(a,'getNormalizedWeights()');fee_raw=integer(BALANCER_VAULT,'getStaticSwapFeePercentage(address)',a)
                    hooks=get(BALANCER_VAULT,'getHooksConfig(address)',a)
                    if info is None or weights is None or fee_raw is None or hooks is None or any(hooks):continue
                    amounts=abi_array(info,2);weights=abi_array(weights,0)
                    # STANDARD tokens have no rate provider or yield-fee flag.
                    if len(coins)!=2 or len(amounts)!=2 or len(weights)!=2 or any(w<=0 for w in weights) or sum(weights)!=10**18:continue
                    info_offset=int.from_bytes(info[32:64],'big')
                    if any(info[info_offset+32:info_offset+32+len(coins)*96]):continue
                    mid=Fraction(amounts[j]*10**decimals[base]*weights[i],amounts[i]*10**decimals[quote]*weights[j])*qr
                    fee=Fraction(fee_raw,10**18);bid,ask=fee_band(mid,fee);venue='Balancer v3 weighted'
                    fee_method='Vault raw balances and static swap fee; normalized weights; STANDARD tokens only; no hooks or token rates.'
                elif kind=='v2':
                    factory=address(a,'factory()')
                    if factory not in FACTORIES:continue
                    raw=get(a,'getReserves()')
                    if not raw or len(raw)<96:continue
                    reserves=[int.from_bytes(raw[n:n+32],'big') for n in [0,32]]
                    if not all(reserves):continue
                    mid=spot_v2(*reserves,decimals[coins[0]],decimals[coins[1]],i)*qr
                    fee=Fraction(3,1000);bid,ask=fee_band(mid,fee)
                    amounts=reserves;fee_method='Verified canonical v2 factory: fixed 0.30% swap fee'
                    venue=FACTORIES[factory]
                elif kind=='v3':
                    raw=get(a,'slot0()');fee_raw=integer(a,'fee()');liquidity=integer(a,'liquidity()')
                    if not raw or not liquidity or fee_raw is None or not 0<=fee_raw<1000000:continue
                    sqrt=int.from_bytes(raw[:32],'big')
                    if not sqrt:continue
                    mid=spot_v3(sqrt,decimals[coins[0]],decimals[coins[1]],i)*qr
                    fee=Fraction(fee_raw,1000000);bid,ask=fee_band(mid,fee)
                    amounts=[integer(t,'balanceOf(address)',a) for t in coins]
                    fee_method='Pool fee() getter, per million';venue=c['venue']
                else:
                    fee_raw=integer(a,'fee()')
                    if fee_raw is None or not 0<=fee_raw<10**10:continue
                    fee=Fraction(fee_raw,10**10);dx=item['dx'];dy=item['dy'];out1=out2=None
                    for sig in ['get_dy(int128,int128,uint256)','get_dy(uint256,uint256,uint256)']:
                        out1=integer(a,sig,i,j,dx);out2=integer(a,sig,j,i,dy)
                        if out1 and out2:break
                    if not out1 or not out2:continue
                    bid=Fraction(out1*10**decimals[base],dx*10**decimals[quote])*qr
                    ask=Fraction(dy*10**decimals[base],out2*10**decimals[quote])*qr
                    if bid>ask:continue
                    with localcontext() as ctx:
                        ctx.prec=70;mid=Fraction((Decimal(bid.numerator)/Decimal(bid.denominator)*Decimal(ask.numerator)/Decimal(ask.denominator)).sqrt())
                    amounts=[integer(a,'balances(uint256)',n) for n in range(len(coins))]
                    fee_method='Directional get_dy samples of approximately $1 each; fee and finite-size impact included; mid is geometric midpoint'
                    venue='Curve'
                if not amounts or any(v is None for v in amounts):continue
                tvl=Fraction(0)
                for t,amount in zip(coins,amounts):
                    tr=rate(t)
                    if tr is None and t==base:tr=mid
                    if tr is None:raise ValueError('missing_tvl_reference')
                    tvl+=Fraction(amount,10**decimals[t])*tr
                if tvl<=0 or mid<=0:continue
                marker={'status':'available','pool':a,'pool_address':a,'venue':venue,'pool_kind':kind,'base_token':base,'quote_token':quote,'base_symbol':metadata.get(base,{}).get('symbol',item['pair']['base_symbol']),'quote_symbol':token_symbol(quote),'mid_usdc_equivalent':text(mid),'bid_usdc_equivalent':text(bid),'ask_usdc_equivalent':text(ask),'fee_bps':text(fee*10000),'bid_fee_bps':text((fees[i] if kind=='v4' else fee)*10000),'ask_fee_bps':text((fees[j] if kind=='v4' else fee)*10000),'liquidity_usd':text(tvl),'liquidity_usdc_equivalent':text(tvl),'block':block_number,'block_hash':block_hash,'method':fee_method,'quote_reference_source':('Verified same-block Uniswap v4 apxUSD/USDC spot' if quote in derived_rates else 'CoW reference'),'inventory_valuation':('Pool spot for base token without CoW reference' if rate(base) is None else 'CoW reference; v4 uses active virtual reserves'),'normalization':'Pool quote normalized using quote_reference_source; pool fee only, no gas, transfer taxes or trade-size quote','ranking':'Highest surveyed 24h trading volume among verified supported pools; live spread breaks ties; inventory fallback if volume unavailable','volume_24h_usd':c.get('volume_24h_usd',0),'activity_observed_at':c.get('observed_at',catalog.get('survey',{}).get(item['pair']['id'],{}).get('observed_at',catalog['discovered_at'])),'discovery_source':c['source'],'catalog_discovered_at':c.get('observed_at',catalog.get('survey',{}).get(item['pair']['id'],{}).get('observed_at',catalog['discovered_at'])),'surveyed_pool_count':len(catalog['pairs'].get(item['pair']['id'],[])),'coverage':'Surveyed v2, v3, Curve, verified hookless static-fee v4 and STANDARD-token Balancer v3 weighted pools', 'survey':catalog.get('survey',{}).get(item['pair']['id'],{})}
                markers[item['pair']['id']].append(marker)
            except (ValueError,ZeroDivisionError,TypeError,KeyError):continue
        for pid,options in markers.items():
            if options:
                chosen=choose_marker(options)
                if chosen is None:continue
                top=catalog.get('survey',{}).get(pid,{}).get('most_active_discovered_pool')
                chosen['selection_caveat']='Most active verified supported pool by surveyed 24h volume' if Decimal(str(chosen.get('volume_24h_usd') or 0))>0 else 'No positive surveyed volume; largest verified inventory fallback'
                if top and top['address']!=chosen['pool']:
                    chosen['selection_caveat']='Supported fallback; highest discovery-volume pool was not selected'
                    chosen['higher_ranked_discovered_pool']=top
                result[pid]=chosen
        end=rpc(url,'eth_getBlockByNumber',[pin,False],evidence)
        if end['hash'].lower()!=block_hash.lower():raise ValueError('pool_state_reorg')
    except Exception as error:
        result={p['id']:unavailable('AMM state unavailable') for p in pairs}
    (workdir/'amm-markers.json').write_text(json.dumps({'markers':result,'rpc_evidence':evidence},indent=2)+'\n')
    return result
