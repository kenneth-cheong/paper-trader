// The factor and regime lab: the conditions behind the AI funds' ideas, and when its ideas have worked.
// Pure functions, no AI.
//
// 1. Six factors, fixed in advance, measured at the moment of an idea from bars that had closed before
//    it (never the session in progress, never anything later):
//      ma50      the close against the average of the last 50 closes
//      high52    the close against the highest close of the last 52 weeks (252 sessions; 0 at the high)
//      volume20  the last session's volume against the average of the 20 before it
//      move1m    the last month's move (21 sessions) divided by the stock's usual month (the spread of its
//                last 60 daily moves, scaled to 21 days): +1 is a rise of one typical month
//      results   trading days to the stock's next results (the first session that trades on them) or, if
//                they're nearer, since its last ones (negative); unknown beyond a quarter (63 days)
//      index200  its index (SPY or ES3) against the average of the index's last 200 closes
//    and two regime values: the VIX's last close, and for SGX stocks USD/SGD's move over the last month.
//    Stored at decision time as one compact array per order and idea passed on (FACTOR_KEYS order,
//    rounded), and worked out again from the two years of prices in data/ohlcv.json for ideas made before
//    that (learning.js adds them to the frozen idea log as columns).
// 2. Its revealed style (revealedStyle): where the stocks a fund chose sat among its market's stocks on
//    each factor at the time (the average within-market percentile), against what it called its ideas.
// 3. When its ideas work (factorLab): each market's funds' ideas pooled (one case per fund, stock and
//    direction per 5 trading days), split into buckets fixed in advance, each with its cases, separate
//    bets (stats.js separateBets), the calendar weeks and separate episodes they came from, and the
//    stock-specific edge a week later (after beta and fees), averaged week by week (stats.js weeklyMean).
//    The page greys a bucket with fewer than PAGE_MIN_BETS bets.
// 4. Lessons: only three comparisons fixed in advance can become lessons (SPLITS): ideas opened in the 5
//    trading days before results against the rest, the index above or below its 200-day average, and a
//    calm VIX (under 16) against a stressed one (over 25; US stocks, as the regime line). Each side needs
//    20+ separate bets from 6+ calendar weeks and 2+ separate episodes, the difference a week-clustered
//    |t| of 2.5 or more, and the same sign in both halves of the record (LAB). The lesson is about the
//    side that did worse, and the AI sees it only while that side's condition holds (conditionHolds).
//    Everything else here is for the page only. conditionNoiseCheck runs these rules on made-up funds
//    with no skill at all, and the page prints how often a false lesson got through.
// On 17 stocks a bucket is often one or two stocks, and regimes last weeks: descriptive, not rules.

import { BENCHMARKS, sessionLength } from './benchmark.js';
import { separateBets, weeklyMean, isoWeek, weekdaysBetween, tCdf, quantile, seeded, gauss, LIKELY } from './stats.js';
import { MARKETS, marketDate, tradingDaysBetween, sessionDateAfter } from './markets.js';
import { REGIME, VIX, vixLevel } from './memory-long.js';

export const FX = 'SGD=X';
export const FACTORS = ['ma50', 'high52', 'volume20', 'move1m', 'results', 'index200'];
export const REGIME_KEYS = ['vix', 'usdsgd1m'];
// The order of a stored factor array (append-only: stored arrays and idea-log columns refer to it).
export const FACTOR_KEYS = [...FACTORS, ...REGIME_KEYS];
// decimals each value is stored with (fractions for the moves, a ratio, days, the VIX's level)
const DECIMALS = { ma50: 3, high52: 3, volume20: 2, move1m: 2, results: 0, index200: 3, vix: 1, usdsgd1m: 4 };
export const FACTOR = { ma: 50, high: 252, highMin: 240, volDays: 20, volMin: 15, month: 21, sdDays: 60, resultsMax: 63, index: 200, staleDays: 7 };
// Ideas the lab counts: entries the AI made or proposed (not the ones it passed on, nor exits).
export const LAB_OUTCOMES = ['traded', 'declined', 'expired', 'blocked'];
export const CASE_DAYS = 5; // one case per fund, stock and direction per this many trading days
export const PAGE_MIN_BETS = 8; // the page greys a bucket with fewer separate bets
export const LAB = { bets: 20, weeks: 6, episodes: 2, t: 2.5, window: 5 };

