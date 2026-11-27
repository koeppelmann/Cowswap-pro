import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import twap_api as api


def row(event='1'):
    return dict(eventId=event,chainId=1,hash='0x'+'01'*32,owner='0x'+'02'*20,handler='0x'+'03'*20,salt='0x'+'00'*32,staticInput='0x00000000',txHash='0x'+'04'*32,creationDate='1700000000',decodedParams={'t0':'incorrect'})


class Candidates(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
    def fetch(self,pages):
        with patch.object(api,'_request_page',side_effect=pages),patch.object(api.time,'sleep'):
            return api.fetch_candidates(self.root)
    def test_raw_params_and_cache(self):
        result=self.fetch([{'items':[row()],'totalCount':1}])
        self.assertEqual(result['status'],'available');self.assertTrue(result['complete_query'])
        self.assertEqual(result['records'][0]['staticInput'],'0x00000000')
        self.assertNotIn('decodedParams',result['records'][0])
        with patch.object(api,'_request_page',side_effect=AssertionError('network')):
            self.assertEqual(api.fetch_candidates(self.root)['records'],result['records'])
    def test_pagination(self):
        with patch.object(api,'PAGE_SIZE',1):
            result=self.fetch([{'items':[row('a')],'totalCount':2},{'items':[row('b')],'totalCount':2}])
        self.assertEqual(result['fetched_count'],2);self.assertTrue(result['complete_query'])
    def test_duplicate_event(self):
        with patch.object(api,'PAGE_SIZE',1):
            result=self.fetch([{'items':[row()],'totalCount':2},{'items':[row()],'totalCount':2}])
        self.assertEqual(result['status'],'partial');self.assertEqual(result['reason'],'query_duplicate_event')
    def test_invalid_chain(self):
        invalid=row();invalid['chainId']=True
        result=self.fetch([{'items':[invalid],'totalCount':1}])
        self.assertEqual(result['status'],'partial');self.assertEqual(result['invalid_records'],1)
        self.assertFalse(result['complete_query'])
    def test_population_mismatch(self):
        result=self.fetch([{'items':[row()],'totalCount':0}])
        self.assertEqual(result['reason'],'query_population_changed');self.assertFalse(result['complete_query'])
    def test_partial_failure(self):
        with patch.object(api,'PAGE_SIZE',1):
            result=self.fetch([{'items':[row()],'totalCount':2},api.QueryFailure('query_transport_failed')])
        self.assertEqual(result['status'],'partial');self.assertEqual(result['fetched_count'],1)
    def test_stale_fallback(self):
        self.fetch([{'items':[row()],'totalCount':1}])
        file=self.root/'twap-api/candidates.json';cache=json.loads(file.read_text());cache['observed_at']=0;file.write_text(json.dumps(cache))
        result=self.fetch([api.QueryFailure('query_transport_failed')])
        self.assertEqual(result['status'],'stale');self.assertFalse(result['complete_query'])
    def test_cooldowns(self):
        for status in (403,429,503):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as root:
                with patch.object(api,'_request_page',side_effect=api.QueryFailure('query_HTTP_'+str(status),3600)):
                    result=api.fetch_candidates(root)
                state=json.loads((Path(root)/'twap-api/pacing.json').read_text())
                self.assertGreater(state['cooldown_until'],time.time()+3500)
                with patch.object(api,'_request_page',side_effect=AssertionError('network')):
                    self.assertEqual(api.fetch_candidates(root)['reason'],'query_cooldown')
    def test_deadline(self):
        with patch.object(api,'_request_page',side_effect=AssertionError('network')):
            self.assertEqual(api.fetch_candidates(self.root,deadline=time.monotonic()-1)['reason'],'query_deadline')
    def test_lock(self):
        import fcntl
        directory=self.root/'twap-api';directory.mkdir()
        with (directory/'fetch.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(api.fetch_candidates(self.root)['reason'],'query_refresh_in_progress')
    def test_malformed_response(self):
        for data in (None,[],{'programmaticOrders':None}):
            response=io.BytesIO(json.dumps({'data':data}).encode())
            with patch.object(api.urllib.request,'urlopen',return_value=response):
                with self.assertRaisesRegex(api.QueryFailure,'query_invalid_page'):api._request_page(0,time.monotonic()+10)
    def test_http_body_not_exposed(self):
        error=urllib.error.HTTPError(api.SOURCE,403,'private error',{'Retry-After':'3600'},io.BytesIO(b'sensitive body'))
        with patch.object(api.urllib.request,'urlopen',side_effect=error):
            with self.assertRaises(api.QueryFailure) as raised:api._request_page(0,time.monotonic()+10)
        self.assertEqual(str(raised.exception),'query_HTTP_403');self.assertEqual(raised.exception.retry_after,3600)
    def test_corrupt_pacing_shape(self):
        directory=self.root/'twap-api';directory.mkdir();(directory/'pacing.json').write_text('[]')
        self.assertEqual(self.fetch([{'items':[],'totalCount':0}])['status'],'available')

if __name__=='__main__':unittest.main()
