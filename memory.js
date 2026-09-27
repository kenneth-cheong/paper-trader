// Market memory: how each market's stocks have behaved after news and after big one-day moves,
// measured on the last year of daily prices. Pure functions, no AI. Every AI fund in that market sees
// the lessons (with their evidence), and the AI fund page shows them.
//
// Two studies:
//   - News events (from a one-off backfill of the past year, see scripts/backfill-news.mjs, plus every
//     daily news digest from then on): the price move on the day of the news (the first trading day
//     on or after it), then the drift over the next week (5 trading days) and month (21), each
//     against the index. A positive story "continues" if the drift keeps going up; negative, down.
//   - Big moves (prices only, free): after a one-day move of BIG_MOVE or more, what the next week
//     and month did against the index: continued, or gave some back.
// The AI only ever supplies what happened (date, headline, type, positive or negative); all price
// moves are measured here, so the lessons aren't the AI's opinion of itself. Moves are total returns:
// dividends that went ex in between count, for the stock and the index (actions.js dividendReturn).
// An event can carry `effectiveDate`, the first trading day that could react to it (US results out
// after the close count from the next day), and is then measured from that day instead of its date.
// Where primary sources exist they replace what the AI recalled (marketEvents): US results come from
// SEC filings with their exact release time, and rating changes from Yahoo's dated list. SGX news
// dates are checked against the day's trading volume, since results and big news trade heavily.
// Lessons use the same evidence engine as the funds' own (stats.js): the drift after allowing for each
// stock's beta, in separate bets (the same stock moving the same way within a week is one), with the
// uncertainty worked out by date, so one market-wide selloff that hit every stock counts once.

import { BENCHMARKS, sessionLength } from './benchmark.js';
import { divsBetween, dividendReturn } from './actions.js';
import { sessionDateFor, marketDate, tradingDaysBetween } from './markets.js';
import { describeChange } from './analysts.js';
import { betaAt, separateBets, estimate, lessonStatus, confidenceOf } from './stats.js';

export const EVENT_TYPES = ['earnings', 'guidance', 'deal', 'product', 'legal', 'management', 'analyst', 'macro', 'other'];
export const TONES = ['positive', 'negative', 'mixed'];
export const BIG_MOVE = 0.04;
export const MIN_CASES = 5; // the page's chart only draws rows with at least this many cases
const MARKET_CURRENCY = { US: 'USD', SGX: 'SGD' };

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const share = (x) => `${Math.round(x * 100)}%`;
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10); // a daily bar's trading date

// ---------- the event list ----------

const eventKey = (e) => `${e.symbol}|${e.date}|${String(e.headline).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}`;

// Adds events (deduplicated), keeping only watchlist stocks and well-formed ones. Newest last.
export function mergeEvents(list, fresh, quotes) {
  const all = Array.isArray(list) ? [...list] : [];
  const seen = new Set(all.map(eventKey));
  for (const e of fresh ?? []) {
    if (!quotes[e.symbol] || !/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? '') || !e.headline) continue;
    const ev = {
      symbol: e.symbol, date: e.date, headline: String(e.headline).slice(0, 200),
      type: EVENT_TYPES.includes(e.type) ? e.type : 'other', tone: TONES.includes(e.tone) ? e.tone : 'mixed',
      source_url: e.source_url ?? null, from: e.from ?? 'digest',
    };
    const effective = effectiveDateOf(e, quotes[e.symbol].market);
    if (effective) ev.effectiveDate = effective;
    const k = eventKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(ev);
  }
  return all.sort((a, b) => a.date.localeCompare(b.date)).slice(-3000);
}

// The first trading day that could react to an event: its `effectiveDate` if it has a valid one, else
// worked out from its exact release `time` (an ISO time with offset) when it has one, else null (the
// event's own date is used).
export function effectiveDateOf(e, market) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(e.effectiveDate ?? '')) return e.effectiveDate;
  if (e.time && market && !Number.isNaN(Date.parse(e.time))) return sessionDateFor(market, e.time);
  return null;
}

