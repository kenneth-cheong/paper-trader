import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio, applyTrade, summarize, validatePortfolio } from '../portfolio.js';
import { toQuote } from '../scripts/fetch-prices.mjs';

const buy = (p, symbol, qty, price, currency = 'USD') => applyTrade(p, { symbol, side: 'buy', qty, price, currency });
const sell = (p, symbol, qty, price, currency = 'USD') => applyTrade(p, { symbol, side: 'sell', qty, price, currency });

test('buying moves cash into a position at average cost', () => {
  let p = newPortfolio({ USD: 10000 });
  p = buy(p, 'AAPL', 10, 100);
  p = buy(p, 'AAPL', 10, 200);
  assert.equal(p.accounts.USD.cash, 7000);
  assert.deepEqual(p.positions.AAPL, { qty: 20, avgCost: 150, currency: 'USD' });
});

test('selling realizes profit against average cost and closes the position', () => {
  let p = newPortfolio({ USD: 10000 });
  p = buy(p, 'AAPL', 10, 100);
  p = buy(p, 'AAPL', 10, 200);
  p = sell(p, 'AAPL', 5, 170);
  assert.equal(p.accounts.USD.realized, 100);
  assert.equal(p.positions.AAPL.qty, 15);
  p = sell(p, 'AAPL', 15, 120);
  assert.equal(p.accounts.USD.realized, 100 - 450);
  assert.equal(p.positions.AAPL, undefined);
  assert.equal(p.accounts.USD.cash, 10000 - 350);
});

test('summary nets cash, holdings and start per currency', () => {
  let p = newPortfolio({ SGD: 50000, USD: 10000 });
  p = buy(p, 'D05.SI', 100, 40, 'SGD');
  p = buy(p, 'NVDA', 10, 100);
  const s = summarize(p, { 'D05.SI': { price: 42 }, NVDA: { price: 90 } });
  assert.equal(s.accounts.SGD.net, 200);
  assert.equal(s.accounts.USD.net, -100);
  assert.equal(s.accounts.USD.netPct, -0.01);
  const nvda = s.positions.find((x) => x.symbol === 'NVDA');
  assert.equal(nvda.unrealized, -100);
});

test('a holding with no quote is valued at cost and flagged', () => {
  let p = buy(newPortfolio({ USD: 1000 }), 'XYZ', 1, 50);
  const s = summarize(p, {});
  assert.equal(s.positions[0].unpriced, true);
  assert.equal(s.accounts.USD.net, 0);
});

test('bad trades throw and leave the portfolio untouched', () => {
  const p = buy(newPortfolio({ USD: 1000 }), 'AAPL', 1, 100);
  const before = JSON.stringify(p);
  assert.throws(() => buy(p, 'AAPL', 100, 100), /Not enough USD cash/);
  assert.throws(() => sell(p, 'AAPL', 2, 100), /only hold 1/);
  assert.throws(() => buy(p, 'AAPL', 1.5, 100), /whole number/);
  assert.throws(() => buy(p, 'AAPL', 1, 0), /no price/);
  assert.throws(() => buy(p, 'D05.SI', 1, 10, 'SGD'), /no SGD account/);
  assert.equal(JSON.stringify(p), before);
});

test('many small trades do not drift from float error', () => {
  let p = newPortfolio({ USD: 1000 });
  for (let i = 0; i < 100; i++) p = buy(p, 'A', 1, 0.1);
  for (let i = 0; i < 100; i++) p = sell(p, 'A', 1, 0.1);
  assert.equal(p.accounts.USD.cash, 1000);
});

test('validatePortfolio accepts its own output and rejects junk', () => {
  const p = buy(newPortfolio(), 'AAPL', 1, 100);
  assert.deepEqual(validatePortfolio(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => validatePortfolio({ foo: 1 }), /not a paper-trader/);
  assert.throws(() => validatePortfolio({ ...p, positions: { X: { qty: -1, avgCost: 1, currency: 'USD' } } }));
});

test('toQuote reads price, previous close and history from a Yahoo chart result', () => {
  const q = toQuote({
    meta: { currency: 'SGD', regularMarketPrice: 41.5, regularMarketTime: 1_758_800_000, chartPreviousClose: 38 },
    indicators: { quote: [{ close: [40, null, 41, 41.5] }] },
  });
  assert.equal(q.price, 41.5);
  assert.equal(q.prevClose, 41);
  assert.deepEqual(q.history, [40, 41, 41.5]);
  assert.equal(q.currency, 'SGD');
  assert.throws(() => toQuote({ meta: {}, indicators: { quote: [{ close: [] }] } }), /no price/);
});