export const FACTOR_LABELS = {
  ma50: 'Price against its 50-day average', high52: 'Distance from its 52-week high', volume20: 'Last session\'s volume against its 20-day average',
  move1m: 'The month\'s move, against its usual month', results: 'Results', index200: 'Index against its 200-day average',
  vix: 'The VIX (US stocks)', usdsgd1m: 'US dollar against the Singapore dollar, over a month',
};
// Buckets fixed in advance: each value falls in the first bucket whose `below` it's under (the last has none).
export const BUCKETS = {
  ma50: [{ below: -0.03, label: 'over 3% below it' }, { below: 0.03, label: 'within 3%' }, { label: 'over 3% above it' }],
  high52: [{ below: -0.15, label: 'over 15% below it' }, { below: -0.05, label: '5–15% below it' }, { label: 'within 5% of it' }],
  volume20: [{ below: 0.8, label: 'under 0.8x' }, { below: 1.5, label: '0.8x to 1.5x' }, { label: '1.5x or more' }],
  move1m: [{ below: -1, label: 'fell more than usual' }, { below: 1, label: 'in its usual range' }, { label: 'rose more than usual' }],
  results: [{ label: 'in the 5 trading days before' }, { label: 'up to 5 trading days after' }, { label: 'further from results' }],
  index200: [{ below: 0, label: 'below it' }, { label: 'above it' }],
  vix: [{ label: 'calm (under 16)' }, { label: 'normal (16 to 25)' }, { label: 'stressed (over 25)' }],
  usdsgd1m: [{ below: -0.01, label: 'down 1% or more' }, { below: 0.01, label: 'within 1%' }, { label: 'up 1% or more' }],
};
const VIX_BUCKET = { calm: 0, normal: 1, stressed: 2 };

// The bucket (its index in BUCKETS[key]) a factor value falls in, or null without one.
export function bucketOf(key, v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (key === 'vix') return VIX_BUCKET[vixLevel(v)];
  if (key === 'results') return v >= 1 && v <= LAB.window ? 0 : v <= 0 && v >= -LAB.window ? 1 : 2;
  const i = BUCKETS[key].findIndex((b) => b.below == null || v < b.below);
  return i;
}

// The three comparisons fixed in advance that can become lessons: each value's side, or null when it's on
// neither (a normal VIX; an unknown value). `market`: where the comparison applies.
export const SPLITS = [
  { id: 'results', key: 'results', sides: ['before', 'other'], side: (v) => (v == null ? null : v >= 1 && v <= LAB.window ? 'before' : 'other') },
  { id: 'index', key: 'index200', sides: ['below', 'above'], side: (v) => (v == null ? null : v >= 0 ? 'above' : 'below') },
  { id: 'vix', key: 'vix', sides: ['stressed', 'calm'], markets: ['US'], side: (v) => (v == null ? null : { calm: 'calm', stressed: 'stressed' }[vixLevel(v)] ?? null) },
];

const DAY_S = 86400;
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const r5 = (x) => round(x, 5);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const indexOf = (market) => BENCHMARKS[market === 'SGX' ? 'SGD' : 'USD'].symbol;
const currencyOf = (market) => (market === 'SGX' ? 'SGD' : 'USD');

// ---------- the data ----------

