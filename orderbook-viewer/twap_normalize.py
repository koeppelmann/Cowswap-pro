"""Project scheduled TWAP limits without adding them to funded order depth."""
import re
from fractions import Fraction
from allocator import ETH,WETH,USDC,text


def quote_rate(token,metadata,prices,usdc=USDC,weth=WETH):
    priced=token if prices.get(token) else weth if token==ETH else token
    if not prices.get(priced) or not prices.get(usdc) or token not in metadata:return None
    return Fraction(int(prices[priced])*10**metadata[token]['decimals'],int(prices[usdc])*10**6)


def project_schedule(schedule,pair,metadata,prices,stable_tokens,family_rates,usdc=USDC,weth=WETH):
    sell,buy=schedule['sell_token'].lower(),schedule['buy_token'].lower()
    if not schedule.get('state_complete') or not schedule.get('remaining_parts') or not schedule.get('registered'):return None
    family=pair['id']=='eth';assets=set(family_rates) if family else {pair['base_token']}
    if sell in assets:actual,quote,side=sell,buy,'ask'
    elif buy in assets:actual,quote,side=buy,sell,'bid'
    else:return None
    if actual not in metadata or quote not in metadata:return None
    rate=quote_rate(quote,metadata,prices,usdc,weth)
    if rate is None:return None
    count=int(schedule['remaining_parts']);part_sell=int(schedule['part_sell_atoms']);part_buy=int(schedule['min_buy_atoms'])
    if min(count,part_sell,part_buy)<=0:return None
    raw_base,raw_quote=(part_sell,part_buy) if side=='ask' else (part_buy,part_sell)
    conversion=family_rates[actual] if family else Fraction(1)
    base_human=Fraction(raw_base,10**metadata[actual]['decimals'])*conversion
    quote_value=Fraction(raw_quote,10**metadata[quote]['decimals'])*rate
    base_atoms=base_human*10**pair['base_decimals'];slice_base=base_atoms.numerator//base_atoms.denominator
    if slice_base<=0 or quote_value<=0:return None
    # The $ SIZE is the token amount valued at its reference (CoW) price — NOT the signed
    # limit. A TWAP with a deliberately low limit ("sell at any price") must still report its
    # true market value, so the $ figures reflect what the tokens are worth, not the proceeds
    # at the limit. normalized_price stays the signed limit (shown separately as the limit).
    base_rate=quote_rate(actual,metadata,prices,usdc,weth)
    size_value=Fraction(raw_base,10**metadata[actual]['decimals'])*base_rate if base_rate is not None else quote_value
    row={**schedule,'side':side,'normalized_price':text(quote_value/base_human),'base_token':actual,'base_symbol':metadata[actual]['symbol'],'quote_token':quote,'quote_symbol':metadata[quote]['symbol'],'quote_is_stable':quote in stable_tokens,'slice_base_atoms':str(slice_base),'remaining_base_atoms':str(slice_base*count),'slice_native_base_atoms':str(raw_base),'remaining_native_base_atoms':str(raw_base*count),'native_base_decimals':metadata[actual]['decimals'],'slice_quote_atoms':str(raw_quote),'remaining_quote_atoms':str(raw_quote*count),'slice_usdc_equivalent':text(size_value),'remaining_usdc_equivalent':text(size_value*count),'slice_limit_usdc_equivalent':text(quote_value),'base_conversion':text(conversion),'volume_kind':'Scheduled at signed limit, not funded executable depth'}
    return row


def attach_schedules(pairs,collection,metadata,prices,stable_tokens,family_rates,empty_mode,usdc=USDC,weth=WETH):
    """Add TWAP-only assets when the other leg has a reference valuation."""
    records=collection.get('schedules',[])
    usable=[r for r in records if r.get('state_complete') and r.get('registered') and int(r.get('remaining_parts',0))>0]
    covered={p['base_token'] for p in pairs}|set(family_rates)
    ids={p['id'] for p in pairs}
    for row in usable:
        sell,buy=row['sell_token'].lower(),row['buy_token'].lower()
        for asset,quote in [(sell,buy),(buy,sell)]:
            if asset in covered or asset in stable_tokens or asset not in metadata or quote_rate(quote,metadata,prices,usdc,weth) is None:continue
            symbol=metadata[asset]['symbol'];slug=re.sub('[^a-z0-9]+','',symbol.lower()) or 'token'
            if slug=='eth' and not family_rates:slug+='-'+asset[2:8]
            if slug in ids:slug+='-'+asset[2:8]
            ref=quote_rate(asset,metadata,prices,usdc,weth)
            p={'id':slug,'label':symbol,'base_symbol':symbol,'base_decimals':metadata[asset]['decimals'],'base_token':asset,'reference_available':ref is not None,'reference_usdc_equivalent':text(ref) if ref is not None else '1','order_count':0,'modes':{'enriched':empty_mode(asset,False)},'quote_modes':{},'twap_only':True,'default_quote':quote,'amm_marker':{'status':'unavailable','reason':'TWAP-only asset; no AMM survey configured'}}
            pairs.append(p);covered.add(asset);ids.add(slug)
    projected_ids=set()
    for pair in pairs:
        rows=[]
        for record in usable:
            row=project_schedule(record,pair,metadata,prices,stable_tokens,family_rates,usdc,weth)
            if row is not None:rows.append(row);projected_ids.add(row['id'])
        pair['twap_schedules']=rows
        for quote in {r['quote_token'] for r in rows}:
            if quote not in pair['quote_modes']:
                mode=empty_mode(pair['base_token'],pair['id']=='eth')
                mode['quote_usdc_equivalent_rates'][quote]=text(quote_rate(quote,metadata,prices,usdc,weth))
                pair['quote_modes'][quote]=mode
        if pair.get('twap_only'):
            stable_quotes=[r['quote_token'] for r in rows if r['quote_is_stable']]
            if stable_quotes:pair.pop('default_quote',None)
    coverage={**collection.get('coverage',{}),'active_schedule_count':len(usable),'plotted_schedule_count':len(projected_ids),'unpriced_schedule_count':sum(r['id'] not in projected_ids for r in usable),'planned_flow_only':True}
    return coverage