// Company news from a daily digest, one event per stock it names.
export function eventsFromDigest(news) {
  return (news?.items ?? []).flatMap((i) => (i.symbols ?? []).map((symbol) => ({ symbol, date: String(i.date ?? '').slice(0, 10), headline: i.headline, type: i.type, tone: i.tone, source_url: i.source_url, from: 'digest' })));
}

// ---------- events from primary sources ----------

const IN_LINE = 0.02; // an EPS surprise, or a first-day move against the index, within ±2% is "mixed"
const VOLUME_SPIKE = 1.8; // a news day trades at least this multiple of the median volume...
const VOLUME_DAYS = 20; // ...of the previous 20 sessions
const VOLUME_SEARCH = 3; // sessions either side to look for the real date
const dayMs = 86400000;
const toneOf = (x) => (x >= IN_LINE ? 'positive' : x <= -IN_LINE ? 'negative' : 'mixed');

// The first session on or after `day`: its total return minus the index's, or null.
function firstDayExcess(q, index, day) {
  const bars = q.daily ?? [];
  const i = bars.findIndex(([t]) => dateOf(t) >= day);
  if (i < 1) return null;
  const sl = sessionLength(q);
  const r = bars[i][1] / bars[i - 1][1] - 1 + divsBetween(q, bars[i - 1][0] + sl, bars[i][0] + sl) / bars[i - 1][1];
  const k = (index.q?.daily ?? []).findIndex(([t]) => dateOf(t) === dateOf(bars[i][0]));
  if (k < 1) return r;
  const ib = index.q.daily, isl = sessionLength(index.q);
  return r - (ib[k][1] / ib[k - 1][1] - 1 + divsBetween(index.q, ib[k - 1][0] + isl, ib[k][0] + isl) / ib[k - 1][1]);
}

// US results from SEC filings (calendar.js resultsFromSubmissions), as events measured from their
// exact first session. The tone is the EPS surprise of the quarter they report (Yahoo's
// earningsHistory: the last quarter that ended within 120 days before the release), or, without one,
// the first day's move against the index. Within ±2% it is "mixed", which the memory leaves out.
export function eventsFromFilings(filings, company, quotes) {
  const out = [];
  for (const [symbol, list] of Object.entries(filings?.symbols ?? {})) {
    const q = quotes[symbol];
    if (!q) continue;
    const index = indexBars(quotes, q.market);
    const eps = company?.symbols?.[symbol]?.eps ?? [];
    for (const f of list) {
      const quarter = eps.filter((e) => e.quarter < f.date && Date.parse(f.date) - Date.parse(e.quarter) <= 120 * dayMs).at(-1);
      const surprise = quarter?.surprise ?? null;
      const reaction = surprise == null ? firstDayExcess(q, index, f.effectiveDate) : null;
      out.push({
        symbol, date: f.date, effectiveDate: f.effectiveDate, type: 'earnings', from: 'filing', source_url: f.url ?? null,
        tone: toneOf(surprise ?? reaction ?? 0),
        headline: surprise != null && quarter.actual != null
          ? `Results: EPS ${quarter.actual} vs ${quarter.estimate} expected (${pct(surprise)})`
          : `Results released ${f.time.slice(11)} New York time (${f.form})`,
      });
    }
  }
  return out;
}

// Real rating changes on Yahoo (analysts.js), as analyst events. Changes to one stock within 3
// trading days of each other are one event (brokers often move together after results); its tone is
// the balance of upgrades and downgrades.
export function analystEvents(company, quotes) {
  const out = [];
  for (const [symbol, rec] of Object.entries(company?.symbols ?? {})) {
    const q = quotes[symbol];
    if (!q || !rec.changes?.length) continue;
    const groups = [];
    for (const c of [...rec.changes].sort((a, b) => a[0] - b[0])) {
      const day = marketDate(q.market, new Date(c[0] * 1000));
      const g = groups.at(-1);
      if (g && tradingDaysBetween(g.day, day) <= 3) g.changes.push(c);
      else groups.push({ day, t: c[0], changes: [c] });
    }
    for (const g of groups) {
      const net = g.changes.reduce((s, c) => s + c[4], 0);
      out.push({
        symbol, date: g.day, effectiveDate: sessionDateFor(q.market, g.t * 1000), type: 'analyst', from: 'yahoo', source_url: null,
        tone: net > 0 ? 'positive' : net < 0 ? 'negative' : 'mixed',
        headline: g.changes.map(([, firm, from, to, , targetFrom, targetTo]) => describeChange({ firm, from, to, targetFrom, targetTo })).join('; ').slice(0, 200),
      });
    }
  }
  return out;
}

