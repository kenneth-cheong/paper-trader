import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPortfolio, applyTrade } from '../portfolio.js';
import { newRule, runRules, backtest, checkRule, describeRule } from '../rules.js';

const T0 = 1_760_000_000; // rule creation time (unix seconds)
const quoteFrom = (prices, { step = 900, currency = 'USD', daily = [] } = {}) => ({
  currency, price: prices.at(-1), time: null, daily,
  intraday: prices.map((p, i) => [T0 + (i + 1) * step, p]),
});
const rule = (fields) => newRule({ symbol: 'X', repeat: 'once', ...fields }, T0 * 1000);
const withRules = (p, ...rules) => ({ ...p, rules });

test('limit buy fires once at the first price at or below the level', () => {
  const p = withRules(newPortfolio({ USD: 1000 }), rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 2 } }));
  const { portfolio, log } = runRules(p, { X: quoteFrom([100, 95, 89, 85, 80]) });
  assert.equal(log.length, 1);
  assert.equal(log[0].trade.price, 89);
  assert.equal(portfolio.positions.X.qty, 2);
  assert.equal(portfolio.rules[0].enabled, false, 'once-rules switch off');
  assert.equal(portfolio.trades[0].rule, portfolio.rules[0].id);
});

test('points at or before the rule was created are ignored, and each point is seen only once', () => {
  const r = rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 1 }, repeat: 'repeat' });
  const q = quoteFrom([80]);
  q.intraday.unshift([T0 - 900, 50]); // before creation
  let { portfolio, log } = runRules(withRules(newPortfolio({ USD: 1000 }), r), { X: q });
  assert.equal(log.length, 1);
  ({ log } = runRules(portfolio, { X: q })); // same data again: nothing new
  assert.equal(log.length, 0);
});

test('repeating rules re-arm only after the condition has been false', () => {
  const p = withRules(newPortfolio({ USD: 10000 }), rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 1 }, repeat: 'repeat' }));
  const { log } = runRules(p, { X: quoteFrom([85, 84, 83, 95, 88, 87]) });
  assert.deepEqual(log.map((l) => l.trade.price), [85, 88]);
});

test('stop-loss sells everything once the price falls far enough below cost', () => {
  let p = applyTrade(newPortfolio({ USD: 1000 }), { symbol: 'X', side: 'buy', qty: 10, price: 50, currency: 'USD' });
  p = withRules(p, rule({ when: { type: 'loss_from_cost', value: 10 }, action: { side: 'sell', unit: 'all', amount: 0 } }));
  const { portfolio, log } = runRules(p, { X: quoteFrom([48, 46, 44.9, 40]) });
  assert.equal(log.length, 1);
  assert.equal(log[0].trade.price, 44.9);
  assert.equal(portfolio.positions.X, undefined);
  assert.equal(portfolio.accounts.USD.realized, -51);
});

test('trailing stop measures from the high reached while holding', () => {
  let p = applyTrade(newPortfolio({ USD: 1000 }), { symbol: 'X', side: 'buy', qty: 10, price: 50, currency: 'USD' });
  p = withRules(p, rule({ when: { type: 'drop_from_high', value: 10 }, action: { side: 'sell', unit: 'all', amount: 0 } }));
  const { log } = runRules(p, { X: quoteFrom([50, 60, 70, 65, 63.5, 63]) });
  assert.equal(log[0].trade.price, 63); // 10% below the 70 high
});

test('a sell rule with nothing held does nothing and stays armed', () => {
  const p = withRules(newPortfolio({ USD: 1000 }), rule({ when: { type: 'price_above', value: 10 }, action: { side: 'sell', unit: 'all', amount: 0 } }));
  const { portfolio, log } = runRules(p, { X: quoteFrom([20, 21]) });
  assert.equal(log.length, 0);
  assert.equal(portfolio.rules[0].enabled, true);
  assert.equal(portfolio.rules[0].state.armed, true);
});

test('a buy that cannot be afforded is logged once, not on every bar', () => {
  const p = withRules(newPortfolio({ USD: 100 }), rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 5 }, repeat: 'repeat' }));
  const { portfolio, log } = runRules(p, { X: quoteFrom([80, 79, 78]) });
  assert.equal(log.length, 1);
  assert.match(log[0].error, /Not enough USD cash/);
  assert.match(portfolio.rules[0].state.lastError, /Not enough/);
  assert.equal(portfolio.trades.length, 0);
});

test('cash-sized buys round down to whole shares', () => {
  const p = withRules(newPortfolio({ USD: 1000 }), rule({ when: { type: 'price_above', value: 1 }, action: { side: 'buy', unit: 'cash', amount: 250 } }));
  const { portfolio } = runRules(p, { X: quoteFrom([30]) });
  assert.equal(portfolio.positions.X.qty, 8);
});

test('scheduled buys fire every N days', () => {
  const p = withRules(newPortfolio({ USD: 10000 }), rule({ when: { type: 'every', value: 7 }, action: { side: 'buy', unit: 'cash', amount: 100 }, repeat: 'repeat' }));
  const prices = Array.from({ length: 30 }, () => 10); // one point per day for 30 days
  const { log } = runRules(p, { X: quoteFrom(prices, { step: 86400 }) });
  assert.equal(log.length, 5); // days 1, 8, 15, 22, 29
});

test('moving-average rule uses only earlier daily closes', () => {
  const daily = Array.from({ length: 5 }, (_, i) => [T0 - (5 - i) * 86400, 10]); // five closes of 10 before T0
  const p = withRules(newPortfolio({ USD: 1000 }), rule({ when: { type: 'above_ma', value: 5 }, action: { side: 'buy', unit: 'shares', amount: 1 } }));
  const { log } = runRules(p, { X: quoteFrom([9.5, 10, 10.5], { daily }) });
  assert.equal(log[0].trade.price, 10.5);
});

