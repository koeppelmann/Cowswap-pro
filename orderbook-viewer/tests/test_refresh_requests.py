"""Reload requests are same-origin, shared, paced and wake the snapshot worker."""
import fcntl
from functools import partial
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from cache import RefreshRequests,SnapshotCache
from http_server import ReportHandler
from tests.test_cache import book


class RefreshAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def test_requests_coalesce_and_cooldown_survives_new_handler(self):
        queue=RefreshRequests(self.root)
        self.assertEqual(queue.request(),(202,{'status':'queued'}))
        self.assertEqual(RefreshRequests(self.root).request(),(202,{'status':'queued'}))
        self.assertTrue(queue.consume())
        status,body=RefreshRequests(self.root).request()
        self.assertEqual(status,429);self.assertGreater(body['retry_after'],0)
        self.assertFalse(queue.consume())

    def test_active_refresh_coalesces_without_another_queued_run(self):
        with (self.root/'refresh.lock').open('a') as active:
            fcntl.flock(active,fcntl.LOCK_EX)
            self.assertEqual(RefreshRequests(self.root).request(),(202,{'status':'refreshing'}))
            self.assertFalse((self.root/'refresh-request.json').exists())

    def test_worker_picks_up_reload_instead_of_waiting_five_minutes(self):
        calls=[];second=threading.Event()
        def build(work):
            calls.append(1)
            if len(calls)==2:second.set()
            return book(len(calls))
        cache=SnapshotCache(build,root=self.root,refresh_seconds=300)
        cache.start();self.addCleanup(cache.stop)
        deadline=time.monotonic()+3
        while (not cache.snapshot() or cache.status()['refreshing']) and time.monotonic()<deadline:time.sleep(.01)
        self.assertIsNotNone(cache.snapshot())
        self.assertEqual(cache.requests.request()[0],202)
        self.assertTrue(second.wait(2),'reload was not picked up promptly')
        cache.stop();self.assertEqual(len(calls),2)

    def test_http_keeps_static_reports_and_rejects_cross_origin_and_large_body(self):
        (self.root/'index.html').write_text('static report')
        class QuietHandler(ReportHandler):
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(self.root),refresh_root=self.root/'cache'))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),worker.join(2)))
        base='http://127.0.0.1:'+str(server.server_port)
        with urllib.request.urlopen(base+'/') as response:self.assertEqual(response.read(),b'static report')
        def post(origin,data=b''):
            request=urllib.request.Request(base+'/dfusion-limit-depth-live/refresh',data=data,headers={'Origin':origin},method='POST')
            try:return urllib.request.urlopen(request)
            except urllib.error.HTTPError as error:return error
        with post('https://elsewhere.invalid') as response:self.assertEqual(response.status,403)
        with post(base,b'x'*257) as response:self.assertEqual(response.status,413)
        with post(base) as response:
            self.assertEqual(response.status,202);self.assertEqual(json.load(response)['status'],'queued')
        RefreshRequests(self.root/'cache').consume()
        with post(base) as response:
            self.assertEqual(response.status,429);self.assertIsNotNone(response.headers.get('Retry-After'))


if __name__=='__main__':unittest.main()