// An SGX news date the AI gave, checked against trading volume: kept if that day traded at least
// VOLUME_SPIKE times the median of the previous 20 sessions; if only the next day did, the news came
// after the close, so it's measured from that next day (its effectiveDate); otherwise moved to the
// heaviest such day within 3 sessions either side (as its effectiveDate); otherwise null (dropped).
// Unchecked when there's no volume data or the date is too recent.
export function checkVolumeDate(e, q) {
  const bars = q?.daily ?? [];
  if (!bars.some((b) => b[2] > 0)) return e;
  const i = bars.findIndex(([t]) => dateOf(t) >= (e.effectiveDate ?? e.date));
  if (i < 0) return e;
  const ratio = (k) => {
    if (k < 1 || k >= bars.length || !(bars[k][2] > 0)) return null;
    const prior = bars.slice(Math.max(0, k - VOLUME_DAYS), k).map((b) => b[2]).filter((v) => v > 0).sort((a, b) => a - b);
    return prior.length >= VOLUME_DAYS / 2 ? bars[k][2] / prior[Math.floor(prior.length / 2)] : null;
  };
  if (ratio(i) == null) return e;
  if (ratio(i) >= VOLUME_SPIKE) return e;
  if ((ratio(i + 1) ?? 0) >= VOLUME_SPIKE) return { ...e, effectiveDate: dateOf(bars[i + 1][0]) }; // out after the close
  if (i === bars.length - 1) return e; // the next session hasn't traded yet
  let best = null;
  for (let k = i - VOLUME_SEARCH; k <= i + VOLUME_SEARCH; k++) {
    const r = ratio(k);
    if (r >= VOLUME_SPIKE && (best == null || r > best.r)) best = { k, r };
  }
  return best ? { ...e, effectiveDate: dateOf(bars[best.k][0]) } : null;
}

