// Builds data/prices.json from Yahoo Finance chart data for every symbol in symbols.json.
// Usage: node scripts/fetch-prices.mjs [previousPricesUrl]
// In GitHub Actions, scripts/yahoo_fetch.py downloads the raw data first (Yahoo blocks Node's HTTP
// client on cloud servers) and YAHOO_RAW_DIR points here at it; run locally, this fetches directly.
// When a symbol fails, its entry from previousPricesUrl (the live site's prices.json) is carried
// over and marked stale, so one bad request never blanks a price.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const FX_SYMBOL = 'SGD=X'; // Yahoo's USD -> SGD rate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Yahoo answers requests from cloud servers with HTTP 429 unless they carry a session cookie and
// the matching "crumb" token, which is how a browser visiting finance.yahoo.com gets them.
let session = null;
async function yahooSession() {
  if (session) return session;
  const cookies = [];
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'manual' });
      cookies.push(...res.headers.getSetCookie().map((c) => c.split(';')[0]));
    } catch { /* try the next one */ }
    if (cookies.length) break;
  }
  const cookie = cookies.join('; ');
  const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.includes('<')) throw new Error(`could not get a Yahoo session (HTTP ${res.status})`);
  session = { cookie, crumb };
  return session;
}

// Must match raw_name() in yahoo_fetch.py.
const rawPath = (dir, symbol, range, interval) => `${dir}/${encodeURIComponent(symbol)}_${range}_${interval}.json`;

async function readRawChart(dir, symbol, range, interval) {
  let json;
  try {
    json = JSON.parse(await readFile(rawPath(dir, symbol, range, interval), 'utf8'));
  } catch {
    throw new Error('no downloaded data');
  }
  if (json.error && !json.chart) throw new Error(json.error);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'empty result');
  return result;
}

async function fetchChart(symbol, range, interval) {
  if (process.env.YAHOO_RAW_DIR) return readRawChart(process.env.YAHOO_RAW_DIR, symbol, range, interval);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { cookie, crumb } = await yahooSession();
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie } });
      if (res.status === 401 || res.status === 403) session = null; // stale crumb: get a new one next attempt
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120).replace(/\s+/g, ' ')}`);
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
    if (!process.env.YAHOO_RAW_DIR) await sleep(250); // be gentle with the endpoint
  }

  let usdsgd = previous?.fx?.USDSGD ?? null;
  try {
    usdsgd = toQuote(await fetchChart(FX_SYMBOL, '5d', '1d')).price;
  } catch (err) {
    console.warn(`! ${FX_SYMBOL}: ${err.message}`);
  }

  if (Object.keys(quotes).length === 0) {
    console.log(`Wrote nothing: 0/${symbols.length} quotes.`);
    process.exit(1);
  }
  const out = { updatedAt: new Date().toISOString(), fx: { USDSGD: usdsgd }, quotes };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/prices.json', ROOT), JSON.stringify(out));
  console.log(`Wrote ${Object.keys(quotes).length}/${symbols.length} quotes (${failures} failed), USDSGD=${usdsgd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
