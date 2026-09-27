"""Tests for scripts/page_fetch.py (a logged article's page) with a fake web. Run: python -m unittest discover -s test -p 'test_*.py'"""

import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import page_fetch as pf  # noqa: E402

PAGES = pathlib.Path(__file__).resolve().parent / 'fixtures' / 'pages'
FEEDS = pathlib.Path(__file__).resolve().parent / 'fixtures' / 'feeds'
URL = 'https://www.cnbc.com/2026/09/26/apple-taction-technology-patent-infringement-verdict.html?utm_source=x'


class FakeSession:
    """Answers `url` with a fixture; `blocked` get Cloudflare's 403 page, `down` raise with the site's name in the error."""

    def __init__(self, pages=None, blocked=(), down=()):
        self.pages, self.blocked, self.down = pages or {}, set(blocked), set(down)
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)
        if url in self.down:
            raise ConnectionError('Could not resolve host: www.cnbc.com')
        if url in self.blocked:
            return SimpleNamespace(status_code=403, content=(FEEDS / 'cloudflare-403.html').read_bytes())
        return SimpleNamespace(status_code=200, content=self.pages[url])


def event_file(folder, command):
    path = pathlib.Path(folder) / 'event.json'
    path.write_text(json.dumps({'inputs': {'fund_command': command if isinstance(command, str) else json.dumps(command), 'refresh_picks': False}}))
    return str(path)


class PageFetchTest(unittest.TestCase):
    def test_the_link_is_read_from_the_event_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(pf.command_url(event_file(tmp, {'fund': 'all', 'reading': {'url': f' {URL} ', 'text': 'x'}})), URL)
            self.assertIsNone(pf.command_url(event_file(tmp, {'fund': 'all', 'reading': {'text': 'pasted only'}})))
            self.assertIsNone(pf.command_url(event_file(tmp, {'fund': 'all', 'stockNote': {'symbol': 'D05.SI', 'text': 'n'}})))
            self.assertIsNone(pf.command_url(event_file(tmp, '{"fund": "all", "reading": ')))  # not JSON
            self.assertIsNone(pf.command_url(event_file(tmp, '')))
            self.assertIsNone(pf.command_url(event_file(tmp, '[1, 2]')))
        self.assertIsNone(pf.command_url('/no/such/event.json'))
        self.assertIsNone(pf.command_url(''))

    def test_only_a_public_web_page_is_fetched(self):
        self.assertTrue(pf.public_url(URL))
        self.assertTrue(pf.public_url('http://www.businesstimes.com.sg:80/x'))
        for bad in ['http://169.254.169.254/latest/meta-data', 'http://localhost:8000/x', 'http://app.localhost/x', 'https://intranet/x',
                    'ftp://example.com/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'http://[::1]/x', 'http://10.0.0.1/x',
                    'not a link', 'https://example.com:99999/x']:
            self.assertFalse(pf.public_url(bad), bad)

    def test_the_page_is_written_down_and_nothing_about_it_is_printed(self):
        html = (PAGES / 'cnbc-article.html').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / 'raw-page'
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                status = pf.fetch_page(URL, out, session=FakeSession({URL: html}))
            self.assertEqual(status, {'status': 200, 'bytes': len(html)})
            self.assertEqual((out / 'page.html').read_bytes(), html)
            self.assertEqual(json.loads((out / 'page.json').read_text()), status)
            self.assertEqual(printed.getvalue(), "Your reading: the logged article's page was downloaded.\n")
            # blocked, down, or not a public page: written down as failed, and never how in the log
            for session, url, code in [(FakeSession(blocked=[URL]), URL, 403), (FakeSession(down=[URL]), URL, 0), (FakeSession(), 'http://127.0.0.1/x', 0)]:
                printed = io.StringIO()
                with contextlib.redirect_stdout(printed):
                    status = pf.fetch_page(url, out, session=session)
                self.assertEqual(status['status'], code)
                self.assertNotIn('cnbc', printed.getvalue())
                self.assertNotIn('127.0.0.1', printed.getvalue())
                self.assertTrue(printed.getvalue().startswith("Your reading: the logged article's page could not be downloaded"))
            self.assertEqual(json.loads((out / 'page.json').read_text()), {'status': 0, 'bytes': 0, 'error': 'not a public web page'})
            self.assertEqual(session.calls, [])  # never asked for
            # at most MAX_BYTES of a page is kept
            with mock.patch.object(pf, 'MAX_BYTES', 10), contextlib.redirect_stdout(io.StringIO()):
                pf.fetch_page(URL, out, session=FakeSession({URL: html}))
            self.assertEqual((out / 'page.html').read_bytes(), html[:10])

    def test_without_a_link_nothing_is_fetched(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / 'raw-page'
            with mock.patch.dict(os.environ, {'GITHUB_EVENT_PATH': event_file(tmp, {'fund': 'all', 'reading': {'text': 'pasted'}})}), \
                    mock.patch.object(sys, 'argv', ['page_fetch.py', str(out)]), mock.patch.object(pf, 'page_session') as session:
                pf.main()
            session.assert_not_called()
            self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