// The events the memory measures: the saved news events (from the digests and the backfill) with
// primary sources taking over where they exist. SEC filings replace the AI's results events for
// those US stocks (from 3 days before the first filing on, so a misdated duplicate can't survive);
// Yahoo's rating changes replace its analyst events for stocks Yahoo covers; and SGX dates from the
// AI must pass the volume check.
export function marketEvents(newsEvents, quotes, { filings = null, company = null } = {}) {
  const filed = eventsFromFilings(filings, company, quotes);
  const rated = analystEvents(company, quotes);
  const filedFrom = {};
  for (const e of filed) if (!filedFrom[e.symbol] || e.date < filedFrom[e.symbol]) filedFrom[e.symbol] = e.date;
  const covered = new Set(Object.entries(company?.symbols ?? {}).filter(([, r]) => r.ratingRows > 0 || r.changes?.length).map(([s]) => s));
  const kept = [];
  for (const e of newsEvents ?? []) {
    const q = quotes[e.symbol];
    if (!q) continue;
    if (e.type === 'earnings' && filedFrom[e.symbol] && Date.parse(e.date) >= Date.parse(filedFrom[e.symbol]) - 3 * dayMs) continue;
    if (e.type === 'analyst' && covered.has(e.symbol)) continue;
    const checked = q.market === 'SGX' && ['digest', 'backfill', undefined].includes(e.from) ? checkVolumeDate(e, q) : e;
    if (checked) kept.push(checked);
  }
  return [...kept, ...filed, ...rated].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- measuring ----------

// { day, week, month } total returns in direction `dir` (+1 or -1) after bar `i` of the quote's daily
// bars: the day from the previous close, then the drift from bar i's close. Each is { move, index },
// the index's return over the same days in the same direction.
function movesAfter(q, i, index, dir) {
  const bars = q.daily;
  const close = (k) => bars[k][0] + sessionLength(q);
  const ret = (a, b) => dir * (bars[b][1] / bars[a][1] - 1) + dividendReturn(q, close(a), close(b), dir, bars[a][1]);
  const idx = (a, b) => {
    const i0 = index.byDate.get(dateOf(bars[a][0])), i1 = index.byDate.get(dateOf(bars[b][0]));
    if (!i0 || !i1) return null;
    return dir * (i1[1] / i0[1] - 1) + dividendReturn(index.q, i0[0] + sessionLength(index.q), i1[0] + sessionLength(index.q), dir, i0[1]);
  };
  const out = { day: i >= 1 ? { move: ret(i - 1, i), index: idx(i - 1, i) } : null };
  for (const [key, n] of [['week', 5], ['month', 21]]) out[key] = bars[i + n] ? { move: ret(i, i + n), index: idx(i, i + n) } : null;
  return out;
}

function indexBars(quotes, market) {
  const q = quotes[BENCHMARKS[MARKET_CURRENCY[market]]?.symbol];
  return { q, byDate: new Map((q?.daily ?? []).map((bar) => [dateOf(bar[0]), bar])) };
}

// Results are never announced within days of the quarter ending, so an earnings event dated in the
// last week of March, June, September or December is really the period's end date, not the news date.
// Only an exactly timed release (an SEC filing, or an event with its release time) is trusted as it
// is: a date the volume check moved (its effectiveDate) started from the quarter end, and a volume
// spike near it may be something else (a rebalance, an ex-date).
export function plausibleDate(e) {
  if (e.type !== 'earnings' || e.from === 'filing' || e.time) return true;
  const [, m, d] = e.date.split('-').map(Number);
  return !([3, 6, 9, 12].includes(m) && d >= 24);
}

// Each news event with the moves after it (in the direction of its tone: + means it went the way the
// news pointed). Events before the price history, or too recent to have a week after, are left out.
export function measureEvents(events, quotes, market) {
  const index = indexBars(quotes, market);
  const out = [];
  for (const e of events) {
    const q = quotes[e.symbol];
    if (!q || q.market !== market || e.tone === 'mixed' || !plausibleDate(e)) continue;
    const bars = q.daily ?? [];
    const day = e.effectiveDate ?? e.date;
    const i = bars.findIndex(([t]) => dateOf(t) >= day);
    if (i < 1) continue;
    const direction = e.tone === 'negative' ? -1 : 1;
    const m = movesAfter(q, i, index, direction);
    if (!m.week) continue;
    const { beta, idio } = betaAt(q, bars[i][0], index.q);
    out.push({ ...e, t: bars[i][0], direction, beta, idio, day: m.day, week: m.week, month: m.month });
  }
  return out;
}

// Every one-day move of BIG_MOVE or more in the market's stocks (not the index itself), with what
// followed, in the direction of the move.
export function bigMoves(quotes, market) {
  const index = indexBars(quotes, market);
  const indexSymbol = BENCHMARKS[MARKET_CURRENCY[market]]?.symbol;
  const out = [];
  for (const [symbol, q] of Object.entries(quotes)) {
    if (q.market !== market || symbol === indexSymbol) continue;
    const bars = q.daily ?? [];
    const sl = sessionLength(q);
    for (let i = 1; i < bars.length; i++) {
      // the day's total return before tax, so a stock going ex-dividend isn't a "drop"
      const r = bars[i][1] / bars[i - 1][1] - 1 + divsBetween(q, bars[i - 1][0] + sl, bars[i][0] + sl) / bars[i - 1][1];
      if (Math.abs(r) < BIG_MOVE) continue;
      const m = movesAfter(q, i, index, Math.sign(r));
      if (!m.week) continue;
      const { beta, idio } = betaAt(q, bars[i][0], index.q);
      out.push({ symbol, date: dateOf(bars[i][0]), t: bars[i][0], direction: Math.sign(r), beta, idio, move: r, week: m.week, month: m.month });
    }
  }
  return out;
}

// n, average drift in the direction (+ = continued), share that continued, average vs the index, and
// `est`: the drift after beta as an estimate (stats.js), in separate bets clustered by date.
export function driftStats(list, horizon = 'week') {
  const xs = list.filter((x) => x[horizon]);
  if (!xs.length) return null;
  const withIndex = xs.filter((x) => x[horizon].index != null);
  const est = estimate(separateBets(withIndex.map((x) => ({ ...x, t: x.t ?? Date.parse(x.date) / 1000, direction: x.direction ?? 1 }))),
    (x) => x[horizon].move - (x.beta ?? 1) * x[horizon].index, { cluster: 'date' });
  return {
    n: xs.length,
    avg: xs.reduce((s, x) => s + x[horizon].move, 0) / xs.length,
    continued: xs.filter((x) => x[horizon].move > 0).length / xs.length,
    vsIndex: withIndex.length ? withIndex.reduce((s, x) => s + x[horizon].move - x[horizon].index, 0) / withIndex.length : null,
    est,
  };
}

// ---------- lessons ----------

// A lesson when the drift after beta passes the gate (stats.js lessonStatus): it kept going, or gave
// part of it back. `was`: the ids on last time, kept until their chance falls below the keep level.
function driftLesson(id, what, st, lessons, { broader = null, was = new Set() } = {}) {
  const est = st?.est;
  if (!est || st.vsIndex == null) return;
  if (broader && broader.n === st.n) return; // the same cases as the broader lesson: nothing new
  const ev = `${st.n} cases, ${est.bets} separate bet${est.bets === 1 ? '' : 's'} on ${est.clusters} day${est.clusters === 1 ? '' : 's'}: ${share(st.continued)} kept going the same way over the next week, average ${pct(st.vsIndex)} vs the index, ${pct(est.edge)} after allowing for beta (likely ${pct(est.lo)} to ${pct(est.hi)})`;
  for (const [sign, text] of [
    [1, `${what} tended to keep going the same way over the following week. Don't assume the first day's move used it all up.`],
    [-1, `${what} tended to give part of it back within a week. Be wary of chasing the first day's move.`],
  ]) {
    if (lessonStatus(est, sign, was.has(id)) !== 'lesson') continue;
    lessons.push({ id, text, evidence: ev, source: 'market memory', confidence: confidenceOf(est.p), p: est.p, edge: est.edge, lo: est.lo, hi: est.hi, bets: est.bets });
  }
}

// The market's memory: statistics, lessons and the latest measured events (for the page). `prev`:
// the last memory for this market, whose lessons stay on until their evidence fades.
export function buildMemory(events, quotes, market, now = new Date(), prev = null) {
  const measured = measureEvents(events, quotes, market);
  const moves = bigMoves(quotes, market);
  const lessons = [];
  // only lessons this engine showed (with a confidence) keep the lower keep level; older ones must pass the gate
  const was = new Set((prev?.lessons ?? []).filter((l) => l.confidence).map((l) => l.id));
  const up = moves.filter((m) => m.move > 0), down = moves.filter((m) => m.move < 0);
  driftLesson(`${market}:big-up`, `After a one-day jump of ${BIG_MOVE * 100}% or more, ${market} stocks`, driftStats(up), lessons, { was });
  driftLesson(`${market}:big-down`, `After a one-day drop of ${BIG_MOVE * 100}% or more, ${market} stocks`, driftStats(down), lessons, { was });
  for (const tone of ['positive', 'negative']) {
    const all = driftStats(measured.filter((e) => e.tone === tone));
    driftLesson(`${market}:news-${tone}`, `After ${tone} company news, ${market} stocks`, all, lessons, { was });
    for (const type of EVENT_TYPES) {
      driftLesson(`${market}:news-${tone}-${type}`, `After ${tone} ${type} news, ${market} stocks`, driftStats(measured.filter((e) => e.tone === tone && e.type === type)), lessons, { broader: all, was });
    }
  }
  return {
    updatedAt: now.toISOString(), market,
    events: measured.length, bigMoves: moves.length,
    stats: {
      bigUp: driftStats(up), bigDown: driftStats(down),
      positive: driftStats(measured.filter((e) => e.tone === 'positive')), negative: driftStats(measured.filter((e) => e.tone === 'negative')),
    },
    lessons,
    recent: measured.slice(-25).reverse().map((e) => ({ symbol: e.symbol, date: e.date, headline: e.headline, type: e.type, tone: e.tone, from: e.from, day: e.day, week: e.week })),
  };
}
