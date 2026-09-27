import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio, applyTrade, summarize, validatePortfolio, buyingPower } from '../portfolio.js';
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
  assert.throws(() => validatePortfolio({ ...p, positions: { X: { qty: 0, avgCost: 1, currency: 'USD' } } }));
});

test('toQuote reads price, previous close and bars from Yahoo chart results', () => {
  const daily = {
    meta: { currency: 'SGD', regularMarketPrice: 41.4, regularMarketTime: 1_758_800_000, chartPreviousClose: 38 },
    timestamp: [1, 2, 3, 4],
    indicators: { quote: [{ close: [40, null, 41, 41.4] }] },
  };
  const intraday = { meta: { ...daily.meta, regularMarketPrice: 41.5 }, timestamp: [10, 11], indicators: { quote: [{ close: [41.45, 41.5] }] } };
  const q = toQuote(daily, intraday);
  assert.equal(q.price, 41.5);
  assert.equal(q.prevClose, 41);
  assert.deepEqual(q.daily, [[1, 40], [3, 41], [4, 41.4]]);
  assert.deepEqual(q.intraday, [[10, 41.45], [11, 41.5]]);
  assert.equal(q.currency, 'SGD');
  assert.throws(() => toQuote({ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }), /no price/);
});

test('daily bars keep the day\'s volume as a third value, which [t, close] readers ignore', () => {
  const daily = {
    meta: { currency: 'SGD', regularMarketPrice: 41.4 },
    timestamp: [1, 2, 3],
    indicators: { quote: [{ close: [40, 41, 41.4], volume: [2870900, null, 0] }] },
  };
  const intraday = { meta: daily.meta, timestamp: [10], indicators: { quote: [{ close: [41.4], volume: [500] }] } };
  const q = toQuote(daily, intraday);
  assert.deepEqual(q.daily, [[1, 40, 2870900], [2, 41], [3, 41.4]]); // no volume, no third value
  assert.deepEqual(q.intraday, [[10, 41.4]]); // 15-minute bars stay [t, close]
  assert.deepEqual(q.daily.map(([, c]) => c), [40, 41, 41.4]);
  assert.equal(q.prevClose, 41);
});

test('selling more than you hold opens a short that profits when the price falls', () => {
  let p = newPortfolio({ USD: 10000 });
  p = sell(p, 'TSLA', 10, 200);
  assert.deepEqual(p.positions.TSLA, { qty: -10, avgCost: 200, currency: 'USD' });
  assert.equal(p.accounts.USD.cash, 12000);
  assert.equal(buyingPower(p, 'USD'), 12000 - 3000);
  let s = summarize(p, { TSLA: { price: 150 } });
  assert.equal(s.accounts.USD.net, 500);
  assert.equal(s.positions[0].unrealized, 500);
  assert.equal(s.positions[0].unrealizedPct, 0.25);
  p = buy(p, 'TSLA', 10, 150);
  assert.equal(p.positions.TSLA, undefined);
  assert.equal(p.accounts.USD.realized, 500);
  assert.equal(p.accounts.USD.cash, 10500);
});

test('a sale bigger than a long position flips it to short at the sale price', () => {
  let p = buy(newPortfolio({ USD: 10000 }), 'A', 10, 100);
  p = sell(p, 'A', 15, 120);
  assert.equal(p.accounts.USD.realized, 200);
  assert.deepEqual(p.positions.A, { qty: -5, avgCost: 120, currency: 'USD' });
});

test('shorting needs 150% collateral, and short collateral cannot be spent on buys', () => {
  let p = newPortfolio({ USD: 1000 });
  assert.throws(() => sell(p, 'A', 21, 100), /buying power to short/); // 2100 short needs 1050 free
  p = sell(p, 'A', 20, 100); // uses exactly all 1000 of buying power
  assert.equal(buyingPower(p, 'USD'), 0);
  assert.throws(() => buy(p, 'B', 1, 1), /Not enough USD cash/);
  p = buy(p, 'A', 20, 130); // covering is always allowed, even at a loss
  assert.equal(p.accounts.USD.cash, 400);
});

