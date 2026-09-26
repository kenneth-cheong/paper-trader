import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newFund, applySettings, executeDecision, approveProposals, rejectProposals, expireProposals, applyBrokerFills,
  pauseFund, resumeFund, checkDailyLoss, checkProtections, setProtections, stopFund, tigerSymbol, limitPrice, decisionDue,
} from '../fund.js';
import { summarize } from '../portfolio.js';

// Wed 7 Jan 2026; the US market trades 14:30-21:00 UTC.
const at = (hhmm) => new Date(`2026-01-07T${hhmm}:00Z`);
const q = (price, extra = {}) => ({ currency: 'USD', market: 'US', price, daily: [], intraday: [], time: at('15:40').toISOString(), ...extra });
const live = { updatedAt: at('15:45').toISOString(), quotes: { A: q(100) } };
const tiger = (settings = {}) => newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger', ...settings }, now: at('14:00') });
const buy = (symbol, shares) => ({ symbol, action: 'buy', shares, reason: 'r' });

test('Tiger symbols and limit prices follow each exchange', () => {
  assert.equal(tigerSymbol('D05.SI'), 'D05');
  assert.equal(tigerSymbol('C38U.SI'), 'C38U');
  assert.equal(tigerSymbol('BRK-B'), 'BRK.B');
  assert.equal(tigerSymbol('AAPL'), 'AAPL');
  assert.equal(limitPrice('buy', 100, 'US'), 101); // at most 1% above
  assert.equal(limitPrice('sell', 100, 'US'), 99);
  assert.equal(limitPrice('buy', 38.47, 'SGX'), 38.85); // 38.8547 rounded down to the 0.01 grid
  assert.equal(limitPrice('buy', 0.52, 'SGX'), 0.525); // 0.005 steps below 1.00
  assert.equal(limitPrice('sell', 0.155, 'SGX'), 0.154); // 0.001 steps below 0.20, rounded up for sells
});

test('settings: approval and limits can change, the broker only at the start', () => {
  const f = tiger();
  assert.deepEqual(f.settings, { broker: 'tiger', approval: 'manual', maxOrderPct: 25, dailyLossPct: 5 });
  applySettings(f, { approval: 'auto', maxOrderPct: 10, dailyLossPct: 3 });
  assert.equal(f.settings.approval, 'auto');
  assert.throws(() => applySettings(f, { broker: 'simulator' }), /only be chosen when starting/);
  assert.throws(() => applySettings(f, { maxOrderPct: 0 }), /between 1% and 100%/);
  assert.throws(() => applySettings(f, { dailyLossPct: 80 }), /between 0.5% and 50%/);
});

test('with approval on, the AI\'s trades wait as proposals and nothing is sent', () => {
  const f = tiger();
  const res = executeDecision(f, [buy('A', 10)], { A: q(100) }, at('15:50'));
  assert.equal(res[0].status, 'awaiting approval');
  assert.equal(f.proposals.length, 1);
  assert.equal(f.proposals[0].limitPrice, 101);
  assert.equal(f.brokerOrders.length, 0);
  assert.equal(summarize(f.portfolio, {}).accounts.USD.cash, 10000); // nothing spent yet
});

test('approving sends a limit order to Tiger; rejecting and expiry do not', () => {
  const f = tiger();
  executeDecision(f, [buy('A', 10), buy('A', 5), buy('A', 3)], { A: q(100) }, at('15:50'));
  const [p1, p2, p3] = f.proposals;
  rejectProposals(f, [p2.id], at('15:55'));
  const out = approveProposals(f, [p1.id], { A: q(100.5) }, live, at('15:55'));
  assert.equal(out[0].status, 'approved');
  assert.equal(f.brokerOrders.length, 1);
  const o = f.brokerOrders[0];
  assert.deepEqual([o.tigerSymbol, o.side, o.qty, o.limitPrice, o.status], ['A', 'buy', 10, 101.5, 'queued']);
  assert.equal(p2.status, 'rejected');
  expireProposals(f, at('16:51'));
  assert.equal(p3.status, 'expired');
});

