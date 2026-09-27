// Stock cards ("Stock notes"): each stock's own history and risk, for the owner and the AI. Pure
// functions, no AI. The market memory pools DBS with Singapore Airlines, and a stop-loss set without
// knowing a stock's own swings, or how the positions overlap, is a guess; a card per stock shows that
// stock's own history as counts, never as rules:
//   - its typical daily move now (the spread of its last 60 sessions' total returns, as the ten-year
//     memory measures it) and its beta against its index over the year (stats.js betaAt);
//   - the two stocks in its market it moved with most over the year (the correlation of their daily
//     moves): holding stocks that move together is close to one bet;
//   - its results days, on the results calendar's dates (calendar.js) and the ten-year memory's older
//     ones (memory-long.js): the move against the index on the day the price could react, and from the
//     close before over a week and a month; and the next results date, with where it comes from;
//   - its dividends: the last one, how much of it the price lost on the ex-date (SGX, from ten years),
//     the months it usually goes ex, and the next ex-date as an estimate (a year after the one a year
//     before);
//   - how far ordinary swings reached against a stop within 21 trading days (from ten years), and the
//     stop they reached in only 1 hold in 5, at today's daily move;
//   - the home page's AI picks' record on it (scorecard.js), and each fund's (learning.js
//     stockRecords, kept with the fund: private when the fund is).
// The public part (prices and news only) is state/dossiers.json: built with the weekly ten-year memory
// by scripts/build-history.mjs and refreshed once a day; the page reads it, and the job builds the same
// thing in memory every run for the AI.
//
// The AI sees at most DOSSIER.cards cards per market, 2-3 short lines each, inside the market data
// every fund in that market shares (and caches), so they're chosen by what's true for the whole market
// in that run (cardSymbols): stocks any fund in the market holds, then the home page's picks, then
// stocks in today's news. A position's own numbers (its risk as a share of the fund, its stop in daily
// moves, the stop ordinary swings reach in 1 hold in 5) go in the fund's own part (positionRisk). All
// of it is advice: the hard limits never change.

import { BENCHMARKS, sessionLength } from './benchmark.js';
import { divsBetween } from './actions.js';
import { betaAt, BANKS } from './stats.js';
import { nextResults } from './calendar.js';
import { summarizeScores } from './scorecard.js';
import { marketDate } from './markets.js';
import { LONG } from './memory-long.js';

export const DOSSIER = {
  moveDays: LONG.sdDays, minMoveDays: 40, // the typical daily move: the spread of the last 60 sessions' moves
  corrDays: 250, minCorrDays: 120, peers: 2, // the stocks it moved with over the year, on 120+ shared days
  reactions: 8, // results days kept per stock
  cards: 6, cardReactions: 4, // stock cards per market for the AI, and the results days on each
  exDateNear: 45, minYieldPct: 0.5, // an ex-date this many days away, with a dividend this big, gets a line on the AI's card
  cardPeer: 0.5, // a peer is named on the AI's card from this correlation
  noteMax: 300, // an owner's note on a stock, in characters
  refreshHours: 20, // dossiers.json is refreshed at most this often
  together: 0.7, // two positions on the same side this correlated count as close to one bet
  uneven: { ratio: 1.3, share: 0.3 }, // risk-uneven: one position's share of the daily risk at 1.3x its share of the money, and 30%+
};
export const VERSION = 1;

const DAY_MS = 86400000;
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sdOf = (xs) => { const m = avg(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const isStock = (s, q) => q && !q.etf && !Object.values(BENCHMARKS).some((b) => b.symbol === s);
const indexOf = (q) => BENCHMARKS[q?.currency]?.symbol ?? null;
export const indexName = (symbol) => String(symbol ?? '').replace(/\.SI$/, '');
// In sorted dates: the index of the last on or before `d` (-1 if none).
function onOrBefore(dates, d) {
  let lo = 0, hi = dates.length - 1, out = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= d) { out = mid; lo = mid + 1; } else hi = mid - 1; }
  return out;
}

