import io
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from http_server import ReportHandler
from run import main, prepare_site, stop_children


class QuietHandler(ReportHandler):
    def log_message(self, *_):
        pass


class BootstrapTests(unittest.TestCase):
    def test_only_public_cache_is_reachable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = prepare_site(root)
            (root / 'public' / 'index.html').write_text('public viewer')
            (root / 'private.json').write_text('private source response')
            handler = partial(QuietHandler, directory=str(site), refresh_root=root)
            with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    base = f'http://127.0.0.1:{server.server_port}'
                    with urllib.request.urlopen(base + '/pro/') as response:
                        self.assertEqual(response.read(), b'public viewer')
                    for path in ['/private.json', '/pro/../private.json']:
                        with self.assertRaises(urllib.error.HTTPError) as error:
                            urllib.request.urlopen(base + path)
                        self.assertEqual(error.exception.code, 404)
                        error.exception.close()
                finally:
                    server.shutdown()
                    thread.join(2)

    def test_does_not_overwrite_an_existing_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'site' / 'pro').mkdir(parents=True)
            with self.assertRaises(ValueError):
                prepare_site(root)

    def test_refuses_a_public_cache_symlink_to_another_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / 'external'
            external.mkdir()
            cache = root / 'cache'
            cache.mkdir()
            (cache / 'public').symlink_to(external, target_is_directory=True)
            with self.assertRaises(ValueError):
                prepare_site(cache)

    def test_missing_rpc_fails_before_starting_children(self):
        with patch.dict('os.environ', {}, clear=True), patch.object(sys, 'argv', ['run.py']), \
                patch('subprocess.Popen') as spawn, patch('sys.stderr', io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                main()
            self.assertEqual(error.exception.code, 2)
            spawn.assert_not_called()

    def test_shutdown_kills_only_a_child_that_exceeds_its_grace_period(self):
        class Child:
            def __init__(self, timeout):
                self.timeout = timeout
                self.terminated = self.killed = False

            def poll(self):
                return None

            def terminate(self):
                self.terminated = True

            def wait(self, timeout=None):
                if self.timeout and timeout is not None:
                    raise subprocess.TimeoutExpired('fixture', timeout)
                return 0

            def kill(self):
                self.killed = True

        responsive, stuck = Child(False), Child(True)
        stop_children([responsive, stuck])
        self.assertTrue(responsive.terminated and stuck.terminated)
        self.assertFalse(responsive.killed)
        self.assertTrue(stuck.killed)


class ColdStartAssets(unittest.TestCase):
    def test_assets_exist_before_any_collection_starts(self):
        import service
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(service,'build_snapshot',side_effect=AssertionError('must not collect during preparation')):
                cache=service.prepare_cache(Path(directory))
            self.assertTrue((cache.public/'index.html').is_file())
            html=(cache.public/'index.html').read_text()
            self.assertIn('CoW Swap',html)
            self.assertIn('href="/pro/"',html)
            self.assertNotIn('dfusion',html.lower())
            self.assertTrue(list(cache.public.glob('depth.*.js')))
            self.assertIsNone(cache._thread)