// Everything the factors are measured from: each symbol's daily closes and volumes (the two years in
// data/ohlcv.json where there are some, else prices.json's year), the VIX, USD/SGD, and each stock's
// results days (the first session that could trade on them) from the results calendar (calendar.js
// resultsCalendar). `ohlcv`: data/ohlcv.json ({ symbols: { SYMBOL: { market, etf?, bars: [[t, open, high,
// low, close, volume]] } }, macro: { '^VIX': [[t, close]], 'SGD=X': [[t, close]] } }); `quotes` and
// `macro`: prices.json's.
export function factorInputs({ ohlcv = null, quotes = {}, calendar = null, macro = null } = {}) {
  const series = {};
  const symbols = new Set([...Object.keys(ohlcv?.symbols ?? {}), ...Object.keys(quotes ?? {})]);
  for (const s of symbols) {
    const o = ohlcv?.symbols?.[s], q = quotes?.[s];
    const long = (o?.bars ?? []).filter((b) => b[4] > 0);
    const market = o?.market ?? q?.market;
    if (!market) continue;
    const bars = long.length >= (q?.daily?.length ?? 0) ? long.map((b) => [b[0], b[4], b[5]]) : (q?.daily ?? []).filter((b) => b[1] > 0);
    if (bars.length) series[s] = line(bars, sessionLength({ market }), { market, etf: Boolean(o?.etf ?? q?.etf) });
  }
  const macroLine = (key, len) => {
    const bars = (ohlcv?.macro?.[key]?.length ? ohlcv.macro[key] : macro?.[key]?.daily ?? []).filter((b) => b[1] > 0);
    return bars.length ? line(bars, len) : null;
  };
  const results = {};
  for (const [s, r] of Object.entries(calendar ?? {})) {
    const market = series[s]?.market ?? quotes?.[s]?.market;
    const days = [...(r.past ?? []), ...(r.next ? [r.next] : [])].filter((x) => x?.date).map((x) => resultsSession(x, market));
    results[s] = [...new Set(days)].sort();
  }
  return { series, vix: macroLine(VIX, sessionLength({ market: 'US' })), fx: macroLine(FX, DAY_S), results, cache: new Map() };
}
// The first session that trades on a results date from the calendar: its effectiveDate when an SEC filing
// gave one; for a US date without one (Yahoo's date, before the filing lands) the next weekday, since the
// watchlist's US companies report after the close; else the date itself. One definition for an idea's
// factors stored on the day and the same idea's factors worked out again once the filing is in.
export function resultsSession(x, market) {
  if (x.effectiveDate) return x.effectiveDate;
  return market === 'US' ? sessionDateAfter('US', x.date, MARKETS.US.sessions.at(-1)[1]) : x.date;
}

// A series as parallel arrays: bar times, closes, volumes (null without), and when each bar's session ends.
function line(bars, len, extra = {}) {
  return { ...extra, t: bars.map((b) => b[0]), c: bars.map((b) => b[1]), v: bars.map((b) => (b[2] > 0 ? b[2] : null)), len };
}

// The last bar whose session had ended by unix time t (-1 if none).
function lastClosed(s, t) {
  let lo = 0, hi = s.t.length - 1, out = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.t[mid] + s.len <= t) { out = mid; lo = mid + 1; } else hi = mid - 1; }
  return out;
}

// The last session's volume against the average of the `days` sessions before it (at least FACTOR.volMin
// of them with a volume), or null. Shared with the AI's price statistics (ai.js stockStats rel_volume_20d).
export function relVolume(volumes, i, days = FACTOR.volDays) {
  if (i < days || !(volumes[i] > 0)) return null;
  const before = volumes.slice(i - days, i).filter((v) => v > 0);
  return before.length >= FACTOR.volMin ? volumes[i] / avg(before) : null;
}

// The four factors that are the stock's own, at bar i (remembered per symbol and bar).
function stockFactors(inputs, symbol, s, i) {
  const key = `${symbol}|${i}`;
  if (inputs.cache.has(key)) return inputs.cache.get(key);
  const c = s.c;
  const ma = i + 1 >= FACTOR.ma ? c[i] / avg(c.slice(i + 1 - FACTOR.ma, i + 1)) - 1 : null;
  const high = i + 1 >= FACTOR.highMin ? c[i] / Math.max(...c.slice(Math.max(0, i + 1 - FACTOR.high), i + 1)) - 1 : null;
  let move = null;
  if (i >= FACTOR.sdDays) {
    const r = [];
    for (let k = i + 1 - FACTOR.sdDays; k <= i; k++) r.push(Math.log(c[k] / c[k - 1]));
    const m = avg(r), sd = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1));
    if (sd > 0) move = (c[i] / c[i - FACTOR.month] - 1) / (sd * Math.sqrt(FACTOR.month));
  }
  const out = { ma50: ma, high52: high, volume20: relVolume(s.v, i), move1m: move };
  inputs.cache.set(key, out);
  return out;
}