// ---------- a year of prices (prices.json) ----------

// A quote's closed sessions as a total-return level (dividends counted on their ex-date, as actions.js
// does): { dates, tr, r }, where r[i] is the return into session i (null for the first, and for a move
// over LONG.jump, a data error the ten-year memory leaves out too). Remembered per quote and day.
const levelCache = new WeakMap();
function levels(q, nowS) {
  const key = Math.floor(nowS / 3600);
  const hit = levelCache.get(q);
  if (hit?.key === key) return hit.value;
  const sl = sessionLength(q);
  const bars = (q?.daily ?? []).filter((b) => b[1] > 0 && b[0] + sl <= nowS);
  const dates = [], tr = [], r = [];
  bars.forEach((b, i) => {
    dates.push(dateOf(b[0]));
    if (!i) { tr.push(1); r.push(null); return; }
    const x = (b[1] + divsBetween(q, bars[i - 1][0] + sl, b[0] + sl)) / bars[i - 1][1] - 1;
    tr.push(tr[i - 1] * (1 + x));
    r.push(Math.abs(x) <= LONG.jump ? x : null);
  });
  const value = { dates, tr, r };
  if (q) levelCache.set(q, { key, value });
  return value;
}

// The typical daily move now: the spread (standard deviation) of the last DOSSIER.moveDays closed
// sessions' total returns, as a fraction, or null with fewer than DOSSIER.minMoveDays of them.
export function typicalMove(q, now = new Date()) {
  const xs = levels(q, now.getTime() / 1000).r.slice(-DOSSIER.moveDays).filter((x) => x != null);
  return xs.length >= DOSSIER.minMoveDays ? sdOf(xs) : null;
}

// The correlation of two stocks' daily moves on the days both traded, over the last DOSSIER.corrDays
// sessions of the first, or null with fewer than DOSSIER.minCorrDays shared days.
export function correlation(qa, qb, now = new Date()) {
  const nowS = now.getTime() / 1000;
  const a = levels(qa, nowS), b = levels(qb, nowS);
  const byDate = new Map(b.dates.map((d, i) => [d, b.r[i]]));
  const pairs = [];
  for (let i = Math.max(1, a.dates.length - DOSSIER.corrDays); i < a.dates.length; i++) {
    const y = byDate.get(a.dates[i]);
    if (a.r[i] != null && y != null) pairs.push([a.r[i], y]);
  }
  if (pairs.length < DOSSIER.minCorrDays) return null;
  const mx = avg(pairs.map((p) => p[0])), my = avg(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// The DOSSIER.peers stocks in `symbol`'s market (not an index fund) it moved with most over the year,
// strongest first: [[symbol, correlation]]. For a Singapore bank that's usually the other two.
export function correlatedPeers(quotes, symbol, now = new Date(), n = DOSSIER.peers) {
  const q = quotes?.[symbol];
  if (!isStock(symbol, q)) return [];
  return Object.keys(quotes).filter((s) => s !== symbol && quotes[s].market === q.market && isStock(s, quotes[s]))
    .map((s) => [s, correlation(q, quotes[s], now)]).filter(([, c]) => c != null)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([s, c]) => [s, round(c, 2)]);
}

// Its results days in the year of prices: for each of the calendar's past results ({ date,
// effectiveDate? }), the session the price could react on (with a release time: that one; without it
// may have come before the open or after the close, so the bigger move of that day and the next, as
// calendar.js typicalResultsMove does), and against the index's total return: the day's move, and from
// the close before over a week (5 sessions) and a month (21; null until they've happened). Fractions.
export function reactionsIn(q, iq, past, now = new Date()) {
  const nowS = now.getTime() / 1000;
  const S = levels(q, nowS), I = levels(iq, nowS);
  const n = S.dates.length;
  if (n < 2 || I.dates.length < 2) return [];
  const idxAt = (d) => { const k = onOrBefore(I.dates, d); return k >= 0 ? I.tr[k] : null; };
  const vs = (a, b) => {
    if (a < 0 || b >= n) return null;
    const i0 = idxAt(S.dates[a]), i1 = idxAt(S.dates[b]);
    return i0 && i1 ? S.tr[b] / S.tr[a] - 1 - (i1 / i0 - 1) : null;
  };
  const out = [];
  for (const p of past ?? []) {
    const day0 = p.effectiveDate ?? p.date;
    let i = S.dates.findIndex((d) => d >= day0);
    if (i < 1) continue;
    if (!p.effectiveDate && i + 1 < n && Math.abs(vs(i, i + 1) ?? 0) > Math.abs(vs(i - 1, i) ?? 0)) i += 1;
    const day = vs(i - 1, i);
    if (day == null || out.some((x) => x.date === S.dates[i])) continue;
    out.push({ date: S.dates[i], day, week: vs(i - 1, i + 4), month: vs(i - 1, i + 20) });
  }
  return out;
}

// The ten-year memory's results days for a stock (memory-long.js stocks[symbol].results.recent:
// [date, day, week, month] in %, the last two missing in older files) with this year's (reactionsIn),
// one per results (two within 3 days are the same, the year of prices' copy kept), oldest first, the
// last DOSSIER.reactions. Fractions.
export function mergeReactions(history, fresh) {
  const old = (history ?? []).map(([date, day, week, month]) => ({
    date, day: day == null ? null : day / 100, week: week == null ? null : week / 100, month: month == null ? null : month / 100,
  }));
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * DAY_MS;
  const all = [...(fresh ?? []), ...old.filter((o) => !(fresh ?? []).some((f) => near(f.date, o.date)))];
  return all.filter((x) => x.day != null).sort((a, b) => a.date.localeCompare(b.date)).slice(-DOSSIER.reactions);
}

// ---------- dividends ----------

const addYear = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y + 1, m - 1, Math.min(dd, m === 2 ? 28 : dd)));
  return t.toISOString().slice(0, 10);
};

