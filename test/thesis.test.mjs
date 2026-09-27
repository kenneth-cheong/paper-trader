import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  thesisOf, lessonsAppliedOf, catalystDateFor, catalystAge, checkedThesis, catalystPassed, beatsFees, positionThesis, thesisProgress, moveWords,
  CATALYST_TYPES, HORIZON_DAYS,
} from '../thesis.js';
import { newFund, applyOrders, executeDecision } from '../fund.js';
import { fundContext, decideFund, FUND_TOOL, FUND_SYSTEM } from '../ai.js';
import { catalystsPassed, collectAlerts } from '../alerts.js';

const prices = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8'));

// A thesis as the tool sends it; a sell or cover gets the sentinels.
const thesis = (extra = {}) => ({ expected_move_pct: 6, horizon_days: 21, catalyst_type: 'results', catalyst_date: '', wrong_if: 'NIM guidance cut', lessons_applied: [], ...extra });
const SENTINELS = { expected_move_pct: 0, horizon_days: 5, catalyst_type: 'none', catalyst_date: '', wrong_if: '', lessons_applied: [] };

test('the thesis fields are required in the tool, with sentinels, and the same for every fund', () => {
  const order = FUND_TOOL.input_schema.properties.orders.items;
  const considered = FUND_TOOL.input_schema.properties.considered.items;
  for (const item of [order, considered]) {
    for (const k of Object.keys(SENTINELS)) assert.ok(item.required.includes(k) && item.properties[k], k);
    assert.deepEqual(item.properties.horizon_days.enum, HORIZON_DAYS);
    assert.deepEqual(item.properties.catalyst_type.enum, CATALYST_TYPES);
    assert.equal(item.properties.lessons_applied.items.type, 'string'); // plain strings: no fund-specific enum
  }
  assert.match(FUND_SYSTEM, /expected_move_pct/);
  assert.match(FUND_SYSTEM, /lessons_applied/);
});

test('a thesis is cleaned up, and absent on older orders', () => {
  assert.deepEqual(thesisOf(thesis({ catalyst_date: '2026-01-06' })), { expected: 6, horizon: 21, catalyst: 'results', catalystDate: '2026-01-06', wrongIf: 'NIM guidance cut' });
  assert.deepEqual(thesisOf({ expected_move_pct: 'x', horizon_days: 10, catalyst_type: 'rumour', catalyst_date: 'soon', wrong_if: 42 }),
    { expected: null, horizon: null, catalyst: 'none', catalystDate: '', wrongIf: '42' });
  assert.equal(thesisOf({ symbol: 'A', action: 'buy', shares: 1 }), null);
  assert.deepEqual(lessonsAppliedOf({ lessons_applied: ['a', '', 'b', 'c', 'd'] }), ['a', 'b', 'c']);
  assert.deepEqual(lessonsAppliedOf({}), []);
});

// Tue 20 Jan 2026; the last results were on Fri 2 Jan (12 trading days before), the next on Wed 28 Jan.
const now = new Date('2026-01-20T15:00:00Z');
const quotes = { A: { market: 'US', currency: 'USD', price: 100, daily: [], intraday: [] } };
const past = { A: { past: [{ date: '2026-01-01', effectiveDate: '2026-01-02' }], next: null } };
const upcoming = { A: { past: past.A.past, next: { date: '2026-01-28' } } };

test('a stale catalyst: more than 10 trading days old, results dated from the calendar', () => {
  const opts = (calendar) => ({ calendar, quotes, now });
  assert.equal(catalystDateFor(thesisOf(thesis()), 'A', opts(past)), '2026-01-02'); // no date: the last results
  assert.equal(catalystAge(thesisOf(thesis()), 'A', opts(past)), 12);
  assert.equal(catalystDateFor(thesisOf(thesis({ catalyst_date: '2025-12-31' })), 'A', opts(past)), '2026-01-02'); // the known date nearby
  assert.equal(catalystDateFor(thesisOf(thesis()), 'A', opts(upcoming)), '2026-01-28'); // results still to come
  assert.deepEqual([checkedThesis(thesis(), 'A', opts(past)).stale, checkedThesis(thesis(), 'A', opts(upcoming)).stale], [true, false]);
  assert.equal(checkedThesis(thesis(), 'A', opts(upcoming)).age, -6);
  // other catalysts use the date given
  assert.equal(checkedThesis(thesis({ catalyst_type: 'deal', catalyst_date: '2026-01-09' }), 'A', opts(null)).stale, false); // 7 trading days
  assert.equal(checkedThesis(thesis({ catalyst_type: 'deal', catalyst_date: '2026-01-05' }), 'A', opts(null)).stale, true); // 11
  assert.equal(checkedThesis(thesis({ catalyst_type: 'macro_data' }), 'A', opts(null)).stale, null); // no date: unknown
  assert.equal(checkedThesis(thesis({ catalyst_type: 'results' }), 'A', opts(null)).stale, null); // no calendar either
});

