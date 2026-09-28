import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, convert, statusOf, fundFigures, rankFunds, combine, fundsOverview } from '../fund-views.js';
import { newFund } from '../fund.js';

const now = new Date('2026-01-07T15:00:00Z');
const bar = Date.parse('2026-01-02T14:30:00Z') / 1000; // a session well before the funds started
// SPY doubled and ES3 rose 10% since the funds started (no fees, so the sums stay round)
const quotes = {
  AAPL: { currency: 'USD', market: 'US', price: 110 },
  MSFT: { currency: 'USD', market: 'US', price: 50 },
  TSLA: { currency: 'USD', market: 'US', price: 80 },
  'D05.SI': { currency: 'SGD', market: 'SGX', price: 40 },
  SPY: { currency: 'USD', market: 'US', price: 200, daily: [[bar, 100]] },
  'ES3.SI': { currency: 'SGD', market: 'SGX', price: 4.4, daily: [[bar, 4]] },
};
// A fund holding `held` ({ symbol: [qty, avgCost] }), bought out of its cash.
function fund(id, currency, budget, held = {}, extra = {}) {
  const f = newFund({ budget, currency, settings: { feePlan: 'none' }, now });
  Object.assign(f, { id, name: id, style: 'balanced', focus: '' }, extra);
  for (const [symbol, [qty, avgCost]] of Object.entries(held)) {
    f.portfolio.positions[symbol] = { qty, avgCost, entry: avgCost, currency };
    f.portfolio.accounts[currency].cash -= qty * avgCost;
  }
  return f;
}
const cost = (usd) => ({ time: now.toISOString(), outlook: '', orders: [], usage: { costUsd: usd } });

test('a fund\'s figures: value, stocks held, share invested and each position\'s weight, largest first', () => {
  const f = fund('growth', 'USD', 10000, { AAPL: [50, 100], MSFT: [20, 50] }, { decisions: [cost(10)] });
  const x = fundFigures(f, quotes);
  assert.equal(x.account.equity, 4000 + 5500 + 1000);
  assert.equal(x.account.net, 500);
  assert.equal(x.stocks, 2);
  assert.deepEqual(x.positions.map((p) => p.symbol), ['AAPL', 'MSFT']);
  assert.equal(x.positions[0].weight, 5500 / 10500);
  assert.equal(x.investedPct, 6500 / 10500);
  assert.equal(x.positions[0].unrealizedPct, 0.1);
  assert.equal(x.costUsd, 10);
  assert.equal(x.afterCost, (500 - 10) / 10000);
  assert.equal(x.bench.pct, 1); // SPY doubled
  assert.equal(x.vsIndex, 0.05 - 1);
  assert.equal(x.status, 'running');
  assert.equal(x.market, 'US');
});

test('a fund with no positions is all cash: 0 stocks, 0% invested', () => {
  const x = fundFigures(fund('empty', 'USD', 5000), quotes);
  assert.equal(x.stocks, 0);
  assert.equal(x.investedPct, 0);
  assert.equal(x.free, 5000);
  assert.deepEqual(x.positions, []);
});

test('a short counts at its size, and only the cash free to spend counts as not invested', () => {
  const f = fund('shorty', 'USD', 10000, { TSLA: [-10, 100] }); // sold 10 at 100: cash 11,000, 1,500 set aside
  const x = fundFigures(f, quotes);
  assert.equal(x.shorts, true);
  assert.equal(x.gross, 800);
  assert.equal(x.free, 11000 - 1500);
  assert.equal(x.investedPct, 800 / (800 + 9500));
  assert.equal(x.positions[0].unrealized, 200); // the price fell from 100 to 80: a gain on the short
  assert.equal(x.longs, 0);
});

test('an SGD fund\'s AI cost needs the exchange rate; without it there is no "after AI cost"', () => {
  const f = fund('sg', 'SGD', 10000, { 'D05.SI': [100, 38] }, { decisions: [cost(2)] });
  assert.equal(fundFigures(f, quotes).afterCost, null);
  const x = fundFigures(f, quotes, { fx: 1.3 });
  assert.equal(x.cost, 2.6);
  assert.equal(x.afterCost, (200 - 2.6) / 10000);
});

test('convert: the same currency as it is, USD and SGD at the rate, null without one', () => {
  assert.equal(convert(10, 'USD', 'USD', null), 10);
  assert.equal(convert(10, 'USD', 'SGD', 1.25), 12.5);
  assert.equal(convert(12.5, 'SGD', 'USD', 1.25), 10);
  assert.equal(convert(10, 'USD', 'SGD', null), null);
  assert.equal(convert(10, 'USD', 'SGD', 0), null);
  assert.equal(convert(null, 'USD', 'USD', 1), null);
});

