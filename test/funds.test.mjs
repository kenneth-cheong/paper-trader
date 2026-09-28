import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunds, addFund, updateFund, removeFund, targetFund, otherTigerHoldings, reconcileAll, STYLES, MAX_ACTIVE_FUNDS } from '../funds.js';
import { newFund, executeDecision, stopFund } from '../fund.js';
import { fundContext } from '../ai.js';

const now = new Date('2026-01-07T15:00:00Z');
const q = (price) => ({ currency: 'USD', market: 'US', price, time: '2026-01-07T14:55:00Z', daily: [], intraday: [] });
const buy = (symbol, shares, action = 'buy') => ({ symbol, action, shares, reason: 'r' });

test('a file with one fund from before becomes the first fund of a collection', () => {
  const old = { ...newFund({ budget: 1000, currency: 'USD', now }), previousFunds: [{ startedAt: 'a', budget: 500 }] };
  const c = loadFunds(old);
  assert.equal(c.version, 2);
  assert.deepEqual([c.funds[0].id, c.funds[0].name, c.funds[0].style, c.funds[0].budget], ['f1', 'AI fund', 'balanced', 1000]);
  assert.equal(c.archived[0].budget, 500);
  assert.equal(loadFunds(c), c);
  assert.deepEqual(loadFunds(null).funds, []);
});

test('funds start side by side with their style\'s limits, up to the maximum', () => {
  const c = loadFunds(null);
  const a = addFund(c, { name: 'Steady', style: 'cautious', budget: 1000, currency: 'USD', now });
  assert.deepEqual([a.settings.maxOrderPct, a.settings.dailyLossPct, a.settings.allowShorts], [10, 3, false]);
  const b = addFund(c, { style: 'aggressive', budget: 1000, currency: 'SGD', settings: { maxOrderPct: 30, model: 'claude-opus-5' }, now });
  assert.deepEqual([b.settings.maxOrderPct, b.settings.allowShorts, b.settings.model], [30, true, 'claude-opus-5']);
  assert.match(b.name, /Aggressive SGD fund/);
  for (let i = 2; i < MAX_ACTIVE_FUNDS; i++) addFund(c, { budget: 100, currency: 'USD', now });
  assert.throws(() => addFund(c, { budget: 100, currency: 'USD', now }), new RegExp(`Up to ${MAX_ACTIVE_FUNDS} funds`));
  assert.throws(() => targetFund(c), /choose one/);
  assert.equal(targetFund(c, a.id), a);
  assert.throws(() => addFund(loadFunds(null), { style: 'yolo', budget: 1, currency: 'USD' }), /Unknown style/);
});

test('a fund can be renamed, restyled and refocused; only a stopped fund can be removed', () => {
  const c = loadFunds(null);
  const a = addFund(c, { budget: 1000, currency: 'USD', now });
  updateFund(a, { name: 'Banks', style: 'cautious', focus: 'Only banks', settings: { allowShorts: false } });
  assert.deepEqual([a.name, a.style, a.focus, a.settings.allowShorts], ['Banks', 'cautious', 'Only banks', false]);
  assert.throws(() => removeFund(c, a.id), /Stop the fund/);
  stopFund(a, {}, now);
  removeFund(c, a.id, now);
  assert.equal(c.funds.length, 0);
  assert.equal(c.archived[0].name, 'Banks');
});