// The next ex-date as an estimate: a year after an ex-date in the last 13 months, the soonest one
// that hasn't happened yet (an ex-date within 30 days of it already went ex for that payment). One up
// to 14 days late still counts: payers slip by a few days. `dates`: past ex-dates, ISO, any order.
export function nextExDate(dates, today) {
  const t = Date.parse(today);
  const known = [...new Set(dates ?? [])].sort();
  const candidates = known.filter((d) => t - Date.parse(d) <= 400 * DAY_MS).map(addYear).sort();
  for (const c of candidates) {
    const tc = Date.parse(c);
    if (tc < t - 14 * DAY_MS) continue;
    if (known.some((d) => Math.abs(Date.parse(d) - tc) <= 30 * DAY_MS)) continue;
    return c;
  }
  return null;
}

// Its dividends: the last one ([date, amount], from the year of prices, else the ten-year memory's),
// as a share of today's price, how much of a dividend the price typically lost on the ex-date (the
// ten-year memory's SGX study: 1 = all of it; null where it isn't measured), how many it paid in ten
// years, the months it went ex in the last three, and the next ex-date as an estimate: `late` when that
// date has passed without it going ex (a payer later than last year), so it's due any day. Null
// without any.
export function dividendsOf(q, history = null, now = new Date()) {
  const nowS = now.getTime() / 1000;
  const past = (q?.events?.dividends ?? []).filter(([t, a]) => a > 0 && t <= nowS).map(([t, a]) => [dateOf(t), a]);
  const h = history?.dividends ?? null;
  const last = past.at(-1) ?? h?.last ?? null;
  if (!last) return null;
  const today = marketDate(q?.market ?? history?.market ?? 'US', now);
  const next = nextExDate([...past.map(([d]) => d), ...(h?.last ? [h.last[0]] : [])], today);
  return {
    last: [last[0], round(last[1], 4)], yield_pct: q?.price > 0 ? round((last[1] / q.price) * 100, 2) : null,
    n: h?.n ?? past.length, drop_vs_dividend: h?.drop_vs_dividend ?? null,
    months: h?.months?.length ? h.months : [...new Set(past.map(([d]) => Number(d.slice(5, 7))))].sort((a, b) => a - b),
    next: next ? { date: next, amount: round(last[1], 4), estimate: true, ...(next < today ? { late: true } : {}) } : null,
  };
}

