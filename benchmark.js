// "What if the same money had simply bought the index?" Compares the AI fund and your accounts with
// an index fund bought on the same day, after the same buying fee: SPY (S&P 500) for USD money and
// ES3 (SPDR Straits Times Index ETF) for SGD money. Prices are price-only, without the index's
// dividends, so the index is slightly understated.

import { calcFee } from './fees.js';

export const BENCHMARKS = { USD: { symbol: 'SPY', label: 'S&P 500 (SPY)' }, SGD: { symbol: 'ES3.SI', label: 'Straits Times Index (ES3)' } };
// A daily bar is stamped at its session's open; the close comes this many seconds later
// (US 9:30 to 16:00 New York time, SGX 9:00 to 17:00 Singapore time).
const SESSION_S = { US: 6.5 * 3600, SGX: 8 * 3600 };
export const sessionLength = (quote) => SESSION_S[quote?.market] ?? 7 * 3600;

// The last known price of `quote` at unix time `t` (15-minute bars where there are some, else daily
// closes), or null if `t` is before its price history.
export const priceAt = (quote, t) => priceAtWithTime(quote, t)[0];

// The same price with the time it was set: `t` itself for a 15-minute price, else the close of the
// session it comes from. A total return has to count dividends from that time: an idea made during
// an ex-dividend session but priced at the day before's close (cum dividend) earns that dividend.
// [null, null] before the price history.
export function priceAtWithTime(quote, t) {
  const intraday = quote?.intraday ?? [];
  if (intraday.length && t >= intraday[0][0]) {
    let p = null;
    for (const [bt, v] of intraday) { if (bt <= t) p = v; else break; }
    return [p, p == null ? null : t];
  }
  let p = null, at = null;
  const after = sessionLength(quote);
  for (const [bt, v] of quote?.daily ?? []) { if (bt + after <= t) { p = v; at = bt + after; } else break; }
  return [p, at];
}

// { symbol, label, since, partial, startPrice, shares, value, net, pct } for `amount` put into the
// index at `since` (ISO time), valued now. `partial` means the price history starts later than
// `since`, so the comparison starts at the first price there is. Null without the index's prices.
export function benchmarkFor({ currency, amount, since, quotes, plan = null }) {
  const b = BENCHMARKS[currency];
  const q = quotes?.[b?.symbol];
  if (!q?.price || !(amount > 0)) return null;
  const t0 = Date.parse(since) / 1000;
  let startPrice = priceAt(q, t0), from = since, partial = false;
  if (startPrice == null) {
    const first = q.daily?.[0] ?? q.intraday?.[0];
    if (!first) return null;
    [startPrice, from, partial] = [first[1], new Date(first[0] * 1000).toISOString(), true];
  }
  const fee = plan ? calcFee(plan, q.market, 'buy', Math.max(1, Math.floor(amount / startPrice)), startPrice).total : 0;
  const shares = Math.max(0, amount - fee) / startPrice;
  const value = shares * q.price;
  return { symbol: b.symbol, label: b.label, since: from, partial, startPrice, shares, fee, value, net: value - amount, pct: value / amount - 1 };
}

// The benchmark's value at each of `times` (ISO), for drawing next to a fund's history.
export const benchmarkSeries = (bench, quote, times) =>
  times.map((iso) => { const p = priceAt(quote, Date.parse(iso) / 1000); return p == null || Date.parse(iso) < Date.parse(bench.since) ? null : bench.shares * p; });
