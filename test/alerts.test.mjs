import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAlerts, collectAllAlerts, collectMessages, unmarkSent, dailySummary, formatMessage, MESSAGE_MAX } from '../alerts.js';
import { loadFunds, addFund } from '../funds.js';
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
  f.events.push({ time: '2026-01-07T16:05:00Z', symbol: 'A', action: 'sell', shares: 10, price: 94, why: 'stop-loss at -5%', track: { openedAt: '2026-01-07T15:00:00Z', worst: -0.0612, best: 0.021 } });
  const texts = collectAlerts(f);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /🔻 SELL 10 A at 94.00 USD \(stop-loss at -5%\)\. While held: at worst −6.12%, at best \+2.10%\./);
  assert.match(texts[1], /Trading paused/);
  assert.deepEqual(collectAlerts(f), []);
  // a position opened before tracking began was followed only from then: it says so, not "while held"
  f.events.push({ time: '2026-01-08T16:05:00Z', symbol: 'B', action: 'sell', shares: 5, price: 200, why: 'stop-loss at -8%', track: { openedAt: '2026-01-06T15:00:00Z', late: true, worst: -0.081, best: 0.004 } });
  const [late] = collectAlerts(f);
  assert.match(late, /\(stop-loss at -8%\)\. Since tracking began \(6 Jan\): at worst −8\.10%, at best \+0\.40%\./);
  assert.doesNotMatch(late, /While held/);
});

