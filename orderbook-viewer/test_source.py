import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import source

class SourceTest(unittest.TestCase):
    def order(self):
        raw='{"metadata":{"orderClass":{"orderClass":"limit"}}}'
        return {'uid':'uid','sellToken':'base','buyToken':'stable','sellAmount':'1','buyAmount':'2','kind':'sell','partiallyFillable':True,'validTo':1,'feeAmount':'0','sellTokenBalance':'erc20','buyTokenBalance':'erc20','fullAppData':raw,'appData':'0x'+'a'*64,'owner':'owner','interactions':{'pre':[{'target':'target','callData':'0x12345678cafebabe'}]}}
    def test_binding_and_projection(self):
        order=self.order()
        digest=source.hashlib.sha256(order['fullAppData'].encode()).hexdigest()
        result=source.project(order,{digest:order['appData']})
        self.assertTrue(result['strict_limit_order'])
        self.assertNotIn('fullAppData',result)
        self.assertNotIn('callData',result['interactions']['pre'][0])
        self.assertEqual(result['pre_interaction_count'],1)
        order['appData']='0x'+'b'*64
        self.assertFalse(source.project(order,{digest:'0x'+'a'*64})['strict_limit_order'])
    def test_cohort(self):
        self.assertTrue(source.member(self.order(),{'base'},{'stable'}))
        self.assertFalse(source.member(self.order(),{'other'},{'stable'}))
        self.assertFalse(source.member({'sellToken':'stable','buyToken':'stable'},{'stable'},{'stable'}))
    def test_duplicate_and_missing_coverage_fail(self):
        competition={'auctionId':1,'auctionStartBlock':1,'auctionDeadlineBlock':2,'auction':{'orders':['uid','uid2']}}
        with tempfile.TemporaryDirectory() as directory, patch.object(source.cowapi,'get_json',return_value=competition), patch.object(source,'configuration',return_value=({'base'},{'stable'},{})), patch.object(source,'lookup',return_value=json.dumps([{'error':{'uid':'uid'}},{'error':{'uid':'uid'}}]).encode()):
            with self.assertRaisesRegex(ValueError,'UID coverage mismatch'):
                source.collect(Path(directory)/'run')
    def test_unresolved_uid_prevents_publication(self):
        competition={'auctionId':1,'auctionStartBlock':1,'auctionDeadlineBlock':2,'auction':{'orders':['uid']}}
        with tempfile.TemporaryDirectory() as directory, patch.object(source.cowapi,'get_json',return_value=competition), patch.object(source,'configuration',return_value=(set(),set(),{})), patch.object(source,'lookup',return_value=b'[{"error":{"uid":"uid"}}]'):
            target=Path(directory)/'run'
            with self.assertRaisesRegex(RuntimeError,'incomplete_resolved'):
                source.collect(target)
            self.assertFalse((target/'sanitized-orders.json').exists())

if __name__=='__main__':unittest.main()