test('ranking: running and paused funds by return after AI cost, stopped ones after them', () => {
  const figs = [
    fund('stopped-best', 'USD', 1000, {}, { stoppedAt: now.toISOString(), portfolio: { ...fund('x', 'USD', 1000).portfolio, accounts: { USD: { start: 1000, cash: 5000, realized: 0 } } } }),
    fund('low', 'USD', 10000, { MSFT: [20, 50] }),
    fund('high', 'USD', 10000, { AAPL: [50, 100] }),
    fund('paused', 'USD', 10000, { AAPL: [10, 100] }, { paused: { at: now.toISOString(), reason: 'r' } }),
  ].map((f) => fundFigures(f, quotes));
  assert.deepEqual(rankFunds(figs).map((x) => x.id), ['high', 'paused', 'low', 'stopped-best']);
  assert.deepEqual(figs.map((x) => statusOf(x.fund)), ['stopped', 'running', 'running', 'paused']);
});

test('all funds in one currency add up in that currency, with no rate needed', () => {
  const a = fund('a', 'USD', 10000, { AAPL: [50, 100] });
  const b = fund('b', 'USD', 5000, { AAPL: [10, 100], MSFT: [20, 50] });
  const v = combine(rankFunds([a, b].map((f) => fundFigures(f, quotes))));
  assert.equal(v.base, 'USD');
  assert.equal(v.fx, null);
  assert.equal(v.totals.value, 10500 + 5100);
  assert.equal(v.totals.invested, 15000);
  assert.equal(v.totals.net, 600);
  assert.equal(v.totals.netPct, 600 / 15000);
  assert.equal(v.totals.benchPct, 1);
  assert.equal(v.totals.longs.US, 5500 + 1100 + 1000);
  assert.equal(v.stocks, 2); // AAPL and MSFT
  assert.equal(v.positions, 3);
  assert.deepEqual(v.shared.map((h) => [h.symbol, h.funds.map((x) => x.name)]), [['AAPL', ['a', 'b']]]);
});

test('the same stock in two funds is one holding: its value, weight of all funds and profit since bought together', () => {
  const a = fund('a', 'USD', 10000, { AAPL: [50, 100] });
  const b = fund('b', 'USD', 5000, { AAPL: [10, 120], MSFT: [20, 50] });
  const v = combine([a, b].map((f) => fundFigures(f, quotes)));
  const [aapl, msft] = v.holdings;
  assert.equal(aapl.symbol, 'AAPL');
  assert.equal(aapl.qty, 60);
  assert.equal(aapl.value, 6600);
  assert.equal(aapl.weight, 6600 / v.totals.value);
  assert.equal(aapl.cost, 5000 + 1200);
  assert.equal(aapl.unrealized, 500 - 100);
  assert.equal(aapl.plPct, 400 / 6200);
  assert.equal(msft.symbol, 'MSFT');
  assert.deepEqual(msft.funds, [{ id: 'b', name: 'b' }]);
});

test('a stock one fund holds long and another short is two rows, not one that nets to nothing', () => {
  const a = fund('a', 'USD', 10000, { AAPL: [10, 100], MSFT: [5, 100] });
  const b = fund('b', 'USD', 10000, { AAPL: [-10, 100] });
  const v = combine([a, b].map((f) => fundFigures(f, quotes)));
  const rows = v.holdings.filter((h) => h.symbol === 'AAPL');
  assert.equal(rows.length, 2);
  const long = rows.find((h) => !h.short), short = rows.find((h) => h.short);
  assert.deepEqual([long.qty, long.value, long.unrealized, long.plPct], [10, 1100, 100, 0.1]);
  assert.deepEqual([short.qty, short.value, short.unrealized, short.plPct], [-10, -1100, -100, -0.1]);
  assert.equal(long.weight, 1100 / v.totals.value);
  assert.equal(short.weight, 1100 / v.totals.value);
  assert.deepEqual(long.funds.map((x) => x.id), ['a']);
  assert.deepEqual(short.funds.map((x) => x.id), ['b']);
  assert.ok(v.holdings.indexOf(rows[1]) < v.holdings.findIndex((h) => h.symbol === 'MSFT')); // both larger than MSFT
  assert.equal(v.stocks, 2); // AAPL once, and MSFT
  assert.equal(v.positions, 3);
  assert.deepEqual(v.shared.map((h) => [h.symbol, h.funds.map((x) => x.id)]), [['AAPL', ['a', 'b']]]);
});

