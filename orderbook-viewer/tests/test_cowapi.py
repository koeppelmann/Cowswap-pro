import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import cowapi


class Clock:
    def __init__(self):self.now=1000
    def sleep(self,duration):self.now+=duration


class CowClientTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.env=patch.dict(os.environ,{'COW_API_CACHE':self.directory.name});self.env.start();self.addCleanup(self.env.stop)
        self.clock=Clock()
        for name,value in [('time',lambda:self.clock.now),('monotonic',lambda:self.clock.now),('sleep',self.clock.sleep)]:
            mocked=patch.object(cowapi.time,name,value);mocked.start();self.addCleanup(mocked.stop)

    def test_pacing_persists_across_independent_client_calls(self):
        cowapi.acquire(deadline=1010)
        cowapi.acquire(deadline=1010)
        self.assertEqual(self.clock.now,1001)
        state=json.loads((Path(self.directory.name)/'limiter.json').read_text())
        self.assertEqual(state['next_request'],1002)

    def test_deadline_does_not_wait_for_pacing(self):
        cowapi.acquire(deadline=1001)
        with self.assertRaises(cowapi.DeadlineExceeded):cowapi.acquire(deadline=1000.5)
        self.assertEqual(self.clock.now,1000)

    def test_server_retry_after_is_not_capped_by_local_backoff(self):
        cowapi.cooldown({'Retry-After':'600'})
        with self.assertRaises(cowapi.Throttled) as error:cowapi.acquire(deadline=2000)
        self.assertEqual(error.exception.retry_after,600)
        self.assertEqual(self.clock.now,1000)

    def test_http_date_retry_after_and_exponential_cooldown(self):
        cowapi.cooldown({'Retry-After':'Thu, 01 Jan 1970 00:20:00 GMT'})
        state=json.loads((Path(self.directory.name)/'limiter.json').read_text())
        self.assertEqual(state['cooldown_until'],1200)
        self.assertEqual(state['backoff_seconds'],60)
        cowapi.cooldown({})
        state=json.loads((Path(self.directory.name)/'limiter.json').read_text())
        self.assertEqual(state['backoff_seconds'],120)
        self.assertEqual(state['cooldown_until'],1200)

    def test_http_error_does_not_expose_response_body(self):
        error=urllib.error.HTTPError('https://api.cow.fi/example',429,'private diagnostic',{'Retry-After':'90'},io.BytesIO(b'not-for-logs'))
        with patch.object(cowapi.urllib.request,'urlopen',side_effect=error):
            with self.assertRaisesRegex(RuntimeError,'^cow_api_HTTP_429$'):cowapi.get_json('https://api.cow.fi/example',deadline=1010)
        with self.assertRaises(cowapi.Throttled) as cooldown:cowapi.acquire(deadline=1010)
        self.assertEqual(cooldown.exception.retry_after,90)

    def test_cached_reads_are_bounded_by_age_and_refresh_bypasses_cache(self):
        response=io.BytesIO(b'{"auctionId":1}')
        with patch.object(cowapi.urllib.request,'urlopen',return_value=response) as fetch:
            self.assertEqual(cowapi.get_json('https://api.cow.fi/example',deadline=1010),{'auctionId':1})
            self.assertEqual(cowapi.get_json('https://api.cow.fi/example',deadline=1010),{'auctionId':1})
            self.assertEqual(fetch.call_count,1)
        with patch.object(cowapi.urllib.request,'urlopen',return_value=io.BytesIO(b'{"auctionId":2}')) as fetch:
            self.assertEqual(cowapi.get_json('https://api.cow.fi/example',refresh=True,deadline=1010),{'auctionId':2})
            self.assertEqual(fetch.call_count,1)

    def test_rejects_unexpected_api_hosts_without_network_access(self):
        with patch.object(cowapi.urllib.request,'urlopen') as fetch:
            for url in ['http://api.cow.fi/example','https://elsewhere.example/example','https://api.cow.fi@elsewhere.example/example']:
                with self.assertRaises(ValueError):cowapi.get_json(url)
            fetch.assert_not_called()