test('whether the catalyst came in time is checked only for results and dividends', () => {
  const t0 = Date.parse('2026-01-20T15:00:00Z') / 1000, t1 = Date.parse('2026-02-18T21:00:00Z') / 1000;
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, { calendar: upcoming }), true);
  // "no" only where the calendar covers the window: the results before it and the next ones after it
  const covered = { A: { past: past.A.past, next: { date: '2026-04-02' } } };
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, { calendar: covered }), false);
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, { calendar: past }), null); // nothing known after it
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, { calendar: { A: { past: [], next: { date: '2026-04-02' } } } }), null); // nor before
  // only an estimate far off, and a gap too long to be sure nothing came between: can't tell
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, { calendar: { A: { past: past.A.past, next: { date: '2026-07-20' } } } }), null);
  assert.equal(catalystPassed(thesisOf(thesis()), 'A', t0, t1, {}), null);
  const quote = { events: { dividends: [[Date.parse('2026-02-05T14:30:00Z') / 1000, 0.5]] } };
  assert.equal(catalystPassed(thesisOf(thesis({ catalyst_type: 'dividend' })), 'A', t0, t1, { quote }), true);
  assert.equal(catalystPassed(thesisOf(thesis({ catalyst_type: 'dividend' })), 'A', t1, t1 + 86400 * 30, { quote }), false);
  assert.equal(catalystPassed(thesisOf(thesis({ catalyst_type: 'product' })), 'A', t0, t1, { calendar: upcoming }), null);
  assert.deepEqual([beatsFees(0.5, 0.004), beatsFees(0.3, 0.004), beatsFees(null, 0.004)], [true, false, null]);
});

test('orders carry their thesis into the ledger and proposals; orders without one still execute', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100, feePlan: 'scb' }, now });
  const res = applyOrders(f, [
    { symbol: 'A', action: 'buy', shares: 10, reason: 'r', ...thesis({ lessons_applied: ['cal:stale'] }) },
    { symbol: 'A', action: 'buy', shares: 1, reason: 'tiny', ...thesis({ expected_move_pct: 1 }) }, // S$10 minimums: 2% round trip on 100
    { symbol: 'A', action: 'buy', shares: 2, reason: 'old decision' },
  ], quotes, now, { calendar: upcoming });
  assert.deepEqual(res.map((r) => r.status), ['filled', 'filled', 'filled']);
  assert.deepEqual(res[0].thesis, { expected: 6, horizon: 21, catalyst: 'results', catalystDate: '', wrongIf: 'NIM guidance cut', age: -6, stale: false, beatsFees: true });
  assert.deepEqual(res[0].lessonsApplied, ['cal:stale']);
  assert.equal(res[1].thesis.beatsFees, false); // logged, not blocked
  assert.equal(res[2].thesis, null);
  assert.equal(res[2].lessonsApplied, undefined);
  const [sell] = applyOrders(f, [{ symbol: 'A', action: 'sell', shares: 5, reason: 'r', ...SENTINELS }], quotes, now);
  assert.equal(sell.status, 'filled');
  assert.equal(sell.thesis, null); // an exit has no thesis
  // with approval, the proposal keeps the thesis
  const t = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger' }, now });
  executeDecision(t, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'r', ...thesis({ lessons_applied: ['own:1'] }) }], { A: { ...quotes.A, time: now.toISOString() } }, now, { calendar: past });
  assert.deepEqual([t.proposals[0].thesis.stale, t.proposals[0].thesis.expected, t.proposals[0].lessonsApplied], [true, 6, ['own:1']]);
});

// A fund holding AAPL (sample prices end Fri 2 Jan 2026 at 320.26), bought on Mon 22 Dec at 300.
const holder = () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date('2025-12-22T15:00:00Z') });
  f.portfolio.positions.AAPL = { qty: 10, avgCost: 300, currency: 'USD' };
  f.decisions = [{ time: '2025-12-22T15:00:00Z', outlook: 'o', orders: [{
    symbol: 'AAPL', action: 'buy', shares: 10, price: 300, status: 'filled',
    thesis: { expected: 6, horizon: 21, catalyst: 'results', catalystDate: '2025-12-30', wrongIf: 'iPhone sales fall', stale: false }, lessonsApplied: ['cal:stale'],
  }] }];
  return f;
};

test('each position carries its thesis to the AI and the page: expected move, catalyst, days left, so far', () => {
  const f = holder();
  const th = positionThesis(f, 'AAPL', 'long');
  assert.equal(th.price, 300);
  assert.deepEqual(th.lessons, ['cal:stale']);
  assert.equal(positionThesis(f, 'AAPL', 'short'), null);
  const end = new Date('2026-01-02T21:30:00Z');
  const p = thesisProgress(th, { price: 320.26, quote: prices.quotes.AAPL, now: end });
  assert.equal(p.daysLeft, 12); // 21 trading days from 22 Dec, 9 gone
  assert.ok(Math.abs(p.soFar - 0.06753) < 1e-4);
  const ctx = fundContext({ fund: f, quotes: prices.quotes, now: end });
  assert.deepEqual(ctx.positions[0].thesis, { catalyst_type: 'results', catalyst_date: '2025-12-30', days_left: 12, expected_move_pct: 6, realised_so_far_pct: 6.8 });
  assert.ok(JSON.stringify(ctx.positions[0].thesis).length < 160); // about 30 tokens
  // a position opened by an order without a thesis has none
  f.decisions[0].orders[0].thesis = null;
  assert.equal(fundContext({ fund: f, quotes: prices.quotes, now: end }).positions[0].thesis, undefined);
});

