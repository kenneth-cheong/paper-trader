// Rebuilds what an account was worth over time from its trades, currency conversions, dividends and
// splits, valued at each day's closing prices. The app only stores trades, so this is how the Home
// page can chart value over time. Pure functions.
//
// Yahoo's daily closes are already adjusted for splits, so every trade's shares are counted in today's
// share terms (multiplied by any split after the trade) to stay consistent with those prices.

import { BENCHMARKS, priceAt, sessionLength } from './benchmark.js';
import { summarize } from './portfolio.js';

const cents = (x) => Math.round(x * 100) / 100;

// [[isoTime, value, invested], ...] for `currency`'s account: one point per trading day since the
// portfolio started (at most the price history available), then one at the latest prices (the same
// value as the account's card). `invested` is the money put in so far: the start, plus money
// converted in, less money converted out.
export const valueHistory = (portfolio, quotes, currency) => replay(portfolio, quotes, currency).points;

// The replay behind valueHistory. Also gives every conversion into or out of the account with the
// account's value just before it ({ t, amount, before }), for the index line.
function replay(portfolio, quotes, currency) {
  const acct = portfolio.accounts[currency];
  if (!acct) return { points: [], flows: [] };
  const indexQuote = quotes[BENCHMARKS[currency]?.symbol];
  const closeMs = sessionLength(indexQuote) * 1000;
  const start = Date.parse(portfolio.createdAt);
  const days = (indexQuote?.daily ?? []).map(([t]) => t * 1000 + closeMs).filter((t) => t >= start && t <= Date.now());

  // Everything that moved cash or shares, in time order.
  const splits = {};
  for (const a of portfolio.actions ?? []) if (a.kind === 'split' && a.ratio) (splits[a.symbol] ??= []).push({ t: Date.parse(a.time), ratio: a.ratio });
  const laterSplits = (symbol, t) => (splits[symbol] ?? []).filter((x) => x.t > t).reduce((m, x) => m * x.ratio, 1);
  const events = [];
  for (const t of portfolio.trades) {
    if (t.currency !== currency) continue;
    const at = Date.parse(t.time), k = laterSplits(t.symbol, at);
    events.push({ t: at, symbol: t.symbol, qty: (t.side === 'buy' ? t.qty : -t.qty) * k, price: t.price / k, cash: (t.side === 'buy' ? -1 : 1) * t.qty * t.price - (t.fee ?? 0) });
  }
  for (const c of portfolio.conversions ?? []) {
    if (c.from === currency) events.push({ t: Date.parse(c.time), cash: -c.amount, flow: -c.amount });
    if (c.to === currency) events.push({ t: Date.parse(c.time), cash: c.received, flow: cents(c.amount * c.rate) });
  }
  for (const a of portfolio.actions ?? []) {
    if (a.currency === currency && a.kind === 'dividend' && a.amount) events.push({ t: Date.parse(a.time), cash: a.amount });
  }
  events.sort((a, b) => a.t - b.t);

  // Each symbol's latest close at time t. Days only move forward, so each keeps a moving position in
  // its bars. A holding without a close yet keeps its last traded price.
  const cursor = {}, lastPrice = {};
  const closeAt = (s, t) => {
    const q = quotes[s], bars = q?.daily ?? [], after = sessionLength(q) * 1000;
    let i = cursor[s] ?? -1;
    while (i + 1 < bars.length && bars[i + 1][0] * 1000 + after <= t + 1) i++;
    cursor[s] = i;
    if (i >= 0) lastPrice[s] = bars[i][1];
    return lastPrice[s] ?? 0;
  };

  const out = [], flows = [];
  let cash = acct.start, invested = acct.start, i = 0;
  const qty = {};
  const valueAt = (t) => { let v = cash; for (const [s, q] of Object.entries(qty)) if (q) v += q * closeAt(s, t); return v; };
  const apply = (e) => {
    if (e.flow != null) {
      flows.push({ t: e.t, amount: e.flow, before: cents(valueAt(e.t)) });
      invested += e.flow;
    }
    cash += e.cash;
    if (e.symbol) {
      qty[e.symbol] = (qty[e.symbol] ?? 0) + e.qty;
      if (!(cursor[e.symbol] >= 0)) lastPrice[e.symbol] = e.price;
    }
  };
  for (const t of days) {
    while (i < events.length && events[i].t <= t) apply(events[i++]);
    out.push([new Date(t).toISOString(), cents(valueAt(t)), cents(invested)]);
  }
  while (i < events.length) apply(events[i++]);
  // Now: exactly what the account's card shows.
  const now = summarize(portfolio, quotes).accounts[currency];
  out.push([new Date().toISOString(), cents(now.equity), cents(now.invested)]);
  return { points: out, flows };
}

// What the same money would have been worth in the index fund at each of `hist`'s times (as
// valueHistory returns): the index bought with the account's starting money (bench, from
// benchmarkFor), topped up with money converted into the account at that time's index price, and
// drawn down by the same share of the holding as money converted out took from the account (so it
// can't go below zero). When the index's prices start after the account did (bench.partial), it
// starts instead from the account's value on the first day there's a price.
// { values: [number | null], since: iso, rebased: boolean }, or null without index prices.
export function indexHistory(portfolio, quotes, currency, bench, hist) {
  const q = quotes[bench?.symbol];
  if (!q || !hist.length) return null;
  let units, since;
  if (bench.partial) {
    const first = hist.find(([t]) => priceAt(q, Date.parse(t) / 1000) != null);
    if (!first) return null;
    since = Date.parse(first[0]);
    units = first[1] / priceAt(q, since / 1000);
  } else {
    since = Date.parse(bench.since);
    units = bench.shares;
  }
  const flows = replay(portfolio, quotes, currency).flows.filter((x) => x.t > since);
  let f = 0;
  const values = hist.map(([iso], i) => {
    const t = Date.parse(iso);
    if (t < since) return null;
    while (f < flows.length && flows[f].t <= t) {
      const { t: ft, amount, before } = flows[f++];
      if (amount >= 0) {
        const p = priceAt(q, ft / 1000) ?? priceAt(q, t / 1000);
        if (p) units += amount / p;
      } else units *= before > 0 ? Math.max(0, 1 + amount / before) : 0;
    }
    const p = i === hist.length - 1 ? q.price : priceAt(q, t / 1000);
    return p == null ? null : cents(units * p);
  });
  return { values, since: new Date(since).toISOString(), rebased: Boolean(bench.partial) };
}

// Cumulative realized profit (incl. dividends) over time for one currency: [[isoTime, total], ...].
export function realizedHistory(portfolio, currency) {
  const points = [];
  for (const t of portfolio.trades) if (t.currency === currency && t.realized) points.push([t.time, t.realized]);
  for (const a of portfolio.actions ?? []) if (a.currency === currency && a.kind === 'dividend' && a.amount) points.push([a.time, a.amount]);
  points.sort((a, b) => a[0].localeCompare(b[0]));
  let sum = 0;
  return points.map(([t, v]) => [t, cents(sum += v)]);
}
