import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import twap
from funding import addr,word,blob


def event(owner='0x'+'11'*20,block=3000,log_index=1):
    values=[addr('0x'+'22'*20),addr('0x'+'33'*20),addr('0x'+'00'*20),word(100),word(50),word(1000),word(24),word(3600),word(0),word(0)]
    raw=word(32)+addr(twap.HANDLER)+word(7)+word(96)+blob(b''.join(values))
    return {'address':twap.COMPOSABLE,'topics':[twap.CREATED,'0x'+addr(owner).hex()],'data':'0x'+raw.hex(),'blockNumber':hex(block),'transactionHash':'0x'+'44'*32,'logIndex':hex(log_index)}


class TwapEncoding(unittest.TestCase):
    def test_event_hash_is_exact_tuple_encoding_and_repeated_parent_is_identifiable(self):
        log=event();row=twap.decode_created(log)
        self.assertEqual(row['schedule_hash'],'0x25702c8fe98d818623bd77a8bc1021ae84549d167373f32fbf5c16f9a32e31cf')
        self.assertEqual(row['part_sell_atoms'],'100')
        self.assertEqual(row['min_buy_atoms'],'50')
        self.assertEqual(row['total_parts'],24)
        self.assertEqual(twap.decode_created(event(log_index=2))['id'],row['id'])
    def test_child_uid_preserves_owner_and_big_endian_expiry(self):
        row=twap.decode_created(event());uid=bytes.fromhex(twap.child_uid(row,0x10203040,b'\x55'*32)[2:])
        self.assertEqual(len(uid),56)
        self.assertEqual(uid[32:52],bytes.fromhex(row['owner'][2:]))
        self.assertEqual(uid[52:],bytes.fromhex('10203040'))
        self.assertNotEqual(twap.child_uid(row,0x10203040,b'\x55'*32),twap.child_uid(row,0x10203041,b'\x55'*32))
    def test_registered_malformed_schedule_is_not_executable_flow(self):
        original=event()
        # staticInput starts after the outertuple and its bytes length.
        start=160
        patches=[(2,b'\x01'+b'\0'*31),(0,addr('0x'+'00'*20)),(1,addr('0x'+'22'*20)),(0,addr(twap.NATIVE)),(3,word(0)),(4,word(0)),(5,word(2**32-1)),(6,word(1)),(7,word(365*86400+1)),(8,word(3601))]
        for field,value in patches:
            log=dict(original);raw=bytearray.fromhex(log['data'][2:]);raw[start+32*field:start+32*(field+1)]=value;log['data']='0x'+raw.hex()
            with self.assertRaises(ValueError):twap.decode_created(log)
    def test_other_handler_is_not_misclassified_as_twap(self):
        log=event();raw=bytearray.fromhex(log['data'][2:]);raw[44:64]=b'\x99'*20;log['data']='0x'+raw.hex()
        self.assertIsNone(twap.decode_created(log))


class Response:
    def __init__(self,value):self.raw=json.dumps({'jsonrpc':'2.0','id':1,'result':value}).encode()
    def __enter__(self):return self
    def __exit__(self,*_):pass
    def read(self,*_):return self.raw


class TwapIndex(unittest.TestCase):
    def collect(self,root,head=5000,hash_='0x'+'aa'*32,archive_chain='0x1',archive_hash=None,logs=None,api=None,fail_logs=False):
        seen=[]
        def request(req,timeout):
            data=json.loads(req.data);method=data['method'];params=data['params'];seen.append((method,params))
            if method=='eth_getBlockByNumber':return Response({'hash':archive_hash if 'archive.invalid' in req.full_url and archive_hash else hash_,'timestamp':hex(10000)})
            if method=='eth_chainId':return Response(archive_chain if 'archive.invalid' in req.full_url else '0x1')
            if method=='eth_getLogs':
                if fail_logs:raise RuntimeError('event_range_unavailable')
                return Response(logs or [])
            if method=='eth_call':return Response('0x')
            raise AssertionError(method)
        class Opener:
            open=staticmethod(request)
        with patch.object(twap,'fetch_candidates',return_value=api or {'records':[],'status':'unavailable'},side_effect=api if isinstance(api,Exception) else None),patch.object(twap,'endpoint',return_value='http://unused.invalid'),patch.object(twap.urllib.request,'build_opener',return_value=Opener()),patch.object(twap,'decode',side_effect=lambda _,n:[(True,b'\x55'*32)]*n):
            result=twap.collect_twap_schedules({},head,hash_,root/'work',root/'cache')
        return result,seen
    def test_event_source_failure_keeps_active_recent_parents(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            first,_=self.collect(root,logs=[event(block=4999)])
            self.assertEqual(first['coverage']['indexed_parents'],1)
            second,_=self.collect(root,head=5010,fail_logs=True)
            self.assertEqual(second['coverage']['indexed_parents'],1)
            self.assertTrue(second['coverage']['gaps'])

    def test_bootstrap_and_long_downtime_never_backfill_production_node(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);first,seen=self.collect(root)
            log=next(p[0] for m,p in seen if m=='eth_getLogs')
            self.assertEqual(int(log['toBlock'],16)-int(log['fromBlock'],16),2048)
            self.assertFalse(first['coverage']['complete_census'])
            second,seen=self.collect(root,head=10000)
            log=next(p[0] for m,p in seen if m=='eth_getLogs')
            self.assertEqual(int(log['toBlock'],16)-int(log['fromBlock'],16),2048)
            self.assertTrue(second['coverage']['gaps'])
    def test_changed_index_anchor_resets_coverage_instead_of_retaining_orphans(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.collect(root)
            second,_=self.collect(root,head=5010,hash_='0x'+'bb'*32)
            self.assertEqual(second['coverage']['from_block'],5010-2048)
    def test_archive_gap_source_must_match_chain_and_canonical_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.collect(root)
            with patch.dict(twap.os.environ,{'TWAP_LOG_RPC':'http://archive.invalid'}):
                wrong_chain,_=self.collect(root,head=10000,archive_chain='0x64')
                wrong_hash,_=self.collect(root,head=10000,archive_hash='0x'+'bb'*32)
            self.assertEqual(wrong_chain['coverage']['status'],'unavailable')
            self.assertEqual(wrong_hash['coverage']['status'],'unavailable')
            stored=json.loads((root/'cache/twap-index/index.json').read_text())
            self.assertEqual(stored['through_block'],5000)
    def test_bad_registered_event_cannot_poison_other_schedules(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);bad=event(log_index=2);bad['data']='0x'
            result,_=self.collect(root,logs=[bad,event()])
            self.assertEqual(result['coverage']['status'],'available')
            self.assertEqual(result['coverage']['invalid_event_count'],1)
            self.assertEqual(result['coverage']['indexed_parents'],1)
    def test_uint32_child_limit_bounds_remaining_horizon(self):
        raw={'part_sell_atoms':'100','min_buy_atoms':'50','total_parts':10,'interval_seconds':60,'span_seconds':0,'start_time':twap.MAX_VALID_TO-100}
        result=twap.schedule_state(raw,twap.MAX_VALID_TO-101)
        self.assertEqual(result['remaining_parts'],1)
        self.assertEqual(result['end_time'],twap.MAX_VALID_TO-40)
    def test_rpc_failure_has_explicit_unknown_coverage_not_empty_known_market(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(twap,'endpoint',side_effect=RuntimeError('not configured')):
                result=twap.collect_twap_schedules({},5,'0x'+'aa'*32,Path(directory)/'work')
            self.assertEqual(result['coverage']['status'],'unavailable')
            self.assertEqual(result['schedules'],[])

if __name__=='__main__':unittest.main()
