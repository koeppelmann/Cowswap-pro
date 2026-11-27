"""Verify AMM coverage for every token in a sanitized viewer snapshot."""
import argparse
from fractions import Fraction
import json
from pathlib import Path
import amm


def snapshot_prices(book):
    rates={}
    for pair in book['pairs']:
        if pair.get('reference_available',True):rates[pair['base_token']]=Fraction(pair['reference_usdc_equivalent'])
        rates.update({token:Fraction(value) for token,value in pair['modes']['enriched']['quote_usdc_equivalent_rates'].items()})
    rates[amm.USDC]=Fraction(1)
    return {token:int(rate*10**(36-book['metadata'][token]['decimals'])) for token,rate in rates.items() if token in book['metadata']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--catalog',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.catalog:amm.CATALOG=args.catalog
    book=json.loads(args.snapshot.read_bytes())
    markers=amm.collect_markers(book['metadata'],snapshot_prices(book),book['pairs'],book['block'],book['block_hash'],args.output.parent/(args.output.stem+'-evidence'))
    missing=[pair['id'] for pair in book['pairs'] if markers[pair['id']]['status']!='available']
    result={'block':book['block'],'block_hash':book['block_hash'],'tokens':len(book['pairs']),'verified':len(book['pairs'])-len(missing),'missing':missing,'markers':markers}
    with args.output.open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    print(f"Verified {result['verified']}/{result['tokens']} AMM markers; missing: {', '.join(missing) or 'none'}")
    return int(bool(missing))


if __name__=='__main__':raise SystemExit(main())
