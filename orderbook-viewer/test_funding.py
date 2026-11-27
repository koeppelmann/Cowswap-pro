import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import funding

class FundingTests(unittest.TestCase):
    def test_remaining_uses_kind_and_invalidation(self):
        order={'sellAmount':'100','buyAmount':'200','kind':'buy'}
        self.assertEqual(funding.remaining(order,50),('75','150'))
        self.assertEqual(funding.remaining(order,2**256-1),('0','0'))

    def test_canonical_pin_and_hooks_stay_conditional(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';(source/'raw').mkdir(parents=True)
            owner='0x'+'11'*20;uid='0x'+'22'*32+owner[2:]+'00000000';token=funding.WETH
            order={'uid':uid,'owner':owner,'sellToken':token,'buyToken':funding.NATIVE,'sellAmount':'100','buyAmount':'90','kind':'sell','partiallyFillable':True,'validTo':1000,'strict_limit_order':True,'pre_interaction_count':1,'post_interaction_count':0}
            (source/'sanitized-orders.json').write_text(json.dumps({'orders':[order]}))
            (source/'competition.private.json').write_text(json.dumps({'auctionStartBlock':100,'auctionId':4,'auction':{'prices':{token:'1'}}}))
            (source/'raw/batch-0.private.json').write_text(json.dumps([{'order':{'data':order,'metadata':{'uid':uid,'owner':owner,'interactions':{'pre':[{'callData':'private'}]}}}}]))
            state=[];block_hash='0x'+'33'*32
            def rpc(url,method,params,evidence):
                if method=='eth_getBlockByNumber':return {'number':'0x64','hash':block_hash,'timestamp':'0x64'}
                if method=='eth_chainId':return '0x1'
                state.append(params);return '0x'
            values=[(True,bytes.fromhex(funding.RELAYER[2:]).rjust(32,b'\0'))]+[(True,funding.word(v))for v in (0,100,100,18)]+[(True,b'WETH'.ljust(32,b'\0'))]
            with patch.object(funding,'endpoint',return_value='private'),patch.object(funding,'rpc',side_effect=rpc),patch.object(funding,'selector',return_value=b'1234'),patch.object(funding,'decode',return_value=values):
                result,conversions=funding.read_funding(source,root/'out')
            self.assertEqual(state[0][1],{'blockHash':block_hash,'requireCanonical':True})
            self.assertEqual(result['orders'][0]['funding_condition'],'pre_interaction')
            self.assertEqual(result['groups'][0]['allowance_atoms'],'100')
            self.assertEqual(conversions['tokens'][token]['eth_per_token'],{'numerator':'1','denominator':'1'})

if __name__=='__main__':unittest.main()
