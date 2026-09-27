// Ten years of the watchlist's own prices for the market memory, checked on held-out years. Pure
// functions, no AI. Once a week scripts/build-history.mjs downloads ten years of Yahoo's daily prices
// (scripts/yahoo_fetch.py long; the raw download stays on the runner, it's never saved), runs these
// studies and writes the compact results to state/memory-long.json. The AI funds get its lessons with
// the past year's news memory (memory.js), in shorter words (promptMarketLessons), and the fund page
// shows them in full.
//
// 1. Clean-up (cleanSeries). Yahoo's dividend-adjusted closes are checked against its dividends: where
//    the adjustment changes by far more than that day's dividend, or with no dividend at all, it's
//    broken (Thai Beverage's starts at 0.0016 against a close of 0.965), so the total return is rebuilt
//    from the closes and the dividends. A dividend over 20% of the price is a data error and left out,
//    and a split Yahoo didn't apply to the older closes is applied. One-day moves over 30% (a bad
//    print, or a restructuring such as Keppel's) and runs of 5 or more unchanged closes (a suspension)
//    are left out of every study. The VIX is never filtered: moves of 25-115% in a day are normal for it.
// 2. Fixed studies, decided in advance (never searched for), per market:
//      big moves    a one-day move of at least max(4%, 2.5x the stock's usual daily move, the sd of its
//                   last 60 daily returns), up and down, and what followed over 5 and 21 trading days;
//                   split by volume (2x or more its 50-day average) for the report only
//      best-worst   last week's best stock against last week's worst, the following week
//      ex-dividend  the SGX banks, C38U and Singtel: the ex-date drop against the dividend, and the
//                   21 trading days after
//      results      US results (SEC filings, else Yahoo's past dates): the drift after good and bad
//                   results (the earnings surprise, else the first day against the index), and each
//                   stock's typical results-day move
//      stops        how often ordinary swings hit a stop k daily moves away (k = 1.5, 2, 2.5, 3) within
//                   21 trading days, and the stop they reached in only 1 hold in 5 (suggested_stop_pct)
// 3. Outcomes are abnormal returns: the stock's total return, minus beta times the index's total
//    return (stats.js betaAt, from the year before), minus the stock's own average daily excess over
//    that year times the days. The last part strips out most of the drift of today's winners.
//    Separate bets as for every lesson (stats.js): the same stock and side within the window is one
//    bet, and the uncertainty is worked out by date (by calendar week for 21 days, whose windows
//    overlap), so a market-wide day counts once.
// 4. The held-out check (holdoutCheck): a pattern found on 2016-2023 needs a 90% chance of its sign
//    there (stats.js estimate, 8+ separate bets) and, like every lesson, an effect of at least
//    GATE.edge (over its horizon); 2024 onwards, which it wasn't found on, must then show the same sign
//    at half its size or more. Otherwise the lesson is that there's no reliable pattern, which stops the
//    AI assuming one. holdoutNoiseCheck measures how often pure noise gets through.
// 5. The regime (regimeNow): the index against its 200-day average and, for US stocks, the VIX. Here it's
//    descriptive only: no ten-year lesson depends on it; lessons with evidence from days like today come
//    first. (The factor lab's lessons on the funds' own ideas, factors.js, can depend on it.)
// 6. The owner's own questions (Ask the data, hypotheses.js) are answered from the same cases (longCases),
//    each also with the day after, and the same held-out check.
// The universe is today's 17 stocks, which survived the ten years and mostly won: tendencies, not laws.

import { BENCHMARKS } from './benchmark.js';
import { betaAt, estimate, separateBets, isoWeek, GATE, BANKS, seeded, gauss } from './stats.js';
import { resultsQuarter, toneOf } from './memory.js';
import { typicalResultsMove } from './calendar.js';

export const VIX = '^VIX';
export const LONG = {
  bigMin: 0.04, bigSd: 2.5, // a big move: at least 4% and 2.5x the stock's usual daily move
  sdDays: 60, // the usual daily move: the sd of the last 60 daily returns
  volDays: 50, heavy: 2, // heavy volume: 2x or more the average of the last 50 sessions
  jump: 0.3, // a one-day move beyond 30% is a data error or a restructuring
  flatRun: 5, // this many unchanged closes in a row: no trading
  maxDividend: 0.2, // a dividend over 20% of the price is a data error
  horizons: [5, 21],
  caseHorizons: [1, 5, 21], // every case also carries its next day, for the owner's questions (hypotheses.js)
  stopKs: [1.5, 2, 2.5, 3], hold: 21, stopShare: 0.2, // suggested stop: hit by ordinary swings in 1 hold in 5
  minBars: 250, maxBadShare: 0.05, // a series needs a year of prices, with at most 5% of days left out
};
// Train on 2016-2023, check on 2024 onwards. p: the chance of the sign on the training years; share:
// the held-out years' average must be at least this share of the training estimate, with the same sign.
export const HOLDOUT = { trainTo: '2023-12-31', testFrom: '2024-01-01', p: 0.9, share: 0.5, testBets: 5 };
export const REGIME = { calm: 16, stressed: 25, days: 200, min: 10, gap: 20, runDays: 5, vixDays: 4 };
export const EX_DIVIDEND = [...Object.keys(BANKS), 'C38U.SI', 'Z74.SI'];
export const MAX_BYTES = 50000;
export const REFRESH_DAYS = 7;
const INDEX_OF = { US: BENCHMARKS.USD.symbol, SGX: BENCHMARKS.SGD.symbol };
const CURRENCY_OF = { US: 'USD', SGX: 'SGD' };

