"""Tests for scripts/yahoo_fetch.py's chart downloads with a fake Yahoo. Run: python -m unittest discover -s test -p 'test_*.py'"""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import yahoo_fetch as yf  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent


class FakeSession:
    """Answers chart requests; `fail` lists symbols that always get HTTP 500."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    def get(self, url, params=None, timeout=None):
        symbol = url.rsplit('/', 1)[1]
        self.calls.append((symbol, dict(params or {})))
        if any(url.endswith(yf.urllib.parse.quote(s, safe='')) for s in self.fail):
            return SimpleNamespace(status_code=500, text='server error')
        return SimpleNamespace(status_code=200, text=json.dumps({'chart': {'result': [{'meta': {'symbol': symbol}}]}}))


class LongHistoryTest(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        os.chdir(ROOT)  # symbols.json is read from the repository root, as in the workflow
        self.symbols = [s['symbol'] for s in json.loads((ROOT / 'symbols.json').read_text())]

    def tearDown(self):
        os.chdir(self.cwd)

    @mock.patch.object(yf.time, 'sleep', lambda s: None)
    def test_every_symbol_and_the_vix_for_ten_years(self):
        session = FakeSession()
        with tempfile.TemporaryDirectory() as out:
            yf.long_history(pathlib.Path(out), session=session, crumb='c1')
            files = sorted(os.listdir(out))
        self.assertEqual(len(session.calls), len(self.symbols) + 1)
        self.assertEqual(files, sorted(yf.raw_name(s, '10y', '1d') for s in self.symbols + ['^VIX']))
        self.assertIn('%5EVIX_10y_1d.json', files)  # the name build-history.mjs looks for
        params = dict((s, p) for s, p in session.calls)
        self.assertEqual(params['AAPL'], {'range': '10y', 'interval': '1d', 'events': 'div,splits', 'crumb': 'c1'})
        self.assertEqual(params['%5EVIX'], {'range': '10y', 'interval': '1d', 'crumb': 'c1'})  # no dividends for the VIX

    @mock.patch.object(yf.time, 'sleep', lambda s: None)
    def test_a_symbol_that_fails_is_written_as_an_error_after_three_tries(self):
        session = FakeSession(fail=['TSLA'])
        with tempfile.TemporaryDirectory() as out:
            yf.long_history(pathlib.Path(out), session=session, crumb='')
            body = json.loads((pathlib.Path(out) / yf.raw_name('TSLA', '10y', '1d')).read_text())
            good = json.loads((pathlib.Path(out) / yf.raw_name('NVDA', '10y', '1d')).read_text())
        self.assertIn('HTTP 500', body['error'])
        self.assertIn('chart', good)
        self.assertEqual(sum(1 for s, _ in session.calls if s == 'TSLA'), 3)
        self.assertNotIn('crumb', session.calls[0][1])

    @mock.patch.object(yf.time, 'sleep', lambda s: None)
    def test_the_daily_download_adds_a_year_of_the_vix(self):
        session = FakeSession()
        with tempfile.TemporaryDirectory() as out, mock.patch.object(yf, 'yahoo_session', lambda: (session, 'c')), \
                mock.patch.object(sys, 'argv', ['yahoo_fetch.py', out]):
            yf.main()
            files = set(os.listdir(out))
        self.assertIn(yf.raw_name('^VIX', '1y', '1d'), files)
        self.assertIn(yf.raw_name('SGD=X', '5d', '1d'), files)
        self.assertEqual(len(files), 2 * len(self.symbols) + 2)


if __name__ == '__main__':
    unittest.main()
