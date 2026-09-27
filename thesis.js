// The short, structured thesis the AI gives with every idea (ai.js FUND_TOOL): how far it expects the
// price to go its way and over how long, the catalyst and its date, what would prove it wrong, and which
// playbook lessons it applied. Pure functions, shared by fund.js (which checks the thesis when an order
// is made), learning.js (which grades it for calibration), the AI's context, Telegram and the page.
//
// What code can check, it checks; it never asks an AI to judge:
//   - a stale catalyst: the catalyst's date is more than STALE_DAYS trading days before the idea.
//     For results, the date comes from the results calendar (calendar.js) where one is known, so a
//     results catalyst without a date, or with last quarter's, is dated correctly;
//   - whether the catalyst came within the idea's horizon: only for results (the calendar) and
//     dividends (the ex-dates in the price data);
//   - whether the expected move covers the round-trip fee (fund.js).
// Orders from before the thesis existed (and Tiger replays) have none: thesis null.

import { marketDate, tradingDaysBetween } from './markets.js';

export const HORIZON_DAYS = [5, 21, 63];
export const HORIZON_LABELS = { 5: 'a week', 21: 'a month', 63: 'a quarter' };
export const CATALYST_TYPES = ['results', 'guidance', 'dividend', 'rate_decision', 'macro_data', 'deal', 'product', 'valuation', 'technical', 'none'];
export const CATALYST_LABELS = {
  results: 'results', guidance: 'guidance', dividend: 'dividend', rate_decision: 'rate decision', macro_data: 'economic data',
  deal: 'deal', product: 'product news', valuation: 'valuation', technical: 'chart signal', none: 'no dated catalyst',
};
export const STALE_DAYS = 10; // a catalyst more than this many trading days old is stale
export const MAX_LESSONS_APPLIED = 3;
const NEAR_DAYS = 3; // a date this close to a known results date is those results

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const todayOf = (quote, now) => (quote?.market ? marketDate(quote.market, now) : now.toISOString().slice(0, 10));
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= NEAR_DAYS * 86400000;

// The thesis in an AI order or considered idea (the tool's snake_case fields), cleaned up:
// { expected (% in the idea's direction), horizon (trading days), catalyst, catalystDate ('' if none),
// wrongIf }, or null when the AI gave none (older decisions).
export function thesisOf(o) {
  if (!o || (o.expected_move_pct === undefined && o.horizon_days === undefined)) return null;
  const expected = Number(o.expected_move_pct);
  const horizon = Number(o.horizon_days);
  return {
    expected: Number.isFinite(expected) ? Math.round(Math.max(-100, Math.min(500, expected)) * 100) / 100 : null,
    horizon: HORIZON_DAYS.includes(horizon) ? horizon : null,
    catalyst: CATALYST_TYPES.includes(o.catalyst_type) ? o.catalyst_type : 'none',
    catalystDate: DATE.test(o.catalyst_date ?? '') ? o.catalyst_date : '',
    wrongIf: String(o.wrong_if ?? '').trim().slice(0, 200),
  };
}