// Whether a card's next ex-date estimate has passed by `now` without the stock going ex (it's due any
// day): worked out when it's read, since state/dossiers.json can be a day old.
export const exDateLate = (d, now = new Date()) => Boolean(d?.dividends?.next && d.dividends.next.date < marketDate(d.market ?? 'US', now));

// ---------- records ----------

// The home page's AI picks' record on one stock, from scorecard.js scorePicks: after a week and a
// month, how many were scored, the share right (made money in their direction), the share that beat
// the index, and their average return. Null before any is scored.
export function picksRecord(scores, symbol) {
  const mine = (scores ?? []).filter((x) => x.symbol === symbol);
  if (!mine.length) return null;
  const sum = summarizeScores(mine);
  const one = (h) => (h.n ? { n: h.n, right: round(h.right, 3), beat: h.beat == null ? null : round(h.beat, 3), avg: round(h.avgRet, 5) } : null);
  return { week: one(sum.week), month: one(sum.month) };
}

// ---------- one stock's card ----------

// The stop-loss base rates for a stock from the ten-year memory (memory-long.js stocks[symbol]): how
// often ordinary swings touched a stop 1.5, 2, 2.5 and 3 daily moves away (LONG.stopKs) within 21
// trading days, for a long and a short; the multiple they reached in only 1 hold in 5; and that stop at
// today's daily move `movePct` (the memory's own when there's no price today).
function stopsOf(history, movePct) {
  const st = history?.stops;
  if (!st) return null;
  const at = (side) => (movePct != null && st[side]?.k != null ? round(st[side].k * movePct, 1) : history.suggested_stop_pct?.[side] ?? null);
  return {
    holds: st.holds, hits: { long: st.long?.hits ?? null, short: st.short?.hits ?? null },
    k: { long: st.long?.k ?? null, short: st.short?.k ?? null }, suggested_stop_pct: { long: at('long'), short: at('short') },
  };
}

// The card for `symbol` (see the header). `quotes`: prices.json quotes; `history`: the ten-year memory's
// entry for it (memory-long.json stocks[symbol]); `calendar`: calendar.js resultsCalendar; `picksScores`:
// scorecard.js scorePicks; `fundRecords`: each fund's record on it ([{ fund, name, record }], from each
// fund's graded ideas by learning.js stockRecords), only on the page, never in the public file. Null
// for a symbol with neither prices nor history.
export function buildDossier(symbol, { quotes = {}, history = null, calendar = null, picksScores = null, fundRecords = null, now = new Date() } = {}) {
  const q = quotes[symbol];
  if (!q && !history) return null;
  const market = q?.market ?? history?.market ?? null;
  const index = q ? indexOf(q) : market === 'SGX' ? BENCHMARKS.SGD.symbol : BENCHMARKS.USD.symbol;
  const iq = quotes[index];
  const move = q ? typicalMove(q, now) : null;
  const movePct = move != null ? round(move * 100, 2) : history?.typical_daily_move_pct ?? null;
  const beta = q && iq ? betaAt(q, Infinity, iq) : null;
  const cal = calendar?.[symbol];
  const reactions = mergeReactions(history?.results?.recent, q && iq ? reactionsIn(q, iq, cal?.past ?? [], now) : []);
  const next = calendar ? nextResults(calendar, symbol, quotes, now) : null;
  // the typical results-day move: the ten-year memory's, or the calendar's if it has more results
  const tenYear = history?.results?.typical_results_day_move_pct != null ? { pct: history.results.typical_results_day_move_pct, n: history.results.n } : null;
  const year = cal?.typicalMove ? { pct: round(cal.typicalMove.avg * 100, 1), n: cal.typicalMove.n } : null;
  const typical = tenYear && (!year || tenYear.n >= year.n) ? tenYear : year;
  const pr = picksRecord(picksScores, symbol);
  return {
    symbol, name: q?.name ?? null, market, index,
    daily_move_pct: movePct,
    beta_1y: beta && !beta.fallback ? round(beta.beta, 2) : null,
    peers: q ? correlatedPeers(quotes, symbol, now) : [],
    stops: stopsOf(history, movePct),
    results: reactions.length || next || typical ? {
      typical_day_move_pct: typical?.pct ?? null, n: typical?.n ?? null,
      reactions: reactions.map((x) => [x.date, round(x.day * 100, 1), round(x.week == null ? null : x.week * 100, 1), round(x.month == null ? null : x.month * 100, 1)]),
      next: next ? { date: next.date, source: next.source, ...(next.effectiveDate ? { effectiveDate: next.effectiveDate } : {}) } : null,
    } : null,
    dividends: dividendsOf(q, history, now),
    picks: pr,
    ...(history?.data === 'rebuilt' ? { data: 'rebuilt' } : {}),
    ...(fundRecords ? { funds: fundRecords } : {}),
  };
}

