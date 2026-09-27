"""One-off check of the free data sources the learning features use, run from GitHub Actions
(they can't be reached from a laptop sandbox). Prints only the shape of each answer: counts, dates,
which fields come back, and a few public headlines.

Usage: python scripts/probe_sources.py
"""

import json
import re
import time
import urllib.parse
from datetime import datetime, timezone

from curl_cffi import requests

CHARTS = [("AAPL", "10y"), ("NVDA", "10y"), ("D05.SI", "10y"), ("C38U.SI", "10y"), ("BN4.SI", "10y"), ("Y92.SI", "10y"),
          ("SPY", "10y"), ("ES3.SI", "10y"), ("^VIX", "10y"), ("^VIX", "2y"), ("D05.SI", "2y"), ("SGD=X", "1y")]
FEEDS = [
    "https://thesmartinvestor.com.sg/feed/",
    "https://fool.sg/feed/",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.cnbc.com/id/15839135/device/rss/rss.html",
    "https://www.cnbc.com/id/19854910/device/rss/rss.html",
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US",
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=D05.SI&region=SG&lang=en-SG",
    "https://www.businesstimes.com.sg/rss/companies-markets",
    "https://www.straitstimes.com/news/business/rss.xml",
    "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936",
    "https://www.theedgesingapore.com/rss.xml",
]


def day(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")


def main():
    session = requests.Session(impersonate="chrome")
    for url in ("https://fc.yahoo.com/", "https://finance.yahoo.com/"):
        try:
            session.get(url, timeout=20, allow_redirects=False)
        except Exception as err:  # noqa: BLE001
            print(f"! {url}: {err}")
        if session.cookies:
            break
    res = session.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=20)
    crumb = res.text.strip() if res.status_code == 200 and "<" not in res.text else ""
    print("crumb:", "yes" if crumb else f"no (HTTP {res.status_code})")

    for symbol, range_ in CHARTS:
        params = {"range": range_, "interval": "1d", "events": "div,splits", **({"crumb": crumb} if crumb else {})}
        res = session.get(f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe='')}", params=params, timeout=30)
        print(f"\n=== {symbol} {range_}: HTTP {res.status_code}, {len(res.text)} bytes")
        try:
            r = res.json()["chart"]["result"][0]
            ts = r.get("timestamp") or []
            ind = r["indicators"]
            q = ind["quote"][0]
            closes = q.get("close") or []
            adj = (ind.get("adjclose") or [{}])[0].get("adjclose") or []
            ev = r.get("events") or {}
            nulls = sum(1 for c in closes if c is None)
            jumps = []
            prev = None
            for t, c in zip(ts, closes):
                if c is not None and prev:
                    ch = c / prev - 1
                    if abs(ch) > 0.25:
                        jumps.append((day(t), round(ch * 100, 1)))
                if c is not None:
                    prev = c
            print(f" bars {len(ts)} from {day(ts[0]) if ts else '-'} to {day(ts[-1]) if ts else '-'}; indicators {list(ind.keys())}; quote keys {list(q.keys())}")
            print(f" adjclose {len(adj)} (first {adj[:2]}, last {adj[-2:]}); close first {closes[:2]} last {closes[-2:]}; null closes {nulls}")
            print(f" dividends {len(ev.get('dividends', {}))}, splits {len(ev.get('splits', {}))}: {json.dumps(list(ev.get('splits', {}).values()))[:300]}")
            print(f" one-day moves over 25%: {jumps[:12]}")
            print(f" meta: {json.dumps({k: r['meta'].get(k) for k in ('currency', 'exchangeName', 'instrumentType', 'dataGranularity', 'range', 'firstTradeDate')})}")
        except Exception as err:  # noqa: BLE001
            print("! parse:", err, res.text[:300])
        time.sleep(0.5)

    for url in FEEDS:
        for name, getter in (("chrome", lambda u: session.get(u, timeout=20)), ("plain", lambda u: requests.get(u, timeout=20, headers={"User-Agent": "paper-trader/1.0 (+https://github.com/kenneth-cheong/paper-trader)"}))):
            try:
                res = getter(url)
                body = res.text
                items = re.findall(r"<item[\s>].*?</item>", body, flags=re.S) or re.findall(r"<entry[\s>].*?</entry>", body, flags=re.S)
                print(f"\n=== {url} [{name}]: HTTP {res.status_code}, {res.headers.get('content-type')}, {len(body)} bytes, {len(items)} items")
                for it in items[:3]:
                    title = re.search(r"<title[^>]*>(.*?)</title>", it, flags=re.S)
                    date = re.search(r"<(pubDate|updated|published|dc:date)>(.*?)</", it, flags=re.S)
                    link = re.search(r"<link[^>]*>(.*?)</link>", it, flags=re.S) or re.search(r'<link[^>]*href="([^"]+)"', it)
                    desc = re.search(r"<description>(.*?)</description>", it, flags=re.S)
                    cats = re.findall(r"<category[^>]*>(.*?)</category>", it, flags=re.S)
                    print("  -", (title.group(1).strip() if title else "?")[:140], "|", date.group(2).strip() if date else "?", "|", (link.group(1).strip() if link else "?")[:120])
                    print("    desc", len(desc.group(1)) if desc else 0, "chars; categories", [c.strip()[:40] for c in cats[:6]])
                if not items:
                    print("  body start:", body[:200].replace("\n", " "))
            except Exception as err:  # noqa: BLE001
                print(f"\n=== {url} [{name}]: ! {err}")
            time.sleep(0.4)


if __name__ == "__main__":
    main()
