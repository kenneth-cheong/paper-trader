"""Tests for scripts/feed_fetch.py's downloads with a fake web. Run: python -m unittest discover -s test -p 'test_*.py'"""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import feed_fetch as ff  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent / 'fixtures' / 'feeds'


class FakeSession:
    """Answers with a fixture by URL; `blocked` get Cloudflare's 403 page, `down` raise, `flaky` raise once."""

    def __init__(self, pages, blocked=(), down=(), flaky=()):
        self.pages, self.blocked, self.down, self.flaky = pages, set(blocked), set(down), set(flaky)
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        if url in self.down or (url in self.flaky and self.calls.count(url) == 1):
            raise ConnectionError('Could not resolve host')
        if url in self.blocked:
            return SimpleNamespace(status_code=403, content=(FIXTURES / 'cloudflare-403.html').read_bytes())
        return SimpleNamespace(status_code=200, content=(FIXTURES / self.pages[url]).read_bytes())


class FeedFetchTest(unittest.TestCase):
    PLAN = [
        {'id': 'bt', 'url': 'https://bt.example/rss', 'file': 'bt.xml'},
        {'id': 'smartinvestor', 'url': 'https://tsi.example/feed/', 'file': 'smartinvestor.xml'},
        {'id': 'yahoo:D05.SI', 'url': 'https://yahoo.example/rss?s=D05.SI', 'file': 'yahoo_D05.SI.xml'},
        {'id': 'gone', 'url': 'https://gone.example/feed/', 'file': 'gone.xml'},
    ]

    @mock.patch.object(ff.time, 'sleep', lambda s: None)
    def test_every_planned_feed_is_written_with_its_status(self):
        session = FakeSession({'https://bt.example/rss': 'bt.xml', 'https://yahoo.example/rss?s=D05.SI': 'yahoo-d05.xml'},
                              blocked=['https://tsi.example/feed/'], down=['https://gone.example/feed/'],
                              flaky=['https://yahoo.example/rss?s=D05.SI'])
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / 'plan.json').write_text(json.dumps(self.PLAN))
            ff.fetch_feeds(out, session=session)
            status = json.loads((out / 'status.json').read_text())
            self.assertEqual((out / 'bt.xml').read_bytes(), (FIXTURES / 'bt.xml').read_bytes())  # as it came, byte for byte
            self.assertIn(b'Just a moment', (out / 'smartinvestor.xml').read_bytes())
            self.assertEqual((out / 'gone.xml').read_bytes(), b'')
        self.assertEqual(status['bt']['status'], 200)
        self.assertEqual(status['smartinvestor']['status'], 403)  # the Node side counts it as a failure
        self.assertEqual(status['yahoo:D05.SI']['status'], 200)  # a connection error is tried once more
        self.assertEqual(status['gone'], {'status': 0, 'bytes': 0, 'error': 'Could not resolve host'})
        self.assertEqual(session.calls.count('https://gone.example/feed/'), 2)
        self.assertEqual(session.calls.count('https://tsi.example/feed/'), 1)  # an HTTP error isn't retried

    @mock.patch.object(ff.time, 'sleep', lambda s: None)
    def test_an_empty_plan_writes_an_empty_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / 'plan.json').write_text('[]')
            ff.fetch_feeds(out, session=FakeSession({}))
            self.assertEqual(json.loads((out / 'status.json').read_text()), {})


if __name__ == '__main__':
    unittest.main()
