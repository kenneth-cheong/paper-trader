"""Downloads Yahoo Finance chart data for every symbol in symbols.json into a folder of raw JSON files,
which scripts/fetch-prices.mjs then turns into data/prices.json (set YAHOO_RAW_DIR to that folder).

Yahoo answers ordinary HTTP clients running on cloud servers (like GitHub's) with HTTP 429, so this
fetches through curl_cffi impersonating Chrome, with the session cookie and crumb a browser would have.

Usage: python scripts/yahoo_fetch.py <out_dir>
       python scripts/yahoo_fetch.py summary <out_dir>
       python scripts/yahoo_fetch.py long <out_dir>

The first form fetches two years of daily prices and 5 days of 15-minute prices for every symbol, two
years of the VIX and a year of USD/SGD's daily rate. fetch-prices.mjs keeps the last year of each in
prices.json (the VIX apart from the watchlist, under `macro`) and the two years in data/ohlcv.json, for
the scripts only. The second downloads each stock's quoteSummary instead
(results dates, earnings surprises, analysts' ratings and targets), once a day;
scripts/company-data.mjs turns it into state/company-data.json. Index funds are skipped, since they
have no results or analysts. The third downloads ten years of daily prices with dividends and splits
for every symbol plus the VIX, once a week; scripts/build-history.mjs turns them into
state/memory-long.json, and the raw files are never saved.
"""

import json
import pathlib
import sys
import time
import urllib.parse

FX_SYMBOL = "SGD=X"
VIX = "^VIX"  # the market's fear gauge: a macro series, never a watchlist quote
# Must match DAILY, INTRADAY and FX_RANGE in fetch-prices.mjs.
REQUESTS = [("2y", "1d"), ("5d", "15m")]
DAILY_MACRO = ("2y", "1d")  # the VIX
FX_RANGE = ("1y", "1d")
LONG = ("10y", "1d")
SUMMARY_MODULES = "calendarEvents,earningsHistory,upgradeDowngradeHistory,recommendationTrend,financialData"


def raw_name(symbol, range_, interval):
    # Must match rawPath() in fetch-prices.mjs and build-history.mjs.
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
    from curl_cffi import requests  # only here, so the tests can run without it

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


def fetch_chart(session, crumb, symbol, range_, interval, tries=3):
    """One chart request, retried with a growing pause: (body, None), or (None, error). Daily bars of a
    stock or fund come with its dividends and splits (see actions.js); the FX rate and the VIX have none."""
    params = {"range": range_, "interval": interval}
    if interval == "1d" and symbol not in (FX_SYMBOL, VIX):
        params["events"] = "div,splits"
    if crumb:
        params["crumb"] = crumb
    error = ""
    for attempt in range(tries):
        try:
            res = session.get(
                f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol, safe='')}",
                params=params, timeout=30,
            )
            if res.status_code == 200:
                return res.text, None
            error = f"HTTP {res.status_code} {res.text[:120]}"
        except Exception as err:  # noqa: BLE001
            error = str(err)
        time.sleep(2 ** attempt)
    return None, error


def download(out, jobs, session, crumb, pause):
    """Runs the chart requests in `jobs` ([(symbol, range, interval)]), writing each answer to `out`
    (a failure as {"error": ...}, so the builder keeps the last good copy). Returns (ok, failed)."""
    ok = failed = 0
    for symbol, range_, interval in jobs:
        body, error = fetch_chart(session, crumb, symbol, range_, interval)
        if body is None:
            failed += 1
            print(f"! {symbol} {range_}/{interval}: {error}")
            body = json.dumps({"error": error})
        else:
            ok += 1
        (out / raw_name(symbol, range_, interval)).write_text(body)
        time.sleep(pause)  # be gentle with the endpoint
    return ok, failed


def long_history(out, session=None, crumb=None):
    """Ten years of daily prices, dividends and splits for every symbol in symbols.json plus the VIX,
    once a week (scripts/build-history.mjs), 0.4 s apart: about 21 requests of some 280 KB each."""
    out.mkdir(parents=True, exist_ok=True)
    symbols = [s["symbol"] for s in json.loads(pathlib.Path("symbols.json").read_text())]
    if session is None:
        session, crumb = yahoo_session()
    ok, failed = download(out, [(s, *LONG) for s in symbols + [VIX]], session, crumb, 0.4)
    print(f"Yahoo, ten years: {ok} fetched, {failed} failed (crumb {'yes' if crumb else 'no'}).")


def main():
    if sys.argv[1] == "summary":
        summary(pathlib.Path(sys.argv[2]))
        return
    if sys.argv[1] == "long":
        long_history(pathlib.Path(sys.argv[2]))
        return
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    symbols = [s["symbol"] for s in json.loads(pathlib.Path("symbols.json").read_text())]
    session, crumb = yahoo_session()
    jobs = [(s, r, i) for s in symbols for r, i in REQUESTS] + [(FX_SYMBOL, *FX_RANGE), (VIX, *DAILY_MACRO)]
    ok, failed = download(out, jobs, session, crumb, 0.3)
    print(f"Yahoo: {ok} fetched, {failed} failed (crumb {'yes' if crumb else 'no'}).")


if __name__ == "__main__":
    main()