const DAY_MS = 86400000;
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sdOf = (xs) => { const m = avg(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
// The value below which a share `q` of `xs` falls (linear between the nearest two).
function quantileOf(xs, q) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), at = q * (a.length - 1), lo = Math.floor(at);
  return lo + 1 < a.length ? a[lo] + (at - lo) * (a[lo + 1] - a[lo]) : a[lo];
}
// In sorted dates: the last on or before `d` (-1 if none), and the first on or after it (length if none).
function onOrBefore(dates, d) {
  let lo = 0, hi = dates.length - 1, out = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= d) { out = mid; lo = mid + 1; } else hi = mid - 1; }
  return out;
}
const firstFrom = (dates, d) => { const k = onOrBefore(dates, d); return k >= 0 && dates[k] === d ? k : k + 1; };
// +1.2%, −0.4%, or 0.0% for what rounds to nothing
const pct = (x, d = 1) => { const v = Math.abs(x * 100) < 0.5 * 10 ** -d ? 0 : x; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(d)}%`; };
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// ---------- the data ----------

// One symbol's daily bars from Yahoo's chart answer (range=10y, interval=1d): parallel arrays, oldest
// first, bars without a close dropped and one bar per date (the last, when Yahoo repeats today's).
// `ev`: its dividends and splits (scripts/fetch-prices.mjs events()).
export function seriesFrom(result, ev = null) {
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const adj = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const num = (x) => (typeof x === 'number' && x > 0 ? x : null);
  const byDate = new Map();
  ts.forEach((t, i) => {
    const close = num(q.close?.[i]);
    if (close && Number.isFinite(t)) byDate.set(dateOf(t), { t, close, high: num(q.high?.[i]), low: num(q.low?.[i]), volume: typeof q.volume?.[i] === 'number' ? q.volume[i] : null, adj: num(adj[i]) });
  });
  const bars = [...byDate.values()].sort((a, b) => a.t - b.t);
  const col = (k) => bars.map((b) => b[k]);
  return { t: col('t'), close: col('close'), high: col('high'), low: col('low'), volume: col('volume'), adj: col('adj'), dividends: ev?.dividends ?? [], splits: ev?.splits ?? [] };
}

// A series cleaned for the studies (see the header): { t, date, close, high, low, volume, r (each
// day's total return), ok (whether the return into that day is usable), bad (how many unusable days so
// far, so a window a..b is clean when bad[b] === bad[a]), tr (a total-return level, flat over unusable
// days), divOn (the dividend going ex on each day), divBars ([day, amount]), source ('adjclose' or
// 'close+dividends'), why (why the adjusted closes weren't used), notes (what the clean-up did),
// leftOut (why the series can't be used, or null) }. `macro` (the VIX): no filters, and no total return.
export function cleanSeries(raw, { macro = false } = {}) {
  const notes = {};
  let rows = raw.t.map((t, i) => ({ t, close: raw.close[i], high: raw.high?.[i] ?? null, low: raw.low?.[i] ?? null, volume: raw.volume?.[i] ?? null, adj: raw.adj?.[i] ?? null }));
  if (!macro) {
    // a day or two with no trading at all (no volume, unchanged close) is a holiday some feeds include;
    // a longer stretch is a suspension, kept for the unchanged-closes filter below
    const dead = rows.map((b, i, a) => i > 0 && b.volume === 0 && b.close === a[i - 1].close);
    const drop = new Array(rows.length).fill(false);
    for (let i = 1; i < rows.length; i++) {
      if (!dead[i] || dead[i - 1]) continue;
      let j = i;
      while (j + 1 < rows.length && dead[j + 1]) j++;
      if (j - i + 2 < LONG.flatRun) for (let k = i; k <= j; k++) drop[k] = true; // the run with the close before it
    }
    const kept = rows.filter((_, i) => !drop[i]);
    if (kept.length < rows.length) notes.holidays = rows.length - kept.length;
    rows = kept;
  }
  const n = rows.length;
  const t = rows.map((b) => b.t), date = t.map(dateOf);
  const close = rows.map((b) => b.close), high = rows.map((b) => b.high), low = rows.map((b) => b.low);
  const volume = rows.map((b) => b.volume), adj = rows.map((b) => b.adj);
  const ok = new Array(n).fill(true);
  const r = new Array(n).fill(0), divOn = new Array(n).fill(0);
  let source = 'close', why = null;
  if (n) ok[0] = false;

  if (!macro) {
    let dividends = (raw.dividends ?? []).filter(([, a]) => a > 0).map(([dt, amount]) => ({ date: dateOf(dt), amount }));
    // Yahoo's closes already allow for splits; if one wasn't applied to the older closes, the day
    // shows a drop the split explains (a 4-for-1 split, a 75% fall): apply it
    for (const [st, ratio] of raw.splits ?? []) {
      if (!(ratio > 0) || ratio === 1) continue;
      const k = firstFrom(date, dateOf(st));
      if (k < 1 || k >= n) continue;
      const m = close[k] / close[k - 1];
      if (Math.abs(m - 1) < 0.04 || Math.abs(m * ratio - 1) >= 0.3 * Math.abs(m - 1)) continue;
      for (let i = 0; i < k; i++) {
        close[i] /= ratio;
        if (high[i]) high[i] /= ratio;
        if (low[i]) low[i] /= ratio;
        if (adj[i]) adj[i] /= ratio;
      }
      dividends = dividends.map((d) => (d.date < date[k] ? { ...d, amount: d.amount / ratio } : d));
      notes.splitsApplied = (notes.splitsApplied ?? 0) + 1;
    }
    for (const d of dividends) {
      const k = firstFrom(date, d.date);
      if (k < 1 || k >= n) continue;
      if (d.amount / close[k - 1] > LONG.maxDividend) { notes.dividendsDropped = (notes.dividendsDropped ?? 0) + 1; continue; }
      divOn[k] += d.amount;
    }
    // the adjusted closes may only change on an ex-date, by that day's dividend (their factor falls by
    // dividend / previous close); anything else means they're broken
    let off = 0;
    const missing = !n || adj.some((a) => !(a > 0));
    if (!missing) {
      for (let i = 1; i < n; i++) {
        const implied = 1 - (adj[i - 1] / close[i - 1]) / (adj[i] / close[i]);
        const expected = divOn[i] / close[i - 1];
        if (Math.abs(implied - expected) > Math.max(0.003, 0.3 * expected)) off++;
      }
    }
    source = !missing && !off ? 'adjclose' : 'close+dividends';
    if (source !== 'adjclose' && n) why = missing ? 'no adjusted closes' : `its adjusted closes disagreed with its dividends on ${plural(off, 'day')}`;
    for (let i = 1; i < n; i++) r[i] = source === 'adjclose' ? adj[i] / adj[i - 1] - 1 : (close[i] + divOn[i]) / close[i - 1] - 1;

    // one-day moves over 30%, and the move straight back after one (a bad print usually reverses)
    for (let i = 1; i < n; i++) {
      if (Math.abs(r[i]) <= LONG.jump) continue;
      ok[i] = false;
      notes.jumps = (notes.jumps ?? 0) + 1;
      if (i + 1 < n && Math.sign(r[i + 1]) === -Math.sign(r[i]) && Math.abs(Math.log1p(r[i + 1])) >= 0.5 * Math.abs(Math.log1p(r[i]))) ok[i + 1] = false;
    }
    // runs of unchanged closes: the days inside and the first move after (it covers the whole gap)
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && close[i] === close[i - 1]) continue;
      if (i - start >= LONG.flatRun) {
        for (let k = start + 1; k <= Math.min(i, n - 1); k++) ok[k] = false;
        notes.flatRuns = (notes.flatRuns ?? 0) + 1;
      }
      start = i;
    }
  } else {
    for (let i = 1; i < n; i++) r[i] = close[i] / close[i - 1] - 1;
  }

  const tr = new Array(n), bad = new Array(n);
  for (let i = 0; i < n; i++) {
    tr[i] = macro ? close[i] : i ? tr[i - 1] * (ok[i] ? 1 + r[i] : 1) : 1;
    bad[i] = i ? bad[i - 1] + (ok[i] || macro ? 0 : 1) : 0;
  }
  let leftOut = null;
  if (n < LONG.minBars) leftOut = 'less than a year of prices';
  else if (bad[n - 1] > LONG.maxBadShare * n) leftOut = `${plural(bad[n - 1], 'day')} of its prices were unusable`;
  const divBars = divOn.map((a, i) => [i, a]).filter(([, a]) => a > 0);
  return { t, date, close, high, low, volume, r, ok, bad, tr, divOn, divBars, source: macro ? 'close' : source, why, notes, leftOut, macro };
}

// A cleaned series as a prices.json quote, so stats.js betaAt and calendar.js typicalResultsMove work on
// it: its total-return level as the daily closes (dividends already in, flat over unusable days), and
// no dividend events (they'd be counted twice).
export const asQuote = (s, market) => ({ market, currency: CURRENCY_OF[market], daily: s.t.map((t, i) => [t, s.tr[i]]) });

// Whether the weekly build is due: when the last one is REFRESH_DAYS days old, or there's none. After a
// failed attempt (a Yahoo outage) it waits 6 hours rather than retrying every 15 minutes.
export function historyDue(data, now = new Date()) {
  if (data?.triedAt && now - Date.parse(data.triedAt) < 6 * 3600000) return false;
  return !data?.updatedAt || now - Date.parse(data.updatedAt) >= REFRESH_DAYS * DAY_MS;
}

// A download that came back with less than last week's (a stock's or a whole market's prices failed,
// or a stock's came back over a year shorter) isn't taken at once: scripts/build-history.mjs keeps last
// week's build and tries again 6 hours later, up to PARTIAL.tries times in all; then it takes this
// week's build with last week's figures for what it lost (carryOver), each marked with the date of the
// build it comes from (`asOf`), for up to PARTIAL.carryDays.
export const PARTIAL = { tries: 4, carryDays: 28, shortDays: 365 };

// What this week's build `mem` lost against last week's `prev`: the watchlist's stocks (`symbols`, as in
// symbols.json: one the owner took off isn't lost) that `prev` has and `mem` hasn't, or whose prices
// start over PARTIAL.shortDays later than they did, and the markets they're in or that `mem` hasn't.
// { stocks, markets }, both empty when nothing was lost.
export function lostSince(prev, mem, symbols) {
  const listed = new Set((symbols ?? []).map((x) => x.symbol));
  const shorter = (a, b) => Boolean(a && b) && Date.parse(a) - Date.parse(b) > PARTIAL.shortDays * DAY_MS;
  const stocks = Object.keys(prev?.stocks ?? {}).filter((s) => listed.has(s) && (!mem?.stocks?.[s] || shorter(mem.stocks[s].from, prev.stocks[s].from))).sort();
  const markets = Object.keys(prev?.markets ?? {}).filter((m) => !mem?.markets?.[m] || stocks.some((s) => prev.stocks[s].market === m)).sort();
  return { stocks, markets };
}

// This week's build `mem` with last week's (`prev`) figures for what it lost (`lost`, lostSince): each
// lost stock's entry and each lost market, marked `asOf` the build they come from, while that's under
// PARTIAL.carryDays old at `now`. The carried stocks are listed in data.carried ({ symbol, asOf }).
export function carryOver(prev, mem, lost, now = new Date()) {
  const out = { ...mem, stocks: { ...mem.stocks }, markets: { ...mem.markets }, data: { ...mem.data } };
  const asOf = (x) => { const at = x?.asOf ?? prev?.updatedAt; return at && now - Date.parse(at) < PARTIAL.carryDays * DAY_MS ? at : null; };
  const carried = [];
  for (const s of lost?.stocks ?? []) {
    const at = asOf(prev.stocks[s]);
    if (!at) continue;
    out.stocks[s] = { ...prev.stocks[s], asOf: at };
    carried.push({ symbol: s, asOf: at });
  }
  for (const m of lost?.markets ?? []) {
    const at = asOf(prev.markets[m]);
    if (at) out.markets[m] = { ...prev.markets[m], asOf: at };
  }
  out.data.leftOut = (mem.data?.leftOut ?? []).filter((x) => !carried.some((c) => c.symbol === x.symbol));
  if (carried.length) out.data.carried = carried;
  return out;
}

// ---------- one market's prices, aligned ----------

// The index's regime on each of its days: above or below the average of its last 200 closes.
function trendOf(idx) {
  const out = new Array(idx.t.length).fill(null);
  let sum = 0;
  idx.close.forEach((c, k) => {
    sum += c - (k >= REGIME.days ? idx.close[k - REGIME.days] : 0);
    if (k >= REGIME.days - 1) out[k] = c >= sum / REGIME.days ? 'above' : 'below';
  });
  return out;
}

export const vixLevel = (v) => (v < REGIME.calm ? 'calm' : v > REGIME.stressed ? 'stressed' : 'normal');

// Everything the studies need about one stock against its index: each day's index return, the usual
// daily move, the average volume, beta and the stock-specific volatility (stats.js betaAt, from the
// closes of the year before each month, so no event sees its own future), the usual drift, and each
// day's regime. `abnormal(i, h, dir)` is the abnormal total return from day i's close to day i+h's, in
// `dir`, or null when the window holds an unusable day or hasn't happened yet.
function stockFrame(symbol, s, market, idx, trend, vix) {
  const n = s.t.length;
  const pos = s.date.map((d) => onOrBefore(idx.date, d));
  const idxR = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const a = pos[i - 1], b = pos[i];
    if (a >= 0 && b >= 0 && idx.bad[b] === idx.bad[a]) idxR[i] = idx.tr[b] / idx.tr[a] - 1;
  }
  // sd[i]: the usual daily move before day i (sd[n]: now)
  const sd = new Array(n + 1).fill(null);
  for (let i = 1; i <= n; i++) {
    const xs = [];
    for (let k = Math.max(1, i - LONG.sdDays); k < i; k++) if (s.ok[k]) xs.push(s.r[k]);
    if (xs.length >= (LONG.sdDays * 2) / 3) sd[i] = sdOf(xs);
  }
  const vol = new Array(n).fill(null);
  let vSum = 0, vCount = 0;
  for (let i = 0; i < n; i++) {
    if (vCount >= LONG.volDays / 2) vol[i] = vSum / vCount;
    if (s.volume[i] > 0) { vSum += s.volume[i]; vCount++; }
    const out = i - LONG.volDays;
    if (out >= 0 && s.volume[out] > 0) { vSum -= s.volume[out]; vCount--; }
  }
  // running sums of the usable days' returns and the index's, for the usual drift
  const cumR = new Array(n).fill(0), cumI = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (let j = 1; j < n; j++) {
    const use = s.ok[j] && idxR[j] != null;
    cumR[j] = cumR[j - 1] + (use ? s.r[j] : 0);
    cumI[j] = cumI[j - 1] + (use ? idxR[j] : 0);
    cnt[j] = cnt[j - 1] + (use ? 1 : 0);
  }
  const q = asQuote(s, market), iq = asQuote(idx, market);
  const monthStart = new Array(n);
  for (let i = 0; i < n; i++) monthStart[i] = i && s.date[i].slice(0, 7) === s.date[i - 1].slice(0, 7) ? monthStart[i - 1] : i;
  const betas = new Map();
  const betaOf = (i) => {
    const m0 = monthStart[i];
    if (!betas.has(m0)) {
      // betaAt on the ~260 sessions before the month (the same answer as on the whole series, faster)
      const from = Math.max(0, m0 - 260);
      const iFrom = Math.max(0, pos[from]), iTo = pos[m0];
      betas.set(m0, betaAt({ market, daily: q.daily.slice(from, m0 + 1) }, s.t[m0], { market, daily: iTo >= 0 ? iq.daily.slice(iFrom, iTo + 1) : [] }));
    }
    return betas.get(m0);
  };
  // the stock's average daily excess (after beta) over the year before day i: its usual drift
  const driftOf = (i, beta) => {
    const hi = i - 1, lo = Math.max(0, i - 253);
    const c = hi >= 1 ? cnt[hi] - cnt[lo] : 0;
    return c >= 120 ? ((cumR[hi] - cumR[lo]) - beta * (cumI[hi] - cumI[lo])) / c : 0;
  };
  const abnormal = (i, h, dir) => {
    const j = i + h;
    if (i < 1 || j >= n || s.bad[j] !== s.bad[i] || pos[i] < 0 || pos[j] < 0 || idx.bad[pos[j]] !== idx.bad[pos[i]]) return null;
    const { beta } = betaOf(i);
    return dir * (s.tr[j] / s.tr[i] - 1 - beta * (idx.tr[pos[j]] / idx.tr[pos[i]] - 1) - h * driftOf(i, beta));
  };
  // the plain total return against the index's from day a's close to day b's (a stock card's results
  // days, dossier.js), or null when the window holds an unusable day or hasn't happened yet
  const vsIndex = (a, b) => {
    if (a < 0 || b >= n || s.bad[b] !== s.bad[a] || pos[a] < 0 || pos[b] < 0 || idx.bad[pos[b]] !== idx.bad[pos[a]]) return null;
    return s.tr[b] / s.tr[a] - idx.tr[pos[b]] / idx.tr[pos[a]];
  };
  const regimeAt = (i) => {
    const out = { trend: pos[i] >= 0 ? trend[pos[i]] : null };
    if (market === 'US' && vix) { const k = onOrBefore(vix.date, s.date[i]); if (k >= 0) out.vix = vixLevel(vix.close[k]); }
    return out;
  };
  // one case at day i in `dir`, with its outcomes at each horizon and the date each ends
  const item = (i, dir, extra = {}) => {
    const { beta, idio } = betaOf(i);
    const out = { symbol, t: s.t[i], date: s.date[i], direction: dir, beta, idio, ...regimeAt(i) };
    for (const h of LONG.caseHorizons) { out[`x${h}`] = abnormal(i, h, dir); out[`end${h}`] = i + h < n ? s.date[i + h] : null; }
    return Object.assign(out, extra);
  };
  return { symbol, s, market, n, pos, idxR, sd, vol, betaOf, driftOf, abnormal, vsIndex, regimeAt, item, q, iq };
}

// ---------- the studies ----------

// Every big one-day move: at least max(4%, 2.5x the usual daily move before it), in total return (so
// an ex-dividend day isn't a drop), with whether it came on heavy volume (null without volume).
function bigMoves(F) {
  const { s } = F, out = [];
  for (let i = 1; i < F.n; i++) {
    const unit = F.sd[i], r = s.r[i];
    if (!s.ok[i] || unit == null || Math.abs(r) < Math.max(LONG.bigMin, LONG.bigSd * unit)) continue;
    const heavy = F.vol[i] > 0 && s.volume[i] > 0 ? s.volume[i] >= LONG.heavy * F.vol[i] : null;
    out.push(F.item(i, Math.sign(r), { move: r, heavy }));
  }
  return out;
}

// Each ex-date: the dividend as a share of the price before it, and how much of it the price fell
// by that day after the market's move (1 = all of it), with the 21 days after as the outcome.
function exDividends(F) {
  const { s } = F, out = [];
  for (const [k, amount] of s.divBars) {
    if (!s.ok[k] || F.idxR[k] == null) continue;
    const divYield = amount / s.close[k - 1];
    const drop = -((s.close[k] / s.close[k - 1] - 1) - F.betaOf(k).beta * F.idxR[k]) / divYield;
    out.push(F.item(k, 1, { amount, divYield, drop }));
  }
  return out;
}

// The results dates for a stock, oldest first: SEC filings (results-dates.json, with the first session
// that could react) where there are some, and Yahoo's past dates (company-data.json) filling the rest,
// each with its earnings surprise where Yahoo has one (memory.js resultsQuarter).
export function resultsDates(symbol, { filings = null, company = null } = {}) {
  const out = (filings?.symbols?.[symbol] ?? []).map((f) => ({ date: f.date, effectiveDate: f.effectiveDate, from: 'filing' }));
  for (const d of company?.symbols?.[symbol]?.past ?? []) {
    if (!out.some((x) => Math.abs(Date.parse(x.date) - Date.parse(d)) <= 3 * DAY_MS)) out.push({ date: d, from: 'yahoo' });
  }
  return out.map((x) => ({ ...x, surprise: resultsQuarter(company, symbol, x.date)?.surprise ?? null })).sort((a, b) => a.date.localeCompare(b.date));
}

// Each results day's reaction against the index, as calendar.js typicalResultsMove measures it (a
// date without its release time may have come before the open or after the close: the bigger of that
// day and the next), with its tone as memory.js gives filings one (the earnings surprise, else the
// first day's move; in line within ±2%), and the drift after it in the tone's direction as outcomes.
function resultsReactions(F, dates) {
  const { s } = F, out = [];
  const dayEx = (i) => (i >= 1 && i < F.n && s.ok[i] && F.idxR[i] != null ? s.r[i] - F.idxR[i] : null);
  for (const d of dates) {
    let i = firstFrom(s.date, d.effectiveDate ?? d.date);
    if (i < 1 || i >= F.n) continue;
    if (!d.effectiveDate && Math.abs(dayEx(i + 1) ?? 0) > Math.abs(dayEx(i) ?? 0)) i += 1;
    const day = dayEx(i);
    if (day == null) continue;
    const tone = toneOf(d.surprise ?? day);
    const dir = tone === 'positive' ? 1 : tone === 'negative' ? -1 : 0;
    // and, for the stock's card, the week and month from the close before, against the index
    const it = F.item(i, dir || 1, { day, tone, from: d.from, week: F.vsIndex(i - 1, i + 4), month: F.vsIndex(i - 1, i + 20) });
    if (!dir) for (const h of LONG.caseHorizons) it[`x${h}`] = null; // in line: no side to drift to
    out.push(it);
  }
  return out;
}

// Each week, the market's best stock of the week against its worst (by total return), the following
// week: the best's abnormal return minus the worst's. One case per week (it needs 4 stocks with prices).
function bestWorst(frames, idx) {
  const ends = frames.map((F) => { const m = new Map(); F.s.t.forEach((t, i) => m.set(isoWeek(t), i)); return m; });
  const weeks = [...new Set(idx.t.map(isoWeek))];
  const out = [];
  for (let w = 1; w + 1 < weeks.length; w++) {
    const rows = [];
    frames.forEach((F, f) => {
      const k0 = ends[f].get(weeks[w - 1]), k1 = ends[f].get(weeks[w]), k2 = ends[f].get(weeks[w + 1]);
      if (k0 == null || k1 == null || k2 == null || F.s.bad[k1] !== F.s.bad[k0]) return;
      const next = F.abnormal(k1, k2 - k1, 1);
      if (next != null) rows.push({ F, k1, k2, ret: F.s.tr[k1] / F.s.tr[k0] - 1, next });
    });
    if (rows.length < 4) continue;
    rows.sort((a, b) => b.ret - a.ret);
    const best = rows[0], worst = rows.at(-1);
    const [ib, iw] = [best, worst].map((x) => x.F.betaOf(x.k1).idio);
    out.push({
      symbol: `week:${weeks[w]}`, direction: 1, t: best.F.s.t[best.k1], date: best.F.s.date[best.k1], end5: best.F.s.date[best.k2],
      idio: ib > 0 && iw > 0 ? Math.hypot(ib, iw) : null, x5: best.next - worst.next, best: best.F.symbol, worst: worst.F.symbol,
      ...best.F.regimeAt(best.k1),
    });
  }
  return out;
}

// How far each stock's price went against a position opened at a close, over the next 21 trading days,
// in its usual daily moves at the time (the day's low for a long, its high for a short: stops trigger
// during the day), on every day with a clean window, with each start day's regime. Raw prices, not
// total return: a stop sees the ex-dividend drop too.
function stopExcursions(F) {
  const { s } = F, H = LONG.hold, out = { long: [], short: [], period: [], days: [] };
  const low = (j) => (s.low[j] > 0 && s.low[j] <= s.close[j] * 1.0001 && s.low[j] >= s.close[j] * 0.5 ? s.low[j] : s.close[j]);
  const high = (j) => (s.high[j] > 0 && s.high[j] >= s.close[j] * 0.9999 && s.high[j] <= s.close[j] * 2 ? s.high[j] : s.close[j]);
  for (let i = 1; i + H < F.n; i++) {
    const unit = F.sd[i];
    if (unit == null || s.bad[i + H] !== s.bad[i]) continue;
    let down = 0, up = 0;
    for (let j = i + 1; j <= i + H; j++) { down = Math.max(down, 1 - low(j) / s.close[i]); up = Math.max(up, high(j) / s.close[i] - 1); }
    out.long.push(down / unit);
    out.short.push(up / unit);
    out.period.push(s.date[i + H] <= HOLDOUT.trainTo ? 'train' : s.date[i] >= HOLDOUT.testFrom ? 'test' : null);
    out.days.push({ date: s.date[i], ...F.regimeAt(i) });
  }
  return out;
}
const hitRates = (ks) => LONG.stopKs.map((k) => round(ks.filter((x) => x >= k).length / ks.length, 3));

// ---------- the held-out check ----------

// The estimate (stats.js) for `items` at horizon h, as a drift per week: 21-day outcomes are divided
// by 21/5, and each stock's weekly stock-specific volatility scaled to match, so every study faces the
// same prior and the same floor. Items on the same stock and side within h trading days are one bet;
// the uncertainty is worked out by date for a week (a market-wide day counts once), by calendar week
// for 21 days (whose windows overlap across days).
export function horizonEstimate(items, h) {
  const k = h / 5;
  const xs = items.filter((it) => it[`x${h}`] != null && Number.isFinite(it[`x${h}`]))
    .map((it) => ({ symbol: it.symbol, direction: it.direction, t: it.t, idio: it.idio > 0 ? it.idio / Math.sqrt(k) : null, x: it[`x${h}`] / k }));
  return xs.length ? estimate(separateBets(xs, h), (it) => it.x, { cluster: h > 5 ? 'week' : 'date' }) : null;
}

const brief = (e) => (e ? { bets: e.bets, clusters: e.clusters, mean: e.mean, edge: e.edge, lo: e.lo, hi: e.hi, p: e.p, sign: e.sign } : null);

// A study checked on held-out years: trained on cases whose window ended by HOLDOUT.trainTo, tested on
// those starting from HOLDOUT.testFrom (a window across the boundary is in neither). status:
//   held        on 2016-2023 a 90% chance of its sign (8+ separate bets) and an effect of GATE.edge or
//               more over the horizon, and 2024 on shows the same sign at half that or more: a pattern
//   didnt-hold  it looked real on 2016-2023 but 2024 on disagreed
//   no-pattern  under a 90% chance on 2016-2023, or too small to matter
//   too-few     too few cases in either period to check
// `cut`: other periods ({ trainTo, testFrom }), for the owner's questions on the funds' own ideas
// (hypotheses.js), which only go back months.
export function holdoutCheck(items, h, cut = HOLDOUT) {
  const train = horizonEstimate(items.filter((x) => x[`end${h}`] && x[`end${h}`] <= cut.trainTo), h);
  const test = horizonEstimate(items.filter((x) => x.date >= cut.testFrom), h);
  let status;
  if (!train || train.bets < GATE.bets || !test || test.bets < HOLDOUT.testBets) status = 'too-few';
  else if (train.p < HOLDOUT.p || Math.abs(train.edge * (h / 5)) < GATE.edge) status = 'no-pattern';
  else status = Math.sign(test.mean) === train.sign && Math.abs(test.mean) >= HOLDOUT.share * Math.abs(train.edge) ? 'held' : 'didnt-hold';
  return { status, train: brief(train), test: brief(test) };
}

// A made-up study with no pattern at all, shaped like a market's big moves over ten years: about 200
// days with cases (some 370 cases), a quarter of them market-wide days that hit 3 to 6 of 8 stocks at
// once (which share a common move), and each case's week after is that day's common move plus the
// stock's own noise.
export function noiseStudy(rand, days = 200) {
  const start = Date.parse('2016-10-03T14:30:00Z') / 1000; // a Monday
  const weekday = (d) => start + (Math.floor(d / 5) * 7 + (d % 5)) * 86400;
  const items = [];
  for (let e = 0; e < days; e++) {
    const t = weekday(Math.floor(rand() * 2600));
    const date = dateOf(t), end5 = dateOf(t + 7 * 86400);
    const common = gauss(rand) * 0.01, dir = rand() < 0.5 ? 1 : -1;
    const k = rand() < 0.25 ? 3 + Math.floor(rand() * 4) : 1;
    for (let j = 0; j < k; j++) items.push({ symbol: `S${Math.floor(rand() * 8)}`, direction: dir, t, date, end5, idio: 0.03, x5: common + gauss(rand) * 0.025 });
  }
  return items;
}

// How often pure noise passes the held-out check: the share of `sims` made-up studies called 'held'.
export function holdoutNoiseCheck({ sims = 400, seed = 1 } = {}) {
  const rand = seeded(seed);
  let held = 0;
  for (let i = 0; i < sims; i++) if (holdoutCheck(noiseStudy(rand), 5).status === 'held') held++;
  return { sims, held: held / sims };
}
// The figure the page prints (test/memory-long.test.mjs checks it): about 1 made-up study in 45 passes.
export const HOLDOUT_NOISE = { sims: 400, held: 0.0225 };

// ---------- the lessons ----------

// How many separate days of each regime a study's cases cover (the page and the report show it, and
// the AI sees first the lessons whose evidence covers days like today).
function regimeCounts(items) {
  const cells = {}, seen = new Set();
  for (const it of items) {
    for (const c of [it.trend, it.vix]) {
      if (!c || seen.has(`${c}|${it.date}`)) continue;
      seen.add(`${c}|${it.date}`);
      cells[c] = (cells[c] ?? 0) + 1;
    }
  }
  return cells;
}

const DRIFT = 'beyond the market and their usual drift';
// The words of each gated study: its label; how its number reads (`measure`; `flip` -1 when that is
// the price's own move against the cases' direction, so a bounce after a drop reads +); `held(sign)`
// for a pattern (`sign`: in the cases' direction, + = kept going); `none` for no reliable pattern.
const WORDS = {
  'big-up': {
    label: 'After a big one-day jump', flip: 1, measure: (v, per) => `the price moved ${v} ${per}`,
    held: (m, sign) => (sign > 0
      ? `After a big one-day jump, ${m} stocks tended to keep rising over the next week, ${DRIFT}. Don't assume the first day used it all up.`
      : `After a big one-day jump, ${m} stocks tended to give part of it back over the next week, ${DRIFT}. Be wary of chasing a jump.`),
    none: (m) => `After a big one-day jump, ${m} stocks showed no reliable follow-through or giveback over the next week. Don't assume either.`,
  },
  'big-down': {
    label: 'After a big one-day drop', flip: -1, measure: (v, per) => `the price moved ${v} ${per}`,
    held: (m, sign) => (sign > 0
      ? `After a big one-day drop, ${m} stocks tended to keep falling over the next week, ${DRIFT}. Don't assume a rebound.`
      : `After a big one-day drop, ${m} stocks tended to bounce back part of it over the next week, ${DRIFT}. Don't assume the fall continues.`),
    none: (m) => `After a big one-day drop, ${m} stocks showed no reliable rebound or further fall over the next week. Don't assume either.`,
  },
  'best-worst': {
    label: 'Last week\'s best stock against its worst', flip: 1, measure: (v) => `the best beat the worst by ${v} the next week`,
    held: (m, sign) => (sign > 0
      ? `Last week's best ${m} stock tended to keep beating last week's worst the following week (momentum), ${DRIFT}.`
      : `Last week's worst ${m} stock tended to beat last week's best the following week (a reversal), ${DRIFT}.`),
    none: (m) => `Last week's best ${m} stock was no more likely to beat last week's worst the following week than the reverse. Don't assume a winner keeps winning, or a loser bounces back.`,
  },
  'ex-dividend': {
    label: 'After going ex-dividend', flip: 1, measure: (v, per) => `the price moved ${v} ${per}`,
    held: (m, sign, st) => (sign > 0
      ? `On the ex-dividend date the SGX banks, C38U and Singtel fell by about ${Math.round(st.drop * 100)}% of the dividend, and over the next 21 trading days recovered${st.recovered > 0 ? ` about ${Math.round(st.recovered * 100)}% of it` : ' some of it'}, ${DRIFT}.`
      : `On the ex-dividend date the SGX banks, C38U and Singtel fell by about ${Math.round(st.drop * 100)}% of the dividend, and kept lagging over the next 21 trading days, ${DRIFT}.`),
    none: (m, st) => `On the ex-dividend date the SGX banks, C38U and Singtel fell by about ${Math.round(st.drop * 100)}% of the dividend, with no reliable recovery over the next 21 trading days. Don't count on the drop coming back.`,
  },
  results: {
    label: 'After results', flip: 1, measure: (v, per) => `the stock moved ${v} the way the news went ${per}`,
    held: (m, sign) => (sign > 0
      ? `After ${m} results, the stock tended to keep drifting the way the news went (a beat, or a strong first day) over the next month, ${DRIFT}.`
      : `After ${m} results, the stock tended to reverse part of its first reaction over the next month, ${DRIFT}.`),
    none: (m) => `After ${m} results, there was no reliable drift the way the news went over the next month. Don't count on a beat or a miss to keep moving the stock.`,
  },
};
export const STUDY_LABELS = Object.fromEntries(Object.entries(WORDS).map(([k, w]) => [k, w.label]));
// What each study looked at, for the AI's one line of "no reliable pattern".
const TOPIC = { 'big-up': 'after a big one-day jump', 'big-down': 'after a big one-day drop', 'best-worst': 'last week\'s best stock against its worst', 'ex-dividend': 'the 21 days after an ex-date', results: 'the month after results' };
const BRIEF = { 'big-up': 'big jump', 'big-down': 'big drop', 'best-worst': 'best vs worst', 'ex-dividend': 'ex-dates', results: 'results' };
// Shorter names, for chart rows on a phone.
export const STUDY_SHORT = { 'big-up': 'After a big jump', 'big-down': 'After a big drop', 'best-worst': 'Best vs worst stock', 'ex-dividend': 'After an ex-date', results: 'After results' };

