import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  typicalMove, correlation, correlatedPeers, reactionsIn, mergeReactions, nextExDate, dividendsOf, picksRecord, buildDossier, buildDossiers,
  dossiersDue, cardSymbols, cardLines, stockCards, heldByMarket, setStockNote, notesForPrompt, positionRisk, riskForPrompt, exDateVsStop,
  stopLogSummary, exDateLate, DOSSIER,
} from '../dossier.js';
import { stockRecords } from '../learning.js';
import { newFund, applyOrders, checkProtections, setProtections, applyBrokerFills, executeDecision, PROTECTION_LOG_MAX } from '../fund.js';
import { summarize } from '../portfolio.js';
import { decideFund, fundContext, FUND_TOOL, FUND_SYSTEM } from '../ai.js';
import { seeded, gauss } from '../stats.js';

const root = new URL('..', import.meta.url).pathname;
const DAY = 86400;
// Weekdays from `from`, as bar times at the session's open (US 13:30 UTC, SGX 01:00).
function weekdays(n, from = '2025-09-01', market = 'US') {
  const out = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); out.length < n; d += DAY * 1000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) out.push(d / 1000 + (market === 'US' ? 13.5 : 1) * 3600);
  }
  return out;
}
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const walk = (n, f) => { const out = [100]; for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + f(i))); return out; };
// A prices.json quote from closes, with dividends [[barIndex, amount]].
function quote(market, closes, { from = '2025-09-01', dividends = [], name = null, etf = false } = {}) {
  const ts = weekdays(closes.length, from, market);
  return {
    market, currency: market === 'US' ? 'USD' : 'SGD', ...(name ? { name } : {}), ...(etf ? { etf: true } : {}),
    price: closes.at(-1), prevClose: closes.at(-2), daily: ts.map((t, i) => [t, Math.round(closes[i] * 1e4) / 1e4]),
    ...(dividends.length ? { events: { dividends: dividends.map(([i, a]) => [ts[i], a]), splits: [] } } : {}),
  };
}
const after = (q, days = 1) => new Date((q.daily.at(-1)[0] + days * DAY) * 1000);

// ---------- a year of prices ----------

test('the typical daily move is the spread of the last 60 closed sessions, dividends counted, today\'s unfinished one left out', () => {
  const closes = walk(120, (i) => (i % 2 ? 0.01 : -0.01));
  const q = quote('US', closes);
  assert.ok(Math.abs(typicalMove(q, after(q)) - 0.01) < 0.0003);
  // an ex-date: the price drops by the dividend, which isn't a move
  const withDiv = closes.slice();
  for (let i = 100; i < 120; i++) withDiv[i] -= 1;
  const qd = quote('US', withDiv, { dividends: [[100, 1]] });
  assert.ok(Math.abs(typicalMove(qd, after(qd)) - typicalMove(q, after(q))) < 0.0005);
  // a session that hasn't closed yet doesn't count
  const jumpy = quote('US', [...closes.slice(0, -1), closes.at(-2) * 1.2]);
  const open = new Date((jumpy.daily.at(-1)[0] + 3600) * 1000);
  assert.ok(Math.abs(typicalMove(jumpy, open) - 0.01) < 0.0003);
  assert.ok(typicalMove(jumpy, after(jumpy)) > 0.02);
  assert.equal(typicalMove(quote('US', closes.slice(0, 30)), new Date('2026-01-01T00:00:00Z')), null); // too few
});

test('the stocks it moved with: the correlation of daily moves, in its own market, index funds left out', () => {
  const rand = seeded(5);
  const m = Array.from({ length: 260 }, () => 0.01 * gauss(rand));
  const make = (f) => walk(260, f);
  const quotes = {
    A: quote('US', make((i) => m[i] + 0.003 * gauss(rand))), B: quote('US', make((i) => m[i] + 0.003 * gauss(rand))),
    C: quote('US', make(() => 0.01 * gauss(rand))), SPY: quote('US', make((i) => m[i]), { etf: true }), QQQ: quote('US', make((i) => m[i]), { etf: true }),
    'D05.SI': quote('SGX', make((i) => m[i])),
  };
  const now = after(quotes.A);
  const peers = correlatedPeers(quotes, 'A', now);
  assert.equal(peers[0][0], 'B');
  assert.ok(peers[0][1] > 0.85, `B ${peers[0][1]}`);
  assert.equal(peers[1][0], 'C');
  assert.ok(Math.abs(peers[1][1]) < 0.2);
  assert.ok(!peers.some(([s]) => ['SPY', 'QQQ', 'D05.SI'].includes(s)));
  assert.equal(correlation(quotes.A, quote('US', new Array(260).fill(100)), now), null); // a price that never moves
  assert.equal(correlatedPeers(quotes, 'SPY', now).length, 0); // an index fund has no card
});

test('results days: the day the price could react, and a week and a month from the close before, against the index', () => {
  const n = 100;
  const index = quote('US', walk(n, () => 0.001));
  const ret = (i) => (i === 50 ? 0.061 : i > 50 && i <= 54 ? 0.006 : i === 81 ? -0.049 : 0.001);
  const stock = quote('US', walk(n, ret));
  const ts = stock.daily.map((b) => b[0]);
  const past = [{ date: dayOf(ts[49]), effectiveDate: dayOf(ts[50]) }, { date: dayOf(ts[80]) }, { date: '2024-01-05' }];
  const out = reactionsIn(stock, index, past, after(stock));
  assert.deepEqual(out.map((x) => x.date), [dayOf(ts[50]), dayOf(ts[81])]); // the filing's session; the bigger of a date without a time and the next
  const plain = (a, b) => walk(n, ret)[b] / walk(n, ret)[a] - walk(n, () => 0.001)[b] / walk(n, () => 0.001)[a];
  assert.ok(Math.abs(out[0].day - plain(49, 50)) < 1e-6);
  assert.ok(Math.abs(out[0].week - plain(49, 54)) < 1e-6);
  assert.ok(Math.abs(out[0].month - plain(49, 70)) < 1e-6);
  assert.ok(out[1].day < -0.04);
  assert.equal(out[1].month, null); // not 21 sessions yet
  // merged with the ten-year memory's (in %): the same results within 3 days count once, this year's copy kept
  const merged = mergeReactions([['2025-01-10', 1.2, 2, 3], [dayOf(ts[50] + 2 * DAY), 9, 9, 9], ['2025-04-10', -1, null]], out);
  assert.deepEqual(merged.map((x) => x.date), ['2025-01-10', '2025-04-10', dayOf(ts[50]), dayOf(ts[81])]);
  assert.deepEqual([merged[0].day, merged[0].week, merged[1].week], [0.012, 0.02, null]);
  assert.equal(mergeReactions(Array.from({ length: 12 }, (_, i) => [`2024-0${1 + (i % 9)}-1${i % 10}`, i, null, null]), []).length, DOSSIER.reactions);
});