// Every stock's card, as state/dossiers.json holds it: prices and news only (no fund's record), for
// the watchlist's stocks (the ten-year memory's without prices). `long`: memory-long.json (its
// per-stock entries; without it, just what the year of prices gives).
export function buildDossiers({ quotes = {}, long = null, calendar = null, picksScores = null, now = new Date() } = {}) {
  const stocks = {};
  const priced = Object.keys(quotes).filter((s) => isStock(s, quotes[s]));
  const symbols = priced.length ? priced : Object.keys(long?.stocks ?? {});
  for (const symbol of [...symbols].sort()) {
    const d = buildDossier(symbol, { quotes, history: long?.stocks?.[symbol] ?? null, calendar, picksScores, now });
    if (d) stocks[symbol] = d;
  }
  return { version: VERSION, refreshedAt: now.toISOString(), longAt: long?.updatedAt ?? null, stocks };
}

// Whether dossiers.json should be rebuilt: none yet, over DOSSIER.refreshHours old, or the ten-year
// memory has been rebuilt since.
export function dossiersDue(prev, long = null, now = new Date()) {
  if (!prev?.refreshedAt) return true;
  if (now - Date.parse(prev.refreshedAt) >= DOSSIER.refreshHours * 3600000) return true;
  return Boolean(long?.updatedAt && long.updatedAt !== prev.longAt);
}

// ---------- what the AI sees ----------

// The stocks whose cards the AI sees in `market` (US or SGX), at most `max`, the same for every fund in
// that market in a run: first those any of its funds holds (`held`: { symbol: value held, summed over
// the funds }, biggest first), then the home page's picks (`picks`: picks.json, by conviction), then
// stocks in today's news (`news`: the digest, items dated in the last 3 days, most items first).
export function cardSymbols(market, { quotes = {}, held = {}, picks = null, news = null, now = new Date(), max = DOSSIER.cards } = {}) {
  const inMarket = (s) => quotes[s]?.market === market && isStock(s, quotes[s]);
  const out = [];
  const add = (s) => { if (inMarket(s) && !out.includes(s)) out.push(s); };
  Object.entries(held).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([s]) => add(s));
  const conviction = { high: 0, medium: 1, low: 2 };
  (picks?.picks ?? []).map((p, i) => [p.symbol, conviction[p.conviction] ?? 3, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).forEach(([s]) => add(s));
  const since = now.getTime() - 3 * DAY_MS;
  const counts = {};
  for (const item of news?.items ?? []) {
    const t = Date.parse(String(item.date ?? '').slice(0, 10));
    if (Number.isFinite(t) && t < since - DAY_MS) continue;
    for (const s of item.symbols ?? []) counts[s] = (counts[s] ?? 0) + 1;
  }
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([s]) => add(s));
  return out.slice(0, max);
}

