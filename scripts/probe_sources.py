"""One-off check of the free data sources the learning features use, run from GitHub Actions
(they can't be reached from a laptop sandbox). Prints the shape of each answer and a few public
headlines, so the code parses the real formats.

Usage: python scripts/probe_sources.py
"""

import json
import re
import time
from html import unescape

from curl_cffi import requests

FEEDS = {
    "smartinvestor": "https://thesmartinvestor.com.sg/feed/",
    "bt": "https://www.businesstimes.com.sg/rss/companies-markets",
    "st": "https://www.straitstimes.com/news/business/rss.xml",
    "cna": "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936",
    "cnbc-top": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "cnbc-earnings": "https://www.cnbc.com/id/15839135/device/rss/rss.html",
}
SYMBOLS = {
    "D05.SI": ["DBS"], "O39.SI": ["OCBC"], "U11.SI": ["UOB", "United Overseas Bank"], "Z74.SI": ["Singtel"],
    "C6L.SI": ["Singapore Airlines", "SIA"], "S68.SI": ["Singapore Exchange", "SGX"], "BN4.SI": ["Keppel"],
    "C38U.SI": ["CapitaLand Integrated", "CICT"], "Y92.SI": ["Thai Beverage", "ThaiBev"],
    "AAPL": ["Apple", "AAPL"], "MSFT": ["Microsoft", "MSFT"], "NVDA": ["Nvidia", "NVDA"], "AMZN": ["Amazon", "AMZN"],
    "GOOGL": ["Alphabet", "Google", "GOOGL"], "META": ["Meta", "META"], "TSLA": ["Tesla", "TSLA"], "BRK-B": ["Berkshire", "BRK"],
}
PAGES = [
    "https://thesmartinvestor.com.sg/smart-thought-of-the-week-beware/",
    "https://www.businesstimes.com.sg/companies-markets/discussing-future-ai-singapore-and-asia-dbs-conference",
    "https://www.straitstimes.com/business/companies-markets/keppel-starhub-discuss-potential-m1-deal-grab-execs-buy-shares-after-stock-falls-markets-this-week",
    "https://www.cnbc.com/2026/09/26/apple-taction-technology-patent-infringement-verdict.html",
    "https://finance.yahoo.com/markets/stocks/articles/investors-may-respond-apple-aapl-071245138.html",
    "https://www.fool.com/investing/",
]


def items_of(body):
    return re.findall(r"<item[\s>].*?</item>", body, flags=re.S)


def text_of(tag, it):
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", it, flags=re.S)
    if not m:
        return ""
    t = m.group(1).strip()
    t = re.sub(r"^<!\[CDATA\[(.*)\]\]>$", r"\1", t, flags=re.S)
    return unescape(re.sub(r"<[^>]+>", " ", t)).strip()


def mentions(text, names):
    return any(re.search(rf"(?<![A-Za-z]){re.escape(n)}(?![A-Za-z])", text) for n in names)


def main():
    s = requests.Session(impersonate="chrome")
    for key, url in FEEDS.items():
        res = s.get(url, timeout=20)
        body = res.text
        its = items_of(body)
        print(f"\n##### FEED {key}: HTTP {res.status_code}, {len(its)} items")
        print("RAW-HEAD:", body[:400].replace("\n", "\\n"))
        for it in its[:2]:
            print("RAW-ITEM:", it[:1800].replace("\n", "\\n"))
        tagged = 0
        for it in its:
            t = text_of("title", it) + " " + text_of("description", it)[:300]
            hits = [sym for sym, names in SYMBOLS.items() if mentions(t, names)]
            if hits:
                tagged += 1
                print("  TAGGED", hits, "|", text_of("title", it)[:120])
        print(f"  {tagged} of {len(its)} items mention a watchlist stock")
        time.sleep(0.4)

    for sym, names in SYMBOLS.items():
        region = "SG" if sym.endswith(".SI") else "US"
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region={region}&lang=en-{region}"
        res = s.get(url, timeout=20)
        its = items_of(res.text)
        about = 0
        domains = {}
        for it in its:
            t = text_of("title", it) + " " + text_of("description", it)[:300]
            link = text_of("link", it)
            d = re.sub(r"^https?://([^/]+)/.*$", r"\1", link)
            domains[d] = domains.get(d, 0) + 1
            if mentions(t, names):
                about += 1
        print(f"\n##### YAHOO {sym}: HTTP {res.status_code}, {len(its)} items, {about} mention it; domains {domains}")
        for it in its[:2]:
            print("  -", text_of("title", it)[:110], "|", text_of("pubDate", it), "|", text_of("link", it)[:100])
        if sym == "AAPL":
            print("RAW-ITEM:", its[0][:1500].replace("\n", "\\n") if its else "")
        time.sleep(0.4)

    for url in PAGES:
        try:
            res = s.get(url, timeout=20)
            html = res.text
            title = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.S)
            ogt = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', html)
            ogd = re.search(r'<meta[^>]+property="og:description"[^>]+content="([^"]*)"', html)
            pub = re.search(r'"datePublished"\s*:\s*"([^"]+)"', html) or re.search(r'<meta[^>]+property="article:published_time"[^>]+content="([^"]*)"', html)
            paras = re.findall(r"<p[^>]*>(.*?)</p>", html, flags=re.S)
            words = sum(len(re.sub(r"<[^>]+>", " ", p).split()) for p in paras)
            paywall = bool(re.search(r"paywall|subscribe to (read|continue)|premium article|isAccessibleForFree\"\s*:\s*\"?false", html, flags=re.I))
            print(f"\n##### PAGE {url[:90]}: HTTP {res.status_code}, {len(html)} bytes, title {unescape(title.group(1).strip())[:90] if title else '-'}")
            print(f"  og:title {unescape(ogt.group(1))[:90] if ogt else '-'}; og:description {len(ogd.group(1)) if ogd else 0} chars; published {pub.group(1) if pub else '-'}; <p> {len(paras)} with {words} words; paywall hint {paywall}")
        except Exception as err:  # noqa: BLE001
            print(f"\n##### PAGE {url[:90]}: ! {err}")
        time.sleep(0.4)


if __name__ == "__main__":
    main()
