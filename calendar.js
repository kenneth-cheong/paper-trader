// The results calendar: when each stock reports, from the best source there is, and how much its
// results days have moved it. Pure functions; the scheduled job, the AI, Telegram and the page use them.
//
// Sources, best first:
//   filing     US results releases filed with the SEC (an 8-K with item 2.02; Berkshire Hathaway
//              publishes its results in the 10-Q or 10-K itself), with the exact time they were
//              accepted. scripts/fetch-filings.mjs keeps them in state/results-dates.json. Needs the
//              SEC_USER_AGENT repository variable; without it, Yahoo's dates are used for US stocks too.
//   yahoo      the next results date on Yahoo Finance, confirmed by the company (state/company-data.json)
//   estimated  Yahoo's estimate, often a guess from last year's timing (most SGX dates until confirmed)
// Filings only ever give dates that have passed, so a filing is "next" only on the day it lands: a
// release after the 4pm close is first traded on the next session.

import { BENCHMARKS, sessionLength } from './benchmark.js';
import { divsBetween } from './actions.js';
import { sessionDateAfter, marketDate, tradingDaysBetween } from './markets.js';
import { plausibleDate } from './memory.js';

// Stocks whose results are published in the quarterly report itself rather than a separate 8-K.
export const RESULTS_IN_REPORTS = new Set(['BRK-B']);
const NEAR_DAYS = 3; // two dates this close are the same results
const MAX_FILINGS = 16; // per stock: four years of quarters

const dayMs = 86400000;
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= NEAR_DAYS * dayMs;
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// ---------- SEC filings ----------