// A study's numbers as its lesson reads them, over its horizon rather than per week: the training
// years' estimate with its likely range, and the held-out years' (their plain average is `mean`). For
// a drop they're the price's own move, so a bounce is +. A period without cases is null.
export function studyNumbers(key, st) {
  const at = (x) => asShown(key, st.h, x);
  const one = (e) => (e ? { edge: at(e.edge), lo: Math.min(at(e.lo), at(e.hi)), hi: Math.max(at(e.lo), at(e.hi)), mean: at(e.mean), bets: e.bets, clusters: e.clusters, p: e.p } : null);
  return { train: one(st.check?.train), test: one(st.check?.test) };
}
// One number of study `key` per week (as estimates are kept) read as its lesson reads it: over the
// horizon h, and for a drop as the price's own move.
export const asShown = (key, h, perWeek) => perWeek * (h / 5) * (WORDS[key]?.flip ?? 1);

// A gated study's lesson for the AI and the page, or null with too few cases to check. A pattern that
// held carries its numbers per week (the training years' edge, likely range and separate bets, read as
// its text reads), like every rule-made lesson; otherwise the lesson is that there's no reliable pattern.
function studyLesson(market, key, st) {
  const { status } = st.check;
  if (status === 'too-few') return null;
  const w = WORDS[key], { train, test } = studyNumbers(key, st), { years } = st;
  const per = st.h === 5 ? 'over the next week' : `over the next ${st.h} trading days`;
  const over = key === 'best-worst' ? plural(train.bets, 'week') : `${plural(train.bets, 'separate bet')} on ${plural(train.clusters, st.h === 5 ? 'day' : 'week')}`;
  const verdict = status === 'held' ? ', which agreed' : status === 'didnt-hold' ? ', which didn\'t agree' : '';
  const evidence = `${years.train}: ${w.measure(pct(train.edge), per)}, beyond the market and each stock's usual drift (likely ${pct(train.lo)} to ${pct(train.hi)}; ${over}). ${years.test}: ${pct(test.mean)} (${plural(test.bets, key === 'best-worst' ? 'week' : 'bet')})${verdict}.`;
  const held = status === 'held', weeks = st.h / 5;
  const text = held ? w.held(market, st.check.train.sign, st) : `${w.none(market, st)}${status === 'didnt-hold' ? ` It looked like a pattern in ${years.train} but didn't hold from 2024.` : ''}`;
  return {
    id: `${market}:10y:${key}`, text, evidence, source: 'market memory', kind: held ? 'pattern' : 'no-pattern', status,
    ...(held ? { confidence: train.p >= 0.99 ? 'High' : 'Moderate', p: train.p, edge: train.edge / weeks, lo: train.lo / weeks, hi: train.hi / weeks, bets: train.bets } : {}),
    // the AI's shorter evidence (promptMarketLessons): a pattern's numbers go with it anyway
    topic: TOPIC[key], brief: held ? `Checked on ${years.test}: ${pct(test.mean)} (${plural(test.bets, 'bet')}).` : `${BRIEF[key]} ${pct(train.edge)} (${years.train}) then ${pct(test.mean)}`,
    regimes: st.regimes,
  };
}