// ---------- dividends ----------

test('the next ex-date is a year after the one a year before, the soonest not paid yet', () => {
  assert.equal(nextExDate(['2025-11-12', '2026-02-10', '2026-05-11', '2026-08-10'], '2026-09-27'), '2026-11-12'); // quarterly
  assert.equal(nextExDate(['2025-10-01', '2026-02-10', '2026-09-20'], '2026-09-27'), '2027-02-10'); // October's already went ex (early)
  assert.equal(nextExDate(['2025-09-20', '2026-03-20'], '2026-09-27'), '2026-09-20'); // a week late: due about now
  assert.equal(nextExDate(['2026-05-10'], '2026-09-27'), '2027-05-10'); // once a year
  assert.equal(nextExDate(['2024-02-29'], '2024-06-01'), '2025-02-28');
  assert.equal(nextExDate([], '2026-09-27'), null);
  assert.equal(nextExDate(['2024-01-05'], '2026-09-27'), null); // too long ago to go by
});

test('dividends: the last one, the ten-year ex-date drop, the usual months and the next as an estimate', () => {
  const closes = walk(260, () => 0.0002);
  const q = quote('SGX', closes, { from: '2025-09-01', dividends: [[50, 0.6], [180, 0.62]] });
  const history = { market: 'SGX', dividends: { n: 21, drop_vs_dividend: 0.88, last: ['2025-08-10', 0.55], months: [5, 11] } };
  const d = dividendsOf(q, history, after(q));
  assert.deepEqual(d.last, [dayOf(q.daily[180][0]), 0.62]);
  assert.equal(d.drop_vs_dividend, 0.88);
  assert.equal(d.n, 21);
  assert.deepEqual(d.months, [5, 11]);
  assert.equal(d.yield_pct, Math.round((0.62 / q.price) * 1e4) / 100);
  assert.equal(d.next.estimate, true);
  assert.ok(d.next.date > dayOf(q.daily.at(-1)[0]));
  assert.equal(dividendsOf(quote('US', closes), null, after(q)), null); // no dividends: nothing
  // a US stock: its months from the year, no measured drop
  const us = dividendsOf(quote('US', closes, { dividends: [[20, 0.26], [83, 0.26], [146, 0.26], [209, 0.26]] }), null, after(q));
  assert.equal(us.drop_vs_dividend, null);
  assert.equal(us.months.length, 4);
});

test('an ex-date estimate that has passed without the stock going ex is due any day, never presented as coming up on that date', () => {
  // C38U went ex on 1 Aug last year and 4 Feb; on 10 Aug it hasn't gone ex yet this year
  const history = { market: 'SGX', dividends: { n: 32, drop_vs_dividend: 0.9, last: ['2026-02-04', 0.056], months: [2, 8] } };
  const q = { market: 'SGX', currency: 'SGD', price: 2, daily: [], events: { dividends: [[Date.parse('2025-08-01T01:00:00Z') / 1000, 0.055], [Date.parse('2026-02-04T01:00:00Z') / 1000, 0.056]] } };
  const now = new Date('2026-08-10T02:00:00Z');
  const dv = dividendsOf(q, history, now);
  assert.deepEqual(dv.next, { date: '2026-08-01', amount: 0.056, estimate: true, late: true });
  assert.equal(dividendsOf(q, history, new Date('2026-07-20T02:00:00Z')).next.late, undefined); // still to come
  const card = { market: 'SGX', dividends: dv };
  assert.equal(exDateLate(card, now), true);
  assert.equal(exDateLate(card, new Date('2026-07-31T02:00:00Z')), false); // a day file from before: worked out when read
  assert.deepEqual(cardLines(card, now), ['Ex-dates drop 90% of the dividend; last 0.056 (2.8%) on 2026-02-04; next due any day (the estimate, ~2026-08-01, has passed).']);
  // a long position whose stop level is 2% below today's price: the drop (about 2.5%) could trigger it
  assert.deepEqual(exDateVsStop(card, 2, now), { date: '2026-08-01', dropPct: 2.5, late: true });
});

// ---------- records ----------

test('the picks\' record on a stock and each fund\'s record from its graded ideas', () => {
  const s = (symbol, horizon, ret, beat) => ({ symbol, horizon, ret, right: ret > 0, beat, indexRet: 0.01, indexBet: 0.01 });
  const rec = picksRecord([s('A', 'week', 0.02, true), s('A', 'week', -0.01, false), s('A', 'month', 0.03, true), s('B', 'week', 0.05, true)], 'A');
  assert.deepEqual(rec.week, { n: 2, right: 0.5, beat: 0.5, avg: 0.005 });
  assert.equal(rec.month.n, 1);
  assert.equal(picksRecord([], 'A'), null);
  const g = (symbol, outcome, move, w) => ({ symbol, kind: 'entry', outcome, direction: 1, t: 1767600000 + w * 7 * DAY, idio: 0.03, beta: 1, fee: 0.002, week: { move, index: 0 } });
  const graded = [...Array.from({ length: 10 }, (_, w) => g('A', 'traded', 0.012, w)), g('A', 'passed', 0.01, 3), g('B', 'passed', -0.01, 1), { symbol: 'A', kind: 'exit', outcome: 'exit', week: { move: 0, index: 0 } }];
  const r = stockRecords(graded);
  assert.deepEqual(Object.keys(r), ['A', 'B']);
  assert.equal(r.A.ideas, 11);
  assert.equal(r.A.traded, 10);
  assert.equal(r.A.bets, 10);
  assert.ok(r.A.edge > 0 && r.A.lo < r.A.edge && r.A.edge < r.A.hi);
  assert.equal(r.A.right, 1);
  assert.deepEqual(r.B, { ideas: 1, traded: 0 }); // no trades: no edge
});

// ---------- one stock's card ----------

function smallMarket() {
  const rand = seeded(9);
  const m = Array.from({ length: 260 }, () => 0.008 * gauss(rand));
  const w = (f) => walk(260, f);
  return {
    'D05.SI': quote('SGX', w((i) => m[i] + 0.004 * gauss(rand)), { name: 'DBS Group', dividends: [[40, 0.6], [100, 0.6], [165, 0.6], [228, 0.6]] }),
    'O39.SI': quote('SGX', w((i) => m[i] + 0.004 * gauss(rand)), { name: 'OCBC Bank' }),
    'C6L.SI': quote('SGX', w(() => 0.02 * gauss(rand)), { name: 'Singapore Airlines' }),
    'ES3.SI': quote('SGX', w((i) => m[i]), { etf: true }),
    AAPL: quote('US', w(() => 0.015 * gauss(rand)), { name: 'Apple', dividends: [[200, 0.26]] }),
    SPY: quote('US', w(() => 0.009 * gauss(rand)), { etf: true }),
  };
}