const signed = (x) => (x == null ? '?' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}%`);

// A card's lines for the AI (2-3, short, since they're in every decision): its typical daily move, the
// stocks it moves with (from a correlation of DOSSIER.cardPeer) and the 1-in-5 stop for a long and for
// a short ("−6.8%/+7.0%"); its latest results days against the index and the next date; and its
// dividends, where the ex-date drop is measured or a dividend of DOSSIER.minYieldPct or more goes ex
// soon. Only what's known.
export function cardLines(d, now = new Date()) {
  if (!d) return [];
  const lines = [];
  const peers = (d.peers ?? []).filter(([, c]) => c >= DOSSIER.cardPeer);
  const stop = d.stops?.suggested_stop_pct;
  const risk = [
    d.daily_move_pct != null ? `±${d.daily_move_pct.toFixed(1)}%/day` : null,
    peers.length ? `moves with ${peers.map(([s, c]) => `${s} ${c.toFixed(2)}`).join(', ')}` : null,
    stop?.long != null ? `1-in-5 stop −${stop.long.toFixed(1)}%${stop.short != null ? `/+${stop.short.toFixed(1)}%` : ''}` : null,
  ].filter(Boolean);
  if (risk.length) lines.push(`${risk.join('; ')}.`);
  const r = d.results;
  const days = (r?.reactions ?? []).slice(-DOSSIER.cardReactions);
  if (days.length || r?.next) {
    const next = r?.next ? `next ${r.next.date}${r.next.source === 'estimated' ? ' (estimate)' : r.next.source === 'filing' ? ' (out)' : ''}` : null;
    lines.push(`${[days.length ? `Results vs ${indexName(d.index)}: ${days.map((x) => signed(x[1])).join(', ')}` : null, next].filter(Boolean).join('; ')}.`);
  }
  const dv = d.dividends;
  const soon = dv?.next && dv.yield_pct >= DOSSIER.minYieldPct && Date.parse(dv.next.date) - now.getTime() <= DOSSIER.exDateNear * DAY_MS;
  if (dv && (dv.drop_vs_dividend != null || soon)) {
    const last = `last ${dv.last[1]}${dv.yield_pct != null ? ` (${dv.yield_pct.toFixed(1)}%)` : ''} on ${dv.last[0]}`;
    const next = !dv.next ? '' : exDateLate(d, now) ? `; next due any day (the estimate, ~${dv.next.date}, has passed)` : `; next ~${dv.next.date}`;
    lines.push(`${dv.drop_vs_dividend != null ? `Ex-dates drop ${Math.round(dv.drop_vs_dividend * 100)}% of the dividend` : 'Dividend'}; ${last}${next}.`);
  }
  return lines;
}

// The cards the AI sees for `market` (cardSymbols), each { symbol, lines }.
export function stockCards(market, { dossiers = {}, quotes = {}, held = {}, picks = null, news = null, now = new Date(), max = DOSSIER.cards } = {}) {
  return cardSymbols(market, { quotes, held, picks, news, now, max: Infinity })
    .map((symbol) => ({ symbol, lines: cardLines(dossiers[symbol], now) })).filter((c) => c.lines.length).slice(0, max);
}

// What every fund in a market holds, by stock: { SGX: { symbol: value }, US: {...} }, summed over the
// running funds at the latest prices, for cardSymbols.
export function heldByMarket(funds, quotes = {}) {
  const out = {};
  for (const f of funds ?? []) {
    if (f.stoppedAt) continue;
    for (const [s, p] of Object.entries(f.portfolio?.positions ?? {})) {
      const q = quotes[s];
      if (!q?.market) continue;
      out[q.market] ??= {};
      out[q.market][s] = (out[q.market][s] ?? 0) + Math.abs(p.qty) * (q.price ?? p.avgCost ?? 0);
    }
  }
  return out;
}

// ---------- the owner's notes on stocks ----------

// The owner's notes (the collection's c.stockNotes, { symbol: { text, at } }, shared by every fund)
// after one is set: `text` empty clears it. Only a watchlist stock (`quotes`, when there are prices)
// can carry one, and a note is at most DOSSIER.noteMax characters.
export function setStockNote(notes, symbol, text, quotes = {}, now = new Date()) {
  const s = String(symbol ?? '').trim();
  if (!/^[A-Z0-9^][A-Z0-9.^-]{0,14}$/.test(s)) throw new Error('Choose a stock for the note.');
  if (Object.keys(quotes).length && !quotes[s]) throw new Error(`${s} isn't on the watchlist.`);
  const out = { ...(notes ?? {}) };
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DOSSIER.noteMax);
  if (words) out[s] = { text: words, at: now.toISOString() };
  else delete out[s];
  return out;
}