// The stop-loss base rate, a fact rather than a pattern: how often ordinary swings hit stops 2 and 3
// daily moves away within 21 trading days, and how far they reached in only 1 hold in 5.
function stopsLesson(market, st, years) {
  const tr = st.train, te = st.test;
  if (!tr?.holds || !te?.holds) return null;
  const at = (c, k) => Math.round(c.long[LONG.stopKs.indexOf(k)] * 100);
  return {
    id: `${market}:10y:stops`, kind: 'fact', status: 'fact', source: 'market memory', regimes: st.regimes,
    text: `In ${market} stocks, ordinary swings hit a stop-loss 2 typical daily moves below the price within 21 trading days in ${at(tr, 2)}% of holds, and one 3 moves below in ${at(tr, 3)}%. Stops that tight mostly catch noise: swings reached about ${st.k} daily moves in only 1 hold in 5 (a typical daily move is about the annual volatility divided by 16).`,
    evidence: `${years.train}: ${plural(tr.holds, 'hold')} of 21 trading days, one starting every day, on ${plural(st.stocks, 'stock')}. ${years.test}: ${at(te, 2)}% and ${at(te, 3)}% (${plural(te.holds, 'hold')}).`,
    short: `Ordinary swings in ${market} stocks hit a stop 2 daily moves away within 21 trading days in ${at(tr, 2)}% of holds in ${years.train}, 3 moves away in ${at(tr, 3)}%; they reached ${st.k} moves in 1 hold in 5 (a daily move is about the annual volatility / 16).`,
    brief: `${years.test}: ${at(te, 2)}% and ${at(te, 3)}%.`,
  };
}