// The playbook lessons the AI says it applied (their ids, or the text if it quoted one), at most 3.
export const lessonsAppliedOf = (o) => (Array.isArray(o?.lessons_applied) ? o.lessons_applied : [])
  .map((s) => String(s ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, MAX_LESSONS_APPLIED);

// A stock's known results dates (the first session that traded on each), past and next, from the
// results calendar (calendar.js resultsCalendar).
function resultsDates(calendar, symbol) {
  const c = calendar?.[symbol];
  if (!c) return [];
  return [...(c.past ?? []), ...(c.next ? [c.next] : [])].map((d) => d.effectiveDate ?? d.date).filter(Boolean).sort();
}

// The catalyst's date as code can check it: a results date the calendar knows within 3 days of the
// one given; for results without a date, the next results if they're still to come, else the last.
// Otherwise the date given, or '' when there's none.
export function catalystDateFor(thesis, symbol, { calendar = null, quotes = {}, now = new Date() } = {}) {
  if (!thesis) return '';
  if (thesis.catalyst === 'results') {
    const known = resultsDates(calendar, symbol);
    if (thesis.catalystDate) return known.find((d) => near(d, thesis.catalystDate)) ?? thesis.catalystDate;
    const today = todayOf(quotes[symbol], now);
    return known.find((d) => d >= today) ?? known.at(-1) ?? '';
  }
  return thesis.catalystDate;
}

// Trading days since the catalyst (0 on the day, negative while it's still to come), or null without a date.
export function catalystAge(thesis, symbol, opts = {}) {
  const date = catalystDateFor(thesis, symbol, opts);
  if (!date) return null;
  return tradingDaysBetween(date, todayOf(opts.quotes?.[symbol], opts.now ?? new Date()));
}

// The thesis of an order or considered idea as it's stored: thesisOf plus `stale` (the catalyst is
// over STALE_DAYS trading days old; null when it has no date) and `age` (its trading days).
export function checkedThesis(o, symbol, opts = {}) {
  const th = thesisOf(o);
  if (!th) return null;
  const age = catalystAge(th, symbol, opts);
  return { ...th, age, stale: age == null ? null : age > STALE_DAYS };
}

// Whether the catalyst came between unix times t0 and t1 (the idea and the end of its horizon), where
// code can tell: results from the calendar, dividends from the ex-dates Yahoo reports with the prices.
// For results, "no" needs the calendar to cover the window: a known results date on or before its
// start and the next one on or after its end, under COVER_DAYS apart (so no results between them can
// be missing); otherwise it can't tell. null for every other kind, or without the data.
export const COVER_DAYS = 100;
export function catalystPassed(thesis, symbol, t0, t1, { calendar = null, quote = null } = {}) {
  if (!thesis || !(t1 > t0)) return null;
  if (thesis.catalyst === 'results') {
    const known = resultsDates(calendar, symbol);
    const [a, b] = [dayOf(t0), dayOf(t1)];
    if (known.some((d) => d >= a && d <= b)) return true;
    const before = known.filter((d) => d <= a).at(-1), after = known.find((d) => d >= b);
    return before && after && Date.parse(after) - Date.parse(before) < COVER_DAYS * 86400000 ? false : null;
  }
  if (thesis.catalyst === 'dividend') {
    const divs = quote?.events?.dividends ?? [];
    if (!divs.length) return null;
    return divs.some(([t]) => t > t0 && t <= t1);
  }
  return null;
}

// A move in an idea's direction (a fraction) in words that read right for its side: "+6%" for a buy;
// for a short, the price's own move, "a 6% fall" (or "a 2% rise" when it went against it). `abs`
// formats the size.
export function moveWords(x, short = false, abs = (v) => `${Math.abs(Math.round(v * 1000) / 10)}%`) {
  if (short) return `a ${abs(x)} ${x >= 0 ? 'fall' : 'rise'}`;
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${abs(x)}`;
}

// Whether an expected move (percent) covers a round trip's fees (a share of the trade), or null if
// either is unknown.
export const beatsFees = (expectedPct, feeShare) => (expectedPct == null || feeShare == null ? null : expectedPct / 100 >= feeShare);

// The thesis behind a position the fund holds: the latest order that opened or added to it on that
// side (a fill, an order sent to Tiger or an approved proposal), with its time and price, or null
// when that order came without one. `side`: 'long' or 'short'.
export function positionThesis(fund, symbol, side) {
  const action = side === 'short' ? 'short' : 'buy';
  const approved = new Set((fund.proposals ?? []).filter((p) => p.status === 'approved').map((p) => p.id));
  const decisions = fund.decisions ?? [];
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    for (const o of [...(d.orders ?? [])].reverse()) {
      if (o.symbol !== symbol || o.action !== action) continue;
      const took = o.status === 'filled' || o.status === 'sent to Tiger' || (o.status === 'awaiting approval' && approved.has(o.proposalId));
      if (!took) continue;
      if (!o.thesis) return null;
      return { ...o.thesis, time: d.time, price: o.price ?? o.refPrice ?? null, lessons: o.lessonsApplied ?? [] };
    }
  }
  return null;
}

// How a position's thesis is doing: { daysLeft (trading days of its horizon left, negative once
// past), soFar (the price move in its direction since it was opened, a fraction, or null) }.
export function thesisProgress(pt, { price, short = false, quote = null, now = new Date() } = {}) {
  const opened = pt?.time ? (quote?.market ? marketDate(quote.market, new Date(pt.time)) : pt.time.slice(0, 10)) : null;
  const daysLeft = pt?.horizon && opened ? pt.horizon - tradingDaysBetween(opened, todayOf(quote, now)) : null;
  const soFar = pt?.price > 0 && price > 0 ? (short ? -1 : 1) * (price / pt.price - 1) : null;
  return { daysLeft, soFar };
}