test('rules on different stocks run in time order and share cash', () => {
  const a = newRule({ symbol: 'A', when: { type: 'price_below', value: 100 }, action: { side: 'buy', unit: 'pct_cash', amount: 100 } }, T0 * 1000);
  const b = newRule({ symbol: 'B', when: { type: 'price_below', value: 100 }, action: { side: 'buy', unit: 'pct_cash', amount: 100 } }, T0 * 1000);
  const quotes = {
    A: { currency: 'USD', daily: [], intraday: [[T0 + 2000, 50]] },
    B: { currency: 'USD', daily: [], intraday: [[T0 + 1000, 50]] },
  };
  const { portfolio, log } = runRules(withRules(newPortfolio({ USD: 1000 }), a, b), quotes);
  assert.equal(portfolio.positions.B.qty, 20); // B came first and used the cash
  assert.match(log.find((l) => l.ruleId === a.id).error, /less than one share/);
});

test('the latest quote counts as a price point after the bars', () => {
  const q = quoteFrom([100]);
  q.time = new Date((T0 + 5000) * 1000).toISOString();
  q.price = 80;
  const p = withRules(newPortfolio({ USD: 1000 }), rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 1 } }));
  assert.equal(runRules(p, { X: q }).log[0].trade.price, 80);
});

test('checkRule catches bad input', () => {
  const ok = rule({ when: { type: 'price_below', value: 90 }, action: { side: 'buy', unit: 'shares', amount: 2 } });
  assert.deepEqual(checkRule(ok, ['X']), []);
  assert.ok(checkRule({ ...ok, symbol: 'Y' }, ['X']).length);
  assert.ok(checkRule({ ...ok, when: { type: 'price_below', value: -1 } }, ['X']).length);
  assert.ok(checkRule({ ...ok, action: { side: 'buy', unit: 'all', amount: 0 } }, ['X']).length);
  assert.ok(checkRule({ ...ok, action: { side: 'sell', unit: 'pct_holding', amount: 150 } }, ['X']).length);
  assert.ok(checkRule({ ...ok, when: { type: 'above_ma', value: 2.5 } }, ['X']).length);
});

test('describeRule reads as a sentence', () => {
  const r = rule({ when: { type: 'loss_from_cost', value: 8 }, action: { side: 'sell', unit: 'all', amount: 0 } });
  assert.equal(describeRule(r, { name: 'Ex' }), 'When X (Ex) is down from my average cost by 8%, sell all my shares, once.');
});

test('backtest compares a strategy with buy and hold', () => {
  const daily = [];
  for (let i = 0; i < 60; i++) daily.push([T0 + i * 86400, i < 30 ? 100 + i : 130 - (i - 30) * 2]); // up to 129 then down to 72
  const stop = rule({ when: { type: 'drop_from_high', value: 10 }, action: { side: 'sell', unit: 'all', amount: 0 } });
  const r = backtest([stop], { currency: 'USD', daily }, { startCash: 10000 });
  assert.equal(r.startInvested, true);
  assert.equal(r.trades, 1);
  assert.ok(r.returnPct > r.buyHoldPct, 'the stop avoided most of the fall');
  assert.ok(Math.abs(r.buyHoldPct - (72 / 100 - 1)) < 1e-9);
  assert.ok(r.maxDrawdown > 0.09 && r.maxDrawdown < 0.2);
});

test('backtest refuses to run on too little history', () => {
  const r = backtest([rule({ when: { type: 'price_below', value: 1 }, action: { side: 'buy', unit: 'shares', amount: 1 } })], { currency: 'USD', daily: [[T0, 1]] });
  assert.match(r.error, /Not enough/);
});

test('an order placed while the market is closed fills at the first price after the open', async () => {
  const { placeOrder, cancelOrder } = await import('../portfolio.js');
  const { fillPendingOrders } = await import('../rules.js');
  const placedAt = new Date(T0 * 1000).toISOString();
  let p = placeOrder(newPortfolio({ USD: 1000 }), { symbol: 'X', side: 'buy', qty: 5, currency: 'USD', time: placedAt });
  p = placeOrder(p, { symbol: 'X', side: 'buy', qty: 1000, currency: 'USD', time: placedAt }); // too big
  p = placeOrder(p, { symbol: 'Y', side: 'buy', qty: 1, currency: 'USD', time: placedAt }); // no price yet
  const q = { currency: 'USD', intraday: [[T0 - 900, 90], [T0 + 900, 100], [T0 + 1800, 110]], time: null };
  const { portfolio, log } = fillPendingOrders(p, { X: q, Y: { currency: 'USD', intraday: [[T0 - 60, 5]] } });
  assert.equal(log.length, 2);
  assert.equal(log[0].trade.price, 100); // the first price after it was placed, not the one before
  assert.equal(log[0].trade.time, new Date((T0 + 900) * 1000).toISOString());
  assert.match(log[1].error, /Not enough USD cash/);
  assert.deepEqual(portfolio.pendingOrders.map((o) => o.symbol), ['Y']); // still waiting
  assert.equal(portfolio.positions.X.qty, 5);
  assert.deepEqual(cancelOrder(portfolio, portfolio.pendingOrders[0].id).pendingOrders, []);
  assert.throws(() => placeOrder(p, { symbol: 'X', side: 'buy', qty: 0, currency: 'USD' }), /whole number/);
});