// Trading days from the market's date at unix time t to the stock's next results (0: that day), or since
// its last (negative), whichever is nearer (the next on a tie); null beyond FACTOR.resultsMax or without dates.
function resultsDays(days, market, t) {
  if (!days?.length) return null;
  const today = marketDate(market, new Date(t * 1000));
  const k = days.findIndex((d) => d >= today);
  const next = k >= 0 ? tradingDaysBetween(today, days[k]) : null;
  const prevDay = k === -1 ? days.at(-1) : k > 0 ? days[k - 1] : null;
  const prev = prevDay ? tradingDaysBetween(today, prevDay) : null;
  const v = next != null && (prev == null || next <= -prev) ? next : prev;
  return v != null && Math.abs(v) <= FACTOR.resultsMax ? v : null;
}

// The factor array (FACTOR_KEYS order, rounded) for `symbol` at unix time t, from bars closed before t,
// or null when there are no prices for it by then.
export function factorsAt(inputs, symbol, t) {
  const s = inputs?.series?.[symbol];
  if (!s || !Number.isFinite(t)) return null;
  const i = lastClosed(s, t);
  if (i < 0) return null;
  const own = stockFactors(inputs, symbol, s, i);
  const idx = inputs.series[indexOf(s.market)];
  const j = idx ? lastClosed(idx, t) : -1;
  const index200 = j + 1 >= FACTOR.index ? idx.c[j] / avg(idx.c.slice(j + 1 - FACTOR.index, j + 1)) - 1 : null;
  // the VIX and USD/SGD only while they're current (a series that stopped updating isn't today's)
  const fresh = (x, k) => k >= 0 && t - (x.t[k] + x.len) <= FACTOR.staleDays * DAY_S;
  const kv = inputs.vix ? lastClosed(inputs.vix, t) : -1;
  const vix = inputs.vix && fresh(inputs.vix, kv) ? inputs.vix.c[kv] : null;
  const kf = s.market === 'SGX' && inputs.fx ? lastClosed(inputs.fx, t) : -1;
  const usdsgd1m = kf >= FACTOR.month && fresh(inputs.fx, kf) ? inputs.fx.c[kf] / inputs.fx.c[kf - FACTOR.month] - 1 : null;
  const values = { ...own, results: s.etf ? null : resultsDays(inputs.results?.[symbol], s.market, t), index200, vix, usdsgd1m };
  const arr = FACTOR_KEYS.map((k) => round(values[k], DECIMALS[k]));
  return arr.some((v) => v != null) ? arr : null;
}

// A stored factor array as { key: value } (missing values null), or null.
export function factorsOf(arr) {
  if (!Array.isArray(arr)) return null;
  return Object.fromEntries(FACTOR_KEYS.map((k, i) => [k, arr[i] ?? null]));
}

// ---------- cases ----------

// A fund's graded ideas (learning.js gradeIdeas) as the lab's cases: its entries made or proposed
// (LAB_OUTCOMES) with a week's grade against the index and their factors, one per stock and direction per
// CASE_DAYS trading days (the first). Each: { fund, symbol, direction, t, ideaType, x (the stock-specific
// edge a week later: the move less beta times the index's, less fees), x21 (the same a month later, null
// until then; the owner's questions, hypotheses.js), made (the move less fees), f }.
export function labCases(graded, fundId = '') {
  const last = new Map();
  const out = [];
  for (const g of [...(graded ?? [])].sort((a, b) => a.t - b.t)) {
    if (g.kind !== 'entry' || !LAB_OUTCOMES.includes(g.outcome) || g.week?.move == null || g.week.index == null) continue;
    const f = factorsOf(g.factors);
    if (!f) continue;
    const key = `${g.symbol}|${g.direction}`;
    if (last.has(key) && weekdaysBetween(last.get(key), g.t) < CASE_DAYS) continue;
    last.set(key, g.t);
    const fee = g.fee ?? 0;
    out.push({ fund: fundId, symbol: g.symbol, direction: g.direction, t: g.t, idio: g.idio, ideaType: g.ideaType ?? 'other',
      x: g.week.move - (g.beta ?? 1) * g.week.index - fee, made: g.week.move - fee, f,
      x21: g.month?.move != null && g.month.index != null ? g.month.move - (g.beta ?? 1) * g.month.index - fee : null });
  }
  return out;
}