// The notes the AI sees for the stocks of `currency`'s market: { symbol: text }, or null without any.
export function notesForPrompt(notes, quotes, currency) {
  const out = Object.fromEntries(Object.entries(notes ?? {})
    .filter(([s, n]) => n?.text && quotes?.[s]?.currency === currency).sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => [s, n.text]));
  return Object.keys(out).length ? out : null;
}

// ---------- a fund's positions against their daily moves ----------

// Each position with its risk (positions: portfolio.js summarize; `equity`: the fund's value;
// `dossiers`: { symbol: card }; `protections`: fund.protections; `quotes`, when given, measure an index
// fund, which has no card of its own, from its prices):
//   weight       its share of the fund's value
//   move         its typical daily move (a fraction), null when unknown
//   risk         how much a typical day moves it, as a share of the fund (weight x move)
//   riskShare    its share of the positions' risks added up; moneyShare: its share of their value (both
//                among the positions whose daily move is known)
//   stop         its stop-loss in % from its average price (null without one); stopDistance: how far
//                today's price is from that stop level, as a share of the price (0 or less: at or
//                through it), and stopMoves: that distance in typical daily moves
//   suggested    the stop ordinary swings reached in only 1 hold in 5, for its side, in %
// and for the fund: `uneven` when one position's share of the risk is at least DOSSIER.uneven.ratio
// times its share of the money and DOSSIER.uneven.share of the risk ({ symbol, weight, riskShare, lo, hi }:
// the smallest and largest risk), and `together`: pairs on the same side that moved together over the
// year (a correlation of DOSSIER.together or more: close to one bet).
export function positionRisk(positions, equity, dossiers = {}, protections = {}, { quotes = null, now = new Date() } = {}) {
  const rows = (positions ?? []).map((p) => {
    const d = dossiers?.[p.symbol];
    const move = d?.daily_move_pct != null ? d.daily_move_pct / 100 : quotes?.[p.symbol] ? typicalMove(quotes[p.symbol], now) : null;
    const weight = equity > 0 ? Math.abs(p.marketValue) / equity : null;
    const stop = Number(protections?.[p.symbol]?.stop_loss_pct) || null;
    const side = p.short || p.qty < 0 ? 'short' : 'long';
    // the stop-loss is a loss from the average price (fund.js checkProtections), so where it sits
    // against today's price depends on the profit or loss so far
    const level = stop && p.avgCost > 0 ? p.avgCost * (side === 'long' ? 1 - stop / 100 : 1 + stop / 100) : null;
    const stopDistance = level != null && p.price > 0 ? (side === 'long' ? p.price - level : level - p.price) / p.price : null;
    return {
      symbol: p.symbol, side, value: Math.abs(p.marketValue), weight, move, risk: move != null && weight != null ? weight * move : null,
      stop, stopDistance, stopMoves: stopDistance != null && move ? stopDistance / move : null, suggested: d?.stops?.suggested_stop_pct?.[side] ?? null,
    };
  });
  // shares of the risk and of the money among the positions whose daily move is known, so one without
  // it doesn't make the others look riskier than their money
  const measured = rows.filter((r) => r.risk != null);
  const totalRisk = measured.reduce((s, r) => s + r.risk, 0), totalMoney = measured.reduce((s, r) => s + r.value, 0);
  for (const r of rows) {
    r.riskShare = r.risk != null && totalRisk > 0 ? r.risk / totalRisk : null;
    r.moneyShare = r.risk != null && totalMoney > 0 ? r.value / totalMoney : null;
  }
  let uneven = null;
  if (measured.length >= 2) {
    const top = [...measured].sort((a, b) => b.riskShare - a.riskShare)[0];
    if (top.riskShare >= DOSSIER.uneven.share && top.riskShare >= DOSSIER.uneven.ratio * top.moneyShare) {
      const risks = measured.map((r) => r.risk);
      uneven = { symbol: top.symbol, weight: top.weight, riskShare: top.riskShare, lo: Math.min(...risks), hi: Math.max(...risks) };
    }
  }
  const together = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [a, b] = [rows[i], rows[j]];
      if (a.side !== b.side) continue;
      const c = dossiers?.[a.symbol]?.peers?.find(([s]) => s === b.symbol)?.[1] ?? dossiers?.[b.symbol]?.peers?.find(([s]) => s === a.symbol)?.[1];
      if (c != null && c >= DOSSIER.together) together.push({ a: a.symbol, b: b.symbol, correlation: c });
    }
  }
  return { rows, uneven, together };
}

