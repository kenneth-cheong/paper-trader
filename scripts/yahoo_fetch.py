"""Downloads Yahoo Finance chart data for every symbol in symbols.json into a folder of raw JSON files,
which scripts/fetch-prices.mjs then turns into data/prices.json (set YAHOO_RAW_DIR to that folder).

Yahoo answers ordinary HTTP clients running on cloud servers (like GitHub's) with HTTP 429, so this
fetches through curl_cffi impersonating Chrome, with the session cookie and crumb a browser would have.

Usage: python scripts/yahoo_fetch.py <out_dir>
"""

import json
import pathlib
import sys
import time
import urllib.parse

from curl_cffi import requests

FX_SYMBOL = "SGD=X"
REQUESTS = [("1y", "1d"), ("5d", "15m")]


def raw_name(symbol, range_, interval):
    # Must match rawPath() in fetch-prices.mjs.
    return f"{urllib.parse.quote(symbol, safe='')}_{range_}_{interval}.json"


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    symbols = [s["symbol"] for s in json.loads(pathlib.Path("symbols.json").read_text())]

    session = requests.Session(impersonate="chrome")
    for url in ("https://fc.yahoo.com/", "https://finance.yahoo.com/"):
        try:
            session.get(url, timeout=20, allow_redirects=False)
        except Exception as err:  # noqa: BLE001 - any failure just means trying the next page
            print(f"! {url}: {err}")
        if session.cookies:
            break
    crumb = ""
    try:
        res = session.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=20)
        if res.status_code == 200 and "<" not in res.text:
            crumb = res.text.strip()
        else:
            print(f"! crumb: HTTP {res.status_code}")
    except Exception as err:  # noqa: BLE001
        print(f"! crumb: {err}")

    ok = failed = 0
    jobs = [(s, r, i) for s in symbols for r, i in REQUESTS] + [(FX_SYMBOL, "5d", "1d")]
    for symbol, range_, interval in jobs:
        params = {"range": range_, "interval": interval}
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
