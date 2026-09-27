import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceAt, priceAtWithTime, benchmarkFor, benchmarkSeries } from '../benchmark.js';
import { recordPicks, scorePicks, summarizeScores } from '../scorecard.js';
import { addSpend, monthSpend, capReached, fundAiCost } from '../spend.js';
import { planFor } from '../fees.js';

const DAY = 86400;
const T0 = Date.parse('2026-03-02T14:30:00Z') / 1000; // a Monday's US open
// n daily bars from T0 (one a day, weekends ignored for simplicity) with the given closes
const daily = (closes) => closes.map((c, i) => [T0 + i * DAY, c]);
const spy = (closes) => ({ market: 'US', currency: 'USD', price: closes.at(-1), daily: daily(closes), intraday: [] });

test('priceAt uses a daily close only once that session is over', () => {
  const q = spy([100, 101, 102]);
  assert.equal(priceAt(q, T0 - 60), null);
  assert.equal(priceAt(q, T0 + 3600), null); // first session still trading
  assert.equal(priceAt(q, T0 + 8 * 3600), 100);
  assert.equal(priceAt(q, T0 + DAY + 8 * 3600), 101);
  const withIntraday = { ...q, intraday: [[T0 + 2 * DAY, 101.5], [T0 + 2 * DAY + 900, 101.7]] };
  assert.equal(priceAt(withIntraday, T0 + 2 * DAY + 1000), 101.7);
  // with the time the price was set: the close of its session, or the time asked for a 15-minute price
  assert.deepEqual(priceAtWithTime(q, T0 + DAY + 3600), [100, T0 + 6.5 * 3600]); // mid-session: the close before
  assert.deepEqual(priceAtWithTime(withIntraday, T0 + 2 * DAY + 1000), [101.7, T0 + 2 * DAY + 1000]);
  assert.deepEqual(priceAtWithTime(q, T0 - 60), [null, null]);
});

test('the index comparison buys the same amount on the same day, after the buying fee', () => {
  const quotes = { SPY: spy([100, 105, 110]) };
  const b = benchmarkFor({ currency: 'USD', amount: 10000, since: new Date((T0 + 8 * 3600) * 1000).toISOString(), quotes, plan: planFor('tiger') });
  assert.equal(b.startPrice, 100);
  assert.equal(b.fee, 2.17); // Tiger US fee for 100 shares
  assert.equal(Math.round(b.value * 100) / 100, Math.round((10000 - 2.17) / 100 * 110 * 100) / 100);
  assert.ok(Math.abs(b.pct - 0.0998) < 0.0001);
  assert.deepEqual(benchmarkSeries(b, quotes.SPY, [new Date((T0 + DAY + 8 * 3600) * 1000).toISOString()]).map(Math.round), [Math.round(b.shares * 105)]);
  // a start before the price history begins compares from the first price there is
  const early = benchmarkFor({ currency: 'USD', amount: 1000, since: '2025-01-01T00:00:00Z', quotes });
  assert.equal(early.partial, true);
  assert.equal(benchmarkFor({ currency: 'SGD', amount: 1000, since: '2026-03-01T00:00:00Z', quotes }), null);
});

