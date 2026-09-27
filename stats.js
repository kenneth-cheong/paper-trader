// The evidence engine behind every lesson (the fund's own, learning.js, and the market memory,
// memory.js). Pure functions, no dependencies. It answers "is this pattern real, and how big is it?"
// honestly for a tiny, correlated universe:
//
//   - Beta: how much a stock tends to move with its index (betaAt). A fund that owns high-beta stocks
//     beats the index in a rising week without any skill, so each result is split into the market's
//     part (beta times the index), fees, and what's left: the stock-specific edge.
//   - Peers: the other stocks in the same market, or for the three Singapore banks the other two
//     (peerBaseline), so "right on banks, wrong bank" shows up.
//   - Fees: an entry idea is charged a round trip (roundTripFee), at what a simulator fill actually
//     paid where there is one, else at the fund's fee plan. Exits aren't charged again.
//   - Separate bets: ideas on the same stock in the same direction whose week-long windows overlap
//     are one bet (separateBets), and the uncertainty is worked out by calendar week (or by date, for
//     the market memory), so one market-wide selloff counts once.
//   - The estimate (estimate): the average edge per bet, pulled towards zero by a named prior (a
//     stock-specific edge is rarely more than PRIOR_SD a week), never more certain than the stocks'
//     own week-to-week noise allows (SD_FLOOR), with a t-distribution on the bets below T_BELOW bets
//     and on the calendar weeks above.
//   - The gate (lessonStatus): a lesson needs a GATE.p chance that the edge has its sign, an edge of
//     at least GATE.edge a week and GATE.bets separate bets. Once shown, it stays until that chance
//     falls below GATE.keep, so lessons don't flicker on and off. Patterns on their way ("watching")
//     come with about how many more bets they'd need.
// A Monte Carlo test (test/learning.test.mjs, learning.js noiseCheck) runs these rules on made-up
// funds with no skill at all and checks they rarely produce a lesson.

import { BENCHMARKS, priceAt, priceAtWithTime, sessionLength } from './benchmark.js';
import { dividendReturn } from './actions.js';
import { calcFee } from './fees.js';

export const PRIOR_SD = 0.005; // the named prior: a stock-specific edge is rarely beyond ±0.5% a week
export const SD_FLOOR = 0.6; // a bet's spread is at least 0.6x its stock's weekly stock-specific volatility
export const DEFAULT_IDIO = 0.03; // a stock's weekly stock-specific volatility when there isn't enough history
export const T_BELOW = 6; // fewer separate bets than this: a t-distribution instead of a normal one
// p: set by the Monte Carlo check on pure noise (learning.js noiseCheck): at 0.9, 24% of made-up funds
// with no skill showed two or more false lessons in half a year; at 0.97, under 2%.
export const GATE = { p: 0.97, edge: 0.003, bets: 8, keep: 0.75 };
export const WATCH_P = 0.7; // shown to the owner as "watching" from this chance
export const LIKELY = 0.8; // the likely range holds the edge with an 8-in-10 chance
export const BETA = { minBars: 120, maxBars: 252, lo: 0, hi: 3 };
export const FUND_BETA_DAYS = 40; // a fund's beta is shown after this many trading days
export const BANKS = { 'D05.SI': 'DBS', 'O39.SI': 'OCBC', 'U11.SI': 'UOB' };

const DAY_S = 86400;
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const r5 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 1e5);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---------- distributions ----------

// The standard normal's cumulative probability (Abramowitz and Stegun 7.1.26, error under 1e-7).
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// ln Γ(x) (Lanczos), for the t-distribution.
function lnGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, s = 1.000000000190015;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  for (const k of c) s += k / ++y;
  return -tmp + Math.log(2.5066282746310005 * s / x);
}

// The regularised incomplete beta function I_x(a, b), by its continued fraction.
function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(1 - x, b, a);
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d);
  f = d;
  for (let m = 1; m <= 200; m++) {
    for (const num of [m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)), -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + num * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d);
      c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      f *= c * d;
    }
    if (Math.abs(c * d - 1) < 1e-10) break;
  }
  return front * f / a;
}

