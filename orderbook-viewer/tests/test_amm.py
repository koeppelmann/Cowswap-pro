from fractions import Fraction as F
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from amm import spot_v2,spot_v3,fee_band

class AMMMath(unittest.TestCase):
    def test_v2_reserves_decimal_and_reciprocal(self):
        self.assertEqual(spot_v2(10**18,2000*10**6,18,6,0),2000)
        self.assertEqual(spot_v2(10**18,2000*10**6,18,6,1),F(1,2000))
    def test_v3_decimal_and_reciprocal(self):
        self.assertEqual(spot_v3(2**96,18,6,0),10**12)
        self.assertEqual(spot_v3(2**96,18,6,1),F(1,10**12))
        self.assertEqual(spot_v3(2**97,18,18,0),4)
    def test_fee_band_includes_fee_once(self):
        bid,ask=fee_band(F(2000),F(5,10000))
        self.assertEqual(bid,F(1999));self.assertEqual(ask,F(4000000,1999))
        self.assertEqual(bid*ask,2000**2)
        with self.assertRaises(ValueError):fee_band(F(1),F(1))

class AMMRelevance(unittest.TestCase):
    def marker(self,pool,volume,inventory,bid='999',ask='1001'):
        return {'pool':pool,'volume_24h_usd':volume,'liquidity_usd':str(inventory),'bid_usdc_equivalent':bid,'ask_usdc_equivalent':ask}
    def test_active_pool_beats_larger_idle_inventory(self):
        from amm import choose_marker
        idle=self.marker('0x'+'a'*40,2390997,39960448)
        active=self.marker('0x56534741cd8b152df6d48adf7ac51f75169a83b2',35654053,30354446)
        self.assertIs(choose_marker([idle,active]),active)
    def test_external_report_pool_cannot_be_selected_from_plain_getters(self):
        from amm import choose_marker
        external=self.marker('0x313698667d7fdd6789a9bc70821309ff891e729a',10**12,10**12)
        normal=self.marker('0x'+'b'*40,1,100)
        self.assertIs(choose_marker([external,normal]),normal)
        self.assertIsNone(choose_marker([external]))
    def test_activity_tie_prefers_narrower_live_spread_and_missing_activity_falls_back(self):
        from amm import choose_marker
        wide=self.marker('0x'+'a'*40,100,100000,'980','1020')
        narrow=self.marker('0x'+'b'*40,100,1000)
        self.assertIs(choose_marker([wide,narrow]),narrow)
        wide['volume_24h_usd']=0;narrow['volume_24h_usd']=0
        self.assertIs(choose_marker([wide,narrow]),wide)
    def test_discovery_preserves_volume_and_excludes_external_policy(self):
        from discover_amm import catalog_from_discovery
        row=lambda address,volume,inventory:{'chainId':'ethereum','dexId':'uniswap','labels':['v3'],'pairAddress':address,'baseToken':{'address':'0x'+'1'*40},'quoteToken':{'address':'0x'+'2'*40},'liquidity':{'usd':inventory},'volume':{'h24':volume}}
        external=row('0x313698667d7fdd6789a9bc70821309ff891e729a',10**10,10**10)
        active=row('0x56534741cd8b152df6d48adf7ac51f75169a83b2',35654053,30354446)
        idle=row('0x'+'a'*40,1,10**9)
        catalog=catalog_from_discovery({'wbtc':[idle,external,active]},'frozen-time')
        self.assertEqual(catalog['pairs']['wbtc'][0]['address'],active['pairAddress'])
        self.assertEqual(catalog['pairs']['wbtc'][0]['volume_24h_usd'],35654053)
        self.assertEqual(catalog['discovered_at'],'frozen-time')
        self.assertEqual(len(catalog['pairs']['wbtc']),2)

if __name__=='__main__':unittest.main()