// A position's risk numbers for the AI (ai.js ownContext): how far today's price is from its stop-loss
// level in typical daily moves, how much a typical day moves it as a % of the fund, and the stop
// ordinary swings reached in only 1 hold in 5. Advice only; nothing here changes a limit.
export const riskForPrompt = (row) => (row?.move == null ? {} : {
  stop_in_daily_moves: row.stopMoves == null ? null : round(row.stopMoves, 1), risk_pct_of_fund: round(row.risk * 100, 2),
  suggested_stop_pct: row.suggested == null ? null : round(row.suggested, 1),
});

// An ex-date coming within `days` (or an estimate that has passed without it going ex: due any day,
// `late`) whose typical drop (the dividend times the share of it the price usually loses, all of it
// where that isn't measured) is at least `distancePct`, how far today's price is above a long
// position's stop-loss level (positionRisk's stopDistance, in %): the stop would trigger on the dividend
// alone. { date, dropPct, late? } or null.
export function exDateVsStop(d, distancePct, now = new Date(), days = 30) {
  const dv = d?.dividends;
  if (!dv?.next || !(distancePct > 0) || dv.yield_pct == null) return null;
  if (Date.parse(dv.next.date) - now.getTime() > days * DAY_MS) return null;
  const dropPct = dv.yield_pct * (dv.drop_vs_dividend ?? 1);
  return dropPct >= distancePct ? { date: dv.next.date, dropPct: round(dropPct, 1), ...(exDateLate(d, now) ? { late: true } : {}) } : null;
}

// What the stop log (fund.protectionLog, fund.js setProtections) says: of the stop-losses set, the
// median distance in typical daily moves when set, and how many were under 2 moves (mostly hit by
// ordinary swings). A change to the take-profit alone (`stopKept`) isn't a stop set. Null with fewer
// than 3 stops set with a known daily move.
export function stopLogSummary(log) {
  const set = (log ?? []).filter((e) => e.stop_loss_pct > 0 && e.dailyMovePct > 0 && !e.stopKept);
  const ks = set.map((e) => e.stop_loss_pct / e.dailyMovePct).sort((a, b) => a - b);
  if (ks.length < 3) return null;
  const m = ks.length >> 1;
  return { n: ks.length, median: round(ks.length % 2 ? ks[m] : (ks[m - 1] + ks[m]) / 2, 1), under2: ks.filter((k) => k < 2).length, since: set[0]?.setAt ?? null };
}

// The banks' names, for words ("DBS"), else the symbol.
export const shortName = (symbol, quotes = {}) => BANKS[symbol] ?? quotes?.[symbol]?.name ?? symbol;
