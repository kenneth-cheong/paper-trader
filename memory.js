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
// moves are measured here, so the lessons aren't the AI's opinion of itself.

import { BENCHMARKS } from './benchmark.js';

export const EVENT_TYPES = ['earnings', 'guidance', 'deal', 'product', 'legal', 'management', 'analyst', 'macro', 'other'];
export const TONES = ['positive', 'negative', 'mixed'];
export const BIG_MOVE = 0.04;
export const MIN_CASES = 5;
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
    const k = eventKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(ev);
  }
  return all.sort((a, b) => a.date.localeCompare(b.date)).slice(-3000);
}

// Company news from a daily digest, one event per stock it names.
export function eventsFromDigest(news) {
  return (news?.items ?? []).flatMap((i) => (i.symbols ?? []).map((symbol) => ({ symbol, date: String(i.date ?? '').slice(0, 10), headline: i.headline, type: i.type, tone: i.tone, source_url: i.source_url, from: 'digest' })));
}

// ---------- measuring ----------

// { day, week, month } moves after bar `i` of `bars`, each { move, index } against the index's bars.
function movesAfter(bars, i, indexByDate) {
  const out = {};
  const c0 = bars[i - 1]?.[1], c1 = bars[i][1];
  const idx = (k) => indexByDate.get(dateOf(bars[k]?.[0] ?? 0));
  out.day = c0 ? { move: c1 / c0 - 1, index: idx(i) && idx(i - 1) ? idx(i) / idx(i - 1) - 1 : null } : null;
  for (const [key, n] of [['week', 5], ['month', 21]]) {
    const j = i + n;
    out[key] = bars[j] ? { move: bars[j][1] / c1 - 1, index: idx(j) && idx(i) ? idx(j) / idx(i) - 1 : null } : null;
  }
  return out;
}

const indexCloses = (quotes, market) => new Map((quotes[BENCHMARKS[MARKET_CURRENCY[market]]?.symbol]?.daily ?? []).map(([t, c]) => [dateOf(t), c]));

// Results are never announced within days of the quarter ending, so an earnings event dated in the
// last week of March, June, September or December is really the period's end date, not the news date.
export function plausibleDate(e) {
  if (e.type !== 'earnings') return true;
  const [, m, d] = e.date.split('-').map(Number);
  return !([3, 6, 9, 12].includes(m) && d >= 24);
}

// Each news event with the moves after it (in the direction of its tone: + means it went the way the
// news pointed). Events before the price history, or too recent to have a week after, are left out.
export function measureEvents(events, quotes, market) {
  const index = indexCloses(quotes, market);
  const out = [];
  for (const e of events) {
    const q = quotes[e.symbol];
    if (!q || q.market !== market || e.tone === 'mixed' || !plausibleDate(e)) continue;
    const bars = q.daily ?? [];
    const i = bars.findIndex(([t]) => dateOf(t) >= e.date);
    if (i < 1) continue;
    const m = movesAfter(bars, i, index);
    if (!m.week) continue;
    const dir = e.tone === 'negative' ? -1 : 1;
    const adj = (x) => (x ? { move: dir * x.move, index: x.index == null ? null : dir * x.index } : null);
    out.push({ ...e, day: adj(m.day), week: adj(m.week), month: adj(m.month) });
  }
  return out;
}

// Every one-day move of BIG_MOVE or more in the market's stocks (not the index itself), with what
// followed, in the direction of the move.
export function bigMoves(quotes, market) {
  const index = indexCloses(quotes, market);
  const indexSymbol = BENCHMARKS[MARKET_CURRENCY[market]]?.symbol;
  const out = [];
  for (const [symbol, q] of Object.entries(quotes)) {
    if (q.market !== market || symbol === indexSymbol) continue;
    const bars = q.daily ?? [];
    for (let i = 1; i < bars.length; i++) {
      const r = bars[i][1] / bars[i - 1][1] - 1;
      if (Math.abs(r) < BIG_MOVE) continue;
      const m = movesAfter(bars, i, index);
      if (!m.week) continue;
      const dir = Math.sign(r);
      out.push({ symbol, date: dateOf(bars[i][0]), move: r, week: { move: dir * m.week.move, index: m.week.index == null ? null : dir * m.week.index }, month: m.month && { move: dir * m.month.move, index: m.month.index == null ? null : dir * m.month.index } });
    }
  }
  return out;
}

// n, average drift in the direction (+ = continued), share that continued, average vs the index.
export function driftStats(list, horizon = 'week') {
  const xs = list.filter((x) => x[horizon]);
  if (!xs.length) return null;
  const withIndex = xs.filter((x) => x[horizon].index != null);
  return {
    n: xs.length,
    avg: xs.reduce((s, x) => s + x[horizon].move, 0) / xs.length,
    continued: xs.filter((x) => x[horizon].move > 0).length / xs.length,
    vsIndex: withIndex.length ? withIndex.reduce((s, x) => s + x[horizon].move - x[horizon].index, 0) / withIndex.length : null,
  };
}

// ---------- lessons ----------

function driftLesson(id, what, st, lessons, broader = null) {
  if (!st || st.n < MIN_CASES || st.vsIndex == null) return;
  if (broader && broader.n === st.n) return; // the same cases as the broader lesson: nothing new
  const ev = `${st.n} cases: ${share(st.continued)} kept going the same way over the next week, average ${pct(st.vsIndex)} vs the index`;
  if (st.vsIndex >= 0.01 && st.continued >= 0.55) lessons.push({ id, text: `${what} tended to keep going the same way over the following week. Don't assume the first day's move used it all up.`, evidence: ev, source: 'market memory' });
  if (st.vsIndex <= -0.01 && st.continued <= 0.45) lessons.push({ id, text: `${what} tended to give part of it back within a week. Be wary of chasing the first day's move.`, evidence: ev, source: 'market memory' });
}

// The market's memory: statistics, lessons and the latest measured events (for the page).
export function buildMemory(events, quotes, market, now = new Date()) {
  const measured = measureEvents(events, quotes, market);
  const moves = bigMoves(quotes, market);
  const lessons = [];
  const up = moves.filter((m) => m.move > 0), down = moves.filter((m) => m.move < 0);
  driftLesson(`${market}:big-up`, `After a one-day jump of ${BIG_MOVE * 100}% or more, ${market} stocks`, driftStats(up), lessons);
  driftLesson(`${market}:big-down`, `After a one-day drop of ${BIG_MOVE * 100}% or more, ${market} stocks`, driftStats(down), lessons);
  for (const tone of ['positive', 'negative']) {
    const all = driftStats(measured.filter((e) => e.tone === tone));
    driftLesson(`${market}:news-${tone}`, `After ${tone} company news, ${market} stocks`, all, lessons);
    for (const type of EVENT_TYPES) {
      driftLesson(`${market}:news-${tone}-${type}`, `After ${tone} ${type} news, ${market} stocks`, driftStats(measured.filter((e) => e.tone === tone && e.type === type)), lessons, all);
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
    recent: measured.slice(-25).reverse().map((e) => ({ symbol: e.symbol, date: e.date, headline: e.headline, type: e.type, tone: e.tone, day: e.day, week: e.week })),
  };
}
