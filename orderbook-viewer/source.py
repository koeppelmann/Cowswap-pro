"""Fresh public CoW competition and signed-class-bound depth source."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import cowapi
import networks
from ethereum_crypto import keccak256
ROOT = Path(__file__).resolve().parent


def urls(network):
    slug = networks.get(network)['slug']
    return (f'https://api.cow.fi/{slug}/api/v2/solver_competition/latest',
            f'https://api.cow.fi/{slug}/api/v1/orders/by_uids')


def now():
    return datetime.now(timezone.utc).isoformat()


def write(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def configuration(network='mainnet'):
    # mainnet (and any network that ships a static catalog) uses a curated base list;
    # other networks discover bases dynamically, so they only need their stable set.
    catalog_path = networks.config_dir(network) / 'catalog.json'
    if catalog_path.exists():
        book = json.loads((networks.config_dir(network) / 'book.json').read_bytes())
        catalog = json.loads(catalog_path.read_bytes())
        bases = {p['base_token'].lower() for p in book['pairs']}
        bases.update(address for address in catalog['eth_family_tokens'] if address in book['metadata'])
        return bases, set(a.lower() for a in catalog['stable_tokens']), catalog
    stable_meta = networks.stable_metadata(network)
    return set(), set(stable_meta), {'tokens': stable_meta}


def member(data, bases, stables, dynamic=False):
    sell, buy = data['sellToken'].lower(), data['buyToken'].lower()
    if sell == buy:
        return False
    # Dynamic networks keep any order where exactly one side is a stable (the other is
    # the base, whatever it is); curated networks require the base to be in the list.
    if dynamic:
        return (sell in stables) != (buy in stables)
    return (sell in bases and buy in stables) or (buy in bases and sell in stables)


def project(order, hashes):
    d, m = order.get('data', order), order.get('metadata', order)
    raw = m.get('fullAppData')
    declared = None
    valid = False
    raw_sha = None
    if isinstance(raw, str):
        raw_sha = hashlib.sha256(raw.encode()).hexdigest()
        if raw_sha not in hashes:
            hashes[raw_sha] = '0x'+keccak256(raw.encode()).hex()
        valid = hashes[raw_sha].lower() == str(d.get('appData', '')).lower()
        try:
            app = json.loads(raw)
            declared = app.get('metadata', {}).get('orderClass', {})
            declared = declared.get('orderClass') if isinstance(declared, dict) else declared
            if not isinstance(declared, str):
                declared = None
        except (ValueError, AttributeError, TypeError):
            declared = None
    fields = ('sellToken','buyToken','sellAmount','buyAmount','kind','partiallyFillable','validTo','feeAmount','sellTokenBalance','buyTokenBalance')
    row = {key: d[key] for key in fields}
    interactions = m.get('interactions', d.get('interactions', {})) or {}
    hooks = {phase: [{'target': i.get('target'), 'selector': str(i.get('callData', ''))[:10], 'calldata_sha256': hashlib.sha256(str(i.get('callData', '')).encode()).hexdigest()} for i in interactions.get(phase, [])] for phase in ('pre','post')}
    for key in ('owner','status','creationDate','isLiquidityOrder','executedSellAmountBeforeFees','executedBuyAmount','executedSellAmount','executedFeeAmount','invalidated','presignaturePending'):
        row[key] = m.get(key)
    row.update(uid=m['uid'], receiver=d.get('receiver'), validFrom=d.get('validFrom',0), signingScheme=m.get('signingScheme',d.get('signingScheme')), declared_order_class=declared, verified_order_class=declared if valid else None, strict_limit_order=valid and declared=='limit', app_data_hash_verified=valid, app_data_hash=d.get('appData'), full_app_data_sha256=raw_sha, class_evidence='fullAppData.metadata.orderClass.orderClass', classification_reason='signed_app_data_declares_limit' if valid and declared=='limit' else 'class_not_proven' if not valid else 'different_declared_class', interactions=hooks, pre_interaction_count=len(hooks['pre']), post_interaction_count=len(hooks['post']))
    return row


def lookup(uids, deadline, orders_url):
    cowapi.acquire(deadline=deadline)
    remaining = deadline-time.monotonic()
    if remaining <= 0:
        raise RuntimeError('source_deadline')
    request = urllib.request.Request(orders_url, data=json.dumps(uids).encode(), headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':cowapi.USER_AGENT}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=min(30,remaining)) as response:
            raw = response.read(16*1024*1024+1)
    except urllib.error.HTTPError as error:
        if error.code in (403,429,503):
            cowapi.cooldown(error.headers)
        code = error.code
        error.close()
        raise RuntimeError(f'order_lookup_HTTP_{code}') from None
    except (OSError, TimeoutError):
        raise RuntimeError('order_lookup_transport_failure') from None
    if len(raw)>16*1024*1024:
        raise ValueError('order batch exceeds cap')
    return raw


def collect(outdir, network='mainnet'):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=False)
    rawdir = outdir/'raw'
    rawdir.mkdir()
    deadline = time.monotonic()+600
    started = now()
    latest_url, orders_url = urls(network)
    dynamic = network != 'mainnet'
    competition = cowapi.get_json(latest_url, refresh=True, deadline=deadline)
    write(outdir/'competition.private.json', competition)
    source_hash = hashlib.sha256((outdir/'competition.private.json').read_bytes()).hexdigest()
    uids = competition['auction']['orders']
    if not isinstance(uids,list) or len(uids)!=len(set(uids)) or len(uids)>20000:
        raise ValueError('invalid competition UID population')
    bases, stables, catalog = configuration(network)
    seen, rows, errors, batches, hashes = set(), [], [], [], {}
    for offset in range(0,len(uids),128):
        if time.monotonic() >= deadline:
            raise RuntimeError('source_deadline')
        requested = uids[offset:offset+128]
        raw = lookup(requested, deadline, orders_url)
        path = rawdir/f'batch-{offset//128:03d}.private.json'
        path.write_bytes(raw)
        entries = json.loads(raw)
        if not isinstance(entries,list) or len(entries)!=len(requested):
            raise ValueError('incomplete order batch')
        batch_seen=set()
        for entry in entries:
            if not isinstance(entry,dict) or len(entry)!=1:
                raise ValueError('unexpected order response')
            if 'error' in entry:
                uid=entry['error']['uid']
                errors.append({'uid':uid,'reason':'public order lookup unavailable'})
            elif 'order' in entry:
                order=entry['order']; d=order.get('data',order); m=order.get('metadata',order); uid=m['uid']
                if member(d,bases,stables,dynamic):
                    rows.append(project(order,hashes))
            else:
                raise ValueError('unknown order response')
            if uid not in requested or uid in batch_seen or uid in seen:
                raise ValueError('UID coverage mismatch')
            batch_seen.add(uid); seen.add(uid)
        if batch_seen!=set(requested):
            raise ValueError('incomplete UID coverage')
        batches.append({'path':str(path.relative_to(outdir)),'sha256':hashlib.sha256(raw).hexdigest(),'requested':len(requested),'retrieved_at':now()})
    if seen!=set(uids):
        raise ValueError('incomplete UID coverage')
    # An unavailable order may belong to the cohort; publication requires resolution.
    if errors:
        write(outdir/'lookup-errors.json',errors)
        raise RuntimeError('incomplete_resolved_UID_coverage')
    strict=[row for row in rows if row['strict_limit_order']]
    projection={'auction_id':competition['auctionId'],'auction_start_block':competition['auctionStartBlock'],'auction_deadline_block':competition['auctionDeadlineBlock'],'lookup_started_at':started,'lookup_finished_at':now(),'auction_uid_count':len(uids),'resolved_uid_count':len(seen),'lookup_errors':errors,'orders':strict,'competition_sha256':source_hash,'batches':batches,'stable_asset_candidates':{a:catalog['tokens'][a] for a in stables},'classification_scope':'Exact fullAppData Keccak equals signed appData and declares limit. Current status/execution is freshly fetched.','classification_summary':{'candidates':len(rows),'strict_limit_orders':len(strict),'excluded_candidates':dict(collections.Counter(row['classification_reason'] for row in rows if not row['strict_limit_order']))},'source_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    write(outdir/'sanitized-orders.json',projection)
    return competition,projection


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--out',required=True,type=Path); args=parser.parse_args()
    try:
        _, result=collect(args.out)
        print(json.dumps({key:result[key] for key in ('auction_id','auction_uid_count','resolved_uid_count','classification_summary','lookup_finished_at')}))
    except Exception as error:
        print(json.dumps({'failed':True,'error_class':type(error).__name__,'reason':str(error) if isinstance(error,RuntimeError) else 'source_collection_stopped'}))
        sys.exit(1)
