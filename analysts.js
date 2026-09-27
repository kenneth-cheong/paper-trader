// What brokers' analysts say about each stock, from Yahoo Finance's quoteSummary (fetched once a day by
// scripts/yahoo_fetch.py summary, turned into state/company-data.json by scripts/company-data.mjs).
// Pure functions. Kept as dated facts, never as advice: the next results date (and whether Yahoo only
// estimates it), the last few quarters' earnings surprises, how many analysts rate it buy, hold or
// sell, their average price target, and real rating changes (an upgrade or a downgrade; a rating
// "maintained" or "reiterated", or only a new price target, isn't a change).
// US stocks have a long history of rating changes on Yahoo; SGX stocks have none, and fewer analysts.

import { BENCHMARKS, sessionLength } from './benchmark.js';
import { marketDate, tradingDaysBetween } from './markets.js';

// Brokers use their own words for the same few ratings. Each maps to a level from 1 (sell) to 5
// (strong buy), so a change can be told apart from a firm renaming its scale.
export const RATING_LEVELS = {
  'strong buy': 5, 'top pick': 5, 'conviction buy': 5,
  buy: 4, outperform: 4, overweight: 4, accumulate: 4, add: 4, positive: 4, 'market outperform': 4, 'sector outperform': 4,
  'moderate buy': 4, 'speculative buy': 4, 'long-term buy': 4, outperformer: 4, 'above average': 4,
  hold: 3, neutral: 3, 'equal-weight': 3, 'equal weight': 3, 'market perform': 3, 'sector perform': 3, 'peer perform': 3,
  'in-line': 3, inline: 3, perform: 3, 'sector weight': 3, 'market weight': 3, mixed: 3, 'fair value': 3,
  underperform: 2, underweight: 2, reduce: 2, 'moderate sell': 2, 'sector underperform': 2, 'market underperform': 2,
  negative: 2, 'below average': 2, underperformer: 2,
  sell: 1, 'strong sell': 1,
};
export const LEVEL_LABELS = { 5: 'Strong Buy', 4: 'Buy', 3: 'Hold', 2: 'Underperform', 1: 'Sell' };

export const ratingLevel = (grade) => RATING_LEVELS[String(grade ?? '').trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;

const CHANGE_DAYS = 400; // rating changes kept: enough to cover the year of daily prices
const MAX_CHANGES = 60; // per stock
const MAX_EPS = 8; // quarters of earnings surprises kept
const MAX_PAST = 12; // past results dates kept per stock
const raw = (x) => (typeof x === 'number' ? x : typeof x?.raw === 'number' ? x.raw : null);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
const dayOf = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

// A real rating change from one row of Yahoo's upgradeDowngradeHistory, or null. Yahoo's action is
// up, down, main (maintains), reit (reiterates) or init (starts coverage); only up and down are
// changes, and not when both ratings mean the same level (a firm renaming its scale).
// As a compact row: [unixSeconds, firm, from, to, direction (+1 up, -1 down), prior target, target].
export function ratingChange(row) {
  if (!row || !['up', 'down'].includes(row.action) || !(row.epochGradeDate > 0)) return null;
  const from = String(row.fromGrade ?? '').trim(), to = String(row.toGrade ?? '').trim();
  if (!to || from.toLowerCase() === to.toLowerCase()) return null;
  const a = ratingLevel(from), b = ratingLevel(to);
  if (a != null && b != null && a === b) return null;
  const dir = a != null && b != null ? Math.sign(b - a) : row.action === 'up' ? 1 : -1;
  const target = (x) => (x > 0 ? Math.round(x * 100) / 100 : null);
  return [row.epochGradeDate, String(row.firm ?? '').slice(0, 40), from.slice(0, 30), to.slice(0, 30), dir, target(row.priorPriceTarget), target(row.currentPriceTarget)];
}

// One stock's record for company-data.json from its quoteSummary result (modules calendarEvents,
// earningsHistory, upgradeDowngradeHistory, recommendationTrend, financialData), merged with the
// previous record so history builds up day by day:
//   next:    { date, estimate } the next results date on or after today, or null. Yahoo sometimes
//            still shows last quarter's date; a date in the past means "not known yet".
//   past:    results dates that have passed (confirmed ones only), oldest first
//   eps:     [{ quarter (the quarter's END date), actual, estimate, surprise (a fraction) }]
//   ratings: { strongBuy, buy, hold, sell, strongSell } this month, target: { mean, median, high, low, n }
//   changes: real rating changes (compact rows, see ratingChange), newest first; ratingRows: how many
//            rows Yahoo returned in all (0 for SGX stocks)
export function parseCompany(r, now = new Date(), prev = null) {
  const today = now.toISOString().slice(0, 10);
  const cal = r?.calendarEvents?.earnings ?? {};
  const estimate = cal.isEarningsDateEstimate === true;
  const dates = (cal.earningsDate ?? []).map((d) => (isDate(d?.fmt) ? d.fmt : raw(d) ? dayOf(raw(d)) : null)).filter(isDate).sort();
  const past = new Set((prev?.past ?? []).filter(isDate));
  if (!estimate) dates.filter((d) => d < today).forEach((d) => past.add(d));
  if (prev?.next && !prev.next.estimate && prev.next.date < today) past.add(prev.next.date);
  for (const d of cal.earningsCallDate ?? []) {
    const day = isDate(d?.fmt) ? d.fmt : raw(d) ? dayOf(raw(d)) : null;
    if (day && day < today) past.add(day);
  }
  const nextDate = dates.find((d) => d >= today);

  const eps = new Map((prev?.eps ?? []).map((e) => [e.quarter, e]));
  for (const h of r?.earningsHistory?.history ?? []) {
    const quarter = h?.quarter?.fmt;
    if (!isDate(quarter)) continue;
    eps.set(quarter, { quarter, actual: raw(h.epsActual), estimate: raw(h.epsEstimate), surprise: raw(h.surprisePercent) });
  }

  const trend = (r?.recommendationTrend?.trend ?? []).find((t) => t?.period === '0m');
  const fd = r?.financialData ?? {};
  const history = r?.upgradeDowngradeHistory?.history ?? [];
  const since = now.getTime() / 1000 - CHANGE_DAYS * 86400;
  const changes = new Map((prev?.changes ?? []).map((c) => [`${c[0]}|${c[1]}`, c]));
  for (const row of history) {
    const c = ratingChange(row);
    if (c) changes.set(`${c[0]}|${c[1]}`, c);
  }
  return {
    next: nextDate ? { date: nextDate, estimate } : null,
    past: [...past].sort().slice(-MAX_PAST),
    eps: [...eps.values()].sort((a, b) => a.quarter.localeCompare(b.quarter)).slice(-MAX_EPS),
    ratings: trend ? { strongBuy: trend.strongBuy ?? 0, buy: trend.buy ?? 0, hold: trend.hold ?? 0, sell: trend.sell ?? 0, strongSell: trend.strongSell ?? 0 } : prev?.ratings ?? null,
    target: raw(fd.targetMeanPrice) ? {
      mean: raw(fd.targetMeanPrice), median: raw(fd.targetMedianPrice), high: raw(fd.targetHighPrice), low: raw(fd.targetLowPrice),
      n: raw(fd.numberOfAnalystOpinions),
    } : prev?.target ?? null,
    changes: [...changes.values()].filter((c) => c[0] >= since).sort((a, b) => b[0] - a[0]).slice(0, MAX_CHANGES),
    ratingRows: history.length,
  };
}

// Whether today's quoteSummary fetch is due: once a day, on the run after the US close (22:00 UTC or
// later) if it hasn't fetched since 22:00 that day, or on any earlier run when the last good fetch is
// over 30 hours old (a missed evening, or the weekend). A catch-up fetch never moves the next one off
// the evening: that evening is still due. Never twice within 2 hours, so a Yahoo outage isn't retried
// every 15 minutes.
export function summaryDue(data, now = new Date()) {
  if (data?.triedAt && now - Date.parse(data.triedAt) < 2 * 3600000) return false;
  if (!data?.fetchedAt) return true;
  const last = Date.parse(data.fetchedAt);
  const evening = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22);
  return now >= evening ? last < evening : now - last > 30 * 3600000;
}

