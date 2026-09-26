import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio, applyTrade, convertCash, summarize, validatePortfolio } from '../portfolio.js';
import { applyCorporateActions, holdingAt, describeAction } from '../actions.js';
import { events } from '../scripts/fetch-prices.mjs';
import { planFor } from '../fees.js';

const T = (iso) => Date.parse(iso) / 1000;
const start = () => ({ ...newPortfolio({ SGD: 10000, USD: 10000 }), createdAt: '2026-01-01T00:00:00Z', feePlan: 'none' });
const buy = (p, symbol, qty, price, time, currency = 'USD', market = 'US') => applyTrade(p, { symbol, side: 'buy', qty, price, currency, market, time });

test('converting cash moves money at the market rate, less the spread, and only the spread is a loss', () => {
  let p = start();
  p = convertCash(p, { from: 'USD', to: 'SGD', amount: 1000, rate: 1.35, spreadPct: 0.1, time: '2026-02-01T00:00:00Z' });
  assert.equal(p.accounts.USD.cash, 9000);
  assert.equal(p.accounts.SGD.cash, 11348.65); // 1350 less 0.1%
  const s = summarize(p, {}).accounts;
  assert.equal(s.USD.net, 0); // moving money out isn't a loss
  assert.equal(Math.round(s.SGD.net * 100) / 100, -1.35); // the spread is
  assert.equal(s.SGD.invested, 11350);
  assert.deepEqual(p.conversions[0], { time: '2026-02-01T00:00:00Z', from: 'USD', to: 'SGD', amount: 1000, rate: 1.35, spreadPct: 0.1, received: 1348.65, cost: 1.35 });
  assert.equal(validatePortfolio(structuredClone(p)).conversions.length, 1);
});

test('converting is refused beyond what is free to spend, or without a rate', () => {
  const p = start();
  assert.throws(() => convertCash(p, { from: 'USD', to: 'SGD', amount: 20000, rate: 1.35 }), /Not enough USD available/);
  assert.throws(() => convertCash(p, { from: 'USD', to: 'SGD', amount: 10, rate: 0 }), /no exchange rate/);
  assert.throws(() => convertCash(p, { from: 'USD', to: 'USD', amount: 10, rate: 1 }), /two different/);
  assert.equal(planFor('tiger').fxSpreadPct, 0.1);
  assert.equal(planFor('custom', { pct: {}, min: {}, fx: 0.3 }).fxSpreadPct, 0.3);
});

test('a split multiplies the shares held at the split and keeps their total cost', () => {
  let p = buy(start(), 'NVDA', 10, 300, '2026-03-01T15:00:00Z');
  const quotes = { NVDA: { market: 'US', currency: 'USD', price: 101, events: { splits: [[T('2026-03-10T13:30:00Z'), 3]], dividends: [] } } };
  const { portfolio, applied } = applyCorporateActions(p, quotes, new Date('2026-03-11T00:00:00Z'));
  assert.equal(portfolio.positions.NVDA.qty, 30);
  assert.equal(portfolio.positions.NVDA.avgCost, 100);
  assert.equal(applied.length, 1);
  assert.match(describeAction(applied[0]), /3-for-1 split: 10 shares became 30/);
  // applied once only
  assert.equal(applyCorporateActions(portfolio, quotes, new Date('2026-03-12T00:00:00Z')).applied.length, 0);
});

test('dividends are paid on shares held before the ex-date, after US withholding tax', () => {
  let p = buy(start(), 'AAPL', 30, 200, '2026-03-01T15:00:00Z');
  p = buy(p, 'AAPL', 5, 200, '2026-03-10T15:00:00Z'); // bought on the ex-date: not entitled
  const quotes = { AAPL: { market: 'US', currency: 'USD', price: 200, events: { dividends: [[T('2026-03-10T13:30:00Z'), 0.25]] } } };
  const { portfolio, applied } = applyCorporateActions(p, quotes, new Date('2026-03-11T00:00:00Z'));
  assert.equal(applied[0].qty, 30);
  assert.equal(applied[0].amount, 5.25); // 7.50 less 30%
  assert.equal(portfolio.accounts.USD.dividends, 5.25);
  assert.equal(portfolio.accounts.USD.cash, p.accounts.USD.cash + 5.25);
  assert.equal(summarize(portfolio, quotes).accounts.USD.net, summarize(p, quotes).accounts.USD.net + 5.25);
});

test('SGX dividends are paid in full; shorts pay the dividend; old and future events are ignored', () => {
  let p = buy(start(), 'D05.SI', 100, 40, '2026-03-01T02:00:00Z', 'SGD', 'SGX');
  p = applyTrade(p, { symbol: 'AAPL', side: 'sell', qty: 10, price: 200, currency: 'USD', market: 'US', time: '2026-03-01T15:00:00Z' });
  const quotes = {
    'D05.SI': { market: 'SGX', currency: 'SGD', price: 40, events: { dividends: [[T('2025-12-01T01:00:00Z'), 0.5], [T('2026-04-01T01:00:00Z'), 0.6], [T('2026-05-01T01:00:00Z'), 0.6]] } },
    AAPL: { market: 'US', currency: 'USD', price: 200, events: { dividends: [[T('2026-04-01T13:30:00Z'), 0.25]] } },
  };
  const { portfolio, applied } = applyCorporateActions(p, quotes, new Date('2026-04-02T00:00:00Z'));
  assert.deepEqual(applied.map((a) => [a.symbol, a.amount]), [['D05.SI', 60], ['AAPL', -2.5]]);
  assert.equal(portfolio.accounts.SGD.dividends, 60);
  assert.equal(portfolio.accounts.USD.dividends, -2.5);
});

test('holdings before a later event count earlier splits', () => {
  let p = buy(start(), 'NVDA', 10, 300, '2026-03-01T15:00:00Z');
  const quotes = { NVDA: { market: 'US', currency: 'USD', price: 100, events: { splits: [[T('2026-03-10T13:30:00Z'), 3]], dividends: [[T('2026-04-10T13:30:00Z'), 0.01]] } } };
  const { portfolio, applied } = applyCorporateActions(p, quotes, new Date('2026-05-01T00:00:00Z'));
  assert.equal(holdingAt(portfolio, 'NVDA', T('2026-04-01T00:00:00Z')), 30);
  assert.equal(applied[1].qty, 30);
  assert.equal(applied[1].amount, 0.21);
});

test('Yahoo dividend and split events are read from chart results', () => {
  const ev = events({ events: {
    dividends: { 1: { amount: 0.24, date: 1700000000 }, 2: { amount: 0.25, date: 1690000000 } },
    splits: { 3: { date: 1680000000, numerator: 4, denominator: 1, splitRatio: '4:1' } },
  } });
  assert.deepEqual(ev, { dividends: [[1690000000, 0.25], [1700000000, 0.24]], splits: [[1680000000, 4]] });
  assert.equal(events({}), undefined);
});