// Separate episodes among bets: runs of bets no more than REGIME.gap trading days apart (a regime that
// lasted a year is one episode; one that came back after a spell of the other is a second).
function episodeCount(bets) {
  let n = 0, prev = null;
  for (const b of [...bets].sort((a, c) => a.t - c.t)) {
    if (prev == null || weekdaysBetween(prev, b.t) > REGIME.gap) n++;
    prev = b.last ?? b.t;
  }
  return n;
}
// For results, an episode is one stock's results: the stocks and calendar quarters the bets fall in.
const resultsEpisodes = (bets) => new Set(bets.map((b) => { const d = new Date(b.t * 1000); return `${b.symbol}|${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}`; })).size;
const EPISODES = { results: resultsEpisodes };

// A group of cases (on factor `key`, which says what an episode is): { n (cases), bets (separate bets),
// weeks, episodes, mean (the edge a week later,
// weeks averaged), se, lo, hi (the likely range, an 8-in-10 chance), right (the share of bets that made
// money after fees) }, with `rows` (each bet's value and week) kept for comparisons, or null without cases.
function group(cases, key = null) {
  if (!cases.length) return null;
  const bets = separateBets(cases, CASE_DAYS);
  const rows = bets.map((b) => ({ x: avg(b.items.map((i) => i.x)), made: avg(b.items.map((i) => i.made)), key: isoWeek(b.t), t: b.t }));
  const wm = weeklyMean(rows);
  const half = wm.n >= 2 ? quantile(0.5 + LIKELY / 2, wm.n - 1) * wm.se : null;
  return {
    n: cases.length, bets: bets.length, weeks: wm.n, episodes: (EPISODES[key] ?? episodeCount)(bets), mean: wm.mean, se: wm.se,
    lo: half == null ? null : r5(wm.mean - half), hi: half == null ? null : r5(wm.mean + half),
    right: round(rows.filter((r) => r.made > 0).length / rows.length, 2), rows,
  };
}
const compact = (g) => (g ? (({ rows, se, ...rest }) => rest)(g) : null);

// One fixed comparison (SPLITS) on `cases`: each side's group, the difference (first side minus second,
// per week), its likely range and week-clustered t, the difference in each half of the record (split at
// the middle bet in time), and whether it passes every gate (`why` names the first it fails).
export function splitTest(split, cases) {
  const by = Object.fromEntries(split.sides.map((s) => [s, cases.filter((c) => split.side(c.f[split.key]) === s)]));
  const [a, b] = split.sides.map((s) => group(by[s], split.key));
  const out = { id: split.id, sides: split.sides.map((s, i) => ({ side: s, ...compact([a, b][i]) })) };
  if (!a || !b) return { ...out, passes: false, why: 'bets' };
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  const diff = a.mean - b.mean, t = se > 0 ? diff / se : 0;
  const df = Math.max(1, Math.min(a.weeks, b.weeks) - 1);
  const half = quantile(0.5 + LIKELY / 2, df) * se;
  // the two halves of the record: every bet on either side, split at the middle one in time
  const times = [...a.rows, ...b.rows].map((r) => r.t).sort((x, y) => x - y);
  const mid = times[times.length >> 1];
  const halves = [(r) => r.t < mid, (r) => r.t >= mid].map((inHalf) => {
    const [ma, mb] = [a, b].map((g) => weeklyMean(g.rows.filter(inHalf))?.mean);
    return ma == null || mb == null ? null : r5(ma - mb);
  });
  const sameSign = halves.every((h) => h != null && Math.sign(h) === Math.sign(diff) && diff !== 0);
  const why = [a, b].some((g) => g.bets < LAB.bets) ? 'bets' : [a, b].some((g) => g.weeks < LAB.weeks) ? 'weeks'
    : [a, b].some((g) => g.episodes < LAB.episodes) ? 'episodes' : Math.abs(t) < LAB.t ? 't' : !sameSign ? 'halves' : null;
  return {
    ...out, diff: r5(diff), lo: r5(diff - half), hi: r5(diff + half), t: round(t, 2), p: round(tCdf(Math.abs(t), df), 3), halves, passes: !why, why,
  };
}