test('a stock\'s card: its own history from prices, the ten-year memory, the calendar and the picks; public cards carry no fund\'s record', () => {
  const quotes = smallMarket();
  const now = after(quotes['D05.SI']);
  const history = {
    market: 'SGX', typical_daily_move_pct: 1.4, beta: 1.1,
    stops: { holds: 2400, long: { hits: [0.7, 0.6, 0.5, 0.4], k: 5 }, short: { hits: [0.7, 0.6, 0.5, 0.45], k: 5.5 } }, suggested_stop_pct: { long: 7, short: 7.7 },
    dividends: { n: 35, drop_vs_dividend: 0.9, last: ['2025-08-10', 0.55], months: [2, 5, 8, 11] },
    results: { n: 12, typical_results_day_move_pct: 2.2, recent: [['2024-11-06', -0.6, 1.9, 3], ['2025-02-10', 0.9, 2.7, 3.7]] },
  };
  const calendar = { 'D05.SI': { next: { date: '2026-11-05', source: 'estimated' }, past: [], typicalMove: { avg: 0.03, n: 4 } } };
  const d = buildDossier('D05.SI', { quotes, history, calendar, picksScores: [{ symbol: 'D05.SI', horizon: 'week', ret: 0.01, right: true, beat: true, indexRet: 0 }], now });
  assert.equal(d.name, 'DBS Group');
  assert.equal(d.index, 'ES3.SI');
  assert.ok(d.daily_move_pct > 0.5 && d.daily_move_pct < 1.5);
  assert.equal(d.peers[0][0], 'O39.SI'); // the other bank, not the airline or the index fund
  assert.equal(d.stops.suggested_stop_pct.long, Math.round(5 * d.daily_move_pct * 10) / 10); // at today's daily move
  assert.deepEqual(d.results.next, { date: '2026-11-05', source: 'estimated' });
  assert.deepEqual([d.results.typical_day_move_pct, d.results.n], [2.2, 12]); // ten years' 12 results beat the year's 4
  assert.deepEqual(d.results.reactions.map((x) => x[0]), ['2024-11-06', '2025-02-10']);
  assert.equal(d.dividends.drop_vs_dividend, 0.9);
  assert.equal(d.picks.week.n, 1);
  assert.equal(d.funds, undefined);
  const withRecords = buildDossier('D05.SI', { quotes, history, calendar, now, fundRecords: [{ fund: 'f1', name: 'Banks', record: { ideas: 3, traded: 2 } }] });
  assert.equal(withRecords.funds[0].name, 'Banks');
  // every stock's card, as dossiers.json: no index funds, small
  const all = buildDossiers({ quotes, long: { updatedAt: '2026-09-20T00:00:00Z', stocks: { 'D05.SI': history } }, calendar, now });
  assert.deepEqual(Object.keys(all.stocks), ['AAPL', 'C6L.SI', 'D05.SI', 'O39.SI']);
  assert.equal(all.longAt, '2026-09-20T00:00:00Z');
  assert.ok(JSON.stringify(all).length < 8000);
  assert.ok(!JSON.stringify(all).includes('"funds"'));
  // rebuilt daily, and when the ten-year memory is rebuilt
  assert.equal(dossiersDue(null), true);
  assert.equal(dossiersDue(all, { updatedAt: '2026-09-20T00:00:00Z' }, now), false);
  assert.equal(dossiersDue(all, { updatedAt: '2026-09-27T00:00:00Z' }, now), true);
  assert.equal(dossiersDue(all, null, new Date(now.getTime() + DOSSIER.refreshHours * 3600000)), true);
});

// ---------- what the AI sees ----------

test('the AI\'s cards are chosen market-wide: held by any fund, then picked, then in the news; at most 6, 2-3 short lines', () => {
  const quotes = smallMarket();
  const now = after(quotes['D05.SI']);
  const f1 = newFund({ budget: 10000, currency: 'SGD' }), f2 = newFund({ budget: 10000, currency: 'SGD' }), f3 = newFund({ budget: 10000, currency: 'USD' });
  f1.portfolio.positions['C6L.SI'] = { qty: 100, avgCost: 90, currency: 'SGD' };
  f2.portfolio.positions['O39.SI'] = { qty: 1000, avgCost: 90, currency: 'SGD' };
  f3.portfolio.positions.AAPL = { qty: 10, avgCost: 90, currency: 'USD' };
  const held = heldByMarket([f1, f2, f3], quotes);
  assert.deepEqual(Object.keys(held.SGX).sort(), ['C6L.SI', 'O39.SI']);
  assert.deepEqual(heldByMarket([f2, f1, f3], quotes), held); // the same whichever fund comes first
  const picks = { picks: [{ symbol: 'AAPL', conviction: 'high' }, { symbol: 'D05.SI', conviction: 'low' }, { symbol: 'O39.SI', conviction: 'high' }] };
  const news = { items: [{ symbols: ['ES3.SI', 'D05.SI'], date: dayOf(now.getTime() / 1000) }] };
  const syms = cardSymbols('SGX', { quotes, held: held.SGX, picks, news, now });
  assert.deepEqual(syms, ['O39.SI', 'C6L.SI', 'D05.SI']); // held (biggest first), then picked; no index fund, no US stock
  assert.equal(cardSymbols('SGX', { quotes, held: held.SGX, picks, news, now, max: 1 }).length, 1);
  const history = { market: 'SGX', stops: { holds: 2400, long: { hits: [0.7, 0.6, 0.5, 0.4], k: 5 }, short: { hits: [0.7, 0.6, 0.5, 0.45], k: 5.5 } }, dividends: { n: 35, drop_vs_dividend: 0.88, last: ['2025-08-10', 0.55], months: [2, 8] }, results: { n: 12, typical_results_day_move_pct: 2.2, recent: [['2024-11-06', -0.6, 1.9, 3], ['2025-02-10', 0.9, 2.7, 3.7], ['2025-05-06', 2.2, 2.1, -0.1], ['2025-08-05', 3.6, 3, 10.4], ['2025-11-04', -0.9, 1.6, 5.2]] } };
  const calendar = { 'D05.SI': { next: { date: '2026-11-05', source: 'estimated' }, past: [] } };
  const dossiers = buildDossiers({ quotes, long: { stocks: { 'D05.SI': history } }, calendar, now }).stocks;
  const lines = cardLines(dossiers['D05.SI'], now);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^±\d\.\d%\/day; moves with O39\.SI 0\.\d\d; 1-in-5 stop −\d+\.\d%\/\+\d+\.\d%\.$/);
  assert.equal(lines[1], 'Results vs ES3: +0.9%, +2.2%, +3.6%, −0.9%; next 2026-11-05 (estimate).'); // the latest 4, latest last
  assert.match(lines[2], /^Ex-dates drop 88% of the dividend; last 0\.6 \(\d\.\d%\) on \d{4}-\d\d-\d\d; next ~\d{4}-\d\d-\d\d\.$/);
  assert.ok(lines.join(' ').length <= 330, `${lines.join(' ').length} characters`);
  // a weak link isn't named, and a tiny US dividend going ex soon adds nothing
  const apple = cardLines({ ...dossiers.AAPL, peers: [['MSFT', 0.31]], dividends: { last: ['2026-08-10', 0.26], yield_pct: 0.1, drop_vs_dividend: null, next: { date: dayOf(now.getTime() / 1000 + 20 * DAY) } } }, now);
  assert.doesNotMatch(apple.join(' '), /moves with|Dividend/);
  const cards = stockCards('SGX', { dossiers, quotes, held: held.SGX, picks, news, now });
  assert.deepEqual(cards.map((c) => c.symbol), syms);
  assert.ok(cards.every((c) => c.lines.length >= 1 && c.lines.length <= 3));
});