test('a fund without shorts can\'t short; Tiger funds can\'t take opposite sides of one stock', () => {
  const c = loadFunds(null);
  const calm = addFund(c, { style: 'cautious', budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now });
  assert.match(executeDecision(calm, [buy('A', 1, 'short')], { A: q(100) }, now)[0].message, /doesn't allow short selling/);
  const x = addFund(c, { style: 'aggressive', budget: 10000, currency: 'USD', settings: { broker: 'tiger', approval: 'auto', maxOrderPct: 100 }, now });
  const y = addFund(c, { style: 'aggressive', budget: 10000, currency: 'USD', settings: { broker: 'tiger', approval: 'auto', maxOrderPct: 100 }, now });
  executeDecision(x, [buy('A', 10)], { A: q(100) }, now, { others: otherTigerHoldings(c, x.id) });
  assert.deepEqual(otherTigerHoldings(c, y.id), { A: 10 }); // x's open buy
  const [r] = executeDecision(y, [buy('A', 5, 'short')], { A: q(100) }, now, { others: otherTigerHoldings(c, y.id) });
  assert.match(r.message, /one account can't be long and short the same stock/);
  const [ok] = executeDecision(y, [buy('A', 5)], { A: q(100) }, now, { others: otherTigerHoldings(c, y.id) });
  assert.equal(ok.status, 'sent to Tiger'); // the same side is fine
  assert.deepEqual(otherTigerHoldings(c, calm.id), { A: 15 }); // the simulator fund isn't affected
});

test('Tiger is checked against all Tiger funds together', () => {
  const c = loadFunds(null);
  const a = addFund(c, { budget: 1000, currency: 'USD', settings: { broker: 'tiger' }, now });
  const b = addFund(c, { budget: 1000, currency: 'USD', settings: { broker: 'tiger' }, now });
  a.portfolio.positions.X = { qty: 10, avgCost: 1, currency: 'USD' };
  b.portfolio.positions.X = { qty: 10, avgCost: 1, currency: 'USD' };
  a.broker = b.broker = { time: 't', positions: [{ symbol: 'X', qty: 20 }, { symbol: 'Y', qty: 3 }], error: null };
  assert.equal(reconcileAll(c).ok, true);
  a.broker = b.broker = { time: 't2', positions: [{ symbol: 'X', qty: 15 }], error: null };
  assert.deepEqual(reconcileAll(c).mismatches, [{ symbol: 'X', fund: 20, tiger: 15 }]);
});

test('the AI is given the fund\'s mandate', () => {
  const c = loadFunds(null);
  const f = addFund(c, { name: 'Banks', style: 'cautious', focus: 'Singapore banks only', budget: 1000, currency: 'SGD', now });
  const ctx = fundContext({ fund: f, quotes: {}, picks: null, news: null, now });
  assert.deepEqual(ctx.mandate, { name: 'Banks', style: 'Cautious', style_brief: STYLES.cautious.brief, owner_focus: 'Singapore banks only', short_selling_allowed: false });
});

test('how often a fund decides can be set at the start and changed while it runs: 1, 2, 4, 8, 16 or every run', () => {
  const c = loadFunds(null);
  const f = addFund(c, { budget: 1000, currency: 'SGD', decisionsPerDay: 0 });
  assert.equal(f.decisionsPerDay, 0);
  updateFund(f, { decisionsPerDay: '16' });
  assert.equal(f.decisionsPerDay, 16);
  updateFund(f, { name: 'Renamed' }); // a save without it leaves it alone
  assert.equal(f.decisionsPerDay, 16);
  assert.throws(() => updateFund(f, { decisionsPerDay: 5 }), /Decisions per day/);
  assert.equal(f.decisionsPerDay, 16);
});

test('every model the app offers for a fund is accepted by its settings, and nothing else', async () => {
  const { FUND_MODELS } = await import('../ai.js');
  const { applySettings } = await import('../fund.js');
  const f = newFund({ budget: 1000, currency: 'USD' });
  for (const model of Object.keys(FUND_MODELS)) {
    applySettings(f, { model });
    assert.equal(f.settings.model, model);
  }
  applySettings(f, { model: '' });
  assert.equal(f.settings.model, null); // the default
  assert.throws(() => applySettings(f, { model: 'gpt-4o' }), /Unknown model gpt-4o/);
  // a refused save changes nothing, not even the fields before the bad one
  const c = loadFunds(null);
  const g = addFund(c, { name: 'Before', budget: 1000, currency: 'USD', decisionsPerDay: 1 });
  assert.throws(() => updateFund(g, { name: 'After', decisionsPerDay: 4, settings: { model: 'gpt-4o' } }), /Unknown model/);
  assert.deepEqual([g.name, g.decisionsPerDay, g.settings.model ?? null], ['Before', 1, null]);
});