// ---------- when its ideas work: each market's funds pooled ----------

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The words of a lesson about side `weak` of a split, which did worse than side `strong`.
const SIDE_WORDS = {
  results: { before: ['Its ideas opened in the 5 trading days before a stock\'s results', 'its other ideas', 'before results'], other: ['Its ideas opened away from results', 'those opened in the 5 trading days before results', 'away from results'] },
  index: { below: ['With {index} below its 200-day average, its ideas', 'when {index} was above it', 'while {index} is below its 200-day average'], above: ['With {index} above its 200-day average, its ideas', 'when {index} was below it', 'while {index} is above its 200-day average'] },
  vix: { stressed: ['With the VIX stressed (over 25), its ideas', 'when it was calm (under 16)', 'while the VIX is stressed'], calm: ['With the VIX calm (under 16), its ideas', 'when it was stressed (over 25)', 'while the VIX is calm'] },
};

// A lesson from a split that passed: about the side that did worse, with its condition.
function splitLesson(s, market, funds) {
  const weakFirst = s.diff < 0;
  const [weak, strong] = weakFirst ? [s.sides[0], s.sides[1]] : [s.sides[1], s.sides[0]];
  const idx = indexOf(market).replace(/\.SI$/, '');
  const [who, than, when] = SIDE_WORDS[s.id][weak.side].map((w) => w.replace(/\{index\}/g, idx));
  const gap = weakFirst ? s.diff : -s.diff; // the weak side minus the strong one (negative)
  const [lo, hi] = weakFirst ? [s.lo, s.hi] : [-s.hi, -s.lo];
  const scope = funds >= 2 ? `the ${funds} ${currencyOf(market)} funds' ideas pooled` : 'its ideas';
  const side = (g) => `${plural(g.bets, 'separate bet')} from ${plural(g.weeks, 'week')} in ${plural(g.episodes, 'episode')}`;
  return {
    id: `cond:${s.id}:${weak.side}`, source: 'conditions', measure: 'split', condition: { split: s.id, side: weak.side },
    text: `${who} have done worse than ${than}, beyond what the market explains: ${pct(weak.mean)} a week against ${pct(strong.mean)}, after beta and fees. Be more selective ${when}, and size smaller.`,
    evidence: `From ${scope}, one case per fund, stock and side per ${CASE_DAYS} trading days: ${side(weak)}, against ${side(strong)}. Difference ${pct(gap)} a week (likely ${pct(lo)} to ${pct(hi)}), ${Math.abs(s.t).toFixed(1)} times what noise alone would usually give (counted by week), and on the same side of zero in both halves of the record.`,
    edge: r5(gap), lo: r5(lo), hi: r5(hi), bets: Math.min(weak.bets, strong.bets), p: s.p, confidence: s.p >= 0.99 ? 'High' : 'Moderate',
  };
}

// Each market's lab, from every fund trading in it (`gradedBy`: this run's graded ideas by fund id; a fund
// without them counts with `frozen(fund)`, its frozen idea log): { [market]: { funds, cases, from, rows:
// [{ key, bucket, ...group }], splits: [splitTest], lessons } }.
export function factorLab(funds, gradedBy = {}, frozen = () => []) {
  const out = {};
  for (const ccy of [...new Set((funds ?? []).map((f) => f.currency))]) {
    const market = ccy === 'SGD' ? 'SGX' : 'US';
    const mine = funds.filter((f) => f.currency === ccy);
    const cases = mine.flatMap((f) => labCases(gradedBy[f.id] ?? frozen(f), f.id));
    const rows = [];
    for (const key of FACTOR_KEYS) {
      if ((key === 'vix' && market !== 'US') || (key === 'usdsgd1m' && market !== 'SGX')) continue;
      BUCKETS[key].forEach((_, bucket) => {
        const g = group(cases.filter((c) => bucketOf(key, c.f[key]) === bucket), key);
        if (g) rows.push({ key, bucket, ...compact(g) });
      });
    }
    const splits = SPLITS.filter((s) => !s.markets || s.markets.includes(market)).map((s) => splitTest(s, cases));
    out[market] = {
      funds: mine.length, cases: cases.length, from: cases.length ? new Date(Math.min(...cases.map((c) => c.t)) * 1000).toISOString().slice(0, 10) : null,
      rows, splits, lessons: splits.filter((s) => s.passes).map((s) => splitLesson(s, market, mine.length)),
    };
  }
  return out;
}