test('the owner\'s notes: one per watchlist stock, trimmed, cleared by an empty note, and the AI sees its market\'s', () => {
  const quotes = smallMarket();
  const now = new Date('2026-09-27T02:00:00Z');
  let notes = setStockNote(null, 'D05.SI', `  I hold   DBS elsewhere. ${'x'.repeat(400)}`, quotes, now);
  assert.equal(notes['D05.SI'].text.length, DOSSIER.noteMax);
  assert.match(notes['D05.SI'].text, /^I hold DBS elsewhere\. x/);
  assert.equal(notes['D05.SI'].at, now.toISOString());
  notes = setStockNote(notes, 'AAPL', 'Watch the tariffs.', quotes, now);
  assert.deepEqual(notesForPrompt(notes, quotes, 'USD'), { AAPL: 'Watch the tariffs.' });
  assert.deepEqual(Object.keys(notesForPrompt(notes, quotes, 'SGD')), ['D05.SI']);
  notes = setStockNote(notes, 'AAPL', '   ', quotes, now);
  assert.equal(notes.AAPL, undefined);
  assert.equal(notesForPrompt(notes, quotes, 'USD'), null);
  assert.throws(() => setStockNote(notes, 'NOPE', 'x', quotes, now), /isn't on the watchlist/);
  assert.throws(() => setStockNote(notes, '<script>', 'x', quotes, now), /Choose a stock/);
});

// ---------- a fund's positions against their daily moves ----------

test('position risk: a position far riskier than its share of the money is flagged, and positions that move together', () => {
  // (summarize's positions: bought at 100 and at 100 today unless given)
  const pos = (symbol, marketValue, extra = {}) => ({ symbol, qty: 10, marketValue, short: false, avgCost: 100, price: 100, ...extra });
  const dossiers = {
    NVDA: { daily_move_pct: 3.2, peers: [['MSFT', 0.72]], stops: { suggested_stop_pct: { long: 15.2, short: 26 } } },
    'BRK-B': { daily_move_pct: 1.0 }, MSFT: { daily_move_pct: 1.7, peers: [['NVDA', 0.72]] }, AAPL: { daily_move_pct: 1.5 },
  };
  const positions = [pos('NVDA', 2800), pos('BRK-B', 3000), pos('MSFT', 2000), pos('AAPL', 1200)];
  const { rows, uneven, together } = positionRisk(positions, 10000, dossiers, { NVDA: { stop_loss_pct: 5 } });
  const nvda = rows.find((r) => r.symbol === 'NVDA');
  assert.ok(Math.abs(nvda.risk - 0.28 * 0.032) < 1e-9);
  assert.equal(uneven.symbol, 'NVDA'); // 31% of the money in positions, 51% of the daily risk
  assert.ok(uneven.riskShare > 0.5 && Math.abs(uneven.weight - 0.28) < 1e-9);
  assert.ok(Math.abs(uneven.hi - 0.00896) < 1e-9 && Math.abs(uneven.lo - 0.0018) < 1e-9);
  assert.deepEqual(together, [{ a: 'NVDA', b: 'MSFT', correlation: 0.72 }]);
  assert.deepEqual(riskForPrompt(nvda), { stop_in_daily_moves: 1.6, risk_pct_of_fund: 0.9, suggested_stop_pct: 15.2 }); // at its cost: 5% away
  assert.deepEqual(riskForPrompt(rows.find((r) => r.symbol === 'BRK-B')), { stop_in_daily_moves: null, risk_pct_of_fund: 0.3, suggested_stop_pct: null });
  assert.deepEqual(riskForPrompt({ move: null }), {}); // unknown daily move: nothing
  // even risk: no warning; a short and a long moving together are a hedge, not one bet
  assert.equal(positionRisk([pos('MSFT', 3000), pos('AAPL', 3000)], 10000, dossiers).uneven, null);
  assert.deepEqual(positionRisk([pos('NVDA', 3000), pos('MSFT', 3000, { short: true, qty: -10 })], 10000, dossiers).together, []);
});

test('position risk: the stop-loss is measured from today\'s price to its level', () => {
  const pos = (symbol, marketValue, extra = {}) => ({ symbol, qty: 10, marketValue, short: false, avgCost: 100, price: 100, ...extra });
  const dossiers = { META: { daily_move_pct: 2.2 }, O39: { daily_move_pct: 1.4 }, NVDA: { daily_move_pct: 2.0 }, MSFT: { daily_move_pct: 1.95 }, TSLA: { daily_move_pct: 4 }, AAPL: { daily_move_pct: 1.5 } };
  const one = (p, stop) => positionRisk([p], 10000, dossiers, { [p.symbol]: { stop_loss_pct: stop } }).rows[0];
  // 6.9% in profit with a 1.5% stop (from the average price): its level is 7.9% below today's price
  const meta = one(pos('META', 3000, { avgCost: 592.73, price: 633.7 }), 1.5);
  assert.ok(Math.abs(meta.stopDistance - (633.7 - 592.73 * 0.985) / 633.7) < 1e-12);
  assert.equal(riskForPrompt(meta).stop_in_daily_moves, 3.6);
  // 6.7% down with a 7% stop: a third of a daily move from it
  const o39 = one(pos('O39', 3000, { avgCost: 5.6, price: 5.23 }), 7);
  assert.equal(riskForPrompt(o39).stop_in_daily_moves, 0.3);
  // through its stop (it gapped past it): 0 or less
  assert.ok(one(pos('O39', 3000, { avgCost: 5.6, price: 5.1 }), 7).stopMoves < 0);
  // a short's stop is above: shorted at 100 with a 5% stop, at 90 today its level (105) is 16.7% above
  const short = one(pos('TSLA', 900, { qty: -10, short: true, price: 90 }), 5);
  assert.ok(Math.abs(short.stopDistance - 15 / 90) < 1e-12);
});

test('position risk: an index fund (no card of its own) doesn\'t make evenly risky positions look uneven', () => {
  const pos = (symbol, marketValue) => ({ symbol, qty: 10, marketValue, short: false, avgCost: 100, price: 100 });
  const dossiers = { NVDA: { daily_move_pct: 2.0 }, MSFT: { daily_move_pct: 1.95 }, TSLA: { daily_move_pct: 4 }, AAPL: { daily_move_pct: 1.5 } };
  // without its prices, the shares of the money count only the measured positions
  const trio = [pos('NVDA', 3000), pos('MSFT', 3000), pos('QQQ', 3000)];
  const unmeasured = positionRisk(trio, 10000, dossiers);
  assert.equal(unmeasured.uneven, null);
  assert.deepEqual(unmeasured.rows.map((r) => r.moneyShare), [0.5, 0.5, null]);
  // with its prices it's measured like a stock
  const quotes = { QQQ: quote('US', walk(80, (i) => (i % 2 ? 0.013 : -0.013))) };
  const measured = positionRisk(trio, 10000, dossiers, {}, { quotes, now: after(quotes.QQQ) });
  assert.ok(Math.abs(measured.rows[2].move - 0.013) < 0.001);
  assert.equal(measured.uneven, null);
  // an uneven risk is still flagged next to an index fund
  const flagged = positionRisk([pos('TSLA', 3000), pos('AAPL', 3000), pos('QQQ', 3000)], 10000, dossiers);
  assert.equal(flagged.uneven.symbol, 'TSLA');
});

test('an ex-date drop as big as the distance to a stop, and what the stop log says', () => {
  const now = new Date('2026-10-01T02:00:00Z');
  const d = { dividends: { yield_pct: 2.7, drop_vs_dividend: 0.88, next: { date: '2026-10-20' } } };
  // the stop's level 2% below today's price: the usual drop (2.4%) reaches it on the dividend alone
  assert.deepEqual(exDateVsStop(d, 2, now), { date: '2026-10-20', dropPct: 2.4 });
  assert.equal(exDateVsStop(d, 2.5, now), null); // it takes more than the dividend
  assert.equal(exDateVsStop(d, 5, now), null); // the stop is well beyond the drop
  assert.equal(exDateVsStop(d, -0.5, now), null); // already through its stop
  assert.equal(exDateVsStop(d, 2, new Date('2026-08-01T00:00:00Z')), null); // not soon
  assert.equal(exDateVsStop({ dividends: { ...d.dividends, drop_vs_dividend: null } }, 2.7, now).dropPct, 2.7); // unmeasured: all of it
  const log = [1.5, 3, 4, 6].map((stop, i) => ({ symbol: 'A', stop_loss_pct: stop, take_profit_pct: 0, setAt: `2026-09-0${i + 1}T00:00:00Z`, dailyMovePct: 1.5 }));
  // 1, 2, 2.7 and 4 daily moves: the median 2.3, one under 2 (a take-profit alone isn't a stop)
  assert.deepEqual(stopLogSummary([...log, { symbol: 'B', stop_loss_pct: 0, take_profit_pct: 5, dailyMovePct: 2 }]), { n: 4, median: 2.3, under2: 1, since: '2026-09-01T00:00:00Z' });
  assert.equal(stopLogSummary(log.slice(0, 2)), null);
});

// ---------- how far each position went against and for the fund ----------

const at = (hhmm) => new Date(`2026-01-07T${hhmm}:00Z`);
const t = (hhmm) => at(hhmm).getTime() / 1000;
const q = (price, extra = {}) => ({ currency: 'USD', market: 'US', price, daily: [], intraday: [], ...extra });

test('each position\'s worst and best move since it opened, as its stops see it, carried onto its exit', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100, feePlan: 'none' }, now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }, { symbol: 'B', action: 'short', shares: 10, reason: '' }], { A: q(100), B: q(50) }, at('14:45'));
  assert.deepEqual(f.tracks.A, { openedAt: at('14:45').toISOString(), from: at('14:45').toISOString(), entry: 100, worst: 0, best: 0 });
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 5, take_profit_pct: 0 }], { now: at('14:45') });
  checkProtections(f, { A: q(103, { intraday: [[t('15:00'), 97], [t('15:15'), 103]] }), B: q(46, { intraday: [[t('15:00'), 52], [t('15:15'), 46]] }) });
  assert.deepEqual([f.tracks.A.worst, f.tracks.A.best], [-0.03, 0.03]);
  assert.deepEqual([f.tracks.B.worst, f.tracks.B.best], [-0.04, 0.08]); // a short: a rise is against it
  // the stop-loss closes A: its exit carries how far it went against and for the fund
  const [e] = checkProtections(f, { A: q(94, { intraday: [[t('15:30'), 94.9]] }), B: q(46) });
  assert.match(e.why, /stop-loss/);
  assert.deepEqual(e.track, { openedAt: at('14:45').toISOString(), worst: -0.051, best: 0.03 });
  assert.equal(f.tracks.A, undefined);
  // the AI covering B: the order carries it
  const [cover] = applyOrders(f, [{ symbol: 'B', action: 'cover', shares: 10, reason: '' }], { B: q(45) }, at('16:00'));
  assert.deepEqual(cover.track, { openedAt: at('14:45').toISOString(), worst: -0.04, best: 0.1 });
  assert.deepEqual(f.tracks, {});
  // adding to a position keeps its track, measured from the new average cost
  applyOrders(f, [{ symbol: 'C', action: 'buy', shares: 10, reason: '' }], { C: q(10) }, at('16:05'));
  applyOrders(f, [{ symbol: 'C', action: 'buy', shares: 10, reason: '' }], { C: q(12) }, at('16:10'));
  assert.deepEqual(f.tracks.C, { openedAt: at('16:05').toISOString(), from: at('16:05').toISOString(), entry: 11, worst: 0, best: 0.0909 });
  // a position from before tracking (an old fund) starts one when first seen
  delete f.tracks.C;
  checkProtections(f, { C: q(10.5, { intraday: [[t('16:30'), 10.5]] }) });
  assert.equal(f.tracks.C.late, true);
  assert.equal(f.tracks.C.worst, -0.0455);
});

