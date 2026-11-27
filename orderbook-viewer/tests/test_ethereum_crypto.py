import json
import os
from unittest.mock import patch
import unittest
from ethereum_crypto import function_selector,keccak256
import funding
import source


class EthereumCryptoTests(unittest.TestCase):
    def test_ethereum_keccak_and_function_selectors(self):
        self.assertEqual(keccak256(b'').hex(),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
        self.assertEqual(function_selector('transfer(address,uint256)').hex(),'a9059cbb')
        self.assertEqual(funding.selector('balanceOf(address)').hex(),'70a08231')

    def test_source_binds_declared_class_to_exact_signed_app_data(self):
        app=json.dumps({'metadata':{'orderClass':{'orderClass':'limit'}}})
        order={'uid':'uid','sellToken':'base','buyToken':'stable','sellAmount':'1','buyAmount':'2','kind':'sell','partiallyFillable':True,'validTo':1,'feeAmount':'0','sellTokenBalance':'erc20','buyTokenBalance':'erc20','fullAppData':app,'appData':'0x'+keccak256(app.encode()).hex(),'owner':'owner'}
        self.assertTrue(source.project(order,{})['strict_limit_order'])
        order['fullAppData']=app+' '
        self.assertFalse(source.project(order,{})['strict_limit_order'])

    def test_rpc_settings_are_explicit_environment_only(self):
        with patch.dict(os.environ,{},clear=True):
            with self.assertRaisesRegex(RuntimeError,'configured_rpc_unavailable'):funding.endpoint()
        with patch.dict(os.environ,{'RPC_ETH':'configured','RPC_ETH_ARCHIVE':'archive'}):
            self.assertEqual(funding.endpoint(),'configured')
            self.assertEqual(funding.endpoint('RPC_ETH_ARCHIVE'),'archive')
            with self.assertRaises(ValueError):funding.endpoint('OTHER_SETTING')
