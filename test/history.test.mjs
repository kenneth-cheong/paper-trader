import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueHistory, indexHistory, realizedHistory } from '../history.js';
import { newPortfolio, applyTrade, convertCash, summarize } from '../portfolio.js';
import { benchmarkFor } from '../benchmark.js';

const cents = (x) => Math.round(x * 100) / 100;
import { applyCorporateActions } from '../actions.js';

const DAY = 86400;
const T0 = Date.parse('2026-03-02T14:30:00Z') / 1000;
const bars = (f, n = 10) => Array.from({ length: n }, (_, i) => [T0 + i * DAY, f(i)]);
const iso = (i, h = 16) => new Date((T0 + i * DAY + (h - 14.5) * 3600) * 1000).toISOString();
const quotes = {
  SPY: { market: 'US', currency: 'USD', price: 409, daily: bars((i) => 400 + i) },
  A: { market: 'US', currency: 'USD', price: 20, daily: bars((i) => 10 + i) },
};

test('value over time replays trades, fees and conversions at each day\'s close', () => {
  let p = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 10, price: 11, currency: 'USD', market: 'US', fee: 1, time: iso(1) });
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 100, rate: 1.3, time: iso(3) });
  const h = valueHistory(p, quotes, 'USD');
  const v = Object.fromEntries(h.slice(0, -1).map(([t, x], i) => [i, x]));
  assert.equal(v[0], 1000); // day 0: all cash
  assert.equal(v[1], 1000 - 110 - 1 + 10 * 11); // bought at the day's close, less the fee
  assert.equal(v[2], 889 + 10 * 12);
  assert.equal(v[3], 789 + 10 * 13); // 100 converted away
  assert.equal(h.at(-1)[1], 789 + 10 * 20); // now, at the latest price
});

test('shares bought before a split count in today\'s (split-adjusted) share terms', () => {
  // A 2-for-1 split on day 5: Yahoo's closes are adjusted, so before it A traded at 2x these prices.
  let p = { ...newPortfolio({ USD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 5, price: 22, currency: 'USD', market: 'US', time: iso(1) });
  const q = { ...quotes, A: { ...quotes.A, events: { splits: [[T0 + 5 * DAY, 2]], dividends: [] } } };
  p = applyCorporateActions(p, q, new Date((T0 + 9 * DAY) * 1000)).portfolio;
  const h = valueHistory(p, q, 'USD');
  assert.equal(h[1][1], 890 + 10 * 11); // 5 shares then = 10 today, at the adjusted close
  assert.equal(h.at(-1)[1], 890 + 10 * 20);
});

test('realized profit adds up over time, with dividends', () => {
  let p = { ...newPortfolio({ USD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 10, price: 10, currency: 'USD', market: 'US', time: iso(1) });
  p = applyTrade(p, { symbol: 'A', side: 'sell', qty: 5, price: 12, currency: 'USD', market: 'US', time: iso(2) });
  p.actions = [{ kind: 'dividend', currency: 'USD', amount: 1.5, time: iso(3), symbol: 'A' }];
  p = applyTrade(p, { symbol: 'A', side: 'sell', qty: 5, price: 9, currency: 'USD', market: 'US', time: iso(4) });
  assert.deepEqual(realizedHistory(p, 'USD').map(([, v]) => v), [10, 11.5, 6.5]);
});

test('value over time carries the money put in, and the last point matches the account card', () => {
  let p = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 10, price: 11, currency: 'USD', market: 'US', time: iso(1) });
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 100, rate: 1.3, time: iso(3) });
  const h = valueHistory(p, quotes, 'USD');
  assert.deepEqual(h.slice(0, 5).map(([, , inv]) => inv), [1000, 1000, 1000, 900, 900]);
  assert.equal(h.at(-1)[2], 900);
  assert.equal(h.at(-1)[1], summarize(p, quotes).accounts.USD.equity);
});

test('a holding with no price yet counts at its traded price, not zero', () => {
  let p = { ...newPortfolio({ USD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'NEW', side: 'buy', qty: 10, price: 50, currency: 'USD', market: 'US', time: iso(1) });
  const q = { ...quotes, NEW: { market: 'US', currency: 'USD', price: 0, daily: [] } };
  const h = valueHistory(p, q, 'USD');
  assert.equal(h[2][1], 1000); // 500 cash + 10 shares at 50
  assert.equal(h.at(-1)[1], 1000); // valued at cost, as the card does
});

test('the index line gets the same money in and out as the account', () => {
  let p = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = convertCash(p, { from: 'SGD', to: 'USD', amount: 403, rate: 1, time: iso(4) }); // during day 4: the last SPY close is day 3's 403
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 700.5, rate: 1, time: iso(6) });
  const b = benchmarkFor({ currency: 'USD', amount: 1000, since: p.createdAt, quotes });
  const h = valueHistory(p, quotes, 'USD');
  const idx = indexHistory(p, quotes, 'USD', b, h);
  assert.equal(b.startPrice, 400);
  assert.equal(idx.values[0], 1000); // 2.5 units at 400
  // 403 converted in buys 1 unit at 403: 3.5 units at day 4's close of 404.
  assert.equal(idx.values[4], cents(3.5 * 404));
  // 700.5 converted out of an account worth 1403 takes the same share (about half) of the index.
  assert.equal(h[5][1], 1403);
  assert.equal(idx.values[6], cents(3.5 * (1 - 700.5 / 1403) * 406));
});