test('with Tiger, the fill that closes a position carries its track; a split doesn\'t change the moves', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger', approval: 'auto' }, now: at('14:00') });
  executeDecision(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: 'r' }], { A: q(100) }, at('14:45'));
  Object.assign(f.brokerOrders[0], { status: 'filled', filledQty: 10, avgFillPrice: 100, fee: 0 });
  applyBrokerFills(f, at('15:00'));
  assert.equal(f.tracks.A.openedAt, at('15:00').toISOString());
  checkProtections(f, { A: q(92, { intraday: [[t('15:15'), 92], [t('15:30'), 108]] }) });
  // a 2-for-1 split halves the average cost, the price paid and the prices (actions.js): the same moves
  f.portfolio.positions.A = { ...f.portfolio.positions.A, qty: 20, avgCost: 50, entry: 50 };
  checkProtections(f, { A: q(53, { intraday: [[t('15:45'), 53]] }) });
  assert.deepEqual([f.tracks.A.worst, f.tracks.A.best], [-0.08, 0.08]);
  f.brokerOrders.push({ id: 'b2', source: 'decision', symbol: 'A', action: 'sell', side: 'sell', qty: 20, filledQty: 20, appliedQty: 0, avgFillPrice: 52, fee: 0, status: 'filled', market: 'US' });
  const [fill] = applyBrokerFills(f, at('16:00'));
  assert.deepEqual(fill.track, { openedAt: at('15:00').toISOString(), worst: -0.08, best: 0.08 });
  assert.equal(f.tracks.A, undefined);
});