// Student's t cumulative probability with `df` degrees of freedom.
export function tCdf(t, df) {
  const p = betaInc(df / (df + t * t), df / 2, 0.5) / 2;
  return t >= 0 ? 1 - p : p;
}

// The value with cumulative probability `p` (by bisection; normal when df is Infinity). Remembered.
const quantiles = new Map();
export function quantile(p, df = Infinity) {
  const key = `${p}|${df}`;
  if (quantiles.has(key)) return quantiles.get(key);
  const cdf = df === Infinity ? normCdf : (x) => tCdf(x, df);
  let lo = -50, hi = 50;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; }
  quantiles.set(key, (lo + hi) / 2);
  return (lo + hi) / 2;
}
const Z_LIKELY = quantile(0.5 + LIKELY / 2);

// ---------- beta ----------

// Trading days (weekdays) after unix time t0's day up to t1's (UTC dates: both markets' sessions fall
// within one UTC day), 0 when t1 isn't later. Public holidays count. Exact over any span, since a
// quarter's horizon (63 days) chains separate bets too.
export function weekdaysBetween(t0, t1) {
  const a = Math.floor(t0 / DAY_S), b = Math.floor(t1 / DAY_S);
  if (b <= a) return 0;
  const weeks = Math.floor((b - a) / 7);
  let n = weeks * 5;
  for (let d = a + weeks * 7 + 1; d <= b; d++) if (![0, 6].includes(new Date(d * DAY_S * 1000).getUTCDay())) n++;
  return n;
}

// Pairs of daily log returns [stock, index] on the same dates, from bars that closed by unix time
// `t` (all of them for Infinity), the last BETA.maxBars.
function dailyPairs(q, iq, t) {
  const byDate = new Map((iq?.daily ?? []).map((b) => [dateOf(b[0]), b[1]]));
  const sl = sessionLength(q);
  const bars = (q?.daily ?? []).filter((b) => b[0] + sl <= t);
  const pairs = [];
  for (let i = 1; i < bars.length; i++) {
    const i0 = byDate.get(dateOf(bars[i - 1][0])), i1 = byDate.get(dateOf(bars[i][0]));
    if (i0 > 0 && i1 > 0 && bars[i - 1][1] > 0 && bars[i][1] > 0) pairs.push([Math.log(bars[i][1] / bars[i - 1][1]), Math.log(i1 / i0)]);
  }
  return pairs.slice(-BETA.maxBars);
}

