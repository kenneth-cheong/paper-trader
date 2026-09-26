import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAlerts, dailySummary, formatMessage } from '../alerts.js';
import { newFund, executeDecision, pauseFund } from '../fund.js';

const at = (iso) => new Date(iso);
const q = (price, time = '2026-01-07T20:59:00Z') => ({ currency: 'USD', market: 'US', price, time, daily: [], intraday: [] });

test('the first run only remembers what is there; later runs send each new thing once', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('2026-01-07T14:00:00Z') });
  executeDecision(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'r' }], { A: q(100) }, at('2026-01-07T15:00:00Z'));
  f.decisions.push({ time: '2026-01-07T15:00:00Z', outlook: 'Bullish.', orders: [{ symbol: 'A', action: 'buy', shares: 10, price: 100, status: 'filled' }] });
  assert.deepEqual(collectAlerts(f), []); // seeded
  assert.deepEqual(collectAlerts(f), []);
  pauseFund(f, 'Lost more than 5% today.', at('2026-01-07T16:00:00Z'));
  f.events.push({ time: '2026-01-07T16:05:00Z', symbol: 'A', action: 'sell', shares: 10, price: 94, why: 'stop-loss at -5%' });
  const texts = collectAlerts(f);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /🔻 SELL 10 A at 94.00 USD \(stop-loss at -5%\)/);
  assert.match(texts[1], /Trading paused/);
  assert.deepEqual(collectAlerts(f), []);
});

test('approvals, Tiger refusals, stop orders and disagreements with Tiger are announced', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger' }, now: at('2026-01-07T14:00:00Z') });
  collectAlerts(f);
  executeDecision(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'Strong earnings' }], { A: q(100) }, at('2026-01-07T15:00:00Z'));
  f.brokerOrders.push({ id: 'g1', source: 'guard', side: 'sell', action: 'sell', qty: 5, symbol: 'B', stopPrice: 47.5, status: 'sent' });
  f.brokerOrders.push({ id: 'b2', source: 'decision', side: 'buy', action: 'buy', qty: 5, symbol: 'C', status: 'rejected', error: 'Not enough buying power' });
  f.portfolio.positions.B = { qty: 5, avgCost: 50, currency: 'USD' };
  f.broker = { time: 'x', positions: [], error: null };
  const texts = collectAlerts(f);
  assert.match(texts.join('\n'), /Waiting for your approval<\/b> until 00:00 SGT: BUY 10 A \(limit 101.00\). Strong earnings/);
  assert.match(texts.join('\n'), /Stop-loss placed at Tiger: sell 5 B if it falls to 47.50/);
  assert.match(texts.join('\n'), /Tiger didn't take<\/b> buy 5 C: Not enough buying power/);
  assert.match(texts.join('\n'), /disagree<\/b>: B fund 5, Tiger 0/);
  assert.match(formatMessage(texts, 'https://x.github.io/p/'), /<a href="https:\/\/x.github.io\/p\/#fund">Open the AI fund<\/a>$/);
});

test('a daily summary after the close of a trading day, once', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: at('2026-01-07T14:00:00Z') });
  f.day = { date: '2026-01-07', startValue: 9900 };
  const prices = { quotes: { A: q(100), SPY: { ...q(500), daily: [[Date.parse('2026-01-06T14:30:00Z') / 1000, 490]] } } };
  assert.equal(dailySummary(f, prices, at('2026-01-07T20:00:00Z')), null); // still open
  const s = dailySummary(f, prices, at('2026-01-07T21:15:00Z'));
  assert.equal(s.key, 'sum:2026-01-07');
  assert.match(s.text, /US close, 2026-01-07/);
  assert.match(s.text, /Value 10,000.00 USD \(today \+100.00\)/);
  assert.match(s.text, /Same money in SPY/);
  assert.equal(dailySummary(f, prices, at('2026-01-08T13:00:00Z')), null); // next morning: no session that day yet
  collectAlerts(f, { prices, now: at('2026-01-07T20:00:00Z') });
  assert.equal(collectAlerts(f, { prices, now: at('2026-01-07T21:15:00Z') }).length, 1);
  assert.equal(collectAlerts(f, { prices, now: at('2026-01-07T21:30:00Z') }).length, 0);
});
