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

async function fetchChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
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

export function toQuote(result) {
  const meta = result.meta;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((c) => c != null);
  const price = meta.regularMarketPrice ?? closes.at(-1);
  if (!(price > 0)) throw new Error('no price');
  // Yahoo's daily bars include the current session, so the bar before the last is the previous close.
  const prevClose = closes.length >= 2 ? closes.at(-2) : meta.chartPreviousClose ?? null;
  return {
    currency: meta.currency,
    price: round(price),
    prevClose: prevClose == null ? null : round(prevClose),
    time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    history: closes.map(round),
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
      quotes[symbol] = { name, market, ...toQuote(await fetchChart(symbol)) };
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
    usdsgd = toQuote(await fetchChart(FX_SYMBOL)).price;
  } catch (err) {
    console.warn(`! ${FX_SYMBOL}: ${err.message}`);
  }

  const out = { updatedAt: new Date().toISOString(), fx: { USDSGD: usdsgd }, quotes };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/prices.json', ROOT), JSON.stringify(out, null, 1));
  console.log(`Wrote ${Object.keys(quotes).length}/${symbols.length} quotes (${failures} failed), USDSGD=${usdsgd}`);
  if (Object.keys(quotes).length === 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
