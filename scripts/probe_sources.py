"""One-off check of the free data sources the learning features use, run from GitHub Actions
(they can't be reached from a laptop sandbox). Prints only the shape of each answer: which fields
come back and one example row, all public market data.

Usage: python scripts/probe_sources.py
"""

import json
import os
import time
import urllib.parse

from curl_cffi import requests

MODULES = "calendarEvents,earningsHistory,earningsTrend,upgradeDowngradeHistory,recommendationTrend,financialData,defaultKeyStatistics"
SYMBOLS = ["NVDA", "AAPL", "BRK-B", "D05.SI", "C38U.SI", "Z74.SI"]
CIKS = {"NVDA": "0001045810", "AAPL": "0000320193", "BRK-B": "0001067983"}


def shape(x, depth=0):
    if isinstance(x, dict):
        if depth > 2:
            return "{…}"
        return {k: shape(v, depth + 1) for k, v in list(x.items())[:25]}
    if isinstance(x, list):
        return [len(x), shape(x[0], depth + 1) if x else None]
    return x


def main():
    session = requests.Session(impersonate="chrome")
    for url in ("https://fc.yahoo.com/", "https://finance.yahoo.com/"):
        try:
            session.get(url, timeout=20, allow_redirects=False)
        except Exception as err:  # noqa: BLE001
            print(f"! {url}: {err}")
        if session.cookies:
            break
    crumb = ""
    res = session.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=20)
    if res.status_code == 200 and "<" not in res.text:
        crumb = res.text.strip()
    print("crumb:", "yes" if crumb else f"no (HTTP {res.status_code})")
    for s in SYMBOLS:
        res = session.get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(s, safe='')}",
                          params={"modules": MODULES, "crumb": crumb}, timeout=20)
        print(f"\n=== {s}: HTTP {res.status_code}")
        try:
            r = res.json()["quoteSummary"]["result"][0]
            for k, v in r.items():
                print(f"--- {k}: {json.dumps(shape(v))[:1500]}")
            up = r.get("upgradeDowngradeHistory", {}).get("history", [])
            print(f"upgrades rows {len(up)}; latest 3: {json.dumps(up[:3])[:800]}")
            eh = r.get("earningsHistory", {}).get("history", [])
            print(f"earningsHistory: {json.dumps(eh)[:1200]}")
            print(f"calendarEvents: {json.dumps(r.get('calendarEvents'))[:800]}")
        except Exception as err:  # noqa: BLE001
            print("! parse:", err, res.text[:300])
        time.sleep(0.6)
        # Daily volume in the chart endpoint
    res = session.get("https://query2.finance.yahoo.com/v8/finance/chart/D05.SI", params={"range": "5d", "interval": "1d", "crumb": crumb}, timeout=20)
    q = res.json()["chart"]["result"][0]["indicators"]["quote"][0]
    print("\nchart quote keys:", list(q.keys()), "volume sample:", q.get("volume", [])[:3])

    ua = os.environ.get("SEC_USER_AGENT", "")
    if not ua:
        print("\nSEC: skipped (no SEC_USER_AGENT repository variable)")
        return
    for s, cik in CIKS.items():
        res = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers={"User-Agent": ua}, timeout=20)
        print(f"\n=== SEC {s}: HTTP {res.status_code}")
        try:
            rec = res.json()["filings"]["recent"]
            rows = [i for i, f in enumerate(rec["form"]) if f == "8-K" and "2.02" in rec["items"][i]][:4]
            for i in rows:
                print(" 8-K 2.02", rec["filingDate"][i], rec["acceptanceDateTime"][i], rec["items"][i])
            print(" keys:", list(rec.keys()), "older pages:", len(res.json()["filings"].get("files", [])))
        except Exception as err:  # noqa: BLE001
            print("! parse:", err, res.text[:200])
        time.sleep(0.3)


if __name__ == "__main__":
    main()
