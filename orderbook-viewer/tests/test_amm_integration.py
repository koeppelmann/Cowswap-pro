import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from allocator import WETH,USDC

class AmmIntegration(unittest.TestCase):
    def test_markers_share_funding_block_and_failure_preserves_book(self):
        import build
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();funding=root/'funding';funding.mkdir()
            def write(path,obj):path.write_text(json.dumps(obj))
            header={'auction_id':1,'reference_state':{'block_number':123,'timestamp':int(time.time())},'block_hash':'0x'+'a'*64,'getter_errors':[],'metadata':{},'groups':[],'orders':[]}
            write(source/'sanitized-orders.json',{'orders':[]})
            header['source_orders_sha256']=hashlib.sha256((source/'sanitized-orders.json').read_bytes()).hexdigest()
            write(source/'competition.private.json',{'auctionId':1,'auction':{'prices':{USDC:'1000000000000000000',WETH:'2000000000'}}})
            write(funding/'funding-state.json',header);write(funding/'eth-conversions.json',{'block_hash':header['block_hash'],'tokens':{}})
            template={'metadata':{WETH:{'symbol':'WETH','decimals':18},USDC:{'symbol':'USDC','decimals':6}},'pairs':[{'id':'eth','label':'ETH','base_symbol':'ETH-equivalent','base_token':WETH,'base_decimals':18,'conversions':[{'token':WETH}]}]}
            write(root/'template.json',template)
            marker={'status':'available','pool':'0x'+'b'*40,'block':123,'block_hash':header['block_hash']}
            with patch.object(build,'BASE',root/'template.json'),patch.object(build,'collect_markers',return_value={'eth':marker}) as collect:
                book=build.build_snapshot(root,source_dir=source,funding_dir=funding)
                self.assertEqual(book['pairs'][0]['amm_marker'],marker)
                self.assertEqual(collect.call_args.args[3:5],(123,header['block_hash']))
            with patch.object(build,'BASE',root/'template.json'),patch.object(build,'collect_markers',side_effect=RuntimeError('offline')):
                book=build.build_snapshot(root,source_dir=source,funding_dir=funding)
                self.assertEqual(book['pairs'][0]['amm_marker']['status'],'unavailable')
                self.assertEqual(book['block'],123)
                self.assertEqual(book['auction_id'],1)