// A quote holds about 5 days of 15-minute prices, and a fund that held nothing kept an old cursor: a new
// position must see only the prices after the one it was bought at (in the simulator) or after its
// order was made (with Tiger, whose fill time is stamped later, by the sync).
test('a new position only sees prices from after it opened: an earlier dip neither shows in its track nor fires its stop', () => {
  const s = (iso) => Date.parse(iso) / 1000;
  const bars = [
    [s('2026-09-21T14:00:00Z'), 100], [s('2026-09-21T19:45:00Z'), 99],
    [s('2026-09-22T15:00:00Z'), 88], [s('2026-09-22T15:15:00Z'), 86], [s('2026-09-22T19:45:00Z'), 97], // Tuesday's dip
    [s('2026-09-23T14:00:00Z'), 100], [s('2026-09-23T14:15:00Z'), 100.5],
  ];
  // what a run at `iso` has: the bars so far, the latest as the price
  const upTo = (iso, extra = {}) => {
    const b = bars.filter(([t]) => t <= s(iso));
    return { NVDA: q(b.at(-1)[1], { intraday: b, time: new Date(b.at(-1)[0] * 1000).toISOString() }), ...extra };
  };
  const run = (f, iso, orders = [], stop = 10) => {
    const now = new Date(iso);
    const events = checkProtections(f, upTo(iso), now);
    if (orders.length) {
      executeDecision(f, orders, upTo(iso), now);
      setProtections(f, orders.map((o) => ({ symbol: o.symbol, stop_loss_pct: stop, take_profit_pct: 0 })), { now });
    }
    return events;
  };
  const buy = [{ symbol: 'NVDA', action: 'buy', shares: 40, reason: 'r' }];
  // the simulator: holding nothing from Monday, it buys on Wednesday at 100 with a 10% stop
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100, feePlan: 'none' }, now: new Date('2026-09-21T13:00:00Z') });
  for (const iso of ['2026-09-21T14:05:00Z', '2026-09-22T15:20:00Z', '2026-09-22T19:50:00Z']) run(f, iso);
  assert.equal(f.cursor, s('2026-09-22T19:45:00Z')); // holding nothing, the cursor still keeps up
  run(f, '2026-09-23T14:05:00Z', buy);
  assert.equal(f.tracks.NVDA.from, '2026-09-23T14:00:00.000Z'); // the price it was bought at
  assert.deepEqual(run(f, '2026-09-23T14:20:00Z'), []);
  assert.deepEqual([f.tracks.NVDA.worst, f.tracks.NVDA.best], [0, 0.005]);
  assert.equal(f.portfolio.trades.length, 1);
  // however old the cursor (here a holding with no prices kept it from moving), the new position's
  // prices start at its fill
  const g = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100, feePlan: 'none' }, now: new Date('2026-09-21T13:00:00Z') });
  g.portfolio.positions.OLD = { qty: 1, avgCost: 10, currency: 'USD' };
  run(g, '2026-09-22T19:50:00Z');
  assert.equal(g.cursor, s('2026-09-21T13:00:00Z'));
  run(g, '2026-09-23T14:05:00Z', buy);
  assert.deepEqual(run(g, '2026-09-23T14:20:00Z'), []);
  assert.deepEqual([g.tracks.NVDA.worst, g.tracks.NVDA.best], [0, 0.005]);
  // with Tiger: the order is made on Wednesday at 14:05 and the sync stamps its fill at 14:21, after
  // that run's prices; Tuesday's dip is still left out, but an 11% fall at 14:15, after the order, fires
  // the stop-loss
  const tiger = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger', approval: 'auto', maxOrderPct: 100 }, now: new Date('2026-09-21T13:00:00Z') });
  for (const iso of ['2026-09-21T14:05:00Z', '2026-09-22T19:50:00Z']) run(tiger, iso);
  run(tiger, '2026-09-23T14:05:00Z', buy);
  Object.assign(tiger.brokerOrders[0], { status: 'filled', filledQty: 40, avgFillPrice: 100, fee: 0, filledAt: '2026-09-23T14:21:00.000Z' });
  applyBrokerFills(tiger, new Date('2026-09-23T14:21:30Z'));
  assert.deepEqual([tiger.tracks.NVDA.openedAt, tiger.tracks.NVDA.from], ['2026-09-23T14:21:00.000Z', '2026-09-23T14:05:00.000Z']);
  const later = upTo('2026-09-23T14:20:00Z');
  later.NVDA.intraday = [...later.NVDA.intraday.slice(0, -1), [s('2026-09-23T14:15:00Z'), 89]];
  Object.assign(later.NVDA, { price: 89, time: '2026-09-23T14:19:00Z' });
  const [e] = checkProtections(tiger, later, new Date('2026-09-23T14:21:30Z'));
  assert.match(e.why, /stop-loss at -10%/);
  assert.equal(e.price, 89);
  assert.equal(tiger.tracks.NVDA.worst, -0.11);
  assert.equal(tiger.brokerOrders.at(-1).source, 'protection');
});

