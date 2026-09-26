import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectIdeas, gradeIdeas, learningStats, statLessons, updatePlaybook, activeLessons, playbookForPrompt, editPlaybook, reviewDue, applyReview, quietReason, decisionSnapshot, QUIET } from '../learning.js';
import { mergeEvents, eventsFromDigest, measureEvents, bigMoves, buildMemory, plausibleDate } from '../memory.js';
import { newFund } from '../fund.js';

const DAY = 86400;
const T0 = Date.parse('2026-03-02T14:30:00Z') / 1000; // first bar
const iso = (i, h = 16) => new Date((T0 + i * DAY + (h - 14.5) * 3600) * 1000).toISOString();
const series = (f, n = 40) => Array.from({ length: n }, (_, i) => [T0 + i * DAY, f(i)]);
const q = (f, market = 'US', currency = 'USD') => ({ market, currency, price: f(39), daily: series(f), intraday: [] });
const now = new Date((T0 + 45 * DAY) * 1000);

test('every idea is collected: trades, declined, expired, blocked, passed-on, exits and stop-losses', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  f.proposals = [{ id: 'p1', status: 'rejected' }, { id: 'p2', status: 'expired' }];
  f.decisions = [
    { time: iso(1), orders: [
      { symbol: 'A', action: 'buy', status: 'filled', price: 100, ideaType: 'news', conviction: 'high', reason: 'beat' },
      { symbol: 'B', action: 'buy', status: 'awaiting approval', proposalId: 'p1', refPrice: 50, ideaType: 'momentum' },
      { symbol: 'C', action: 'short', status: 'awaiting approval', proposalId: 'p2', refPrice: 20 },
      { symbol: 'D', action: 'buy', status: 'rejected', message: 'Over the per-order limit' },
      { symbol: 'E', action: 'sell', status: 'filled', price: 30 },
    ], considered: [{ symbol: 'F', stance: 'short', idea_type: 'value', why_not: 'too early' }] },
    { time: iso(2), orders: [], skipped: true },
  ];
  f.events = [{ time: iso(3), symbol: 'A', action: 'sell', shares: 10, price: 95, why: 'stop-loss at -5%' }];
  const ideas = collectIdeas(f);
  assert.deepEqual(ideas.map((i) => [i.symbol, i.kind, i.outcome, i.direction]), [
    ['A', 'entry', 'traded', 1], ['B', 'entry', 'declined', 1], ['C', 'entry', 'expired', -1], ['D', 'entry', 'blocked', 1],
    ['E', 'exit', 'exit', 1], ['F', 'entry', 'passed', -1], ['A', 'exit', 'stop-loss', 1],
  ]);
});

test('ideas are graded a week and a month later, in their direction and against the index', () => {
  const quotes = { A: q((i) => 100 + i), SPY: q((i) => 400 + i * 2), F: q((i) => 50 - i * 0.5) };
  const ideas = [
    { id: 'a', t: T0 + 8 * 3600, symbol: 'A', direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'news', price: 100 },
    { id: 'f', t: T0 + 8 * 3600, symbol: 'F', direction: -1, kind: 'entry', outcome: 'passed', ideaType: 'value', price: null },
  ];
  const [a, f] = gradeIdeas(ideas, quotes, 'USD', now);
  assert.ok(Math.abs(a.week.move - 0.05) < 1e-9); // 5 trading days later: 105
  assert.ok(Math.abs(a.week.index - 0.025) < 1e-9);
  assert.ok(Math.abs(f.week.move - 0.05) < 1e-9); // a short idea on a falling stock: +5%
  assert.equal(f.price, 50); // no price given: the close before the idea
  assert.equal(gradeIdeas(ideas, quotes, 'USD', new Date((T0 + 3 * DAY) * 1000)).length, 0); // too early
});

test('lessons need 5 cases and come with evidence; passed-on ideas and early exits teach too', () => {
  const g = (outcome, move, index = 0, extra = {}) => ({ kind: outcome === 'exit' || outcome === 'stop-loss' ? 'exit' : 'entry', outcome, direction: 1, ideaType: 'news', conviction: 'medium', week: { move, index }, month: null, ...extra });
  const graded = [
    ...Array.from({ length: 5 }, () => g('traded', -0.03, 0.01)),
    ...Array.from({ length: 5 }, () => g('passed', 0.04, 0.01)),
    ...Array.from({ length: 5 }, () => g('exit', 0.03)),
    ...Array.from({ length: 4 }, () => g('stop-loss', 0.05)),
  ];
  const lessons = statLessons(learningStats(graded));
  const ids = lessons.map((l) => l.id);
  assert.ok(ids.includes('type-weak:news'));
  assert.ok(ids.includes('passed-better'));
  assert.ok(ids.includes('exit-early'));
  assert.ok(!ids.includes('stops-tight')); // only 4 cases
  assert.match(lessons.find((l) => l.id === 'passed-better').evidence, /Ideas passed on: 5 cases, 100% right, average \+4.0%, \+3.0% vs the index/);
});

test('the playbook: owner lessons first, hidden ones stay hidden, and it reaches the AI only with something to say', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: new Date(iso(0)) });
  updatePlaybook(f, {}, now);
  assert.equal(playbookForPrompt(f.playbook), null);
  editPlaybook(f, { add: 'Avoid airlines before earnings.' }, now);
  f.playbook.lessons = [{ id: 'shorts-weak', text: 'Shorts lost.', evidence: 'x', source: 'results' }];
  editPlaybook(f, { remove: 'shorts-weak' }, now);
  assert.deepEqual(activeLessons(f.playbook).map((l) => l.text), ['Avoid airlines before earnings.']);
  const own = f.playbook.own[0].id;
  editPlaybook(f, { remove: own }, now);
  assert.equal(f.playbook.own.length, 0);
  const p = playbookForPrompt(f.playbook, { picksRecord: 'picks: 55% right', marketLessons: [{ id: 'US:big-up', text: 'After jumps...', evidence: 'e' }] });
  assert.deepEqual(Object.keys(p), ['graded_ideas', 'lessons', 'market_memory', 'home_page_picks_record']);
});