// ---------- the lessons' conditions today ----------

// What holds today in a market, for the lessons' conditions: { trend ('above' | 'below' its 200-day
// average), level (the VIX's: calm | normal | stressed, US only), resultsSoon (the market's stocks whose
// results are first traded in 1 to 5 trading days, counted as the results factor counts them:
// resultsSession) }. `regime`: memory-long.js regimeNow; `upcoming`: calendar.js upcomingResults for the
// market's stocks (days_away counts to a filing's first session, else to the date itself).
export const conditionsNow = (regime, upcoming = [], market = null) => ({
  trend: regime?.trend ?? null, level: regime?.level ?? null,
  resultsSoon: (upcoming ?? []).filter((u) => {
    const away = u.source === 'filing' || !u.date ? u.days_away : u.days_away + tradingDaysBetween(u.date, resultsSession(u, market));
    return away >= 1 && away <= LAB.window;
  }).map((u) => u.symbol),
});

// When the AI sees a lesson about `condition`, in words for the page: "while SPY is below its 200-day
// average", "when one of its market's stocks reports within 5 trading days", or "at every decision".
export function conditionWords(condition, market) {
  const idx = indexOf(market).replace(/\.SI$/, '');
  const { split, side } = condition ?? {};
  if (split === 'results') return side === 'before' ? `when one of its market's stocks reports within ${LAB.window} trading days` : 'at every decision';
  if (split === 'index') return `while ${idx} is ${side} its 200-day average`;
  if (split === 'vix') return `while the VIX is ${side}`;
  return '';
}

// Whether a lesson's condition holds today (see conditionsNow), as a few words for the AI, or null.
export function conditionHolds(condition, now = null) {
  if (!condition) return null;
  now ??= {};
  const { split, side } = condition;
  if (split === 'results') return side === 'other' ? 'yes' : now.resultsSoon?.length ? `yes: ${now.resultsSoon.slice(0, 4).join(', ')} report within ${LAB.window} trading days` : null;
  if (split === 'index') return now.trend === side ? `yes: the index is ${side} its 200-day average today` : null;
  if (split === 'vix') return now.level === side ? `yes: the VIX is ${side} today` : null;
  return null;
}

// ---------- its revealed style ----------

