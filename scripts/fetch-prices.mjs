// Builds data/prices.json from Yahoo Finance chart data for every symbol in symbols.json, and
// data/ohlcv.json for the scheduled scripts only (never copied to the site).
// Usage: node scripts/fetch-prices.mjs [previousPricesUrl]
// Each stock's daily data is requested for 2 years (still one request per stock): prices.json keeps the
// last year, as every reader of it expects (charts, moving averages, backtests, grading, the AI's price
// statistics), and data/ohlcv.json keeps the two years of open, high, low, close and volume, with the
// VIX's two years and USD/SGD's year of daily closes, for the factor lab (factors.js). USD/SGD is
// requested for a year of daily closes; prices.json's fx.USDSGD is still its latest rate.
// In GitHub Actions, scripts/yahoo_fetch.py downloads the raw data first (Yahoo blocks Node's HTTP
// client on cloud servers) and YAHOO_RAW_DIR points here at it; run locally, this fetches directly.
// When a symbol fails, its entry from previousPricesUrl (the live site's prices.json) is carried
// over and marked stale, so one bad request never blanks a price.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const FX_SYMBOL = 'SGD=X'; // Yahoo's USD -> SGD rate
// Market-wide gauges, kept under prices.json's `macro` and never in `quotes` (which the app, the AI's
// stock list, the market memory and the news backfill all treat as the watchlist): the VIX, for the
// "Regime today" line (memory-long.js regimeNow).
const MACRO = ['^VIX'];

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

