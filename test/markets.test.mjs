import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradingStatus, isOpen, sessionDateFor, sessionDateAfter } from '../markets.js';

// Wednesday 7 January 2026. SGX trades 01:00-04:00 and 05:00-09:00 UTC; US 14:30-21:00 UTC (winter).
const at = (hhmm, day = '07') => new Date(`2026-01-${day}T${hhmm}:00Z`);
const prices = (market, quoteAt, updatedAt = quoteAt) => ({
  updatedAt: updatedAt.toISOString(),
  quotes: { A: { market, time: quoteAt.toISOString() }, B: { market: market === 'US' ? 'SGX' : 'US', time: '2025-01-01T00:00:00Z' } },
});

test('the clock handles lunch breaks, weekends and New York daylight saving', () => {
  assert.equal(isOpen('SGX', at('03:59')), true);
  assert.equal(isOpen('SGX', at('04:30')), false); // lunch
  assert.equal(isOpen('SGX', at('03:00', '10')), false); // Saturday
  assert.equal(isOpen('US', at('14:29')), false);
  assert.equal(isOpen('US', at('14:30')), true);
  assert.equal(isOpen('US', new Date('2026-07-07T13:30:00Z')), true); // summer: opens an hour earlier in UTC
});

test("open only when today's prices are arriving", () => {
  assert.equal(tradingStatus('US', prices('US', at('15:40'), at('15:45')), at('15:50')), 'open');
  assert.equal(tradingStatus('US', prices('US', at('15:40')), at('22:00')), 'closed');
  // Just after the open, before today's first price: waiting, not open
  assert.equal(tradingStatus('US', prices('US', at('21:00', '06'), at('14:40')), at('14:45')), 'waiting');
  // A holiday: the feed is up but the newest price is from the day before
  assert.equal(tradingStatus('US', prices('US', at('21:00', '06'), at('17:55')), at('18:00')), 'no-trading');
  // An SGX half day that closed at 12:00 Singapore (04:00 UTC): by 05:20 UTC it's clearly over
  assert.equal(tradingStatus('SGX', prices('SGX', at('04:00'), at('05:15')), at('05:20')), 'no-trading');
  // The price feed itself has stalled: don't claim a holiday, just wait
  assert.equal(tradingStatus('US', prices('US', at('15:00'), at('15:00')), at('18:00')), 'waiting');
  // Stale (failed-fetch) quotes don't count
  const p = prices('US', at('15:40'), at('15:45'));
  p.quotes.A.stale = true;
  assert.equal(tradingStatus('US', p, at('15:50')), 'waiting');
});

test('news after the close, or at a weekend, counts from the next session', () => {
  assert.equal(sessionDateFor('US', '2026-03-12T19:30:00Z'), '2026-03-12'); // 15:30 New York: same day
  assert.equal(sessionDateFor('US', '2026-03-12T20:05:00Z'), '2026-03-13'); // 16:05 New York: next day
  assert.equal(sessionDateFor('US', '2026-03-13T21:00:00Z'), '2026-03-16'); // Friday evening: Monday
  assert.equal(sessionDateFor('US', '2026-03-12T11:00:00Z'), '2026-03-12'); // before the open
  assert.equal(sessionDateFor('SGX', '2026-03-12T10:00:00Z'), '2026-03-13'); // 18:00 Singapore
  assert.equal(sessionDateAfter('US', '2026-03-14', 9 * 60), '2026-03-16'); // a Saturday
});