// ---------- the whole memory ----------

// "2016–23", or "2023" for one year.
const span = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? a.slice(0, 4) : `${a.slice(0, 4)}–${b.slice(2, 4)}`);

// A study's summary for memory-long.json: its check at its horizon, the years its training and
// held-out cases span (results dates may only go back a few years), the 21 days after for a 5-day
// study (descriptive), and the regime counts.
function study(items, h, to, extra = {}) {
  const trained = items.filter((x) => x[`x${h}`] != null && x[`end${h}`] && x[`end${h}`] <= HOLDOUT.trainTo).map((x) => x.date).sort();
  return {
    h, cases: items.length, check: holdoutCheck(items, h),
    years: { train: trained.length ? span(trained[0], HOLDOUT.trainTo) : null, test: span(HOLDOUT.testFrom, to) },
    ...(h === 5 && items.some((x) => x.x21 != null) ? { month: holdoutCheck(items, 21) } : {}), regimes: regimeCounts(items), ...extra,
  };
}

// The regime table for the report: each gated study's cases by regime, with separate bets and the
// average per week (descriptive: no lesson depends on it).
function regimeRows(studies, itemsBy) {
  const rows = [];
  for (const [key, items] of Object.entries(itemsBy)) {
    const h = studies[key]?.h;
    if (!h) continue;
    for (const cell of ['above', 'below', 'calm', 'normal', 'stressed']) {
      const e = horizonEstimate(items.filter((x) => x.trend === cell || x.vix === cell), h);
      if (e) rows.push([key, cell, e.bets, round(e.mean, 5)]);
    }
  }
  return rows;
}