test('the weekly review runs only with 5+ new graded ideas and a week since the last', () => {
  const f = newFund({ budget: 1000, currency: 'USD' });
  f.playbook = { graded: 4, reviewGraded: 0 };
  assert.equal(reviewDue(f, now), false);
  f.playbook.graded = 6;
  assert.equal(reviewDue(f, now), true);
  applyReview(f, [{ text: 'Cut losers faster.', evidence: '6 cases' }], 6, now);
  assert.equal(f.playbook.review[0].source, 'weekly review');
  f.playbook.graded = 20;
  assert.equal(reviewDue(f, new Date(now.getTime() + 2 * DAY * 1000)), false);
  assert.equal(reviewDue(f, new Date(now.getTime() + 7 * DAY * 1000)), true);
  f.settings.learning = false;
  assert.equal(reviewDue(f, new Date(now.getTime() + 7 * DAY * 1000)), false);
});

test('a decision is skipped only when nothing changed, and never more than twice in a row', () => {
  const f = newFund({ budget: 1000, currency: 'USD' });
  f.portfolio.positions.A = { qty: 1, avgCost: 100, currency: 'USD' };
  const quotes = { A: { price: 100 }, SPY: { price: 400 } };
  const marks = { picksAt: 'p1', newsAt: 'n1' };
  assert.equal(quietReason(f, quotes, marks), null); // no earlier decision
  f.decisions.push({ time: 't', orders: [], snapshot: decisionSnapshot(f, quotes, marks) });
  assert.match(quietReason(f, { A: { price: 101 }, SPY: { price: 402 } }, marks), /Skipped to save AI cost/);
  assert.equal(quietReason(f, { A: { price: 103 }, SPY: { price: 400 } }, marks), null); // a stock moved 3%
  assert.equal(quietReason(f, { A: { price: 100 }, SPY: { price: 405 } }, marks), null); // the index moved 1.25%
  assert.equal(quietReason(f, quotes, { ...marks, newsAt: 'n2' }), null); // fresh news
  f.skipStreak = QUIET.maxSkips;
  assert.equal(quietReason(f, quotes, marks), null);
  f.skipStreak = 0; f.settings.skipQuiet = false;
  assert.equal(quietReason(f, quotes, marks), null);
});

test('market memory: news events are measured after the fact and become lessons with 5+ cases', () => {
  // five stocks that jump on good news, then keep drifting up; the index is flat
  const quotes = { SPY: q(() => 400) };
  const events = [];
  for (let k = 0; k < 5; k++) {
    const s = `S${k}`;
    quotes[s] = q((i) => (i < 10 ? 100 : 106 + (i - 10) * 0.5));
    events.push({ symbol: s, date: new Date((T0 + 10 * DAY) * 1000).toISOString().slice(0, 10), headline: `Beat ${k}`, type: 'earnings', tone: 'positive', from: 'backfill' });
  }
  const merged = mergeEvents([], [...events, events[0], { symbol: 'ZZZ', date: '2026-03-12', headline: 'x' }], quotes);
  assert.equal(merged.length, 5); // duplicate and unknown stock dropped
  const measured = measureEvents(merged, quotes, 'US');
  assert.ok(Math.abs(measured[0].day.move - 0.06) < 1e-9);
  assert.ok(Math.abs(measured[0].week.move - 2.5 / 106) < 1e-9);
  const memory = buildMemory(merged, quotes, 'US', now);
  assert.ok(memory.lessons.some((l) => l.id === 'US:news-positive' && /keep going the same way/.test(l.text)));
  assert.ok(memory.lessons.some((l) => l.id === 'US:big-up')); // the 6% jumps count as big moves too
  assert.equal(bigMoves(quotes, 'US').length, 5);
  assert.deepEqual(eventsFromDigest({ items: [{ symbols: ['A', 'B'], date: '2026-03-12T10:00', headline: 'h', type: 'deal', tone: 'positive' }] }).map((e) => [e.symbol, e.date]), [['A', '2026-03-12'], ['B', '2026-03-12']]);
});

test('earnings dated at a quarter end are ignored, and a narrower lesson on the same cases isn\'t repeated', () => {
  assert.equal(plausibleDate({ type: 'earnings', date: '2025-09-27' }), false); // Apple's fiscal quarter end, not the report day
  assert.equal(plausibleDate({ type: 'earnings', date: '2025-10-30' }), true);
  assert.equal(plausibleDate({ type: 'deal', date: '2025-12-28' }), true);
  const quotes = { SPY: q(() => 400) };
  const events = [];
  for (let k = 0; k < 5; k++) {
    quotes[`S${k}`] = q((i) => (i < 10 ? 100 : 106 + (i - 10) * 0.5));
    events.push({ symbol: `S${k}`, date: new Date((T0 + 10 * DAY) * 1000).toISOString().slice(0, 10), headline: `Beat ${k}`, type: 'earnings', tone: 'positive' });
  }
  const ids = buildMemory(mergeEvents([], events, quotes), quotes, 'US', now).lessons.map((l) => l.id);
  assert.ok(ids.includes('US:news-positive'));
  assert.ok(!ids.includes('US:news-positive-earnings')); // same 5 cases
});
