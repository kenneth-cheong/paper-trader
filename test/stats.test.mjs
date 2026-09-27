import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normCdf, tCdf, quantile, betaAt, fundBeta, peersOf, peerLabel, peerBaseline, roundTripFee, separateBets, isoWeek, estimate, difference,
  lessonStatus, confidenceOf, betsNeeded, seeded, gauss, GATE, PRIOR_SD, weekdaysBetween,
} from '../stats.js';
import { planFor, calcFee } from '../fees.js';

const DAY = 86400;
const T0 = Date.parse('2025-09-01T13:30:00Z') / 1000; // a Monday
// n daily bars (weekdays only) of an index random walk and a stock that moves `beta` times it plus noise
function pair(n, beta, noise = 0.01, seed = 1) {
  const rand = seeded(seed);
  const idx = [], stk = [];
  let i = 400, s = 100, d = 0;
  for (let k = 0; k < n; k++) {
    while ([0, 6].includes(new Date((T0 + d * DAY) * 1000).getUTCDay())) d++;
    const r = 0.01 * gauss(rand);
    i *= Math.exp(r); s *= Math.exp(beta * r + noise * gauss(rand));
    idx.push([T0 + d * DAY, i]); stk.push([T0 + d * DAY, s]);
    d++;
  }
  return { iq: { market: 'US', daily: idx }, q: { market: 'US', daily: stk } };
}

test('the distributions: normal and t probabilities and quantiles', () => {
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-6);
  assert.ok(Math.abs(tCdf(2.015048, 5) - 0.95) < 1e-5);
  assert.ok(Math.abs(tCdf(-1, 1) - 0.25) < 1e-6);
  assert.ok(Math.abs(quantile(0.9) - 1.281552) < 1e-5);
  assert.ok(Math.abs(quantile(0.975, 10) - 2.228139) < 1e-4);
});

test('beta: OLS on daily log returns before the idea, Blume-adjusted, clamped, with a fallback', () => {
  const { q, iq } = pair(260, 1.5);
  const b = betaAt(q, Infinity, iq);
  assert.equal(b.fallback, false);
  assert.ok(Math.abs(b.beta - (0.67 * 1.5 + 0.33)) < 0.08, `beta ${b.beta}`);
  assert.ok(Math.abs(b.idio - 0.01 * Math.sqrt(5)) < 0.004, `idio ${b.idio}`);
  // only closes before the idea's day count: 100 days in, too few for a fit
  const early = betaAt(q, q.daily[100][0], iq);
  assert.deepEqual([early.beta, early.fallback], [1, true]);
  assert.ok(early.idio > 0); // the plain excess over the index still gives its noise
  assert.equal(betaAt(q, q.daily[200][0], iq), betaAt(q, q.daily[200][0] + 3600, iq)); // cached per day
  assert.equal(betaAt(pair(260, 5, 0.001, 2).q, Infinity, pair(260, 5, 0.001, 2).iq).beta, 3); // clamped
  assert.equal(betaAt(iq, Infinity, iq).beta, 1);
});

test('a fund\'s beta comes from its daily values after 40 trading days', () => {
  const { iq } = pair(80, 1);
  const history = iq.daily.map(([t, c]) => [new Date((t + 7 * 3600) * 1000).toISOString(), 5000 + 5000 * c / iq.daily[0][1]]); // half in cash, after the close
  const b = fundBeta(history, iq);
  assert.ok(Math.abs(b.beta - 0.5) < 0.05, `fund beta ${b.beta}`);
  assert.equal(b.days, 79);
  assert.equal(fundBeta(history.slice(0, 30), iq), null);
  // net short: the fund's value moves against the index, so its beta is below 0 (not clamped to 0)
  const short = iq.daily.map(([t, c]) => [new Date((t + 7 * 3600) * 1000).toISOString(), 15000 - 5000 * c / iq.daily[0][1]]);
  assert.ok(fundBeta(short, iq).beta < -0.3, `short fund beta ${fundBeta(short, iq).beta}`);
});