test('an approval is refused if the price moved over 2% or the market is not trading', () => {
  const f = tiger();
  executeDecision(f, [buy('A', 10), buy('A', 5)], { A: q(100) }, at('15:50'));
  const [p1, p2] = f.proposals;
  approveProposals(f, [p1.id], { A: q(103) }, live, at('15:55'));
  assert.equal(p1.status, 'expired');
  assert.match(p1.message, /moved more than 2%/);
  const holiday = { updatedAt: at('15:55').toISOString(), quotes: { A: q(100, { time: '2026-01-06T21:00:00Z' }) } };
  approveProposals(f, [p2.id], { A: q(100) }, holiday, at('16:00')); // no prices today
  assert.equal(p2.status, 'failed');
  assert.match(p2.message, /isn't trading/);
  assert.equal(f.brokerOrders.length, 0);
});

test('automatic mode queues orders straight away, and open orders count against the budget', () => {
  const f = tiger({ approval: 'auto', maxOrderPct: 100 });
  const res = executeDecision(f, [buy('A', 60), buy('A', 40)], { A: q(100) }, at('15:50'));
  // 60 x 101 (limit) = 6060 committed, leaving 3940: 40 x 101 = 4040 doesn't fit
  assert.deepEqual(res.map((r) => r.status), ['sent to Tiger', 'rejected']);
  assert.match(res[1].message, /Not enough USD cash/);
  assert.equal(f.brokerOrders.length, 1);
});

test('each order is capped at a share of the budget', () => {
  const f = tiger({ approval: 'auto' }); // 25% of 10000 = 2500
  const res = executeDecision(f, [buy('A', 30)], { A: q(100) }, at('15:50'));
  assert.equal(res[0].status, 'rejected');
  assert.match(res[0].message, /per-order limit of 25%/);
});

test('Tiger fills are recorded at Tiger\'s prices, including partial fills', () => {
  const f = tiger({ approval: 'auto' });
  executeDecision(f, [buy('A', 20)], { A: q(100) }, at('15:50'));
  const o = f.brokerOrders[0];
  Object.assign(o, { status: 'partial', filledQty: 5, avgFillPrice: 100.2 });
  assert.equal(applyBrokerFills(f, at('16:00')).length, 1);
  assert.equal(f.portfolio.positions.A.qty, 5);
  Object.assign(o, { status: 'filled', filledQty: 20, avgFillPrice: 100.3 });
  applyBrokerFills(f, at('16:15'));
  assert.equal(f.portfolio.positions.A.qty, 20);
  assert.equal(applyBrokerFills(f, at('16:30')).length, 0); // nothing new
});

test('pausing blocks new trades, cancels open orders, and resuming lifts it', () => {
  const f = tiger({ approval: 'auto' });
  executeDecision(f, [buy('A', 10)], { A: q(100) }, at('15:50'));
  pauseFund(f, 'Paused by owner', at('15:55'));
  assert.equal(f.brokerOrders[0].cancelRequested, true);
  assert.equal(decisionDue(f, at('16:00'), live), false);
  const res = executeDecision(f, [buy('A', 1)], { A: q(100) }, at('16:00'));
  assert.match(res[0].message, /paused/);
  resumeFund(f);
  assert.equal(f.paused, null);
});

test('the daily loss limit pauses the fund', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100, dailyLossPct: 5 }, now: at('14:00') });
  executeDecision(f, [buy('A', 50)], { A: q(100) }, at('14:45'));
  assert.equal(checkDailyLoss(f, { A: q(100) }, at('15:00')), false); // sets today's starting value
  assert.equal(checkDailyLoss(f, { A: q(91) }, at('16:00')), false); // -4.5%
  assert.equal(checkDailyLoss(f, { A: q(89) }, at('17:00')), true); // -5.5%
  assert.match(f.paused.reason, /Lost more than 5% today/);
});

test('with Tiger, a stop-loss sends a closing order without waiting for approval', () => {
  const f = tiger({ approval: 'manual' });
  f.portfolio.positions.A = { qty: 10, avgCost: 100, currency: 'USD' };
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 5, take_profit_pct: 0 }]);
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  const quotes = { A: q(94, { intraday: [[t('15:00'), 97], [t('15:15'), 94.5], [t('15:30'), 94]] }) };
  checkProtections(f, quotes, at('15:35'));
  assert.equal(f.brokerOrders.length, 1);
  const o = f.brokerOrders[0];
  assert.deepEqual([o.source, o.side, o.qty, o.limitPrice], ['protection', 'sell', 10, 93.56]);
  assert.equal(f.portfolio.positions.A.qty, 10); // closes when Tiger fills it
  checkProtections(f, { A: q(93, { intraday: [[t('15:45'), 93]] }) }, at('15:50'));
  assert.equal(f.brokerOrders.length, 1); // no duplicate while one is open
});

test('stopping a Tiger fund sends closing orders and cancels the rest', () => {
  const f = tiger({ approval: 'auto', maxOrderPct: 100 });
  f.portfolio.positions.A = { qty: 10, avgCost: 100, currency: 'USD' };
  executeDecision(f, [buy('B', 5)], { B: q(50) }, at('15:50'));
  stopFund(f, { A: q(110), B: q(50) }, at('16:00'));
  assert.ok(f.stoppedAt);
  assert.equal(f.brokerOrders.find((o) => o.symbol === 'B').cancelRequested, true);
  const close = f.brokerOrders.find((o) => o.source === 'stop');
  assert.deepEqual([close.symbol, close.side, close.qty], ['A', 'sell', 10]);
});
