import json
from pathlib import Path
import tempfile
import unittest
import twap
from funding import word
from tests.test_twap_backend import event
from tests import test_twap_backend as backend


def candidate(*,zero_start=False):
    log=event()
    if zero_start:
        raw=bytearray.fromhex(log['data'][2:]);raw[160+5*32:160+6*32]=word(0);log['data']='0x'+raw.hex()
    row=twap.decode_created(log)
    return {'chainId':1,'owner':row['owner'],'handler':twap.HANDLER,'hash':row['schedule_hash'],
            'salt':'0x'+word(7).hex(),'staticInput':'0x'+bytes.fromhex(log['data'][2:])[160:].hex(),
            'txHash':row['creation_tx'],'decodedParams':{'t0':123456}},log


class ApiImport(unittest.TestCase):
    def test_raw_static_input_controls_hash_and_preserves_unresolved_start(self):
        record,_=candidate(zero_start=True);row=twap.decode_api_parent(record)
        self.assertEqual(row['start_time'],0)
        self.assertEqual(row['schedule_hash'],record['hash'])
        self.assertIsNone(row['creation_block'])
        self.assertIsNone(row['event_index'])
        record['hash']='0x'+'aa'*32
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):twap.decode_api_parent(record)

    def test_event_metadata_wins_and_duplicate_parent_is_counted_once(self):
        record,log=candidate();rows,invalid_events,invalid_api=twap.merge_candidates([], [log], [record,record])
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['creation_block'],3000)
        self.assertEqual((invalid_events,invalid_api),(0,0))
        rows,_,_=twap.merge_candidates(rows,[],[record])
        self.assertEqual(rows[0]['creation_block'],3000)

    def test_wrong_chain_hash_and_handler_cannot_inject_schedule(self):
        record,_=candidate()
        for key,value in [('chainId',True),('chainId',100),('hash','0x'+'aa'*32),('owner','0x'+'00'*20)]:
            with self.subTest(key=key,value=value):
                rows,_,invalid=twap.merge_candidates([],[],[{**record,key:value}])
                self.assertEqual(rows,[]);self.assertEqual(invalid,1)
        rows,_,_=twap.merge_candidates([],[],[{**record,'handler':'0x'+'99'*20}])
        self.assertEqual(rows,[])

    def test_older_parent_survives_tail_and_unavailable_api(self):
        record,_=candidate();helper=backend.TwapIndex()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            first,_=helper.collect(root,api={'records':[record],'status':'available','total_count':1,'observed_at':1234})
            self.assertEqual(first['coverage']['indexed_parents'],1)
            self.assertEqual(first['coverage']['api_total_count'],1)
            self.assertEqual(len(first['schedules']),1)
            second,_=helper.collect(root,head=5100)
            self.assertEqual(second['coverage']['api_status'],'unavailable')
            self.assertEqual(second['coverage']['indexed_parents'],1)
            self.assertEqual(len(second['schedules']),1)
            stored=json.loads((root/'cache/twap-index/index.json').read_text())
            self.assertIsNone(stored['records'][0]['creation_block'])

    def test_optional_api_filesystem_failure_does_not_disable_recent_events(self):
        helper=backend.TwapIndex()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            result,_=helper.collect(root,logs=[event()],api=OSError('cache unavailable'))
            self.assertEqual(result['coverage']['api_status'],'unavailable')
            self.assertEqual(result['coverage']['api_reason'],'optional_source_failed')
            self.assertEqual(len(result['schedules']),1)
        record,_=candidate();record['txHash']=None
        self.assertIsNone(twap.decode_api_parent(record)['creation_tx'])

if __name__=='__main__':unittest.main()