test('the AI\'s theses reach the decision record, and the tool JSON stays the same across funds', async () => {
  const f = holder();
  const g = newFund({ budget: 50000, currency: 'USD', style: 'aggressive', now: new Date('2025-12-22T15:00:00Z') });
  const news = { market_summary: 'm', items: [], model: 'claude-haiku-4-5', createdAt: 'x' };
  const answer = () => ({
    stop_reason: 'tool_use', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_use', id: 't', name: FUND_TOOL.name, input: { outlook: 'o', orders: [], considered: [{ symbol: 'MSFT', stance: 'long', idea_type: 'news', why_not: 'wait', ...thesis() }], protections: [], source_urls: [] } }],
  });
  const calls = [];
  const client = { beta: { messages: { stream: (req) => { calls.push(structuredClone(req)); return { finalMessage: async () => answer() }; } } } };
  const d = await decideFund({ client, fund: f, quotes: prices.quotes, news, now: new Date('2026-01-02T21:30:00Z') });
  await decideFund({ client, fund: g, quotes: prices.quotes, news, now: new Date('2026-01-02T21:30:00Z') });
  assert.equal(d.considered[0].expected_move_pct, 6);
  assert.equal(JSON.stringify(calls[0].tools.at(-1)), JSON.stringify(calls[1].tools.at(-1)));
  assert.match(calls[0].messages[0].content[1].text, /"thesis":\{"catalyst_type":"results"/); // the fund's own part
  assert.doesNotMatch(calls[0].messages[0].content[0].text, /iPhone/); // not in the shared market data
});

test('Telegram says when a held position\'s catalyst has passed, once', () => {
  const f = holder();
  const q = { ...prices.quotes.AAPL };
  const pricesNow = { quotes: { AAPL: q } };
  assert.deepEqual(catalystsPassed(f, pricesNow, new Date('2025-12-30T15:00:00Z')), []); // the day itself
  const [a] = catalystsPassed(f, pricesNow, new Date('2025-12-31T15:00:00Z'));
  assert.equal(a.key, 'catalyst:AAPL:2025-12-30');
  assert.match(a.text, /AAPL<\/b>: the catalyst the fund bought it for \(results, Tue 30 Dec\) has passed\. It expected \+6\.00% in a month; so far \+6\.75%\. Wrong if: iPhone sales fall/);
  assert.deepEqual(catalystsPassed(f, pricesNow, new Date('2026-01-08T15:00:00Z')), []); // too late to say
  // a catalyst already past when the position was opened isn't announced
  f.decisions[0].orders[0].thesis.catalystDate = '2025-12-19';
  assert.deepEqual(catalystsPassed(f, pricesNow, new Date('2025-12-23T15:00:00Z')), []);
  f.decisions[0].orders[0].thesis.catalystDate = '2025-12-30';
  collectAlerts(f, { prices: pricesNow, now: new Date('2025-12-29T22:00:00Z') }); // seeded
  const texts = collectAlerts(f, { prices: pricesNow, now: new Date('2025-12-31T15:00:00Z') });
  assert.equal(texts.filter((t) => /catalyst the fund/.test(t)).length, 1);
  assert.equal(collectAlerts(f, { prices: pricesNow, now: new Date('2026-01-01T15:00:00Z') }).filter((t) => /catalyst the fund/.test(t)).length, 0);
});

test('a short\'s thesis reads as a fall, and its progress as the price\'s own move', () => {
  assert.equal(moveWords(0.056), '+5.6%');
  assert.equal(moveWords(-0.033), '−3.3%');
  assert.equal(moveWords(0.056, true), 'a 5.6% fall'); // expected +5.6% in its direction: the price falls
  assert.equal(moveWords(-0.033, true), 'a 3.3% rise'); // so far against it: the price rose
  const f = holder();
  const o = f.decisions[0].orders[0];
  Object.assign(o, { action: 'short' });
  f.portfolio.positions = { AAPL: { qty: -10, avgCost: 300, currency: 'USD' } };
  f.portfolio.accounts.USD.cash += 3000;
  const [a] = catalystsPassed(f, { quotes: { AAPL: { ...prices.quotes.AAPL } } }, new Date('2025-12-31T15:00:00Z'));
  assert.match(a.text, /the catalyst the fund shorted it for \(results, Tue 30 Dec\) has passed\. It expected a 6\.00% fall in a month; so far a 6\.75% rise\./);
});