// Ordinary least squares of y on x over [y, x] pairs: { raw beta, residual sd }.
export function ols(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const my = avg(pairs.map((p) => p[0])), mx = avg(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [y, x] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx, a = my - b * mx;
  const rss = pairs.reduce((s, [y, x]) => s + (y - a - b * x) ** 2, 0);
  return { raw: b, resid: Math.sqrt(rss / (n - 2)), n };
}

// Blume's adjustment (betas drift towards 1 over time), clamped to BETA.lo..BETA.hi.
export const blume = (raw) => Math.min(BETA.hi, Math.max(BETA.lo, 0.67 * raw + 0.33));

const betaCache = new WeakMap();

// { beta, idio, fallback } for `q` from the daily closes before unix time `t`, against index quote
// `iq`: an OLS on daily log returns, Blume-adjusted and clamped. `idio` is the weekly stock-specific
// volatility (what the index doesn't explain). With fewer than BETA.minBars returns it falls back to a
// beta of 1 (the plain excess over the index), with `fallback` set. Cached per stock per day.
export function betaAt(q, t, iq) {
  if (!q || !iq || q === iq) return { beta: 1, idio: q === iq ? 0 : null, fallback: q !== iq };
  const day = Number.isFinite(t) ? Math.floor(t / DAY_S) : 'all';
  let perQuote = betaCache.get(q);
  if (!perQuote) betaCache.set(q, (perQuote = new Map()));
  const key = `${day}|${iq.daily?.length ?? 0}`;
  if (perQuote.has(key)) return perQuote.get(key);
  const pairs = dailyPairs(q, iq, Number.isFinite(t) ? day * DAY_S : Infinity); // closes before t's day
  let out;
  const fit = pairs.length >= BETA.minBars ? ols(pairs) : null;
  if (fit) out = { beta: blume(fit.raw), idio: fit.resid * Math.sqrt(5), fallback: false };
  else {
    const ex = pairs.map(([y, x]) => y - x);
    const m = ex.length >= 20 ? avg(ex) : null;
    out = { beta: 1, idio: m == null ? null : Math.sqrt(ex.reduce((s, x) => s + (x - m) ** 2, 0) / (ex.length - 1)) * Math.sqrt(5), fallback: true };
  }
  perQuote.set(key, out);
  return out;
}

// A fund's beta from its value history ([[iso, value]]) against its index: for each of the index's
// sessions, the fund's last recorded value from that session's open until the next one opens (so a
// value recorded just after the close counts for that day), as daily log returns on consecutive
// sessions. Not Blume-adjusted (cash really does lower it), clamped to -BETA.hi..BETA.hi: a fund that
// is net short moves against its index, so its beta is below 0. Null before FUND_BETA_DAYS trading days.
export function fundBeta(history, iq) {
  const pts = (history ?? []).map(([t, v]) => [Date.parse(t) / 1000, v]).filter(([t, v]) => Number.isFinite(t) && v > 0).sort((a, b) => a[0] - b[0]);
  const bars = iq?.daily ?? [];
  if (pts.length < 2 || !bars.length) return null;
  const daily = []; // [fund value, index close] per session, or null for a session without a value
  let k = 0;
  bars.forEach(([bt, close], i) => {
    const until = i + 1 < bars.length ? bars[i + 1][0] : bt + sessionLength(iq) + 12 * 3600;
    while (k < pts.length && pts[k][0] < bt) k++;
    let last = null;
    for (let j = k; j < pts.length && pts[j][0] < until; j++) last = pts[j][1];
    daily.push(last == null ? null : [last, close]);
  });
  const pairs = [];
  for (let i = 1; i < daily.length; i++) {
    if (daily[i] && daily[i - 1]) pairs.push([Math.log(daily[i][0] / daily[i - 1][0]), Math.log(daily[i][1] / daily[i - 1][1])]);
  }
  if (pairs.length < FUND_BETA_DAYS) return null;
  const fit = ols(pairs);
  return fit ? { beta: Math.min(BETA.hi, Math.max(-BETA.hi, fit.raw)), days: pairs.length } : null;
}

// ---------- peers ----------

const isFundLike = (s, q) => q?.etf === true || Object.values(BENCHMARKS).some((b) => b.symbol === s);

// The stocks `symbol` is compared with: for one of the three Singapore banks, the other two; for any
// other stock, every other stock (not an ETF or index fund) in its market.
export function peersOf(symbol, quotes) {
  const q = quotes?.[symbol];
  if (!q) return [];
  if (BANKS[symbol]) return Object.keys(BANKS).filter((s) => s !== symbol && quotes[s]);
  return Object.keys(quotes).filter((s) => s !== symbol && quotes[s].market === q.market && !isFundLike(s, quotes[s]));
}

// How to name those peers in a lesson: "OCBC and UOB", or "the other US stocks".
export function peerLabel(symbol) {
  if (BANKS[symbol]) return Object.entries(BANKS).filter(([s]) => s !== symbol).map(([, n]) => n).join(' and ');
  return `the other ${/\.SI$/.test(symbol) ? 'SGX' : 'US'} stocks`;
}

// The equal-weight average total return of the peers from unix time t0 to t1, in `direction`
// (dividends counted as in actions.js dividendReturn, from the time each starting price was set), or
// null without peer prices.
export function peerBaseline(quotes, symbol, t0, t1, direction) {
  const moves = [];
  for (const s of peersOf(symbol, quotes)) {
    const q = quotes[s], [p0, at] = priceAtWithTime(q, t0), p1 = priceAt(q, t1);
    if (p0 > 0 && p1 > 0) moves.push(direction * (p1 / p0 - 1) + dividendReturn(q, at, t1, direction, p0));
  }
  return moves.length ? avg(moves) : null;
}

// ---------- fees ----------

// A round trip's fees as a share of the trade: getting in (`paidIn`, what a fill actually paid, else
// the plan's fee) and out again at the same price, on `plan` (fees.js). A long buys then sells; a
// short sells then buys back.
export function roundTripFee(plan, market, direction, qty, price, paidIn = null) {
  if (!plan || !market || !(qty > 0) || !(price > 0)) return null;
  const [inSide, outSide] = direction > 0 ? ['buy', 'sell'] : ['sell', 'buy'];
  const entry = paidIn != null ? paidIn : calcFee(plan, market, inSide, qty, price).total;
  return (entry + calcFee(plan, market, outSide, qty, price).total) / (qty * price);
}

// ---------- separate bets ----------

// ISO week of unix time t, e.g. "2026-W14". Remembered per day (the calibration rules ask often).
const isoWeeks = new Map();
export function isoWeek(t) {
  const day = Math.floor(t / DAY_S);
  if (!isoWeeks.has(day)) isoWeeks.set(day, isoWeekOf(day));
  return isoWeeks.get(day);
}
function isoWeekOf(dayNumber) {
  const d = new Date(dayNumber * DAY_S * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() - day + 3); // that week's Thursday
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Groups items ({ symbol, direction, t, ... }) into separate bets: the same stock and direction with
// overlapping windows (the next starts within `days` trading days of the last) is one bet. Returns
// [{ symbol, direction, t, items }], oldest first.
export function separateBets(items, days = 5) {
  const open = new Map();
  const bets = [];
  for (const it of [...items].sort((a, b) => a.t - b.t)) {
    const key = `${it.symbol}|${it.direction}`;
    const bet = open.get(key);
    if (bet && weekdaysBetween(bet.last, it.t) < days) { bet.items.push(it); bet.last = it.t; continue; }
    const fresh = { symbol: it.symbol, direction: it.direction, t: it.t, last: it.t, items: [it] };
    open.set(key, fresh);
    bets.push(fresh);
  }
  return bets;
}

// A plain average over separate bets that are judged by calendar week: `rows` are [{ x, key }] (key:
// the ISO week each bet started); the bets within a week are averaged first, so a market-wide move that
// hit several bets that week counts once. { mean (of the weeks), se (its standard error across the
// weeks), n (weeks) }, or null without rows.
export function weeklyMean(rows) {
  if (!rows.length) return null;
  const weeks = new Map();
  for (const r of rows) (weeks.get(r.key) ?? weeks.set(r.key, []).get(r.key)).push(r.x);
  const xs = [...weeks.values()].map(avg);
  const m = avg(xs), n = xs.length;
  const sd = n < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { mean: r5(m), se: r5(sd / Math.sqrt(n)), n };
}

// ---------- the estimate ----------

// The edge behind `bets` (from separateBets), where xOf(item) is one item's value (null to leave it
// out) and each bet counts once at the average of its items. Clustered by `cluster` ('week': ISO
// week; 'date': the day). Returns null without a value, else { bets, clusters, mean (the plain
// average), edge (after the prior), sd, lo, hi (the likely range), p (the chance the edge has the
// sign of `edge`), sign }.
export function estimate(bets, xOf, { cluster = 'week' } = {}) {
  const rows = [];
  for (const b of bets) {
    const xs = b.items.map(xOf).filter((x) => x != null && Number.isFinite(x));
    if (!xs.length) continue;
    const idios = b.items.map((i) => i.idio).filter((v) => v > 0);
    rows.push({ x: avg(xs), idio: idios.length ? avg(idios) : DEFAULT_IDIO, key: cluster === 'date' ? dateOf(b.t) : isoWeek(b.t) });
  }
  const n = rows.length;
  if (!n) return null;
  const mean = avg(rows.map((r) => r.x));
  // the spread of the average, by cluster (sums of deviations per cluster), never under the floor
  const groups = new Map();
  for (const r of rows) groups.set(r.key, (groups.get(r.key) ?? 0) + (r.x - mean));
  const G = groups.size;
  const clustered = G >= 2 ? Math.sqrt((G / (G - 1)) * [...groups.values()].reduce((s, v) => s + v * v, 0)) / n : 0;
  const floor = SD_FLOOR * avg(rows.map((r) => r.idio)) / Math.sqrt(n);
  const se = Math.max(clustered, floor, 1e-6);
  const w = PRIOR_SD ** 2 / (PRIOR_SD ** 2 + se ** 2);
  const edge = w * mean, sd = Math.sqrt(w) * se;
  // a t-distribution: below T_BELOW bets on the bets, otherwise on the clusters (few weeks make the
  // clustered spread itself uncertain; with many it's the normal distribution)
  const df = Math.max(1, n < T_BELOW ? n - 1 : G - 1);
  const z = Math.abs(edge) / sd;
  const p = df > 200 ? normCdf(z) : tCdf(z, df);
  const half = (df > 200 ? Z_LIKELY : quantile(0.5 + LIKELY / 2, df)) * sd;
  return { bets: n, clusters: G, mean: r5(mean), se: r5(se), edge: r5(edge), sd: r5(sd), lo: r5(edge - half), hi: r5(edge + half), p: Math.round(p * 1000) / 1000, sign: edge >= 0 ? 1 : -1 };
}

// The difference a - b of two estimates, as one ({ edge, sd, p, sign }).
export function difference(a, b) {
  if (!a || !b) return null;
  const edge = a.edge - b.edge, sd = Math.sqrt(a.sd ** 2 + b.sd ** 2);
  return {
    edge: r5(edge), sd: r5(sd), lo: r5(edge - Z_LIKELY * sd), hi: r5(edge + Z_LIKELY * sd),
    p: Math.round(normCdf(Math.abs(edge) / sd) * 1000) / 1000, sign: edge >= 0 ? 1 : -1, bets: Math.min(a.bets, b.bets),
  };
}

// ---------- the gate ----------

// 'lesson', 'watching' or null for an estimate whose lesson wants `sign` (+1 or -1). `wasOn`: the
// lesson was shown last time, so it stays until its chance falls below GATE.keep.
export function lessonStatus(est, sign, wasOn = false) {
  if (!est || est.sign !== sign) return null;
  if (est.bets >= GATE.bets && (wasOn ? est.p >= GATE.keep : est.p >= GATE.p && Math.abs(est.edge) >= GATE.edge)) return 'lesson';
  if (est.p >= WATCH_P && betsNeeded(est) != null) return 'watching';
  return null;
}

// How the chance is described: High (99%+), Moderate (from GATE.p), Fading (a lesson kept on while its
// chance is between GATE.keep and GATE.p).
export const confidenceOf = (p) => (p >= 0.99 ? 'High' : p >= GATE.p ? 'Moderate' : 'Fading');

// About how many more separate bets would make `est` a lesson if its average held, or null when it
// can't (its average is within GATE.edge of zero). With n bets its spread shrinks like 1/sqrt(n).
export function betsNeeded(est) {
  const m = Math.abs(est?.mean ?? 0), tau2 = PRIOR_SD ** 2, z = quantile(GATE.p);
  if (!est || m <= GATE.edge || !(est.se > 0)) return null;
  // largest squared spread s giving P >= GATE.p (z^2 s^2 + z^2 tau^2 s - tau^2 m^2 <= 0) and an edge >= GATE.edge
  const sP = (-z * z * tau2 + Math.sqrt(z ** 4 * tau2 ** 2 + 4 * z * z * tau2 * m * m)) / (2 * z * z);
  const sE = tau2 * (m / GATE.edge - 1);
  const target = Math.min(sP, sE);
  const need = Math.max(GATE.bets, Math.ceil(est.bets * est.se ** 2 / target));
  return Math.max(0, need - est.bets);
}

// ---------- made-up data ----------

// A seeded random number generator (mulberry32), for repeatable simulations.
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A standard normal draw from `rand` (Box-Muller).
export const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
