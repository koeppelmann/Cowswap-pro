"""Refresh a frozen survey candidate catalog; live workers never mutate it."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import json
from pathlib import Path
import urllib.request
from amm import EXTERNAL_ORACLE_POOLS, CATALOG


def discover(book):
    def read(pair):
        request=urllib.request.Request('https://api.dexscreener.com/token-pairs/v1/ethereum/'+pair['base_token'],headers={'User-Agent':'cowpro-research'})
        try:
            with urllib.request.urlopen(request,timeout=20) as response:raw=json.load(response)
            return pair['id'],[r for r in raw if r.get('chainId')=='ethereum']
        except Exception:return pair['id'],[]
    with ThreadPoolExecutor(max_workers=4) as pool:discovery=dict(pool.map(read,book['pairs']))
    return catalog_from_discovery(discovery,datetime.now(timezone.utc).isoformat())

def catalog_from_discovery(discovery,discovered_at):
    catalog={};survey={}
    for name,rows in discovery.items():
        rows=[r for r in rows if r.get('chainId')=='ethereum']
        ordered=sorted(rows,key=lambda r:((r.get('volume') or {}).get('h24') or 0,(r.get('liquidity') or {}).get('usd') or 0),reverse=True)
        survey[name]={'candidate_count':len(ordered),'most_active_discovered_pool':{'address':ordered[0]['pairAddress'].lower(),'venue':ordered[0]['dexId'],'volume_24h_usd':(ordered[0].get('volume') or {}).get('h24',0)} if ordered else None,'excluded_external_oracle_pools':[r['pairAddress'].lower() for r in ordered if r['pairAddress'].lower() in EXTERNAL_ORACLE_POOLS]}
        selected=[]
        for p in ordered:
            labels=p.get('labels') or [];dex=p.get('dexId');address=p['pairAddress'].lower()
            if len(address)!=42 or address in EXTERNAL_ORACLE_POOLS:continue
            kind='curve' if dex=='curve' else 'v3' if 'v3' in labels else 'v2' if dex in ['uniswap','sushiswap','shibaswap'] else None
            if kind is None:continue
            venue={'uniswap':'Uniswap','sushiswap':'SushiSwap','shibaswap':'ShibaSwap','curve':'Curve'}.get(dex,dex)
            selected.append({'address':address,'venue':venue+(' v3' if kind=='v3' else ' v2' if kind=='v2' else ''),'kind':kind,'discovery_liquidity_usd':(p.get('liquidity') or {}).get('usd',0),'volume_24h_usd':(p.get('volume') or {}).get('h24',0),'tokens':[p['baseToken']['address'].lower(),p['quoteToken']['address'].lower()],'source':'Dexscreener token-pairs Ethereum'})
            if len(selected)==6:break
        catalog[name]=selected
    if 'stusds' in catalog and not any(p['address']=='0x2c7c98a3b1582d83c43987202aeff638312478ae' for p in catalog['stusds']):catalog['stusds'].append({'address':'0x2c7c98a3b1582d83c43987202aeff638312478ae','venue':'Curve','kind':'curve','tokens':['0xdc035d45d973e3ec169d2276ddab16f1e407384f','0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'],'source':'Retained Curve USDS/stUSDS onchain investigation'})
    return {'discovered_at':discovered_at,'selection':'Up to six supported address-based Ethereum pools per token by surveyed 24h volume plus retained stUSDS Curve pool. Verify live state; rank by surveyed activity, live spread then inventories. Known external-oracle delivery pools excluded. V4 and unrecognized venues excluded. A supplemental discovery may add coverage provenance.','pairs':catalog,'survey':survey}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--book',type=Path,default=Path(__file__).parent/'config'/'mainnet'/'book.json');parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    value=discover(json.loads(args.book.read_bytes()))
    if CATALOG.exists():
        prior=json.loads(CATALOG.read_bytes())
        value['quote_references']=prior.get('quote_references',[])
        for name,candidates in prior.get('pairs',{}).items():
            retained=[{**c,'observed_at':c.get('observed_at',prior['discovered_at'])} for c in candidates if c['kind'] in ('v4','weighted-v3')]
            if not retained:continue
            value['pairs'].setdefault(name,[]).extend(retained)
            value['survey'].setdefault(name,{})['retained_verified_candidates']=len(retained)
        value['selection']+=' Retained manually verified hookless v4, Balancer v3 and quote-reference configurations require onchain revalidation.'
    with args.output.open('x') as stream:json.dump(value,stream,indent=2);stream.write('\n')
    print('Wrote frozen Ethereum pool survey; review and verify onchain before packaging')

if __name__=='__main__':main()