// Separate episodes of `flags` (true days) along `dates`: runs merged across gaps of fewer than
// REGIME.gap days, and lasting REGIME.runDays days or more, as [first, last] dates.
export function episodesOf(dates, flags) {
  const runs = [];
  let last = -Infinity;
  flags.forEach((f, i) => {
    if (!f) return;
    if (i - last > REGIME.gap || !runs.length) runs.push({ from: dates[i], to: dates[i], days: 0 });
    runs.at(-1).to = dates[i];
    runs.at(-1).days++;
    last = i;
  });
  return runs.filter((r) => r.days >= REGIME.runDays).map((r) => [r.from, r.to]);
}
const byPeriod = (runs) => ({ train: runs.filter(([a]) => a <= HOLDOUT.trainTo).length, test: runs.filter(([a]) => a >= HOLDOUT.testFrom).length });

// The ten-year memory from cleaned series (cleanSeries) by symbol, including each market's index and
// the VIX. `symbols`: symbols.json; `filings` and `company`: results-dates.json and company-data.json
// for the results study. The result is what state/memory-long.json holds (see fitSize for its size).
export function buildLongMemory({ series, symbols, filings = null, company = null, now = new Date() }) {
  const vix = series[VIX] && !series[VIX].leftOut ? series[VIX] : null;
  const data = { stocks: 0, leftOut: [], rebuilt: [], fixes: {} };
  const markets = {}, stocks = {};
  let from = null, to = null;
  for (const market of Object.keys(INDEX_OF)) {
    const indexSymbol = INDEX_OF[market], idx = series[indexSymbol];
    if (!idx || idx.leftOut) { data.leftOut.push({ symbol: indexSymbol, why: idx?.leftOut ?? 'no prices this week' }); continue; }
    const trend = trendOf(idx);
    const frames = [];
    for (const row of symbols.filter((x) => x.market === market && !x.etf && x.symbol !== indexSymbol)) {
      const s = series[row.symbol];
      if (!s || s.leftOut) { data.leftOut.push({ symbol: row.symbol, why: s?.leftOut ?? 'no prices this week' }); continue; }
      if (s.source !== 'adjclose') data.rebuilt.push({ symbol: row.symbol, why: s.why });
      for (const [k, v] of Object.entries(s.notes)) data.fixes[k] = (data.fixes[k] ?? 0) + v;
      frames.push(stockFrame(row.symbol, s, market, idx, trend, vix));
      from = !from || s.date[0] < from ? s.date[0] : from;
      to = !to || s.date.at(-1) > to ? s.date.at(-1) : to;
    }
    if (!frames.length) continue;
    data.stocks += frames.length;

    const big = frames.flatMap(bigMoves);
    const itemsBy = { 'big-up': big.filter((x) => x.direction > 0), 'big-down': big.filter((x) => x.direction < 0), 'best-worst': bestWorst(frames, idx) };
    const studies = {};
    for (const key of ['big-up', 'big-down']) {
      const items = itemsBy[key];
      const vol = (heavy) => { const c = holdoutCheck(items.filter((x) => x.heavy === heavy), 5); return { status: c.status, train: c.train, test: c.test }; };
      studies[key] = study(items, 5, to, { volume: { heavy: vol(true), normal: vol(false) } });
    }
    studies['best-worst'] = study(itemsBy['best-worst'], 5, to);

    const results = {};
    if (market === 'SGX') {
      const exd = frames.filter((F) => EX_DIVIDEND.includes(F.symbol)).flatMap(exDividends);
      itemsBy['ex-dividend'] = exd;
      const train = exd.filter((x) => x.end21 && x.end21 <= HOLDOUT.trainTo && x.x21 != null);
      studies['ex-dividend'] = study(exd, 21, to, {
        drop: round(median(exd.map((x) => x.drop)), 3),
        recovered: train.length ? round(avg(train.map((x) => x.x21)) / avg(train.map((x) => x.divYield)), 3) : null,
        yield: round(median(exd.map((x) => x.divYield)), 4),
      });
    }
    const dates = Object.fromEntries(frames.map((F) => [F.symbol, resultsDates(F.symbol, { filings, company })]));
    for (const F of frames) results[F.symbol] = resultsReactions(F, dates[F.symbol]);
    if (market === 'US') {
      const res = Object.values(results).flat().filter((x) => x.tone !== 'mixed');
      itemsBy.results = res;
      studies.results = study(res, 21, to, { dated: Object.values(results).flat().length, fromFilings: Object.values(results).flat().filter((x) => x.from === 'filing').length });
    }

    // stop-loss base rates, per stock and pooled
    const exc = Object.fromEntries(frames.map((F) => [F.symbol, stopExcursions(F)]));
    const pooled = (period) => {
      const long = [], short = [];
      for (const e of Object.values(exc)) e.period.forEach((p, i) => { if (p === period) { long.push(e.long[i]); short.push(e.short[i]); } });
      return long.length ? { holds: long.length, long: hitRates(long), short: hitRates(short) } : null;
    };
    const ks = Object.values(exc).filter((e) => e.long.length).map((e) => quantileOf(e.long, 1 - LONG.stopShare));
    studies.stops = { train: pooled('train'), test: pooled('test'), k: round(median(ks), 1), stocks: frames.length, regimes: regimeCounts(Object.values(exc).flatMap((e) => e.days)) };

    const years = { train: span(frames.map((F) => F.s.date[0]).sort()[0], HOLDOUT.trainTo), test: span(HOLDOUT.testFrom, to) };
    const lessons = [];
    for (const key of ['big-down', 'big-up', 'best-worst', 'ex-dividend', 'results']) {
      if (studies[key]) { const l = studyLesson(market, key, studies[key]); if (l) lessons.push(l); }
    }
    const stop = stopsLesson(market, studies.stops, years);
    if (stop) lessons.push(stop);
    // patterns first, then facts, then no reliable pattern
    const rank = { pattern: 0, fact: 1, 'no-pattern': 2 };
    lessons.sort((a, b) => rank[a.kind] - rank[b.kind]);

    const stressed = vix ? episodesOf(vix.date, vix.close.map((v) => v > REGIME.stressed)) : [];
    const below = episodesOf(idx.date, trend.map((x) => x === 'below'));
    markets[market] = {
      index: indexSymbol, years, stocks: frames.length, studies, lessons,
      regime: { episodes: { ...(market === 'US' ? { stressed: byPeriod(stressed) } : {}), below: byPeriod(below) }, rows: regimeRows(studies, itemsBy) },
    };

    for (const F of frames) {
      const e = exc[F.symbol], unit = F.sd[F.n]; // today's usual daily move
      const side = (arr) => ({ hits: hitRates(arr), k: round(quantileOf(arr, 1 - LONG.stopShare), 1) });
      const stop = (arr) => (unit == null ? null : round(quantileOf(arr, 1 - LONG.stopShare) * unit * 100, 1));
      const reactions = results[F.symbol] ?? [];
      const typical = reactions.length ? typicalResultsMove(F.q, F.iq, dates[F.symbol]) : null;
      const divs = market === 'SGX' ? exDividends(F) : [];
      const recent = `${Number(F.s.date.at(-1).slice(0, 4)) - 3}${F.s.date.at(-1).slice(4)}`; // the last three years
      stocks[F.symbol] = {
        market, from: F.s.date[0], typical_daily_move_pct: round(unit * 100, 2), beta: round(betaAt(F.q, Infinity, F.iq).beta, 2),
        ...(e.long.length ? {
          stops: { holds: e.long.length, long: side(e.long), short: side(e.short) },
          suggested_stop_pct: { long: stop(e.long), short: stop(e.short) }, // hit by ordinary swings in 1 hold in 5, at today's daily move
        } : {}),
        ...(divs.length ? { dividends: {
          n: divs.length, drop_vs_dividend: round(median(divs.map((x) => x.drop)), 2), last: [divs.at(-1).date, round(divs.at(-1).amount, 4)],
          months: [...new Set(divs.filter((x) => x.date >= recent).map((x) => Number(x.date.slice(5, 7))))].sort((a, b) => a - b),
        } } : {}),
        // the last 8 results days: [date, the day's move, and from the close before over a week and a
        // month, each against the index, in %] (the stock cards, dossier.js)
        ...(typical ? { results: { n: typical.n, typical_results_day_move_pct: round(typical.avg * 100, 1), recent: reactions.slice(-8).map((x) => [x.date, round(x.day * 100, 1), x.week == null ? null : round(x.week * 100, 1), x.month == null ? null : round(x.month * 100, 1)]) } } : {}),
        ...(F.s.source !== 'adjclose' ? { data: 'rebuilt' } : {}),
      };
    }
  }
  return { version: 1, updatedAt: now.toISOString(), from, to, train: [from, HOLDOUT.trainTo], test: [HOLDOUT.testFrom, to], data, markets, stocks };
}