test('peers: the other two banks for DBS, OCBC and UOB; the rest of the market otherwise', () => {
  const quotes = Object.fromEntries(['D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'ES3.SI'].map((s) => [s, { market: 'SGX', daily: [[T0, 10], [T0 + DAY, 11]], intraday: [] }]));
  quotes.QQQ = { market: 'US', etf: true, daily: [], intraday: [] };
  quotes.AAPL = { market: 'US', daily: [], intraday: [] };
  assert.deepEqual(peersOf('D05.SI', quotes), ['O39.SI', 'U11.SI']);
  assert.deepEqual(peersOf('Z74.SI', quotes), ['D05.SI', 'O39.SI', 'U11.SI']); // not the index fund
  assert.deepEqual(peersOf('AAPL', quotes), []); // QQQ is an ETF
  assert.equal(peerLabel('O39.SI'), 'DBS and UOB');
  assert.equal(peerLabel('NVDA'), 'the other US stocks');
  quotes['U11.SI'].daily = [[T0, 10], [T0 + DAY, 12]];
  assert.ok(Math.abs(peerBaseline(quotes, 'D05.SI', T0 + 8 * 3600 + 3600, T0 + DAY + 9 * 3600, 1) - 0.15) < 1e-9);
});

test('fees: a round trip, from what a fill paid or the fund\'s plan, as a share of the trade', () => {
  const scb = planFor('scb');
  // S$2,500 on the SCB plan: the S$10 minimum each way plus GST and SGX fees
  const rt = roundTripFee(scb, 'SGX', 1, 100, 25);
  const expect = (calcFee(scb, 'SGX', 'buy', 100, 25).total + calcFee(scb, 'SGX', 'sell', 100, 25).total) / 2500;
  assert.ok(Math.abs(rt - expect) < 1e-12 && rt > 0.008);
  assert.ok(Math.abs(roundTripFee(scb, 'SGX', 1, 100, 25, 5) - (5 + calcFee(scb, 'SGX', 'sell', 100, 25).total) / 2500) < 1e-12); // the actual fill
  assert.equal(roundTripFee(planFor('none'), 'US', 1, 10, 100), 0);
  assert.equal(roundTripFee(scb, 'US', 1, 0, 100), null);
});

test('separate bets: the same stock and side with overlapping weeks is one bet; the estimate clusters by week', () => {
  const it = (symbol, day, direction = 1, x = 0.01) => ({ symbol, direction, t: T0 + day * DAY, x, idio: 0.03 });
  const bets = separateBets([it('A', 0), it('A', 3), it('A', 6), it('A', 14), it('A', 2, -1), it('B', 1)]);
  assert.deepEqual(bets.map((b) => [b.symbol, b.direction, b.items.length]), [['A', 1, 3], ['B', 1, 1], ['A', -1, 1], ['A', 1, 1]]); // chained 0-3-6
  assert.equal(weekdaysBetween(T0, T0 + 7 * DAY), 5);
  assert.equal(weekdaysBetween(T0, T0 + 91 * DAY), 65); // exact over a quarter too
  assert.equal(weekdaysBetween(T0 + 3 * DAY, T0), 0);
  // with a quarter's window, NVDA bought every 6 trading days is one bet; a year later it's another
  const every6 = Array.from({ length: 10 }, (_, k) => it('N', k * 8)).concat([it('N', 400)]);
  assert.deepEqual(separateBets(every6, 63).map((b) => b.items.length), [10, 1]);
  assert.equal(separateBets(every6).length, 11); // a week's window: separate
  assert.equal(isoWeek(Date.parse('2026-01-01T12:00:00Z') / 1000), '2026-W01');
  assert.equal(isoWeek(Date.parse('2027-01-03T12:00:00Z') / 1000), '2026-W53');
  // ten bets that all did +1%: pulled towards zero by the prior, never surer than the stocks' noise allows
  const e = estimate(separateBets(Array.from({ length: 10 }, (_, k) => it(`S${k}`, k * 7))), (i) => i.x);
  const se = 0.6 * 0.03 / Math.sqrt(10), w = PRIOR_SD ** 2 / (PRIOR_SD ** 2 + se ** 2);
  assert.ok(Math.abs(e.edge - w * 0.01) < 1e-5 && e.bets === 10 && e.clusters === 10 && e.lo < e.edge && e.edge < e.hi);
  // the same ten bets in one week: one cluster, so hardly any confidence
  const oneWeek = estimate(separateBets(Array.from({ length: 10 }, (_, k) => it(`S${k}`, 0))), (i) => i.x);
  assert.equal(oneWeek.clusters, 1);
  assert.ok(oneWeek.p < e.p);
  // fewer than 6 bets: a t-distribution, so a wider range than the normal would give
  const few = estimate(separateBets([it('A', 0), it('B', 7), it('C', 14)]), (i) => i.x);
  assert.ok((few.hi - few.lo) / few.sd > 2 * 1.2816 + 0.1);
  const d = difference(e, few);
  assert.ok(Math.abs(d.edge - (e.edge - few.edge)) < 1e-5 && d.lo < d.edge);
});

test('the gate: 8 bets, a confident edge of 0.3% a week; kept until the chance falls below 3 in 4; watching with bets needed', () => {
  const est = (over) => ({ bets: 20, clusters: 20, mean: 0.01, se: 0.003, edge: 0.006, sd: 0.002, p: 0.99, sign: 1, ...over });
  assert.equal(lessonStatus(est(), 1), 'lesson');
  assert.equal(lessonStatus(est(), -1), null);
  assert.equal(lessonStatus(est({ bets: 7 }), 1), 'watching');
  assert.equal(lessonStatus(est({ edge: 0.002 }), 1), 'watching');
  assert.equal(lessonStatus(est({ p: 0.9 }), 1), 'watching');
  assert.equal(lessonStatus(est({ p: 0.8 }), 1, true), 'lesson');
  assert.equal(lessonStatus(est({ p: 0.74 }), 1, true), 'watching');
  assert.equal(lessonStatus(est({ p: 0.6 }), 1), null);
  assert.deepEqual([confidenceOf(0.995), confidenceOf(GATE.p), confidenceOf(0.8)], ['High', 'Moderate', 'Fading']);
  assert.equal(betsNeeded(est({ mean: 0.002 })), null); // too small an average ever to be a lesson
  const more = betsNeeded(est({ bets: 10, se: 0.008, p: 0.8 }));
  assert.ok(more > 0 && more < 100, `more ${more}`);
});
