import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import funding
import networks
from allocator import ETH
from twap_normalize import attach_schedules, quote_rate

class MultichainState(unittest.TestCase):
    def test_empty_limit_population_reads_anchor_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            (source / 'raw').mkdir(parents=True)
            (source / 'sanitized-orders.json').write_text(json.dumps({'orders': []}))
            (source / 'competition.private.json').write_text(json.dumps({'auctionStartBlock': 100, 'auctionId': 4, 'auction': {'prices': {}}}))
            def rpc(url, method, params, evidence):
                if method == 'eth_getBlockByNumber':
                    return {'number': '0x64', 'hash': '0x' + '33' * 32, 'timestamp': '0x64'}
                if method == 'eth_chainId':return hex(8453)
                return '0x'
            values = [(True, bytes.fromhex(funding.RELAYER[2:]).rjust(32, b'\0')), (True, funding.word(6)), (True, b'USDC'.ljust(32, b'\0'))]
            with patch.object(funding, 'primary_endpoint', return_value='test'), patch.object(funding, 'rpc', side_effect=rpc), patch.object(funding, 'decode', return_value=values):
                state, _ = funding.read_funding(source, Path(directory) / 'funding', 'base')
            self.assertEqual(state['metadata'][networks.get('base')['usdc']]['decimals'], 6)
            self.assertEqual(state['orders'], [])

    def test_base_twap_only_wrapped_and_native_assets_are_independent(self):
        cfg = networks.get('base');usdc, weth = cfg['usdc'], cfg['weth']
        metadata = {usdc: {'symbol': 'USDC', 'decimals': 6}, weth: {'symbol': 'WETH', 'decimals': 18}, ETH: {'symbol': 'ETH', 'decimals': 18}}
        prices = {usdc: 10**12, weth: 2000}
        schedules = [{'id': token, 'sell_token': token, 'buy_token': usdc, 'state_complete': True, 'remaining_parts': 2, 'registered': True, 'part_sell_atoms': str(10**18), 'min_buy_atoms': str(2000 * 10**6)} for token in (weth, ETH)]
        pairs = []
        coverage = attach_schedules(pairs, {'schedules': schedules}, metadata, prices, {usdc}, {}, lambda *a: {'quote_usdc_equivalent_rates': {}}, usdc, weth)
        self.assertEqual({p['base_token'] for p in pairs}, {weth, ETH})
        self.assertTrue(all(p['id'] != 'eth' for p in pairs))
        self.assertEqual(coverage['plotted_schedule_count'], 2)
        self.assertEqual(quote_rate(ETH, metadata, prices, usdc, weth), 2000)

    def test_snapshot_can_start_with_only_twap_markets(self):
        import build
        import hashlib
        import time
        cfg=networks.get('base');usdc,weth=cfg['usdc'],cfg['weth']
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';funded=root/'funding'
            source.mkdir();funded.mkdir();raw=b'{"orders":[]}'
            (source/'sanitized-orders.json').write_bytes(raw)
            (source/'competition.private.json').write_text(json.dumps({'auctionId':1,'auction':{'prices':{usdc:10**12,weth:2000}}}))
            state={'auction_id':1,'source_orders_sha256':hashlib.sha256(raw).hexdigest(),'block_hash':'0x'+'33'*32,'reference_state':{'block_number':100,'timestamp':time.time()},'orders':[],'groups':[],'metadata':{usdc:{'symbol':'USDC','decimals':6},weth:{'symbol':'WETH','decimals':18}},'getter_errors':[]}
            (funded/'funding-state.json').write_text(json.dumps(state))
            (funded/'eth-conversions.json').write_text(json.dumps({'block_hash':state['block_hash'],'tokens':{}}))
            schedule={'id':'parent','sell_token':weth,'buy_token':usdc,'state_complete':True,'remaining_parts':2,'registered':True,'part_sell_atoms':str(10**18),'min_buy_atoms':str(2000*10**6)}
            with patch.object(build,'collect_twap_schedules',return_value={'schedules':[schedule],'coverage':{'status':'available'}}),patch.object(build,'collect_markers',return_value={}):
                result=build.build_snapshot(root/'work',source_dir=source,funding_dir=funded,network='base')
            self.assertEqual(result['pairs'][0]['base_token'],weth)
            self.assertEqual(result['twap_coverage']['plotted_schedule_count'],1)