// The requests, which must match REQUESTS, DAILY_MACRO and FX_RANGE in yahoo_fetch.py.
export const DAILY = ['2y', '1d'];
const INTRADAY = ['5d', '15m'];
const FX_RANGE = ['1y', '1d'];
const YEAR_S = 366 * 86400;

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
      const events = interval === '1d' ? '&events=div%2Csplits' : '';
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${events}&crumb=${encodeURIComponent(crumb)}`;
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

// [[unixSeconds, close], ...] with gaps (null closes) dropped. With `withVolume`, each bar that has a
// volume is [unixSeconds, close, volume]: every reader that takes [t, c] from a bar still works, and
// the market memory checks news dates against unusual volume (memory.js).
export function bars(result, withVolume = false) {
  const ts = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const closes = quote.close ?? [];
  const volumes = withVolume ? quote.volume ?? [] : [];
  const out = [];
  ts.forEach((t, i) => {
    if (closes[i] == null) return;
    out.push(volumes[i] > 0 ? [t, round(closes[i]), Math.round(volumes[i])] : [t, round(closes[i])]);
  });
  return out;
}

// Dividends and splits in the daily data: { dividends: [[unixSeconds, perShare]], splits: [[unixSeconds, ratio]] }
// (ratio = new shares per old share, so 3 for a 3-for-1 split), or undefined when there are none.
export function events(result) {
  const ev = result?.events ?? {};
  const dividends = Object.values(ev.dividends ?? {}).filter((d) => d.amount > 0).map((d) => [d.date, round(d.amount)]);
  const splits = Object.values(ev.splits ?? {}).filter((x) => x.numerator > 0 && x.denominator > 0).map((x) => [x.date, round(x.numerator / x.denominator)]);
  const byDate = (a, b) => a[0] - b[0];
  return dividends.length || splits.length ? { dividends: dividends.sort(byDate), splits: splits.sort(byDate) } : undefined;
}

// The last year of `list` ([[unixSeconds, ...]], oldest first): from a year before its last entry.
export const lastYear = (list, last = list.at(-1)?.[0]) => (last == null ? list : list.filter(([t]) => t > last - YEAR_S));

// daily: the last year of daily bars [t, close, volume] (for charts, moving averages, backtests and the
// AI), from the 2 years requested; its dividends and splits over the same year. intraday: ~5 days of
// 15-minute bars (so auto-trading rules can catch up on missed moves).
export function toQuote(daily, intraday) {
  const meta = intraday?.meta ?? daily.meta;
  const d = lastYear(bars(daily, true));
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
    events: yearEvents(events(daily), d[0]?.[0]),
  };
}

// Dividends and splits from `from` (unix seconds) on, or undefined when none are left.
function yearEvents(ev, from) {
  if (!ev || from == null) return ev;
  const dividends = ev.dividends.filter(([t]) => t >= from), splits = ev.splits.filter(([t]) => t >= from);
  return dividends.length || splits.length ? { dividends, splits } : undefined;
}

// Every daily bar with a close, [t, open, high, low, close, volume] (null where Yahoo has none), for
// data/ohlcv.json.
export function ohlcvBars(result) {
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const num = (x) => (typeof x === 'number' && x > 0 ? round(x) : null);
  const out = [];
  ts.forEach((t, i) => {
    if (!(q.close?.[i] > 0)) return;
    out.push([t, num(q.open?.[i]), num(q.high?.[i]), num(q.low?.[i]), round(q.close[i]), q.volume?.[i] > 0 ? Math.round(q.volume[i]) : null]);
  });
  return out;
}

const round = (n) => Math.round(n * 10000) / 10000;

// A macro series for prices.json's `macro`: its latest value and a year of daily closes [[t, close]]
// (the last year of what was requested).
export function toMacro(daily) {
  const d = lastYear(bars(daily));
  const price = daily?.meta?.regularMarketPrice ?? d.at(-1)?.[1];
  if (!(price > 0) || !d.length) throw new Error('no value');
  const time = daily.meta?.regularMarketTime;
  return { price: round(price), time: time ? new Date(time * 1000).toISOString() : null, daily: d };
}

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
  const ohlcv = { updatedAt: new Date().toISOString(), symbols: {}, macro: {} };
  let failures = 0;

  for (const { symbol, name, market, etf } of symbols) {
    const kind = etf ? { etf: true } : {}; // index funds aren't compared as a stock's peers (stats.js)
    try {
      const daily = await fetchChart(symbol, ...DAILY);
      const intraday = await fetchChart(symbol, ...INTRADAY).catch((err) => {
        console.warn(`! ${symbol} intraday: ${err.message}`);
        return null;
      });
      quotes[symbol] = { name, market, ...kind, ...toQuote(daily, intraday) };
      ohlcv.symbols[symbol] = { market, ...kind, bars: ohlcvBars(daily) };
    } catch (err) {
      failures++;
      console.warn(`! ${symbol}: ${err.message}`);
      const old = previous?.quotes?.[symbol];
      if (old) quotes[symbol] = { ...old, name, market, ...kind, stale: true };
    }
    if (!process.env.YAHOO_RAW_DIR) await sleep(250); // be gentle with the endpoint
  }

  let usdsgd = previous?.fx?.USDSGD ?? null;
  try {
    const fx = await fetchChart(FX_SYMBOL, ...FX_RANGE);
    usdsgd = toQuote(fx).price;
    ohlcv.macro[FX_SYMBOL] = bars(fx);
  } catch (err) {
    console.warn(`! ${FX_SYMBOL}: ${err.message}`);
  }

  const macro = {};
  for (const symbol of MACRO) {
    try {
      const daily = await fetchChart(symbol, ...DAILY);
      macro[symbol] = toMacro(daily);
      ohlcv.macro[symbol] = bars(daily);
    } catch (err) {
      console.warn(`! ${symbol}: ${err.message}`);
      // the last value, marked stale, until it's a week old (memory-long.js regimeNow uses it only while
      // it's within a few days of the index's price)
      const old = previous?.macro?.[symbol];
      if (old && Date.now() - Date.parse(old.time ?? '') < 7 * 86400000) macro[symbol] = { ...old, stale: true };
    }
  }

  if (Object.keys(quotes).length === 0) {
    console.log(`Wrote nothing: 0/${symbols.length} quotes.`);
    process.exit(1);
  }
  const out = { updatedAt: new Date().toISOString(), fx: { USDSGD: usdsgd }, quotes, ...(Object.keys(macro).length ? { macro } : {}) };
  await mkdir(new URL('data/', ROOT), { recursive: true });
  await writeFile(new URL('data/prices.json', ROOT), JSON.stringify(out));
  // for the scripts only: .gitignore'd, and the workflow's "Collect site files" step never copies it
  await writeFile(new URL('data/ohlcv.json', ROOT), JSON.stringify(ohlcv));
  console.log(`Wrote ${Object.keys(quotes).length}/${symbols.length} quotes (${failures} failed), USDSGD=${usdsgd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