// Each stock's weeks, for the owner's questions (hypotheses.js): one case at each week's last session,
// in the direction the stock went against its index that week (up if it beat it), with the week's own
// move (its total return) and whether that last session came on heavy volume.
function weeklyCases(F) {
  const { s } = F, out = [];
  const last = new Map();
  s.t.forEach((t, i) => last.set(isoWeek(t), i));
  const ends = [...last.values()];
  for (let w = 1; w < ends.length; w++) {
    const i0 = ends[w - 1], i1 = ends[w];
    if (i0 < 1 || s.bad[i1] !== s.bad[i0]) continue;
    const vs = F.vsIndex(i0, i1);
    if (vs == null) continue;
    const heavy = F.vol[i1] > 0 && s.volume[i1] > 0 ? s.volume[i1] >= LONG.heavy * F.vol[i1] : null;
    out.push(F.item(i1, vs >= 0 ? 1 : -1, { move: s.tr[i1] / s.tr[i0] - 1, heavy }));
  }
  return out;
}

// The cases behind the owner's questions (hypotheses.js), from the same cleaned series as the weekly
// build: for each market, every big move, ex-date, results day and stock-week, each with its outcomes
// a day, a week and a month on (x1, x5, x21: abnormal returns in the case's direction, as the studies
// measure them) and the regime that day (the VIX's level for SGX stocks too). The stocks the build
// leaves out are listed with why. A market whose prices came back but can't be used (its index left
// out, or every stock) is in `unusable` with why, apart from one whose prices didn't arrive this time
// (it's simply missing: try again). { from, to, leftOut, unusable: { [market]: why }, markets: { [market]:
// { index, stocks, cases: { big_moves, ex_dividend, results_days, weekly_stock_sample } } } }.
export function longCases({ series, symbols, filings = null, company = null }) {
  const vix = series[VIX] && !series[VIX].leftOut ? series[VIX] : null;
  const leftOut = [], markets = {}, unusable = {};
  let from = null, to = null;
  for (const market of Object.keys(INDEX_OF)) {
    const indexSymbol = INDEX_OF[market], idx = series[indexSymbol];
    const rows = symbols.filter((x) => x.market === market && !x.etf && x.symbol !== indexSymbol);
    if (!idx || idx.leftOut) {
      for (const row of rows) leftOut.push({ symbol: row.symbol, why: idx ? `its index ${indexSymbol} isn't usable (${idx.leftOut})` : `its index ${indexSymbol} had no prices this time` });
      if (idx) unusable[market] = `${indexSymbol}, the ${market} index the answers are measured against, isn't usable in the ten-year data: ${idx.leftOut}`;
      continue;
    }
    const trend = trendOf(idx);
    const frames = [];
    for (const row of rows) {
      const s = series[row.symbol];
      if (!s || s.leftOut) { leftOut.push({ symbol: row.symbol, why: s?.leftOut ?? 'no prices this time' }); continue; }
      frames.push(stockFrame(row.symbol, s, market, idx, trend, vix));
      from = !from || s.date[0] < from ? s.date[0] : from;
      to = !to || s.date.at(-1) > to ? s.date.at(-1) : to;
    }
    if (!frames.length) {
      if (rows.length && rows.every((row) => series[row.symbol]?.leftOut)) unusable[market] = `None of the ${market} stocks has usable prices in the ten-year data`;
      continue;
    }
    // the VIX's level on every case's day (the build keeps it for US stocks only). For an SGX case, the
    // last VIX close before the SGX session ended: SGX closes (09:00 UTC) before the US opens, so that is
    // the previous US session's close, never the same date's, which comes inside the case's outcome.
    const withVix = (items) => {
      if (vix) {
        for (const it of items) {
          if (it.vix != null) continue;
          let k = onOrBefore(vix.date, it.date);
          if (market === 'SGX' && k >= 0 && vix.date[k] === it.date) k--;
          if (k >= 0) it.vix = vixLevel(vix.close[k]);
        }
      }
      return items;
    };
    markets[market] = {
      index: indexSymbol, stocks: frames.map((F) => F.symbol),
      cases: {
        big_moves: withVix(frames.flatMap(bigMoves)),
        ex_dividend: withVix(frames.flatMap(exDividends)),
        results_days: withVix(frames.flatMap((F) => resultsReactions(F, resultsDates(F.symbol, { filings, company })))),
        weekly_stock_sample: withVix(frames.flatMap(weeklyCases)),
      },
    };
  }
  return { from, to, leftOut, unusable, markets };
}