test('converting everything out takes the index line to zero, not below', () => {
  let p = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 1000, rate: 1.3, time: iso(4) });
  const b = benchmarkFor({ currency: 'USD', amount: 1000, since: p.createdAt, quotes });
  const idx = indexHistory(p, quotes, 'USD', b, valueHistory(p, quotes, 'USD'));
  assert.equal(idx.values.at(-1), 0);
  assert.ok(idx.values.every((v) => v >= 0));
});

test('an account older than the index prices starts the index line at its value then', () => {
  const p = { ...newPortfolio({ USD: 1000 }), createdAt: iso(-30, 10), feePlan: 'none' };
  const b = benchmarkFor({ currency: 'USD', amount: 1000, since: p.createdAt, quotes });
  assert.equal(b.partial, true);
  const h = valueHistory(p, quotes, 'USD');
  const idx = indexHistory(p, quotes, 'USD', b, h);
  assert.equal(idx.rebased, true);
  assert.equal(idx.values[0], 1000);
});

test('money converted out takes the index down by the same share of the account at that moment', () => {
  // In and out on the same day, before the first close: the index keeps the account's share.
  let p = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p = convertCash(p, { from: 'SGD', to: 'USD', amount: 1000, rate: 1, time: iso(0, 11) });
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 1000, rate: 1, time: iso(0, 12) });
  const b = benchmarkFor({ currency: 'USD', amount: 1000, since: p.createdAt, quotes });
  const h = valueHistory(p, quotes, 'USD');
  const idx = indexHistory(p, quotes, 'USD', b, h);
  assert.equal(h[0][1], 1000);
  assert.equal(idx.values[0], 1000); // 2.5 units, +2.5 at 400, then half of 5 units out
  // Two withdrawals of 500 from 1000 empty the account and the index.
  let p2 = { ...newPortfolio({ USD: 1000, SGD: 1000 }), createdAt: iso(0, 10), feePlan: 'none' };
  p2 = convertCash(p2, { from: 'USD', to: 'SGD', amount: 500, rate: 1, time: iso(2) });
  p2 = convertCash(p2, { from: 'USD', to: 'SGD', amount: 500, rate: 1, time: iso(2, 17) });
  const i2 = indexHistory(p2, quotes, 'USD', b, valueHistory(p2, quotes, 'USD'));
  assert.equal(i2.values.at(-1), 0);
});

test('daily bars carrying volume ([t, close, volume]) give the same results everywhere prices are read', async () => {
  const { readFile } = await import('node:fs/promises');
  const { stockStats } = await import('../ai.js');
  const { backtest, newRule } = await import('../rules.js');
  const { buildMemory } = await import('../memory.js');
  const { scorePicks } = await import('../scorecard.js');
  const { gradeIdeas } = await import('../learning.js');
  const sample = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8')).quotes;
  const withVolume = Object.fromEntries(Object.entries(sample).map(([s, q]) => [s, { ...q, daily: q.daily.map(([t, c], i) => [t, c, 1e6 + i]) }]));
  const now = new Date('2026-01-02T22:00:00Z');
  const t0 = sample.AAPL.daily[100][0] + 7 * 3600;
  let p = { ...newPortfolio({ USD: 10000 }), createdAt: new Date(sample.AAPL.daily[90][0] * 1000).toISOString(), feePlan: 'none' };
  p = applyTrade(p, { symbol: 'AAPL', side: 'buy', qty: 10, price: sample.AAPL.daily[100][1], currency: 'USD', market: 'US', fee: 0, time: new Date(t0 * 1000).toISOString() });
  const rules = [newRule({ symbol: 'AAPL', when: { type: 'above_ma', value: 20 }, action: { side: 'buy', unit: 'pct_cash', amount: 50 }, repeat: 'repeat' }),
    newRule({ symbol: 'AAPL', when: { type: 'below_ma', value: 20 }, action: { side: 'sell', unit: 'all', amount: 0 }, repeat: 'repeat' })];
  const picks = [{ createdAt: new Date(t0 * 1000).toISOString(), picks: [{ symbol: 'AAPL', stance: 'long', priceAtPick: sample.AAPL.daily[100][1] }] }];
  const idea = [{ id: 'i', t: t0, symbol: 'AAPL', direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'news', price: sample.AAPL.daily[100][1] }];
  const run = (quotes) => JSON.stringify([
    stockStats(quotes.AAPL), backtest(rules, quotes.AAPL, { feePlan: 'none' }), valueHistory(p, quotes, 'USD').slice(0, -1), // the last point is the time now
    benchmarkFor({ currency: 'USD', amount: 10000, since: '2025-06-01T00:00:00Z', quotes }),
    buildMemory([], quotes, 'US', now), scorePicks(picks, quotes, now), gradeIdeas(idea, quotes, 'USD', now),
  ]);
  assert.equal(run(withVolume), run(sample));
});