test('USD and SGD funds combine in SGD at the rate given; each fund keeps its own figures', () => {
  const us = fund('us', 'USD', 10000, { AAPL: [50, 100] });
  const sg = fund('sg', 'SGD', 13000, { 'D05.SI': [100, 38] });
  const v = combine(rankFunds([us, sg].map((f) => fundFigures(f, quotes, { fx: 1.3 }))), { fx: 1.3 });
  assert.equal(v.base, 'SGD');
  assert.equal(v.fx, 1.3);
  assert.equal(v.totals.value, 10500 * 1.3 + 13200);
  assert.equal(v.totals.invested, 13000 + 13000);
  assert.equal(v.totals.net, 500 * 1.3 + 200);
  // the same money in their indexes: SPY doubled on 13,000 SGD, ES3 rose 10% on 13,000 SGD
  assert.ok(Math.abs(v.totals.benchPct - (26000 + 14300 - 26000) / 26000) < 1e-12);
  assert.equal(v.totals.longs.US, 5500 * 1.3);
  assert.equal(v.totals.longs.SGX, 4000);
  const inBase = Object.fromEntries(v.byFund.map((x) => [x.id, x.inBase]));
  assert.equal(inBase.us, 10500 * 1.3);
  assert.equal(inBase.sg, 13200);
  assert.equal(v.byFund.find((x) => x.id === 'us').account.equity, 10500); // still in USD
  assert.ok(Math.abs(v.byFund.reduce((s, x) => s + x.share, 0) - 1) < 1e-12);
  assert.equal(v.holdings[0].symbol, 'AAPL');
  assert.equal(v.holdings[0].value, 5500 * 1.3);
});

test('without the exchange rate, USD and SGD funds stay apart: each currency is added up on its own', () => {
  const us = fund('us', 'USD', 10000, { AAPL: [50, 100] });
  const us2 = fund('us2', 'USD', 10000);
  const sg = fund('sg', 'SGD', 13000, { 'D05.SI': [100, 38] });
  const v = combine([us, us2, sg].map((f) => fundFigures(f, quotes)), { fx: null });
  assert.equal(v.base, null);
  assert.equal(v.totals, null);
  assert.deepEqual(v.currencies.map((t) => [t.currency, t.value, t.funds]), [['SGD', 13200, 1], ['USD', 20500, 2]]);
  const aapl = v.holdings.find((h) => h.symbol === 'AAPL');
  assert.equal(aapl.value, 5500); // in USD
  assert.equal(aapl.weight, 5500 / 20500); // of the USD funds
  assert.equal(v.byFund.find((x) => x.id === 'us').share, 10500 / 20500);
  assert.equal(v.byFund.find((x) => x.id === 'sg').share, 1);
  assert.equal(v.byFund.find((x) => x.id === 'us').inBase, null);
});

test('stopped funds are listed but not counted in the combined figures', () => {
  const live = fund('live', 'USD', 10000, { AAPL: [50, 100] });
  const done = fund('done', 'SGD', 10000, {}, { stoppedAt: now.toISOString() });
  const v = combine([live, done].map((f) => fundFigures(f, quotes)));
  assert.equal(v.base, 'USD'); // the stopped SGD fund doesn't need a rate
  assert.equal(v.running, 1);
  assert.equal(v.stopped, 1);
  assert.equal(v.paused, 0);
  assert.equal(v.totals.value, 10500);
  assert.equal(v.byFund.find((x) => x.id === 'done').share, null);
  assert.equal(v.byFund.length, 2);
});

test('paused funds are counted with the running ones, and said how many', () => {
  const live = fund('live', 'USD', 10000);
  const resting = fund('resting', 'USD', 10000, {}, { paused: { at: now.toISOString(), reason: 'r' } });
  const done = fund('done', 'USD', 10000, {}, { stoppedAt: now.toISOString() });
  const v = combine([live, resting, done].map((f) => fundFigures(f, quotes)));
  assert.deepEqual([v.running, v.paused, v.stopped], [2, 1, 1]);
  assert.equal(v.totals.value, 20000);
});

test('against their indexes needs every fund\'s index', () => {
  const noIndex = { ...quotes, SPY: undefined };
  const v = combine([fund('a', 'USD', 1000), fund('b', 'SGD', 1000)].map((f) => fundFigures(f, noIndex, { fx: 1.3 })), { fx: 1.3 });
  assert.equal(v.totals.benchPct, null);
  assert.equal(v.totals.vsIndex, null);
});

test('the page\'s overview: funds ranked, and a combined view only with two or more funds', () => {
  const one = fundsOverview({ funds: [fund('solo', 'USD', 1000)] }, quotes);
  assert.equal(one.funds.length, 1);
  assert.equal(one.combined, null);
  const two = fundsOverview({ funds: [fund('a', 'USD', 1000), fund('b', 'USD', 1000, { AAPL: [5, 100] })] }, quotes);
  assert.deepEqual(two.funds.map((x) => x.id), ['b', 'a']);
  assert.equal(two.combined.running, 2);
  assert.deepEqual(fundsOverview(null, quotes), { funds: [], combined: null });
  assert.equal(ALL, 'all');
});