test('approvals, Tiger refusals, stop orders and disagreements with Tiger are announced', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger' }, now: at('2026-01-07T14:00:00Z') });
  collectAlerts(f);
  executeDecision(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'Strong earnings' }], { A: q(100) }, at('2026-01-07T15:00:00Z'));
  f.brokerOrders.push({ id: 'g1', source: 'guard', side: 'sell', action: 'sell', qty: 5, symbol: 'B', stopPrice: 47.5, status: 'sent' });
  f.brokerOrders.push({ id: 'b2', source: 'decision', side: 'buy', action: 'buy', qty: 5, symbol: 'C', status: 'rejected', error: 'Not enough buying power' });
  const texts = collectAlerts(f);
  assert.match(texts.join('\n'), /Waiting for your approval<\/b> until 00:00 SGT: BUY 10 A \(limit 101.00\). Strong earnings/);
  assert.match(texts.join('\n'), /Stop-loss placed at Tiger: sell 5 B if it falls to 47.50/);
  assert.match(texts.join('\n'), /Tiger didn't take<\/b> buy 5 C: Not enough buying power/);
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

test('with several funds, alerts carry the fund name and Tiger is checked against them together', () => {
  const c = loadFunds(null);
  const now = at('2026-01-07T14:00:00Z');
  const a = addFund(c, { name: 'Steady', style: 'cautious', budget: 5000, currency: 'USD', settings: { broker: 'tiger' }, now });
  const b = addFund(c, { name: 'Rocket', style: 'aggressive', budget: 5000, currency: 'USD', settings: { broker: 'tiger' }, now });
  assert.deepEqual(collectAllAlerts(c), []); // seeded
  a.portfolio.positions.X = { qty: 10, avgCost: 10, currency: 'USD' };
  b.portfolio.positions.X = { qty: 5, avgCost: 10, currency: 'USD' };
  a.broker = { time: '2026-01-07T15:00:00Z', positions: [{ symbol: 'X', qty: 12 }], error: null };
  b.broker = a.broker;
  pauseFund(b, 'Paused by its owner.', at('2026-01-07T15:00:00Z'));
  const texts = collectAllAlerts(c);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /^<b>Rocket<\/b> · ⛔ <b>Trading paused/);
  assert.match(texts[1], /doesn't hold what the funds think<\/b>: X funds 15, Tiger 12/);
  assert.deepEqual(collectAllAlerts(c), []); // said once
});

test("a request from the app that didn't work is said once, with its fund's name when there are several", () => {
  const c = loadFunds(null);
  const now = at('2026-01-07T14:00:00Z');
  const a = addFund(c, { name: 'Steady', budget: 5000, currency: 'USD', now });
  c.lastCommand = { time: '2026-01-06T15:00:00.000Z', action: 'pause', message: 'No fund is running.', ok: false, fund: null };
  assert.deepEqual(collectAllAlerts(c), []); // seeded: a request from before alerts began isn't announced late
  const failed = { time: '2026-01-07T15:00:00.000Z', action: 'lessons', message: 'That lesson has gone...', ok: false, fund: a.id };
  const said = `⚠️ Your "lessons" request didn't work: That lesson has gone...`;
  c.lastCommand = failed;
  assert.deepEqual(collectAllAlerts(c), [said]);
  assert.deepEqual(collectAllAlerts(c), []); // said once
  c.lastCommand = { ...failed, time: '2026-01-07T16:00:00.000Z', message: 'Updated the lessons of "Steady".', ok: true };
  assert.deepEqual(collectAllAlerts(c), []);
  addFund(c, { name: 'Rocket', budget: 5000, currency: 'USD', now });
  c.lastCommand = { ...failed, time: '2026-01-07T17:00:00.000Z' };
  assert.deepEqual(collectAllAlerts(c), [`<b>Steady</b> · ${said}`]);
  c.lastCommand = { ...failed, time: '2026-01-07T18:00:00.000Z', fund: 'all' };
  assert.deepEqual(collectAllAlerts(c), [said]); // no one fund named
});

test('each fund\'s weekly report goes as a message of its own with a link to its page, once; proposals link to their approval', () => {
  const c = loadFunds(null);
  const now = at('2026-01-07T14:00:00Z');
  const f = addFund(c, { name: 'Steady', style: 'balanced', budget: 10000, currency: 'USD', settings: { broker: 'tiger' }, now });
  addFund(c, { name: 'Other', style: 'balanced', budget: 10000, currency: 'USD', now });
  const report = (week, extra = {}) => ({ week, to: '2026-01-09', at: '2026-01-09T21:30:00.000Z', fund: { pct: 0.008 }, index: { symbol: 'SPY', pct: 0.003 }, graded: 7, short: false,
    best: { symbol: 'AAPL', action: 'buy', outcome: 'traded', vsIndex: 0.029, reason: 'results & guidance beat', wrongIf: 'iPhone demand <falls>' }, worst: null,
    lessons: [], moreLessons: 0, review: null, summary: null, calls: [], comingUp: [], control: [], cost: null, ...extra });
  f.reports = [report('2026-W01')];
  const app = 'https://x.github.io/p/';
  assert.deepEqual(collectMessages(c, { appUrl: app }), { alerts: [], reports: [] }); // the first run only remembers
  f.reports.push(report('2026-W02'));
  executeDecision(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'Strong earnings' }], { A: q(100) }, at('2026-01-07T15:00:00Z'));
  const { alerts, reports } = collectMessages(c, { appUrl: app });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], new RegExp(`Strong earnings <a href="https://x\\.github\\.io/p/#fund/${f.id}/approve">Approve or decline</a>$`));
  assert.equal(reports.length, 1);
  const [r] = reports;
  assert.deepEqual([r.fundId, r.key], [f.id, 'report:2026-W02']);
  assert.match(r.text, /^📘 <b>What we learned · Steady<\/b>\nWeek to 9 Jan: fund \+0\.8%, SPY \+0\.3%\.\n• 7 ideas graded this week\. Its only trade: bought AAPL \("results &amp; guidance beat"\), \+2\.9% against SPY a week later, after fees \(it said: wrong if iPhone demand &lt;falls&gt;\)\./);
  assert.ok(r.text.endsWith(`\n\n<a href="${app}#fund/${f.id}">Open it on the page</a>`));
  assert.doesNotMatch(r.text + alerts[0], /What it learned this week/); // the review's own alert is gone
  assert.deepEqual(collectMessages(c, { appUrl: app }).reports, []); // sent once
  // a report whose message failed goes out again next run
  unmarkSent(c, r);
  assert.equal(collectMessages(c, { appUrl: app }).reports.length, 1);
});

test('a message cut to Telegram\'s length never splits an HTML tag or entity and closes what it left open', () => {
  const long = `<b>${'x'.repeat(3795)} &amp; more</b>`;
  const out = formatMessage([long], 'https://x.github.io/p/', { hash: 'fund/f1', label: 'Open it' });
  const body = out.split('\n\n<a')[0];
  assert.ok(body.length <= MESSAGE_MAX + 5);
  assert.match(body, /x…<\/b>$/); // the half entity is dropped, the bold closed
  assert.ok(out.endsWith('<a href="https://x.github.io/p/#fund/f1">Open it</a>'));
  assert.equal(formatMessage(['<i>short</i>'], ''), '<i>short</i>');
});