test('the stop log keeps each change with the stock\'s daily move then, capped', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }], { A: q(100) }, at('14:45'));
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 5, take_profit_pct: 10 }], { now: at('14:45'), dailyMoves: { A: 1.8 } });
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 5, take_profit_pct: 10 }], { now: at('16:00'), dailyMoves: { A: 1.8 } }); // unchanged: not logged
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 3, take_profit_pct: 10 }, { symbol: 'Z', stop_loss_pct: 3 }], { now: at('17:00'), dailyMoves: { A: 1.9 } });
  setProtections(f, [{ symbol: 'A', stop_loss_pct: 0, take_profit_pct: 0 }]); // removed: logged, without a daily move
  assert.deepEqual(f.protectionLog.map((e) => [e.symbol, e.stop_loss_pct, e.take_profit_pct, e.dailyMovePct]), [['A', 5, 10, 1.8], ['A', 3, 10, 1.9], ['A', 0, 0, null]]);
  assert.equal(f.protectionLog[0].setAt, at('14:45').toISOString());
  for (let i = 0; i < PROTECTION_LOG_MAX + 20; i++) setProtections(f, [{ symbol: 'A', stop_loss_pct: 1 + (i % 2), take_profit_pct: 0 }]);
  assert.equal(f.protectionLog.length, PROTECTION_LOG_MAX);
});

test('a take-profit moved on its own isn\'t counted as a new stop-loss in the stop log\'s summary', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('14:00') });
  applyOrders(f, [{ symbol: 'NVDA', action: 'buy', shares: 10, reason: '' }, { symbol: 'MSFT', action: 'buy', shares: 10, reason: '' }], { NVDA: q(100), MSFT: q(400) }, at('14:45'));
  const moves = { dailyMoves: { NVDA: 2, MSFT: 1.5 } };
  setProtections(f, [{ symbol: 'NVDA', stop_loss_pct: 8, take_profit_pct: 0 }, { symbol: 'MSFT', stop_loss_pct: 1.5, take_profit_pct: 5 }], { now: at('14:45'), ...moves });
  // MSFT's take-profit trails up four times, its stop left alone
  for (const [i, take] of [6, 7, 8, 9].entries()) setProtections(f, [{ symbol: 'MSFT', stop_loss_pct: 1.5, take_profit_pct: take }], { now: at(`15:0${i}`), ...moves });
  assert.equal(f.protectionLog.length, 6);
  assert.deepEqual(f.protectionLog.map((e) => Boolean(e.stopKept)), [false, false, true, true, true, true]);
  assert.equal(stopLogSummary(f.protectionLog), null); // 2 stops set, not 6
  setProtections(f, [{ symbol: 'NVDA', stop_loss_pct: 6, take_profit_pct: 0 }], { now: at('16:00'), ...moves });
  assert.deepEqual(stopLogSummary(f.protectionLog), { n: 3, median: 3, under2: 1, since: at('14:45').toISOString() }); // 4, 1 and 3 moves
});

// ---------- the AI ----------

test('the cards and the owner\'s notes are in the shared market data, identical for every fund in the market; risk numbers in each fund\'s own part', async () => {
  const prices = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8'));
  const quotes = prices.quotes;
  const now = new Date('2026-01-02T21:30:00Z');
  const dossiers = buildDossiers({ quotes, now }).stocks;
  const a = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date('2026-01-02T15:00:00Z') });
  a.portfolio.positions.NVDA = { qty: 20, avgCost: 150, currency: 'USD' };
  a.protections.NVDA = { stop_loss_pct: 4, take_profit_pct: 0 };
  const b = newFund({ budget: 50000, currency: 'USD', style: 'aggressive', now: new Date('2026-01-02T15:00:00Z') });
  b.portfolio.positions.AAPL = { qty: 5, avgCost: 250, currency: 'USD' };
  const held = heldByMarket([a, b], quotes);
  let built = 0;
  const memo = {};
  const cards = (news) => (memo.US ??= (built++, stockCards('US', { dossiers, quotes, held: held.US, picks: null, news, now })));
  const notes = { AAPL: { text: 'Tariffs worry me.', at: '2026-01-01T00:00:00Z' }, 'D05.SI': { text: 'Hold elsewhere.', at: '2026-01-01T00:00:00Z' } };
  const news = { market_summary: 'm', items: [{ symbols: ['TSLA'], date: '2026-01-02', headline: 'h' }], model: 'claude-haiku-4-5', createdAt: 'x' };
  const calls = [];
  const client = { beta: { messages: { stream: (req) => { calls.push(structuredClone(req)); return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't', name: FUND_TOOL.name, input: { outlook: 'o', orders: [], considered: [], protections: [], source_urls: [] } }], usage: { input_tokens: 1, output_tokens: 1 } }) }; } } } };
  for (const fund of [a, b]) await decideFund({ client, fund, quotes, news, cards, notes, dossiers, cacheShared: true, now });
  assert.equal(built, 1); // chosen once for the market
  const [s1, s2] = calls.map((c) => c.messages[0].content[0].text);
  assert.equal(s1, s2); // one cached copy for both funds
  const market = JSON.parse(s1.split('\n\n')[1]);
  assert.deepEqual(Object.keys(market.stock_cards), ['NVDA', 'AAPL', 'TSLA']); // held (the bigger first), then in the news
  assert.ok(Object.values(market.stock_cards).every((lines) => lines.length >= 1 && lines.length <= 3));
  assert.deepEqual(market.owner_notes, { AAPL: 'Tariffs worry me.' }); // its market's notes only
  const own = JSON.parse(calls[0].messages[0].content[1].text.split('\n\n')[1]);
  const nvda = own.positions.find((p) => p.symbol === 'NVDA');
  assert.equal(nvda.risk_pct_of_fund, Math.round((Math.abs(nvda.value) / own.fund.value) * dossiers.NVDA.daily_move_pct * 100) / 100);
  // how far today's price is above the stop's level (4% below its average price of 150), in daily moves
  assert.equal(nvda.stop_in_daily_moves, Math.round((((nvda.price - 150 * 0.96) / nvda.price) * 100 / dossiers.NVDA.daily_move_pct) * 10) / 10);
  assert.ok('suggested_stop_pct' in nvda); // null without the ten-year memory
  assert.match(FUND_SYSTEM, /stock_cards/);
  assert.match(FUND_SYSTEM, /not limits/);
  // without cards, notes or dossiers the context is as before
  const plain = fundContext({ fund: a, quotes, picks: null, news, now });
  assert.equal(plain.stock_cards, undefined);
  assert.equal(plain.owner_notes, undefined);
  assert.equal(plain.positions[0].risk_pct_of_fund, undefined);
});

// ---------- the scripts ----------

test('the owner\'s note on a stock reaches the job through the settings passthrough, and its words are never printed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-'));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'state'));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [], archived: [] }));
  const run = (command) => execFileSync('node', [join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', FUND_COMMAND: JSON.stringify(command), FUND_PRIVATE: '' },
  });
  const out = run({ fund: 'all', stockNote: { symbol: 'D05.SI', text: 'my secret plan for DBS' } });
  let c = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.equal(c.stockNotes['D05.SI'].text, 'my secret plan for DBS');
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok, c.lastCommand.fund], ['notes', true, 'all']);
  assert.match(c.lastCommand.message, /Saved your note on D05\.SI/);
  assert.doesNotMatch(out + c.lastCommand.message, /secret plan/);
  run({ fund: 'all', stockNote: { symbol: 'D05.SI', text: '' } });
  c = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.deepEqual(c.stockNotes, {});
  assert.match(c.lastCommand.message, /Cleared your note on D05\.SI/);
  run({ fund: 'all', stockNote: { symbol: 'NOPE', text: 'x' } });
  c = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok], ['notes', false]);
});