// Results releases in one page of EDGAR's submissions JSON (`filings.recent`, or one of the older
// `filings.files` pages): parallel arrays form[], items[], acceptanceDateTime[], accessionNumber[], ...
// acceptanceDateTime ends in 'Z' but is really US Eastern time, so its clock reading is used as is.
// Each: { date (the release day in New York), time ('YYYY-MM-DDTHH:MM' New York time), effectiveDate
// (the first session that could react: the next one when accepted after 16:00 or at a weekend), form, url }.
export function resultsFromSubmissions(page, symbol, cik = '') {
  const inReports = RESULTS_IN_REPORTS.has(symbol);
  const out = [];
  const forms = page?.form ?? [];
  for (let i = 0; i < forms.length; i++) {
    const items = String(page.items?.[i] ?? '').split(',').map((x) => x.trim());
    const isResults = inReports ? ['10-Q', '10-K'].includes(forms[i]) : forms[i] === '8-K' && items.includes('2.02');
    const accepted = String(page.acceptanceDateTime?.[i] ?? '');
    if (!isResults || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(accepted)) continue;
    const date = accepted.slice(0, 10);
    const mins = Number(accepted.slice(11, 13)) * 60 + Number(accepted.slice(14, 16));
    const acc = String(page.accessionNumber?.[i] ?? '');
    out.push({
      date, time: accepted.slice(0, 16), effectiveDate: sessionDateAfter('US', date, mins), form: forms[i],
      url: acc && cik ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${page.primaryDocument?.[i] ?? ''}` : null,
    });
  }
  return out;
}

// Adds newly found releases to a stock's list: one per results (an amended or second filing within
// 3 days is the same results, the first kept), oldest first, the last MAX_FILINGS.
export function mergeFilings(list, fresh) {
  const all = [...(list ?? []), ...(fresh ?? [])].sort((a, b) => a.time.localeCompare(b.time));
  const out = [];
  for (const f of all) if (!out.some((x) => near(x.date, f.date))) out.push(f);
  return out.slice(-MAX_FILINGS);
}

// Whether the filings check is due: at most every 2 hours, and always on the run after the US close
// (22:00 UTC or later) if it hasn't run since 22:00 that day.
export function filingsDue(data, now = new Date()) {
  if (!data?.checkedAt) return true;
  const last = Date.parse(data.checkedAt);
  if (now - last >= 2 * 3600000) return true;
  const evening = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22);
  return now >= evening && last < evening;
}

// ---------- the calendar ----------

// How much a stock's results days moved it against the index: the average size (up or down) of the
// day's total return minus the index's, over past results. A date with an exact release time counts
// its first session; for one without (it may have come before the open or after the close) the
// bigger of that day and the next. { avg, n }, or null with fewer than 2 results in the price history.
export function typicalResultsMove(q, iq, past) {
  const bars = q?.daily ?? [];
  if (bars.length < 2) return null;
  const sl = sessionLength(q);
  const ib = new Map((iq?.daily ?? []).map((b, i, a) => [dateOf(b[0]), i > 0 ? b[1] / a[i - 1][1] - 1 + divsBetween(iq, a[i - 1][0] + sessionLength(iq), b[0] + sessionLength(iq)) / a[i - 1][1] : null]));
  const excess = (i) => {
    if (i < 1 || i >= bars.length) return null;
    const r = bars[i][1] / bars[i - 1][1] - 1 + divsBetween(q, bars[i - 1][0] + sl, bars[i][0] + sl) / bars[i - 1][1];
    return Math.abs(r - (ib.get(dateOf(bars[i][0])) ?? 0));
  };
  const moves = [];
  for (const p of past) {
    const day = p.effectiveDate ?? p.date;
    const i = bars.findIndex(([t]) => dateOf(t) >= day);
    if (i < 1) continue;
    const x = p.effectiveDate ? excess(i) : Math.max(excess(i) ?? 0, excess(i + 1) ?? 0);
    if (x != null) moves.push(x);
  }
  return moves.length >= 2 ? { avg: moves.reduce((s, x) => s + x, 0) / moves.length, n: moves.length } : null;
}

// Every stock's results: { SYMBOL: { next: { date, source, effectiveDate?, time? } | null,
// past: [{ date, source, effectiveDate? }], typicalMove: { avg, n } | null } }.
// `company` is company-data.json, `filings` results-dates.json, `events` the market memory's news
// events (memory.js marketEvents; their results dates fill in the past where nothing better has one). Either file may be
// missing; a stock without any date is left out.
export function resultsCalendar({ company = null, filings = null, quotes = {}, events = [], now = new Date() }) {
  const symbols = new Set([...Object.keys(company?.symbols ?? {}), ...Object.keys(filings?.symbols ?? {})]);
  const out = {};
  for (const symbol of symbols) {
    const q = quotes[symbol];
    if (!q) continue;
    const today = marketDate(q.market, now);
    const fl = filings?.symbols?.[symbol] ?? [];
    const rec = company?.symbols?.[symbol];

    const past = fl.filter((f) => f.effectiveDate < today).map((f) => ({ date: f.date, effectiveDate: f.effectiveDate, source: 'filing' }));
    const add = (date, source, extra = {}) => { if (date < today && !past.some((p) => near(p.date, date))) past.push({ date, source, ...extra }); };
    for (const d of rec?.past ?? []) add(d, 'yahoo');
    for (const e of events) {
      if (e.symbol === symbol && e.type === 'earnings' && e.from !== 'filing' && plausibleDate(e)) add(e.date, 'news', e.effectiveDate ? { effectiveDate: e.effectiveDate } : {});
    }
    past.sort((a, b) => a.date.localeCompare(b.date));

    let next = null;
    const landed = fl.find((f) => f.effectiveDate >= today);
    if (landed) next = { date: landed.date, effectiveDate: landed.effectiveDate, time: landed.time, source: 'filing' };
    else if (rec?.next?.date >= today && !fl.some((f) => near(f.date, rec.next.date))) {
      next = { date: rec.next.date, source: rec.next.estimate ? 'estimated' : 'yahoo' };
    }
    if (!next && !past.length) continue;
    out[symbol] = { next, past, typicalMove: typicalResultsMove(q, quotes[BENCHMARKS[q.currency]?.symbol], past) };
  }
  return out;
}

// A stock's next results, with how many trading days away they are (0 = today), or null. For a
// filing (already out), days are counted to the first session that trades on it.
export function nextResults(calendar, symbol, quotes, now = new Date()) {
  const next = calendar?.[symbol]?.next;
  const q = quotes?.[symbol];
  if (!next || !q) return null;
  const today = marketDate(q.market, now);
  return { ...next, daysAway: tradingDaysBetween(today, next.source === 'filing' ? next.effectiveDate : next.date) };
}

const pct1 = (x) => Math.round(x * 1000) / 10;

// For the AI: results in the next `days` trading days among `symbols`, soonest first.
export function upcomingResults(calendar, quotes, symbols, now = new Date(), days = 10) {
  return symbols.map((symbol) => ({ symbol, n: nextResults(calendar, symbol, quotes, now) }))
    .filter(({ n }) => n && n.daysAway >= 0 && n.daysAway <= days)
    .sort((a, b) => a.n.daysAway - b.n.daysAway || a.symbol.localeCompare(b.symbol))
    .map(({ symbol, n }) => ({
      symbol, date: n.date, days_away: n.daysAway,
      ...(n.source === 'filing' ? { released: `${n.time.slice(11)} New York time; first traded ${n.effectiveDate}` } : {}),
      typical_results_day_move_pct: calendar[symbol].typicalMove ? pct1(calendar[symbol].typicalMove.avg) : null,
      source: n.source,
    }));
}
