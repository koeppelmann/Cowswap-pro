"""Funding-capped signed-limit depth, with optional native ETH/stable enrichment."""
from collections import Counter
from decimal import Decimal, localcontext
from fractions import Fraction

WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
STABLES = {
    USDC, '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0x6b175474e89094c44da98b954eedeac495271d0f',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    '0x853d955acef822db058eb8505911ed77f175b99e',
    '0x40d16fc0246ae9be2e8f1226bfa7d685309136d',
    '0x5f98805a4e8be255a32880fdec7f6728c6568ba0',
    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
    '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
}


def text(value):
    value = Fraction(value)
    if value.denominator == 1:
        return str(value.numerator)
    with localcontext() as ctx:
        ctx.prec = 120
        s = format(Decimal(value.numerator)/Decimal(value.denominator), 'f')
        return s.rstrip('0').rstrip('.') if '.' in s else s


def build_depth(orders, metadata, cow_prices, funding, *, block_hash, mode='direct', base_token=WETH, quote_token=USDC, base_conversion=None):
    if mode not in ('direct', 'enriched') or funding['block_hash'].lower() != block_hash.lower():
        raise ValueError('Invalid mode or inconsistent funding state')
    meta = {a.lower(): v for a, v in metadata.items()}
    prices = {a.lower(): int(v, 0) if str(v).startswith('0x') else int(v) for a, v in cow_prices.items()}
    base_token, quote_token = base_token.lower(), quote_token.lower()
    assert meta[USDC]['decimals'] == 6 and prices[USDC] > 0
    base_decimals = int(meta[base_token]['decimals'])
    assert 0 <= base_decimals <= 36
    base_assets = {WETH, ETH} if mode == 'enriched' and base_token in (WETH, ETH) else {base_token}
    if base_conversion is not None:
        if mode != 'enriched':
            raise ValueError('Family conversion requires enriched mode')
        base_assets = set(base_conversion)
        if any(Fraction(rate) <= 0 for rate in base_conversion.values()):
            raise ValueError('Invalid family conversion')
    stable_quotes = STABLES - base_assets
    usd = prices[USDC]*10**6
    groups, available = {}, {}
    for g in funding['groups']:
        key = (g['owner'].lower(), g['sell_token'].lower())
        if key in groups:
            raise ValueError('Duplicate funding group')
        balance, allowance = int(g['balance_atoms']), int(g['allowance_atoms'])
        assert balance >= 0 and allowance >= 0
        if 'effective_allowance_atoms' in g:
            assert g.get('allowance_source') == 'verified_permit'
            allowance = int(g['effective_allowance_atoms'])
        if 'effective_balance_atoms' in g:
            assert g.get('balance_source') == 'verified_funding_hook'
            balance = int(g['effective_balance_atoms'])
        assert balance >= 0 and allowance >= 0
        groups[key] = {**g, 'capacity_atoms': str(min(balance, allowance))}
        available[key] = min(balance, allowance)
    rows, excluded, internal, seen = [], [], {}, set()
    for o in orders:
        uid = o['uid']
        if uid in seen:
            raise ValueError('Duplicate UID')
        seen.add(uid)
        s, b = o['sellToken'].lower(), o['buyToken'].lower()
        reason = None
        if o.get('classification') != 'limit':
            reason = 'not_verified_limit'
        elif o.get('valid_at_reference') is False or o.get('invalidated') is True:
            reason = 'invalid_at_reference'
        elif mode == 'direct' and {s, b} != {base_token, quote_token}:
            reason = 'outside_direct_pair'
        elif mode == 'enriched' and not ((s in base_assets and b in stable_quotes) or (b in base_assets and s in stable_quotes)):
            reason = 'outside_supported_markets'
        elif s == ETH:
            reason = 'native_sell_funding_unsupported'
        elif int(o.get('feeAmount', -1)) != 0:
            reason = 'nonzero_fee_not_modeled'
        elif o.get('sellTokenBalance', 'erc20') != 'erc20':
            reason = 'unsupported_funding_source'
        elif o['kind'] not in ('sell', 'buy'):
            reason = 'unknown_order_kind'
        if reason:
            excluded.append({'uid': uid, 'reason': reason})
            continue
        owner = o['owner'].lower()
        key = (owner, s)
        if key not in groups:
            raise ValueError('Missing funding group')
        sell, buy, executed = int(o['sellAmount']), int(o['buyAmount']), int(o['historical_executed_atoms'])
        assert sell > 0 and buy > 0 and executed >= 0
        target = sell if o['kind'] == 'sell' else buy
        if executed >= target or (not o['partiallyFillable'] and executed):
            excluded.append({'uid': uid, 'reason': 'filled_or_invalid_fok'})
            continue
        rem_sell, rem_buy = sell*(target-executed)//target, buy*(target-executed)//target
        if not rem_sell or not rem_buy:
            excluded.append({'uid': uid, 'reason': 'rounding_zero'})
            continue
        ask = s in base_assets
        quote = b if ask else s
        if quote not in meta or prices.get(quote, 0) <= 0:
            excluded.append({'uid': uid, 'reason': 'missing_metadata_or_cow_price'})
            continue
        price = Fraction(buy*prices[quote]*10**base_decimals, sell*usd) if ask else Fraction(sell*prices[quote]*10**base_decimals, buy*usd)
        actual_base = s if ask else b
        conversion = Fraction(base_conversion[actual_base]) if base_conversion is not None else Fraction(1)
        atom_conversion = conversion * Fraction(10**base_decimals, 10**meta[actual_base]['decimals'])
        price *= Fraction(10**meta[actual_base]['decimals'], 10**base_decimals) / conversion
        condition = o.get('funding_condition', 'none')
        pre = int(o.get('pre_interaction_count', len(o.get('preInteractions', []))))
        verified = condition in ('verified_permit', 'verified_funding_hook')
        conditional = (pre > 0 or condition not in ('none', 'unconditional', '', None)) and not verified
        if condition == 'verified_permit' and groups[key].get('allowance_source') != 'verified_permit':
            raise ValueError('Permit evidence missing')
        if condition == 'verified_funding_hook' and groups[key].get('balance_source') != 'verified_funding_hook':
            raise ValueError('Funding hook evidence missing')
        row = {'signed_sell_atoms': str(sell), 'signed_buy_atoms': str(buy), 'sell_token': s, 'buy_token': b, 'signed_fee_atoms': str(o.get('feeAmount','0')), 'valid_to': o.get('validTo'), 'valid_from': o.get('validFrom',0), 'uid': uid, 'owner': owner, 'side': 'ask' if ask else 'bid', 'base_token': s if ask else b,
            'quote_token': quote, 'quote_symbol': meta[quote]['symbol'], 'kind': o['kind'], 'partially_fillable': o['partiallyFillable'],
            'remaining_sell_atoms': str(rem_sell), 'remaining_buy_atoms': str(rem_buy),
            'nominal_base_atoms': str(int((rem_sell if ask else rem_buy)*atom_conversion)), 'nominal_actual_base_atoms': str(rem_sell if ask else rem_buy), 'base_conversion': text(conversion), 'nominal_quote_atoms': str(rem_buy if ask else rem_sell),
            'normalized_price': text(price), 'funding_condition': condition,
            'allocated_buy_atoms': '0', 'allocated_sell_atoms': '0', 'allocated_base_atoms': '0', 'allocated_quote_atoms': '0',
            'funding_status': 'conditional' if conditional else 'pending'}
        rows.append(row)
        internal[uid] = (price, key, conditional, atom_conversion)
    curves = {}
    for side, name in [('ask', 'asks'), ('bid', 'bids')]:
        ordered = sorted((r for r in rows if r['side'] == side), key=lambda r: ((internal[r['uid']][0] if side == 'ask' else -internal[r['uid']][0]), r['uid']))
        cumulative_base, cumulative_usd, points = 0, Fraction(0), []
        for r in ordered:
            _, key, conditional, atom_conversion = internal[r['uid']]
            if conditional:
                continue
            wanted = int(r['remaining_sell_atoms'])
            sell = min(wanted, available[key])
            if not r['partially_fillable'] and sell < wanted:
                sell = 0
            buy = int(r['remaining_buy_atoms'])*sell//wanted
            if not buy:
                sell = 0
            available[key] -= sell
            r.update(allocated_buy_atoms=str(buy), allocated_sell_atoms=str(sell), allocated_base_atoms=str(int((sell if side == 'ask' else buy)*atom_conversion)), allocated_actual_base_atoms=str(sell if side == 'ask' else buy),
                allocated_quote_atoms=str(buy if side == 'ask' else sell),
                funding_status='fully_allocated' if sell == wanted else 'partially_allocated' if sell else 'not_allocated')
            if sell:
                cumulative_base += int(r['allocated_base_atoms'])
                cumulative_usd += Fraction(int(r['allocated_quote_atoms'])*prices[r['quote_token']], usd)
                points.append({'price': r['normalized_price'], 'base_atoms': str(cumulative_base), 'usdc_equivalent': text(cumulative_usd), 'uid': r['uid']})
        curves[name] = points
    output_groups = []
    selected_groups = {value[1] for value in internal.values()}
    for key, g in groups.items():
        spend = int(g['capacity_atoms'])-available[key]
        assert 0 <= spend <= int(g['capacity_atoms'])
        if key in selected_groups:
            output_groups.append({**g, 'allocated_sell_atoms': str(spend)})
    return {'mode': mode, 'block_hash': block_hash, 'normalized_orders': rows, 'excluded': excluded, **curves,
        'funding_groups': output_groups, 'counts': dict(Counter(r['funding_status'] for r in rows)),
        'quote_usdc_equivalent_rates': {a: text(Fraction(prices[a]*10**meta[a]['decimals'], usd)) for a in {r['quote_token'] for r in rows}},
        'allocation_policy': 'Price-priority feasible funding scenario; each mode has its own budget allocation. FOK is indivisible; no general maximum-depth or full execution claim.',
        'rounding_policy': 'Kind-denominated historical execution; production remaining floors; funded volume is floor-rescaled from remaining amounts. Price uses original signed ratio.'}
