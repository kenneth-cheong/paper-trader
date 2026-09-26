// Fetches the latest prices for every symbol in symbols.json and writes data/prices.json.
// Runs in GitHub Actions (server side, so no browser CORS limits and no API key).
// Usage: node scripts/fetch-prices.mjs [previousPricesUrl]
// When a symbol fails to fetch, its entry from previousPricesUrl (the live site's
// prices.json) is carried over and marked stale, so one bad request never blanks a price.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const FX_SYMBOL = 'SGD=X'; // Yahoo's USD -> SGD rate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description || 'empty result');
      return result;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// [[unixSeconds, close], ...] with gaps (null closes) dropped.
export function bars(result) {
  const ts = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const out = [];
  ts.forEach((t, i) => { if (closes[i] != null) out.push([t, round(closes[i])]); });
  return out;
}

// daily: ~1 year of daily bars (for charts, moving averages, backtests and the AI);
// intraday: ~5 days of 15-minute bars (so auto-trading rules can catch up on missed moves).
export function toQuote(daily, intraday) {
  const meta = intraday?.meta ?? daily.meta;
  const d = bars(daily);
  const price = meta.regularMarketPrice ?? d.at(-1)?.[1];
  if (!(price > 0)) throw new Error('no price');
  // Yahoo's daily bars include the current session, so the bar before the last is the previous close.
  const prevClose = d.length >= 2 ? d.at(-2)[1] : daily.meta.chartPreviousClose ?? null;
  return {
    currency: meta.currency,
    price: round(price),
    prevClose: prevClose == null ? null : round(prevClose),
    time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    daily: d,
    intraday: intraday ? bars(intraday) : [],
  };
}

const round = (n) => Math.round(n * 10000) / 10000;

async function loadPrevious(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
  const previous = await loadPrevious(process.argv[2]);
  const quotes = {};
  let failures = 0;

  for (const { symbol, name, market } of symbols) {
    try {
      const daily = await fetchChart(symbol, '1y', '1d');
      const intraday = await fetchChart(symbol, '5d', '15m').catch((err) => {
        console.warn(`! ${symbol} intraday: ${err.message}`);
        return null;
      });
      quotes[symbol] = { name, market, ...toQuote(daily, intraday) };
    } catch (err) {
      failures++;
      console.warn(`! ${symbol}: ${err.message}`);
      const old = previous?.quotes?.[symbol];
      if (old) quotes[symbol] = { ...old, name, market, stale: true };
    }
    await sleep(250); // be gentle with the endpoint
  }

  let usdsgd = previous?.fx?.USDSGD ?? null;
  try {
    usdsgd = toQuote(await fetchChart(FX_SYMBOL, '5d', '1d')).price;
  } catch (err) {
    console.warn(`! ${FX_SYMBOL}: ${err.message}`);
  }

  const out = { updatedAt: new Date().toISOString(), fx: { USDSGD: usdsgd }, quotes };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/prices.json', ROOT), JSON.stringify(out));
  console.log(`Wrote ${Object.keys(quotes).length}/${symbols.length} quotes (${failures} failed), USDSGD=${usdsgd}`);
  if (Object.keys(quotes).length === 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
