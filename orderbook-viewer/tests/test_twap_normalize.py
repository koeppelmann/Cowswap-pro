from fractions import Fraction as F
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from twap_normalize import project_schedule,attach_schedules
from allocator import ETH,WETH,USDC
WBTC='0x'+'22'*20;HYPER='0x'+'33'*20;WSTETH='0x'+'44'*20
class NormalizeTwap(unittest.TestCase):
    def setUp(self):
        self.meta={USDC:{'symbol':'USDC','decimals':6},WETH:{'symbol':'WETH','decimals':18},ETH:{'symbol':'ETH','decimals':18},WBTC:{'symbol':'WBTC','decimals':8},HYPER:{'symbol':'HYPER','decimals':18},WSTETH:{'symbol':'wstETH','decimals':18}}
        self.prices={USDC:10**30,WETH:2000*10**18,WBTC:60000*10**28};self.rates={ETH:F(1),WETH:F(1),WSTETH:F(6,5)}
    def row(self,**extra):return {'id':'parent','owner':'0x'+'11'*20,'registered':True,'state_complete':True,'remaining_parts':3,'sell_token':WBTC,'buy_token':USDC,'part_sell_atoms':'10000000','min_buy_atoms':'6000000000',**extra}
    def pair(self,token=WBTC,id='wbtc',decimals=8):return {'id':id,'base_token':token,'base_decimals':decimals,'base_symbol':self.meta[token]['symbol'],'modes':{'enriched':{'quote_usdc_equivalent_rates':{}}},'quote_modes':{}}
    def project(self,row,pair=None):return project_schedule(row,pair or self.pair(),self.meta,self.prices,{USDC},self.rates)
    def test_bid_ask_and_decimal_asymmetry(self):
        ask=self.project(self.row());self.assertEqual(ask['side'],'ask');self.assertEqual(F(ask['normalized_price']),60000);self.assertEqual(ask['slice_base_atoms'],'10000000');self.assertEqual(ask['remaining_base_atoms'],'30000000');self.assertEqual(F(ask['slice_usdc_equivalent']),6000);self.assertEqual(F(ask['remaining_usdc_equivalent']),18000)
        bid=self.project(self.row(sell_token=USDC,buy_token=WBTC,part_sell_atoms='6000000000',min_buy_atoms='10000000'));self.assertEqual(bid['side'],'bid');self.assertEqual(bid['normalized_price'],ask['normalized_price']);self.assertEqual(bid['remaining_usdc_equivalent'],ask['remaining_usdc_equivalent'])
    def test_family_conversion_and_native_quote(self):
        row=self.row(sell_token=WSTETH,buy_token=USDC,part_sell_atoms=str(10**18),min_buy_atoms='2400000000');p=self.pair(WETH,'eth',18);out=self.project(row,p)
        self.assertEqual(F(out['normalized_price']),2000);self.assertEqual(out['slice_base_atoms'],str(12*10**17));self.assertEqual(out['remaining_base_atoms'],str(36*10**17))
        row=self.row(sell_token=HYPER,buy_token=ETH,part_sell_atoms=str(10000*10**18),min_buy_atoms=str(10**18));out=self.project(row,self.pair(HYPER,'hyper',18));self.assertEqual(F(out['normalized_price']),F(1,5));self.assertFalse(out['quote_is_stable']);self.assertEqual(out['quote_symbol'],'ETH')
    def test_eighteen_decimal_usd_anchor_values_identically(self):
        # BNB-style: the USD anchor is an 18-decimal stable (Binance-Peg USDC), not 6.
        # The reference math must key off the anchor's real decimals, not a hardcoded 10**6.
        from twap_normalize import quote_rate
        ANCHOR='0x'+'55'*20
        meta={**self.meta,ANCHOR:{'symbol':'USDC','decimals':18}}
        prices={ANCHOR:10**18,WBTC:60000*10**28,WETH:2000*10**18}
        self.assertEqual(quote_rate(WBTC,meta,prices,ANCHOR,WETH),60000)
        self.assertEqual(quote_rate(WETH,meta,prices,ANCHOR,WETH),2000)
        row=self.row(buy_token=ANCHOR,min_buy_atoms=str(6000*10**18))  # sell 0.1 WBTC for >=6000 anchor
        out=project_schedule(row,self.pair(WBTC,'wbtc',8),meta,prices,{ANCHOR},self.rates,ANCHOR,WETH)
        self.assertEqual(F(out['normalized_price']),60000)
        self.assertEqual(F(out['slice_usdc_equivalent']),6000)
        self.assertEqual(F(out['remaining_usdc_equivalent']),18000)
    def test_unknown_or_cancelled_state_never_gets_a_plotted_volume(self):
        for changes in [{'state_complete':False},{'registered':False},{'remaining_parts':0}]:self.assertIsNone(self.project(self.row(**changes)))
        self.assertIsNone(self.project(self.row(buy_token=HYPER)))
    def test_new_asset_uses_real_quote_and_does_not_mutate_limit_depth(self):
        original=self.pair(WETH,'eth',18);original['label']='ETH';pairs=[original];row=self.row(sell_token=HYPER,buy_token=ETH,part_sell_atoms=str(10000*10**18),min_buy_atoms=str(10**18));empty=lambda base,family:{'normalized_orders':[],'quote_usdc_equivalent_rates':{},'funding_groups':[]}
        coverage=attach_schedules(pairs,{'schedules':[row],'coverage':{'from_block':1}},self.meta,self.prices,{USDC},self.rates,empty)
        added=next(p for p in pairs if p['id']=='hyper');self.assertEqual(added['default_quote'],ETH);self.assertFalse(added['reference_available']);self.assertTrue(added['twap_only']);self.assertEqual(len(added['twap_schedules']),1);self.assertIn(ETH,added['quote_modes']);self.assertEqual(original['modes']['enriched'],{'quote_usdc_equivalent_rates':{}});self.assertEqual(coverage['plotted_schedule_count'],1)
