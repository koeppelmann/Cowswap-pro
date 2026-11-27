"""Acceptance tests: complete snapshots publish atomically and survive refresh failure."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))


def book(auction_id=1):
    block_hash = '0x' + 'a' * 64
    return {
        'auction_id': auction_id, 'block': 100, 'block_hash': block_hash,
        'as_of_timestamp': 1795687200, 'metadata': {'source': 'acceptance-fixture'},
        'snapshot_evidence': {
            'auction_id': auction_id, 'block': 100, 'block_hash': block_hash,
            'source_sha256': '1' * 64, 'funding_sha256': '2' * 64,
            'conversions_sha256': '3' * 64,
        },
        'pairs': [{'id': 'test', 'token': 'TEST', 'symbol': 'TEST', 'modes': {'enriched': {'block_hash': block_hash, 'normalized_orders': [], 'funding_groups': []}}}],
    }


class CacheAcceptance(unittest.TestCase):
    def setUp(self):
        from cache import SnapshotCache
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cls = SnapshotCache

    def cache(self, builder, **kwargs):
        cache = self.cls(builder, root=self.root, **kwargs)
        self.addCleanup(cache.stop)
        return cache

    def test_failure_keeps_last_good_snapshot_and_public_file(self):
        calls = 0
        def build(workdir):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('source unavailable')
            return book()
        cache = self.cache(build)
        self.assertTrue(cache.refresh())
        first = cache.snapshot()
        public = self.root / 'public' / 'orderbook.json'
        before = public.read_bytes()
        self.assertFalse(cache.refresh())
        self.assertEqual(first, cache.snapshot())
        self.assertEqual(before, public.read_bytes())
        self.assertTrue(cache.status()['stale'])
        self.assertTrue(cache.status()['last_error'])
        self.assertFalse(cache.status()['refreshing'])

    def test_concurrent_refresh_keeps_old_snapshot_visible(self):
        entered, release = threading.Event(), threading.Event()
        calls = 0
        def build(workdir):
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
                if not release.wait(3):
                    raise RuntimeError('test release timeout')
            return book(calls)
        cache = self.cache(build)
        self.assertTrue(cache.refresh())
        worker = threading.Thread(target=cache.refresh)
        worker.start()
        self.addCleanup(lambda: (release.set(), worker.join(3)))
        self.assertTrue(entered.wait(2))
        self.assertEqual(cache.snapshot()['auction_id'], 1)
        self.assertTrue(cache.status()['refreshing'])
        self.assertFalse(cache.refresh())
        self.assertEqual(calls, 2)
        self.assertEqual(json.loads((self.root/'public'/'orderbook.json').read_text())['auction_id'], 1)
        release.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(cache.snapshot()['auction_id'], 2)
        self.assertFalse(cache.status()['refreshing'])

    def test_invalid_evidence_never_replaces_last_good(self):
        current = book()
        cache = self.cache(lambda workdir: copy.deepcopy(current))
        self.assertTrue(cache.refresh())
        for mutate in (
            lambda x: x['snapshot_evidence'].__setitem__('block', 101),
            lambda x: x['snapshot_evidence'].pop('conversions_sha256'),
            lambda x: x.__setitem__('pairs', []),
            lambda x: x.__setitem__('auction_id', 0),
        ):
            current = book(2)
            mutate(current)
            with self.subTest(snapshot=current):
                self.assertFalse(cache.refresh())
                self.assertEqual(cache.snapshot()['auction_id'], 1)

    def test_cross_block_mode_and_overspent_funding_are_rejected(self):
        current = book()
        cache = self.cache(lambda workdir: copy.deepcopy(current))
        self.assertTrue(cache.refresh())
        current = book(2)
        current['pairs'][0]['modes']['enriched']['block_hash'] = '0x' + 'b' * 64
        self.assertFalse(cache.refresh())
        current = book(2)
        mode = current['pairs'][0]['modes']['enriched']
        mode['normalized_orders'] = [{
            'uid': 'order-1', 'owner': '0xowner', 'side': 'ask',
            'base_token': '0xtoken', 'quote_token': '0xquote',
            'allocated_sell_atoms': '11', 'funding_status': 'funded',
        }]
        mode['funding_groups'] = [{'owner': '0xowner', 'sell_token': '0xtoken', 'capacity_atoms': '10'}]
        self.assertFalse(cache.refresh())
        self.assertEqual(cache.snapshot()['auction_id'], 1)

    def test_timer_refreshes_without_browser_requests_and_stops(self):
        refreshed = threading.Event()
        calls = 0
        def build(workdir):
            nonlocal calls
            calls += 1
            if calls >= 2:
                refreshed.set()
            return book(calls)
        cache = self.cache(build, refresh_seconds=0.05)
        cache.start()
        self.assertTrue(refreshed.wait(2), 'timer must refresh without HTTP requests')
        cache.stop()
        count = calls
        self.assertFalse(cache.status()['refreshing'])
        threading.Event().wait(0.15)
        self.assertEqual(calls, count)


if __name__ == '__main__':
    unittest.main()