test('picks are recorded once per set and scored after a week and a month against the index', () => {
  let h = recordPicks([], { createdAt: new Date((T0 + 8 * 3600) * 1000).toISOString(), picks: [
    { symbol: 'AAA', stance: 'long', conviction: 'high', horizon: 'weeks', priceAtPick: 100 },
    { symbol: 'BBB', stance: 'short', conviction: 'medium', horizon: 'days', priceAtPick: 50 },
  ] });
  h = recordPicks(h, { createdAt: h[0].createdAt, picks: [{ symbol: 'AAA', stance: 'long', priceAtPick: 1 }] });
  assert.equal(h.length, 1);
  const closes = (from, step) => Array.from({ length: 25 }, (_, i) => from + step * i);
  const quotes = {
    AAA: { ...spy(closes(101, 1)) }, // rises 1 a day
    BBB: { ...spy(closes(49, 0.2)) }, // rises slowly
    SPY: spy(closes(400, 2)), // rises 0.5% a day
  };
  const now = new Date((T0 + 30 * DAY) * 1000);
  const scores = scorePicks(h, quotes, now);
  const aaaWeek = scores.find((x) => x.symbol === 'AAA' && x.horizon === 'week');
  assert.ok(Math.abs(aaaWeek.ret - 0.06) < 1e-9); // 5 trading days later it closed at 106
  assert.ok(Math.abs(aaaWeek.indexRet - 0.025) < 1e-9); // the index: 400 -> 410
  assert.equal(aaaWeek.right, true);
  assert.equal(aaaWeek.beat, true);
  const bbbWeek = scores.find((x) => x.symbol === 'BBB' && x.horizon === 'week');
  assert.equal(bbbWeek.right, false); // short, and the price didn't fall
  assert.equal(bbbWeek.beat, true); // but it did worse than the index
  const sum = summarizeScores(scores);
  assert.equal(sum.week.n, 2);
  assert.equal(sum.week.right, 0.5);
  assert.equal(sum.month.n, 2);
  // not scored before the days have passed
  assert.equal(scorePicks(h, quotes, new Date((T0 + 2 * DAY) * 1000)).length, 0);
});

test('AI spend adds up by month and task, and the cap stops at the limit', () => {
  const now = new Date('2026-03-15T00:00:00Z');
  let l = addSpend(null, 'picks', 0.12, now);
  l = addSpend(l, 'fund', 0.3, now);
  l = addSpend(l, 'fund', 0.1, new Date('2026-04-01T00:00:00Z'));
  assert.deepEqual(l.months['2026-03'], { total: 0.42, picks: 0.12, fund: 0.3 });
  assert.equal(monthSpend(l, now), 0.42);
  assert.equal(capReached(l, '0.42', now), true);
  assert.equal(capReached(l, '1', now), false);
  assert.equal(capReached(l, '0', now), false); // 0 = no cap
  assert.equal(fundAiCost({ decisions: [{ usage: { costUsd: 0.1 } }, {}, { usage: { costUsd: 0.25 } }] }), 0.35);
});

test('picks are scored on total return (dividends count), and picks from before the price history are left out', () => {
  const T = new Date((T0 + 8 * 3600) * 1000).toISOString();
  const sgx = (closes, dividends) => ({ market: 'SGX', currency: 'SGD', price: closes.at(-1), daily: daily(closes), intraday: [], events: { dividends } });
  const quotes = {
    D05: sgx(Array.from({ length: 25 }, (_, i) => (i < 3 ? 100 : 98)), [[T0 + 3 * DAY, 2]]), // drops by its S$2 dividend
    'ES3.SI': sgx(Array.from({ length: 25 }, () => 4), []),
  };
  const h = [
    { createdAt: T, picks: [{ symbol: 'D05', stance: 'long', price: 100 }, { symbol: 'D05', stance: 'short', price: 100 }] },
    { createdAt: '2025-01-02T02:00:00Z', picks: [{ symbol: 'D05', stance: 'long', price: 90 }] }, // before the history
  ];
  const scores = scorePicks(h, quotes, new Date((T0 + 30 * DAY) * 1000)).filter((x) => x.horizon === 'week');
  assert.equal(scores.length, 2);
  for (const x of scores) assert.ok(Math.abs(x.ret) < 1e-9);
  assert.equal(scores[0].indexBet, 0);
  // a pick made during the index's ex-dividend session: the index starts at the close before, with its dividend
  const during = new Date((T0 + 3 * DAY + 2 * 3600) * 1000).toISOString();
  const withIndexDiv = { ...quotes, Z74: sgx(Array.from({ length: 25 }, () => 3), []), 'ES3.SI': sgx(Array.from({ length: 25 }, (_, i) => (i < 3 ? 4 : 3.92)), [[T0 + 3 * DAY, 0.08]]) };
  const [z] = scorePicks([{ createdAt: during, picks: [{ symbol: 'Z74', stance: 'long', price: 3 }] }], withIndexDiv, new Date((T0 + 30 * DAY) * 1000));
  assert.ok(Math.abs(z.indexRet) < 1e-9);
  assert.ok(Math.abs(z.indexBet) < 1e-9);
});