// ---------- for the AI and the page ----------

const BUY = (r) => r.strongBuy + r.buy, SELL = (r) => r.sell + r.strongSell;

// A stock's rating changes since `sinceS` (unix seconds), newest first, each with the stock's move
// since the change (from the last close before it), and the index's over the same time.
export function changesSince(symbol, company, quotes, sinceS) {
  const rec = company?.symbols?.[symbol];
  const q = quotes?.[symbol];
  if (!rec?.changes?.length || !q) return [];
  const iq = quotes[BENCHMARKS[q.currency]?.symbol];
  const before = (quote, t) => {
    let p = null;
    for (const [bt, c] of quote?.daily ?? []) { if (bt + sessionLength(quote) <= t) p = c; else break; }
    return p;
  };
  return rec.changes.filter((c) => c[0] >= sinceS).map(([t, firm, from, to, dir, targetFrom, targetTo]) => {
    const p0 = before(q, t), i0 = before(iq, t);
    const move = p0 > 0 && q.price > 0 ? q.price / p0 - 1 : null;
    const index = i0 > 0 && iq?.price > 0 ? iq.price / i0 - 1 : null;
    return { symbol, t, date: dayOf(t), firm, from, to, dir, targetFrom, targetTo, move, index };
  });
}

// Every real rating change in a market over the last `days` calendar days, newest first (for the
// market-memory panel's "Broker rating changes" list).
export function recentRatingChanges(company, quotes, market, now = new Date(), days = 30) {
  const since = now.getTime() / 1000 - days * 86400;
  return Object.keys(company?.symbols ?? {}).filter((s) => quotes?.[s]?.market === market)
    .flatMap((s) => changesSince(s, company, quotes, since)).sort((a, b) => b.t - a.t);
}

const pctText = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
export const describeChange = (c) => `${c.firm} ${c.from || 'new'}→${c.to}${c.targetTo ? `, target ${c.targetFrom ? `${c.targetFrom}→` : ''}${c.targetTo}` : ''}`;

// What the AI sees for one stock, or null when Yahoo has nothing: how many analysts and how they
// rate it, the average target and how far above or below the price it is, and rating changes in the
// last 10 trading days with the move since.
export function analystsForPrompt(symbol, company, quotes, now = new Date()) {
  const rec = company?.symbols?.[symbol];
  const q = quotes?.[symbol];
  if (!rec || !q) return null;
  const r = rec.ratings;
  const n = rec.target?.n ?? (r ? BUY(r) + r.hold + SELL(r) : 0);
  if (!n && !rec.changes?.length) return null;
  const today = marketDate(q.market, now);
  const recent = changesSince(symbol, company, quotes, now.getTime() / 1000 - 20 * 86400)
    .filter((c) => tradingDaysBetween(c.date, today) <= 10);
  const target = rec.target?.mean ?? null;
  return {
    n,
    ...(r ? { buy_hold_sell: [BUY(r), r.hold, SELL(r)] } : {}),
    consensus_target: target,
    implied_upside_pct: target && q.price > 0 ? Math.round((target / q.price - 1) * 1000) / 10 : null,
    rating_changes_10d: recent.map((c) => `${c.date} ${describeChange(c)}${c.move == null ? '' : `, move since ${pctText(c.move)}`}`),
  };
}
