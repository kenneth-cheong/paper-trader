"""Downloads Yahoo Finance chart data for every symbol in symbols.json into a folder of raw JSON files,
which scripts/fetch-prices.mjs then turns into data/prices.json (set YAHOO_RAW_DIR to that folder).

Yahoo answers ordinary HTTP clients running on cloud servers (like GitHub's) with HTTP 429, so this
fetches through curl_cffi impersonating Chrome, with the session cookie and crumb a browser would have.

Usage: python scripts/yahoo_fetch.py <out_dir>
       python scripts/yahoo_fetch.py summary <out_dir>

The second form downloads each stock's quoteSummary instead (results dates, earnings surprises,
analysts' ratings and targets), once a day; scripts/company-data.mjs turns it into
state/company-data.json. Index funds are skipped, since they have no results or analysts.
"""

import json
import pathlib
import sys
import time
import urllib.parse

from curl_cffi import requests

FX_SYMBOL = "SGD=X"
REQUESTS = [("1y", "1d"), ("5d", "15m")]
SUMMARY_MODULES = "calendarEvents,earningsHistory,upgradeDowngradeHistory,recommendationTrend,financialData"


def raw_name(symbol, range_, interval):
    # Must match rawPath() in fetch-prices.mjs.
    return f"{urllib.parse.quote(symbol, safe='')}_{range_}_{interval}.json"


def summary_name(symbol):
    # Must match summaryPath() in company-data.mjs.
    return f"{urllib.parse.quote(symbol, safe='')}_summary.json"


def get_crumb(session):
    try:
        res = session.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=20)
        if res.status_code == 200 and "<" not in res.text:
            return res.text.strip()
        print(f"! crumb: HTTP {res.status_code}")
    except Exception as err:  # noqa: BLE001
        print(f"! crumb: {err}")
    return ""


def yahoo_session():
    """A Chrome-like session with Yahoo's cookie, and the crumb that goes with it ("" if none)."""
    session = requests.Session(impersonate="chrome")
    for url in ("https://fc.yahoo.com/", "https://finance.yahoo.com/"):
        try:
            session.get(url, timeout=20, allow_redirects=False)
        except Exception as err:  # noqa: BLE001 - any failure just means trying the next page
            print(f"! {url}: {err}")
        if session.cookies:
            break
    return session, get_crumb(session)


def summary(out):
    """One quoteSummary call per stock, 0.5 s apart. A 401 ("Invalid Crumb", which recurs) gets a new
    crumb and one retry. A stock that fails is written as {"error": ...}, so its previous data is kept."""
    out.mkdir(parents=True, exist_ok=True)
    rows = json.loads(pathlib.Path("symbols.json").read_text())
    symbols = [s["symbol"] for s in rows if not s.get("etf")]
    session, crumb = yahoo_session()
    ok = failed = 0
    for symbol in symbols:
        body, error = None, ""
        for attempt in range(2):
            try:
                res = session.get(
                    f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(symbol, safe='')}",
                    params={"modules": SUMMARY_MODULES, **({"crumb": crumb} if crumb else {})}, timeout=20,
                )
                if res.status_code == 200:
                    body = res.text
                    break
                error = f"HTTP {res.status_code} {res.text[:120]}"
                if res.status_code == 401 and attempt == 0:
                    crumb = get_crumb(session)
            except Exception as err:  # noqa: BLE001
                error = str(err)
            time.sleep(1)
        if body is None:
            failed += 1
            print(f"! {symbol} summary: {error}")
            body = json.dumps({"error": error})
        else:
            ok += 1
        (out / summary_name(symbol)).write_text(body)
        time.sleep(0.5)  # be gentle with the endpoint
    print(f"Yahoo summaries: {ok} fetched, {failed} failed (crumb {'yes' if crumb else 'no'}).")


def main():
    if sys.argv[1] == "summary":
        summary(pathlib.Path(sys.argv[2]))
        return
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    symbols = [s["symbol"] for s in json.loads(pathlib.Path("symbols.json").read_text())]
    session, crumb = yahoo_session()

    ok = failed = 0
    jobs = [(s, r, i) for s in symbols for r, i in REQUESTS] + [(FX_SYMBOL, "5d", "1d")]
    for symbol, range_, interval in jobs:
        params = {"range": range_, "interval": interval}
        if interval == "1d" and symbol != FX_SYMBOL:
            params["events"] = "div,splits"  # dividends and stock splits (see actions.js)
        if crumb:
            params["crumb"] = crumb
        body = None
        for attempt in range(3):
            try:
                res = session.get(
                    f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe='')}",
                    params=params, timeout=20,
                )
                if res.status_code == 200:
                    body = res.text
                    break
                error = f"HTTP {res.status_code} {res.text[:120]}"
            except Exception as err:  # noqa: BLE001
                error = str(err)
            time.sleep(2 ** attempt)
        if body is None:
            failed += 1
            print(f"! {symbol} {range_}/{interval}: {error}")
            body = json.dumps({"error": error})
        else:
            ok += 1
        (out / raw_name(symbol, range_, interval)).write_text(body)
        time.sleep(0.3)  # be gentle with the endpoint
    print(f"Yahoo: {ok} fetched, {failed} failed (crumb {'yes' if crumb else 'no'}).")


if __name__ == "__main__":
    main()
