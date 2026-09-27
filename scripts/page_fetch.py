"""Downloads the page of an article the owner logged in the app ("Log an article", README: Reading guide)
to a folder on the runner, which scripts/ai-fund.mjs then reads (reading.js pageFacts). The page is
never saved, and nothing about it (its address, title or text) is printed: the Actions log is public.

The app's request reaches the job as the workflow's fund_command input, {"fund": "all", "reading":
{"url": ..., "text": ...}}, read here from the run's event file (GITHUB_EVENT_PATH), never from an
environment value, which the log would print. Only a public web page is fetched (http or https, a host
name with a dot, not an IP address or the runner itself, the usual ports), once, like the feeds through
curl_cffi impersonating Chrome, and at most MAX_BYTES of it is kept. A page that answers with an error
(The Smart Investor's Cloudflare, a paywall's 403) is written down as failed; the app then asks for the
article's text to be pasted instead.

Usage: python scripts/page_fetch.py <raw folder>
With a link to fetch, writes <raw folder>/page.html and <raw folder>/page.json ({"status", "bytes",
"error"?}); without one, nothing. Exits 0 either way.
"""

import ipaddress
import json
import os
import pathlib
import sys
from urllib.parse import urlsplit

MAX_BYTES = 3_000_000


def command_url(event_path):
    """The link in the app's command in the event file, or None (no file, no command, no link)."""
    try:
        event = json.loads(pathlib.Path(event_path).read_text())
        command = json.loads(event.get("inputs", {}).get("fund_command") or "{}")
        url = (command.get("reading") or {}).get("url") if isinstance(command, dict) else None
        return url.strip() if isinstance(url, str) and url.strip() else None
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def public_url(url):
    """Whether `url` is a public web page this job may fetch (the same check as reading.js publicUrl)."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or parts.username or parts.password or "." not in host:
        return False
    if host == "localhost" or host.endswith(".localhost") or port not in (None, 80, 443):
        return False
    try:
        ipaddress.ip_address(host)
        return False  # an IP address rather than a site's name
    except ValueError:
        return True


def page_session():
    from curl_cffi import requests  # only here, so the tests can run without it

    return requests.Session(impersonate="chrome")


def fetch_page(url, out, session=None):
    """Downloads `url` into out/page.html and its status into out/page.json; returns the status."""
    out.mkdir(parents=True, exist_ok=True)
    body, status = b"", {"status": 0, "bytes": 0}
    if not public_url(url):
        status["error"] = "not a public web page"
    else:
        try:
            res = (session or page_session()).get(url, timeout=20)
            body = (res.content or b"")[:MAX_BYTES]
            status = {"status": res.status_code, "bytes": len(body)}
        except Exception as err:  # noqa: BLE001 - written down on the runner, never printed (it may name the site)
            status["error"] = str(err)[:200]
    (out / "page.html").write_bytes(body)
    (out / "page.json").write_text(json.dumps(status))
    # only whether it worked: never the address, the site or the error's words
    code = status["status"]
    if code == 200:
        print("Your reading: the logged article's page was downloaded.")
    else:
        print("Your reading: the logged article's page could not be downloaded" + (f" (HTTP {code})." if code else "."))
    return status


def main():
    url = command_url(os.environ.get("GITHUB_EVENT_PATH", ""))
    if url:
        fetch_page(url, pathlib.Path(sys.argv[1]))


if __name__ == "__main__":
    main()