// Rounds the numbers and, if it's still over MAX_BYTES, drops the least needed detail until it fits:
// the regime rows, then each stock's recent results, then the volume splits and the 21-day views.
export function fitSize(mem, max = MAX_BYTES) {
  const out = JSON.parse(JSON.stringify(mem, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v)));
  const size = () => JSON.stringify(out).length;
  const steps = [
    () => Object.values(out.markets).forEach((m) => { m.regime.rows = []; }),
    () => Object.values(out.stocks).forEach((s) => { if (s.results) delete s.results.recent; }),
    () => Object.values(out.markets).forEach((m) => Object.values(m.studies).forEach((st) => { delete st.volume; delete st.month; })),
  ];
  for (const step of steps) { if (size() <= max) break; step(); }
  return out;
}

// ---------- today's regime and the merged lessons ----------

// Today's regime for a market, from prices.json: its index against the average of its last 200 closes
// and, for US stocks, the VIX (prices.json `macro`, never a watchlist quote) while it's current: a VIX
// that failed to update is carried over from the last prices (marked stale), so it counts only within
// REGIME.vixDays of the index's latest price. Descriptive only. Null without 200 days of the index.
export function regimeNow(quotes, macro, market) {
  const symbol = INDEX_OF[market], q = quotes?.[symbol];
  const closes = (q?.daily ?? []).map((b) => b[1]).filter((c) => c > 0);
  if (closes.length < REGIME.days) return null;
  const last = q.price > 0 ? q.price : closes.at(-1);
  const average = avg(closes.slice(-REGIME.days));
  const vix = market === 'US' ? currentVix(macro?.[VIX], q) : null;
  return { market, index: symbol, trend: last >= average ? 'above' : 'below', vsAverage: last / average - 1, ...(vix > 0 ? { vix, level: vixLevel(vix) } : {}) };
}
// The VIX's value if it's current against the index quote `q` (see regimeNow), else null. One without a
// time counts unless it's marked stale.
function currentVix(v, q) {
  if (!(v?.price > 0)) return null;
  const at = Date.parse(v.time ?? '');
  if (!Number.isFinite(at)) return v.stale ? null : v.price;
  const indexAt = Date.parse(q?.time ?? '') || (q?.daily?.at(-1)?.[0] ?? 0) * 1000;
  return indexAt - at > REGIME.vixDays * DAY_MS ? null : v.price;
}

const indexName = (symbol) => symbol.replace(/\.SI$/, '');
// "SPY above its 200-day average, calm (VIX 14.8)", or "ES3 below its 200-day average".
export const regimeWords = (r) => `${indexName(r.index)} ${r.trend} its 200-day average${r.vix ? `, ${r.level} (VIX ${r.vix.toFixed(1)})` : ''}`;

// What the AI sees (marketContext market_regime_now, about 40 tokens; FUND_SYSTEM gives the VIX
// levels), or null.
export const regimeForPrompt = (r) => (r ? {
  index: r.index, vs_200_day_average_pct: round(r.vsAverage * 100, 1), trend: `${r.trend} its 200-day average`,
  ...(r.vix ? { vix: round(r.vix, 1), volatility: r.level } : {}),
} : null);

// Whether a lesson's evidence covers days like today: at least REGIME.min separate days in today's
// trend and, for US stocks, today's VIX level. Only ten-year lessons carry regime counts.
export function matchesRegime(lesson, r) {
  const c = lesson?.regimes;
  if (!c || !r) return false;
  return (c[r.trend] ?? 0) >= REGIME.min && (!r.level || (c[r.level] ?? 0) >= REGIME.min);
}

// The past year's market-memory lessons (memory.js buildMemory, `year`) that still apply: its big-move
// lessons give way to the ten-year study of the same question when that could be checked (more cases,
// and held-out years).
export function yearLessons(year, long, market) {
  const m = long?.markets?.[market];
  const covered = new Set(['big-up', 'big-down'].filter((k) => m?.studies?.[k]?.check && m.studies[k].check.status !== 'too-few'));
  return (year?.lessons ?? []).filter((l) => !covered.has(String(l.id).split(':')[1]));
}

// The market-memory lessons for `market`: the ten-year ones (memory-long.json) and the past year's.
export const mergedMarketLessons = (year, long, market) => [...(long?.markets?.[market]?.lessons ?? []), ...yearLessons(year, long, market)];

// The same lessons as the AI gets them, compact, since they go in every decision's own (uncached) part:
// a pattern that held keeps its words and numbers with a one-line check; the stop-loss base rate is
// shorter; every "no reliable pattern" becomes one lesson (`hidden`: the fund's removed lessons, left
// out of it), whose regime counts are the smallest of its parts' and which names a study's own years
// where they're fewer than the market's (results dates only go back a few years); then the past year's.
export function promptMarketLessons(year, long, market, { hidden = [] } = {}) {
  const m = long?.markets?.[market], skip = new Set(hidden);
  const ten = (m?.lessons ?? []).filter((l) => !skip.has(l.id));
  const strip = ({ topic, brief, short, ...l }) => l;
  const out = ten.filter((l) => l.kind !== 'no-pattern').map((l) => ({ ...strip(l), text: l.short ?? l.text, evidence: l.brief ?? l.evidence }));
  const none = ten.filter((l) => l.kind === 'no-pattern' && l.topic);
  if (none.length) {
    const cells = [...new Set(none.flatMap((l) => Object.keys(l.regimes ?? {})))];
    const topic = (l) => {
      const years = m.studies?.[String(l.id).split(':')[2]]?.years?.train;
      return years && years !== m.years.train ? `${l.topic} (only ${years})` : l.topic;
    };
    out.push({
      id: `${market}:10y:no-pattern`, kind: 'no-pattern', status: 'no-pattern', source: 'market memory',
      text: `No reliable pattern in ${market} stocks over ${m.years.train}, checked on ${m.years.test}: ${none.map(topic).join('; ')}. Don't assume momentum, a rebound or a continuation.`,
      evidence: `Beyond the market and each stock's usual drift: ${none.map((l) => l.brief).join('; ')}.`,
      regimes: Object.fromEntries(cells.map((c) => [c, Math.min(...none.map((l) => l.regimes?.[c] ?? 0))])),
    });
  }
  return [...out, ...yearLessons(year, long, market)];
}
