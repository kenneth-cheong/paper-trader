import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFund, decisionDue, applyOrders, setProtections, checkProtections, recordValue, stopFund } from '../fund.js';
import { summarize, buyingPower } from '../portfolio.js';

// Wed 7 Jan 2026. US market: 14:30-21:00 UTC. SGX: 01:00-04:00 and 05:00-09:00 UTC.
const at = (hhmm) => new Date(`2026-01-07T${hhmm}:00Z`);
const q = (price, extra = {}) => ({ currency: 'USD', price, daily: [], intraday: [], ...extra });

test('a new fund holds exactly its budget', () => {
  const f = newFund({ budget: 5000, currency: 'USD', now: at('10:00') });
  assert.equal(f.portfolio.accounts.USD.cash, 5000);
  assert.deepEqual(Object.keys(f.portfolio.accounts), ['USD']);
  assert.throws(() => newFund({ budget: 0, currency: 'USD' }), /above 0/);
  assert.throws(() => newFund({ budget: 10, currency: 'EUR' }), /Unsupported/);
});

test('decisions are due 15 minutes after the open, then spaced through the session', () => {
  const f = newFund({ budget: 5000, currency: 'USD', decisionsPerDay: 2, now: at('10:00') });
  assert.equal(decisionDue(f, at('14:40')), false); // 10 min after open
  assert.equal(decisionDue(f, at('14:45')), true);
  f.lastDecisionAt = at('14:45').toISOString();
  assert.equal(decisionDue(f, at('16:30')), false);
  assert.equal(decisionDue(f, at('18:00')), true); // 195-minute gap for 2 a day
  assert.equal(decisionDue(f, at('22:00')), false); // closed
  const sgx = newFund({ budget: 5000, currency: 'SGD', now: at('00:00') });
  assert.equal(decisionDue(sgx, at('01:20')), true);
  assert.equal(decisionDue(sgx, at('04:30')), false); // lunch break
  f.stoppedAt = at('15:00').toISOString();
  assert.equal(decisionDue(f, at('18:00')), false);
});

test('the fund can never spend more than its budget', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: at('10:00') });
  const quotes = { A: q(100), B: q(50), C: { ...q(10), currency: 'SGD' } };
  const res = applyOrders(f, [
    { symbol: 'A', action: 'buy', shares: 8, reason: '' },
    { symbol: 'B', action: 'buy', shares: 5, reason: '' }, // 250 > the 200 left
    { symbol: 'C', action: 'buy', shares: 1, reason: '' },
    { symbol: 'Z', action: 'buy', shares: 1, reason: '' },
  ], quotes, at('15:00'));
  assert.deepEqual(res.map((r) => r.status), ['filled', 'rejected', 'rejected', 'rejected']);
  assert.match(res[1].message, /Not enough USD cash/);
  assert.equal(f.portfolio.accounts.USD.cash, 200);
});

test('sells run before buys so the freed cash can be reused', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: at('10:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }], { A: q(100) }, at('15:00'));
  const res = applyOrders(f, [
    { symbol: 'B', action: 'buy', shares: 10, reason: '' },
    { symbol: 'A', action: 'sell', shares: 10, reason: '' },
  ], { A: q(100), B: q(100) }, at('16:00'));
  assert.deepEqual(res.map((r) => `${r.symbol}:${r.status}`), ['A:filled', 'B:filled']);
});

test('short and cover work, but actions must match the position', () => {
  const f = newFund({ budget: 1500, currency: 'USD', now: at('10:00') });
  const quotes = { A: q(100) };
  let res = applyOrders(f, [{ symbol: 'A', action: 'short', shares: 10, reason: '' }], quotes, at('15:00'));
  assert.equal(res[0].status, 'filled');
  assert.equal(buyingPower(f.portfolio, 'USD'), 1000);
  res = applyOrders(f, [
    { symbol: 'A', action: 'buy', shares: 1, reason: '' },
    { symbol: 'A', action: 'sell', shares: 1, reason: '' },
  ], { A: q(90) }, at('16:00'));
  assert.deepEqual(res.map((r) => `${r.action}:${r.status}`), ['sell:rejected', 'buy:rejected']);
  assert.match(res[1].message, /use cover/);
  res = applyOrders(f, [{ symbol: 'A', action: 'cover', shares: 50, reason: '' }], { A: q(90) }, at('16:15'));
  assert.equal(res[0].status, 'filled');
  assert.equal(res[0].shares, 10); // capped at the short size
  assert.equal(f.portfolio.accounts.USD.realized, 100);
});

test('stop-loss and take-profit fire on the 15-minute prices between decisions', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }, { symbol: 'B', action: 'buy', shares: 10, reason: '' }], { A: q(100), B: q(100) }, at('14:45'));
  setProtections(f, [
    { symbol: 'A', stop_loss_pct: 5, take_profit_pct: 0 },
    { symbol: 'B', stop_loss_pct: 0, take_profit_pct: 10 },
    { symbol: 'Z', stop_loss_pct: 5, take_profit_pct: 5 }, // not held: ignored
  ]);
  assert.deepEqual(Object.keys(f.protections), ['A', 'B']);
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  const quotes = {
    A: q(96, { intraday: [[t('15:00'), 98], [t('15:15'), 94.9], [t('15:30'), 96]] }),
    B: q(111, { intraday: [[t('15:00'), 105], [t('15:15'), 108], [t('15:30'), 111]] }),
  };
  const events = checkProtections(f, quotes);
  assert.deepEqual(events.map((e) => `${e.symbol}@${e.price}:${e.why}`), ['A@94.9:stop-loss at -5%', 'B@111:take-profit at +10%']);
  assert.deepEqual(f.portfolio.positions, {});
  assert.equal(checkProtections(f, quotes).length, 0); // already seen
});

test('a short 40% under water is covered even without a stop-loss, keeping losses within the budget', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'short', shares: 20, reason: '' }], { A: q(100) }, at('14:45'));
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  const events = checkProtections(f, { A: q(141, { intraday: [[t('15:00'), 120], [t('15:15'), 140], [t('15:30'), 141]] }) });
  assert.equal(events.length, 1);
  assert.match(events[0].why, /forced cover/);
  assert.equal(events[0].price, 140);
  const a = summarize(f.portfolio, {}).accounts.USD;
  assert.equal(a.equity, 200); // lost 800 of the 1000, never more than the budget
  assert.ok(a.cash >= 0);
});

test('stopping closes everything; recordValue tracks the fund value', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 5, reason: '' }], { A: q(100) }, at('14:45'));
  assert.equal(recordValue(f, { A: q(110) }, at('15:00')), 1050);
  stopFund(f, { A: q(120) }, at('16:00'));
  assert.ok(f.stoppedAt);
  assert.equal(f.portfolio.accounts.USD.cash, 1100);
  assert.equal(f.decisions.at(-1).orders[0].status, 'filled');
});
