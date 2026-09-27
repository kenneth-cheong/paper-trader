"""Downloads the news feeds (feeds.json) that scripts/fetch-articles.mjs planned into a folder of raw
files on the runner, which fetch-articles.mjs build then reads. The raw feeds are never saved.

Like yahoo_fetch.py, it goes through curl_cffi impersonating Chrome: some of these sites answer
ordinary HTTP clients on cloud servers with errors. Each feed is tried once (a connection error once
more), 0.4 s apart; a feed that fails is simply written down as failed, and fetch-articles.mjs's health
counters decide when it's tried again (a feed that keeps failing, such as The Smart Investor when
Cloudflare blocks it, is tried once a day until it answers).

Usage: python scripts/feed_fetch.py <raw folder>
Reads <raw folder>/plan.json ([{"id", "url", "file"}]), writes each answer to its file and every feed's
HTTP status (or error) to <raw folder>/status.json: {id: {"status", "bytes", "error"?}}. Only public
feed addresses and counts are printed.
"""

import json
import pathlib
import sys
import time


def feed_session():
    from curl_cffi import requests  # only here, so the tests can run without it

    return requests.Session(impersonate="chrome")


def fetch_one(session, url, tries=2):
    """(status, body bytes, error): one GET, repeated once after a connection error."""
    error = ""
    for attempt in range(tries):
        try:
            res = session.get(url, timeout=20)
            return res.status_code, res.content or b"", ""
        except Exception as err:  # noqa: BLE001 - any failure is written down, never raised
            error = str(err)[:200]
            time.sleep(1 + attempt)
    return 0, b"", error


def fetch_feeds(out, session=None, pause=0.4):
    """Downloads every feed in out/plan.json; returns the status of each, by id."""
    plan = json.loads((out / "plan.json").read_text())
    if session is None:
        session = feed_session()
    status = {}
    for feed in plan:
        code, body, error = fetch_one(session, feed["url"])
        (out / feed["file"]).write_bytes(body)
        status[feed["id"]] = {"status": code, "bytes": len(body), **({"error": error} if error else {})}
        if code != 200:
            print(f"! {feed['id']}: {error or f'HTTP {code}'}")
        time.sleep(pause)  # be gentle with the sites
    (out / "status.json").write_text(json.dumps(status))
    ok = sum(1 for s in status.values() if s["status"] == 200)
    print(f"Feeds: {ok} of {len(plan)} answered.")
    return status


def main():
    fetch_feeds(pathlib.Path(sys.argv[1]))


if __name__ == "__main__":
    main()
