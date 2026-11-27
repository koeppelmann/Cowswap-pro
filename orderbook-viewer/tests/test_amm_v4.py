from fractions import Fraction
import unittest
from amm import v4_key,v4_state,STATE_VIEW,abi_array
from funding import selector,word


class V4Markers(unittest.TestCase):
    def candidate(self):
        return {'address':'0x9f2d9491277a9f2551c1f7533c1789aa6023bba0c5e9397e8a019cac5c10fe7f','tokens':['0x98a878b1cd98131b271883b390f68d2c90674665','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],'hooks':'0x'+'00'*20,'fee':500,'tick_spacing':10}
    def answers(self,c,protocol=0,liquidity=100):
        pool=bytes.fromhex(c['address'][2:])
        return {(STATE_VIEW,selector('getSlot0(bytes32)')+pool):(True,word(2**96)+word(0)+word(protocol)+word(500)),(STATE_VIEW,selector('getLiquidity(bytes32)')+pool):(True,word(liquidity))}
    def test_known_pool_key_and_forged_token_or_hook(self):
        c=self.candidate();self.assertEqual(v4_key(c),c['tokens'])
        for change in [{'fee':3000},{'tick_spacing':1},{'hooks':'0x'+'11'*20},{'tokens':list(reversed(c['tokens']))}]:
            with self.subTest(change=change),self.assertRaises(ValueError):v4_key({**c,**change})
    def test_directional_protocol_fees_use_contract_integer_composition(self):
        c=self.candidate();sqrt,liquidity,fees=v4_state(c,self.answers(c,1000+(200<<12)))
        self.assertEqual((sqrt,liquidity),(2**96,100))
        self.assertEqual(fees,[Fraction(1500,10**6),Fraction(700,10**6)])
    def test_empty_pool_bad_protocol_fee_and_failed_getter_are_not_prices(self):
        c=self.candidate()
        for answers in [self.answers(c,liquidity=0),self.answers(c,protocol=1001),{}]:
            with self.assertRaises(ValueError):v4_state(c,answers)
    def test_bounded_dynamic_array(self):
        self.assertEqual(abi_array(word(32)+word(2)+word(3)+word(7),0),[3,7])
        for raw in [word(4096),word(32)+word(9),word(33)+word(1)+word(1)]:
            with self.assertRaises(ValueError):abi_array(raw,0)