// Where the stocks a fund chose sat among its market's stocks, at the time: for its buys and its shorts
// (labCases, index funds left out of the percentiles), the average within-market percentile of each of
// the stock's own factors (0 the lowest of its market's stocks that day, 100 the highest; needs 4 stocks
// with a value, against the others), their average values, the share opened in the 5 trading days before results and with
// the index above its 200-day average, and what it called them (its most used kind of idea and its
// share). `inputs`: factorInputs. { buys, shorts } (each null without cases).
export function revealedStyle(graded, inputs) {
  const cases = labCases(graded).filter((c) => inputs?.series?.[c.symbol]);
  const own = FACTORS.slice(0, 4);
  const side = (dir) => {
    const list = cases.filter((c) => c.direction === dir);
    if (!list.length) return null;
    const pcts = Object.fromEntries(own.map((k) => [k, []]));
    for (const c of list) {
      const s = inputs.series[c.symbol];
      if (s.etf) continue;
      // the market's other stocks (not index funds) that day
      const others = Object.entries(inputs.series).filter(([sym, x]) => sym !== c.symbol && x.market === s.market && !x.etf).map(([sym]) => factorsOf(factorsAt(inputs, sym, c.t)));
      own.forEach((k) => {
        const v = c.f[k], vals = others.map((p) => p?.[k]).filter((x) => x != null);
        if (v == null || vals.length < 3) return;
        pcts[k].push((vals.filter((x) => x < v).length + vals.filter((x) => x === v).length / 2) / vals.length);
      });
    }
    const mean = (xs) => (xs.length ? avg(xs) : null);
    const known = (k) => list.map((c) => c.f[k]).filter((v) => v != null);
    const types = new Map();
    for (const c of list) types.set(c.ideaType, (types.get(c.ideaType) ?? 0) + 1);
    const [topType, topN] = [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const results = known('results'), index = known('index200');
    return {
      cases: list.length,
      percentile: Object.fromEntries(own.map((k) => [k, pcts[k].length ? Math.round(mean(pcts[k]) * 100) : null])),
      counted: Math.max(...own.map((k) => pcts[k].length)),
      average: Object.fromEntries(own.map((k) => [k, round(mean(known(k)), DECIMALS[k] + 1)])),
      beforeResults: results.length ? round(results.filter((v) => v >= 1 && v <= LAB.window).length / results.length, 2) : null,
      indexAbove: index.length ? round(index.filter((v) => v >= 0).length / index.length, 2) : null,
      topType, topShare: round(topN / list.length, 2),
    };
  };
  const buys = side(1), shorts = side(-1);
  return buys || shorts ? { buys, shorts, from: cases.length ? new Date(cases[0].t * 1000).toISOString().slice(0, 10) : null } : null;
}

// ---------- checking the lesson rules on pure noise ----------

// A made-up market with no skill at all, `weeks` long: a few ideas a trading day on 8 stocks, each one's
// stock-specific edge pure noise (the stock's own weekly swing plus a little that's shared that week, as
// a real market's residuals are), with results every quarter, the index above or below its 200-day
// average in runs of weeks, and the VIX wandering between calm and stressed. Any lesson is a false one.
// Returns cases as labCases makes them.
export function noiseCases(rand, weeks = 52) {
  const start = Date.parse('2026-01-05T15:00:00Z') / 1000; // a Monday
  const stocks = Array.from({ length: 8 }, (_, i) => ({ symbol: `N${i}`, idio: 0.02 + 0.025 * rand(), offset: Math.floor(rand() * 63) }));
  const cases = [];
  let above = rand() < 0.6, runLeft = 20 + Math.floor(rand() * 100), vix = 14 + 8 * rand();
  const last = new Map();
  for (let day = 0; day < weeks * 5; day++) {
    const t = start + (Math.floor(day / 5) * 7 + (day % 5)) * DAY_S;
    if (--runLeft <= 0) { above = !above; runLeft = 20 + Math.floor(rand() * 100); }
    vix = Math.min(45, Math.max(10, vix + 0.1 * (18 - vix) + 1.5 * gauss(rand)));
    const shared = 0.008 * gauss(rand);
    for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) {
      const st = stocks[Math.floor(rand() * stocks.length)];
      const direction = rand() < 0.75 ? 1 : -1, key = `${st.symbol}|${direction}`;
      if (last.has(key) && day - last.get(key) < CASE_DAYS) continue;
      last.set(key, day);
      // results every 63 trading days: the nearer of the days to the next and since the last
      const since = (day + st.offset) % 63, toNext = 63 - since;
      const x = st.idio * gauss(rand) + shared * direction;
      cases.push({ fund: 'n', symbol: st.symbol, direction, t, idio: st.idio, ideaType: 'other', x, made: x,
        f: { results: toNext <= since ? toNext : -since, index200: above ? 0.05 : -0.05, vix } });
    }
  }
  return cases;
}

// How often the lesson rules find a pattern in pure noise: `sims` made-up markets, each re-checked every
// `every` weeks over `weeks` weeks (from the 8th), as the job re-checks the growing record. { sims, any
// (the share that ever showed a false lesson), moreThanOne }.
export function conditionNoiseCheck({ sims = 200, seed = 1, weeks = 52, every = 1 } = {}) {
  const rand = seeded(seed);
  let any = 0, many = 0;
  for (let k = 0; k < sims; k++) {
    const cases = noiseCases(rand, weeks);
    const seen = new Set();
    for (let w = 8; w <= weeks; w += every) {
      const cut = cases[0].t + w * 7 * DAY_S;
      const upTo = cases.filter((c) => c.t < cut);
      for (const s of SPLITS) if (splitTest(s, upTo).passes) seen.add(s.id);
    }
    if (seen.size) any++;
    if (seen.size > 1) many++;
  }
  return { sims, any: any / sims, moreThanOne: many / sims };
}
// What conditionNoiseCheck({}) gives (the tests re-run it): the page prints it.
export const COND_NOISE_CHECK = { sims: 200, any: 0.08, moreThanOne: 0.005 };
