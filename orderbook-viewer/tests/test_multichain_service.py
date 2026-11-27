import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from cache import RefreshRequests
from service import Collectors
from tests.test_cache import book


class MultichainService(unittest.TestCase):
    def test_books_and_refresh_requests_are_isolated_per_network(self):
        def build(work,network):
            result=book(1 if network=='mainnet' else 2)
            result['network']=network
            result['chain_id']=1 if network=='mainnet' else 8453
            return result
        with tempfile.TemporaryDirectory() as directory,patch('service.build_snapshot',side_effect=build):
            root=Path(directory);collectors=Collectors(root,enabled=['mainnet','base'])
            self.assertTrue(collectors.caches['mainnet'].refresh())
            self.assertFalse((root/'public/base/orderbook.json').exists())
            self.assertTrue(collectors.caches['base'].refresh())
            for net,chain in [('mainnet',1),('base',8453)]:
                result=json.loads((root/'public'/net/'orderbook.json').read_text())
                self.assertEqual(result['network'],net)
                self.assertEqual(result['chain_id'],chain)
            self.assertEqual(RefreshRequests(root/'base').request()[0],202)
            self.assertTrue((root/'base/refresh-request.json').exists())
            self.assertFalse((root/'mainnet/refresh-request.json').exists())
