import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcFee, planFor, FEE_PLANS, describeFees } from '../fees.js';
import { newPortfolio, applyTrade, summarize } from '../portfolio.js';
import { backtest } from '../rules.js';
import { newFund, applyOrders } from '../fund.js';

test('Tiger Brokers: US per-share fees with minimums and the 0.5% cap, plus GST and sale-only regulatory fees', () => {
  const t = FEE_PLANS.tiger;
  assert.deepEqual(calcFee(t, 'US', 'buy', 10, 100), { total: 2.17, parts: [
    { label: 'Commission', amount: 0.99 }, { label: 'Platform fee', amount: 1 }, { label: 'GST 9%', amount: 0.18 },
  ] });
  assert.equal(calcFee(t, 'US', 'sell', 10, 100).total, 2.2); // + SEC fee and FINRA TAF
  assert.equal(calcFee(t, 'US', 'buy', 1000, 5).total, 10.9); // per-share would be 5 + 5; capped at 0.5% each
  assert.equal(calcFee(t, 'US', 'buy', 2000, 300).total, 21.8); // 10 + 10 + GST
});

test('Tiger Brokers and Standard Chartered on SGX, including SGX clearing and trading fees', () => {
  assert.equal(calcFee(FEE_PLANS.tiger, 'SGX', 'buy', 1000, 38).total, 41.42);
  assert.equal(calcFee(FEE_PLANS.tiger, 'SGX', 'buy', 100, 1).total, 2.21); // both minimums + SGX fees (3¢ + 1¢) + GST
  assert.equal(calcFee(FEE_PLANS.scb, 'SGX', 'buy', 1000, 38).total, 99.41);
  assert.equal(calcFee(FEE_PLANS.scb, 'SGX', 'buy', 100, 10).total, 11.35); // S$10 minimum
  assert.equal(calcFee(FEE_PLANS.none, 'SGX', 'buy', 1000, 38).total, 0);
});

test('a custom plan is a percentage with a minimum', () => {
  const plan = planFor('custom', { pct: { US: 0.1, SGX: 0.2 }, min: { US: 5, SGX: 10 } });
  assert.equal(calcFee(plan, 'US', 'buy', 10, 100).total, 5);
  assert.equal(calcFee(plan, 'SGX', 'buy', 1000, 38).total, 76);
});

test('fees are part of the cost, the proceeds and the profit', () => {
  let p = newPortfolio({ USD: 10000 }); // Tiger fees by default
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 10, price: 100, currency: 'USD', market: 'US' });
  assert.equal(p.accounts.USD.cash, 10000 - 1000 - 2.17);
  assert.equal(p.positions.A.avgCost, 100.217); // cost per share includes the fee
  assert.equal(p.trades[0].fee, 2.17);
  p = applyTrade(p, { symbol: 'A', side: 'sell', qty: 10, price: 100, currency: 'USD', market: 'US' });
  // Buying and selling at the same price loses exactly the fees
  assert.equal(p.accounts.USD.realized, -4.37);
  assert.equal(p.accounts.USD.fees, 4.37);
  assert.equal(p.accounts.USD.cash, 10000 - 4.37);
  assert.equal(Math.round(summarize(p).accounts.USD.net * 100) / 100, -4.37);
});

test("fees count against buying power, and a short's fees lower its entry price", () => {
  let p = newPortfolio({ USD: 1000 });
  assert.throws(() => applyTrade(p, { symbol: 'A', side: 'buy', qty: 10, price: 100, currency: 'USD', market: 'US' }), /including 2.17 in fees/);
  p = applyTrade(p, { symbol: 'A', side: 'sell', qty: 5, price: 100, currency: 'USD', market: 'US' });
  assert.ok(p.positions.A.avgCost < 100);
  p = applyTrade(p, { symbol: 'A', side: 'buy', qty: 5, price: 100, currency: 'USD', market: 'US' });
  assert.ok(p.accounts.USD.realized < 0); // covering at the same price loses the fees
});

test('backtests and the simulated AI fund pay fees too', () => {
  const T0 = 1_760_000_000;
  const daily = Array.from({ length: 30 }, (_, i) => [T0 + i * 86400, 100]);
  const rule = { id: 'r', symbol: 'X', when: { type: 'every', value: 7 }, action: { side: 'buy', unit: 'cash', amount: 500 }, repeat: 'repeat', enabled: true, state: {} };
  const bt = backtest([rule], { currency: 'USD', market: 'US', daily }, { startCash: 10000 });
  assert.ok(bt.fees > 0);
  assert.ok(bt.returnPct < 0); // flat prices: only the fees
  const free = backtest([rule], { currency: 'USD', market: 'US', daily }, { startCash: 10000, feePlan: 'none' });
  assert.equal(free.returnPct, 0);

  const f = newFund({ budget: 1000, currency: 'USD', settings: { maxOrderPct: 100, feePlan: 'scb' } });
  const [r] = applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 5, reason: '' }], { A: { currency: 'USD', market: 'US', price: 100 } });
  assert.equal(r.fee, 10.9); // SC: US$10 minimum + GST
  assert.equal(f.portfolio.accounts.USD.cash, 1000 - 500 - 10.9);
});

test('the AI is told what a round trip costs', () => {
  assert.match(describeFees(newPortfolio(), 'US', 2500), /Tiger Brokers.*round trip.*costs about 4\.42/);
});