test('in Actions the app\'s command is read from the event file on the runner, never put where the public log prints it', async () => {
  // the workflow: no step puts the fund_command input in its env or its script (both are printed in the log)
  const yml = await readFile(join(root, '.github/workflows/prices.yml'), 'utf8');
  assert.doesNotMatch(yml, /\$\{\{\s*(github\.event\.)?inputs\.fund_command\s*\}\}/);
  const dir = await mkdtemp(join(tmpdir(), 'event-'));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'state'));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [], archived: [] }));
  const command = { fund: 'all', stockNote: { symbol: 'D05.SI', text: 'my secret plan for DBS' } };
  await writeFile(join(dir, 'event.json'), JSON.stringify({ inputs: { fund_command: JSON.stringify(command), refresh_picks: false } }));
  const { FUND_COMMAND, ...env } = process.env;
  const run = (extra) => spawnSync('node', [join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...env, ANTHROPIC_API_KEY: '', FUND_PRIVATE: '', GITHUB_EVENT_PATH: join(dir, 'event.json'), ...extra },
  });
  const out = run({});
  const c = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.equal(c.stockNotes['D05.SI'].text, 'my secret plan for DBS');
  assert.doesNotMatch(out.stdout + out.stderr, /secret plan/);
  // a command that isn't JSON is ignored without printing it
  const bad = run({ FUND_COMMAND: '{"fund":"all","stockNote":{"text":"my secret plan"' });
  assert.match(bad.stderr, /Ignoring the app's command: it isn't JSON/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /secret plan/);
});

test('the public copy keeps when each note was saved but never its words, the latest stop log, and only each track\'s worst and best', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-'));
  const f = newFund({ budget: 1000, currency: 'USD', now: at('14:00') });
  f.id = 'f1';
  f.tracks = { A: { openedAt: at('14:00').toISOString(), entry: 100, worst: -0.02, best: 0.05 }, B: { openedAt: at('15:00').toISOString(), late: true, entry: 10, worst: -0.01, best: 0 } };
  f.protectionLog = Array.from({ length: 120 }, (_, i) => ({ symbol: 'A', stop_loss_pct: i, take_profit_pct: 0, setAt: at('14:00').toISOString(), dailyMovePct: 1 }));
  const c = { version: 2, funds: [f], archived: [], stockNotes: { 'D05.SI': { text: 'private words', at: '2026-01-01T00:00:00Z' } } };
  await writeFile(join(dir, 'in.json'), JSON.stringify(c));
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'in.json'), join(dir, 'out.json')], { cwd: root });
  const out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(out.stockNotes, { 'D05.SI': { at: '2026-01-01T00:00:00Z' } });
  assert.doesNotMatch(JSON.stringify(out), /private words/);
  assert.equal(out.funds[0].protectionLog.length, 50);
  assert.equal(out.funds[0].protectionLog.at(-1).stop_loss_pct, 119);
  assert.deepEqual(out.funds[0].tracks, { A: { worst: -0.02, best: 0.05 }, B: { worst: -0.01, best: 0, late: true, openedAt: at('15:00').toISOString() } }); // when tracking began
});

test('build-history.mjs refreshes the stock cards once a day from this run\'s prices, prices and news only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dossiers-'));
  await mkdir(join(dir, 'state'));
  const run = () => execFileSync('node', [join(root, 'scripts/build-history.mjs'), 'dossiers', 'state/dossiers.json'], { cwd: dir, encoding: 'utf8' });
  assert.match(run(), /no prices this run/);
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'picks-history.json'), JSON.stringify([{ createdAt: '2025-10-01T02:00:00Z', picks: [{ symbol: 'D05.SI', stance: 'long', price: 1.5 }] }]));
  assert.match(run(), /Stock cards: \d+ stocks, [\d.]+ KB, without the ten-year memory yet/);
  const d = JSON.parse(await readFile(join(dir, 'state', 'dossiers.json'), 'utf8'));
  assert.ok(d.refreshedAt && d.stocks['D05.SI'].daily_move_pct > 0 && d.stocks['D05.SI'].picks.week.n === 1);
  assert.equal(d.stocks.SPY, undefined);
  assert.match(run(), /refreshed within the day/);
  // a new ten-year build makes it due again
  await writeFile(join(dir, 'state', 'memory-long.json'), JSON.stringify({ updatedAt: new Date().toISOString(), stocks: { 'D05.SI': { market: 'SGX', stops: { holds: 10, long: { hits: [1, 1, 1, 1], k: 4 }, short: { hits: [1, 1, 1, 1], k: 4 } } } } }));
  assert.match(run(), /with the ten-year memory of/);
  const again = JSON.parse(await readFile(join(dir, 'state', 'dossiers.json'), 'utf8'));
  assert.ok(again.stocks['D05.SI'].stops.suggested_stop_pct.long > 0);
  // the weekly ten-year build writes them too, with its own per-stock history
  const raw = join(dir, 'raw');
  await mkdir(raw);
  const symbols = JSON.parse(await readFile(join(root, 'symbols.json'), 'utf8'));
  const ts = weekdays(300, '2025-08-01');
  const rand = seeded(3);
  for (const s of [...symbols.map((x) => x.symbol), '^VIX']) {
    const closes = walk(300, () => 0.012 * gauss(rand));
    const result = { meta: { currency: 'USD', regularMarketPrice: closes.at(-1) }, timestamp: ts, indicators: { quote: [{ close: closes, volume: closes.map(() => 1000), high: closes, low: closes }], adjclose: [{ adjclose: closes }] } };
    await writeFile(join(raw, `${encodeURIComponent(s)}_10y_1d.json`), JSON.stringify({ chart: { result: [result] } }));
  }
  const out = execFileSync('node', [join(root, 'scripts/build-history.mjs'), 'build', 'raw', 'state/memory-long.json'], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /Ten-year prices: 17 stocks[\s\S]*Stock cards: \d+ stocks, [\d.]+ KB, with the ten-year memory of/);
  const weekly = JSON.parse(await readFile(join(dir, 'state', 'dossiers.json'), 'utf8'));
  const mem = JSON.parse(await readFile(join(dir, 'state', 'memory-long.json'), 'utf8'));
  assert.equal(weekly.longAt, mem.updatedAt);
  assert.ok(weekly.stocks.NVDA.stops.hits.long.length === 4);
});
