import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectIdeas, gradeIdeas, learningStats, statLessons, updatePlaybook, activeLessons, playbookForPrompt, editPlaybook, reviewDue, applyReview, quietReason, decisionSnapshot, QUIET,
  poolIdeas, frozenIdeas, freezeIdeas, trimDecisions, reviewLessonId, CLASS_CODES, TYPE_CODES, IDEA_LOG_MAX, ideaRow as ideaRowOf,
  evaluateLessons, chargeFees, noiseCheck, noiseFund, statsForReview, NOISE_CHECK,
  calibration, calibrationLessons, poolCalibration, CATALYST_CODES, calibrationNoiseCheck, CAL_NOISE_CHECK, rememberCited, CITED_MAX,
} from '../learning.js';
import { seeded, gauss } from '../stats.js';
import { mergeEvents, eventsFromDigest, measureEvents, bigMoves, buildMemory, plausibleDate, effectiveDateOf } from '../memory.js';
import { newFund } from '../fund.js';

const DAY = 86400;
const T0 = Date.parse('2026-03-02T14:30:00Z') / 1000; // first bar
const iso = (i, h = 16) => new Date((T0 + i * DAY + (h - 14.5) * 3600) * 1000).toISOString();
const series = (f, n = 40) => Array.from({ length: n }, (_, i) => [T0 + i * DAY, f(i)]);
const q = (f, market = 'US', currency = 'USD') => ({ market, currency, price: f(39), daily: series(f), intraday: [] });
const now = new Date((T0 + 45 * DAY) * 1000);
const priceOf = (quote, i) => quote.daily[i][1];

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

test('lessons need 8 separate bets and a confident edge after beta and fees, and come with evidence', () => {
  const week = (k) => T0 + k * 7 * DAY;
  const g = (outcome, k, move, index = 0, extra = {}) => ({
    id: `${outcome}${k}`, t: week(k), symbol: `S${k % 9}`, kind: ['exit', 'stop-loss'].includes(outcome) ? 'exit' : 'entry', outcome, direction: 1,
    ideaType: 'news', conviction: 'medium', beta: 1, idio: 0.03, fee: 0, week: { move: move + (k % 2 ? 0.002 : -0.002), index, peer: null }, month: null, ...extra,
  });
  const graded = [
    ...Array.from({ length: 12 }, (_, k) => g('traded', k, -0.03, 0.01)),
    ...Array.from({ length: 12 }, (_, k) => g('passed', k, 0.04, 0.01)),
    ...Array.from({ length: 12 }, (_, k) => g('exit', k, 0.03)),
    // twelve stop-losses on one stock on one day: one separate bet, so only watched
    ...Array.from({ length: 12 }, (_, k) => ({ ...g('stop-loss', 0, 0.08), id: `s${k}`, symbol: 'A', t: T0 + k * 600 })),
  ];
  const { lessons, watching } = evaluateLessons(learningStats(graded));
  const ids = lessons.map((l) => l.id);
  assert.ok(ids.includes('type-weak:news'));
  assert.ok(ids.includes('passed-better'));
  assert.ok(ids.includes('exit-early'));
  assert.ok(!ids.includes('stops-tight'));
  const stops = watching.find((w) => w.id === 'stops-tight');
  assert.equal(stops.bets, 1);
  assert.ok(stops.more >= 7);
  const passed = lessons.find((l) => l.id === 'passed-better');
  assert.match(passed.evidence, /^Ideas passed on: 12 ideas, 12 separate bets\. \+3\.0% a week vs the index: \+0\.0% of that from beta, leaving a stock-specific edge of \+[12]\.\d% \(likely /);
  assert.ok(['High', 'Moderate'].includes(passed.confidence) && passed.p >= 0.97 && passed.bets === 12 && passed.lo < passed.edge && passed.edge < passed.hi);
  // the same five ideas as before the engine (5 cases) are no longer enough
  assert.deepEqual(statLessons(learningStats(graded.filter((x) => x.outcome === 'traded').slice(0, 5))), []);
});

test('a result that only reflects beta is called that, and fees and peers are counted', () => {
  const g = (k, extra = {}) => ({
    id: `b${k}`, t: T0 + k * 7 * DAY, symbol: 'D05.SI', kind: 'entry', outcome: 'traded', direction: 1, ideaType: 'momentum', conviction: 'high',
    idio: 0.03, fee: 0, month: null, ...extra,
  });
  // beta 2 stocks in weeks the index rose 1%: 1% ahead of the index, all of it beta
  const betaOnly = Array.from({ length: 30 }, (_, k) => g(k, { beta: 2, week: { move: 0.02 + (k % 2 ? 0.001 : -0.001), index: 0.01, peer: 0.02 } }));
  const st = learningStats(betaOnly);
  const ev = st.tradedByType.momentum.ev;
  assert.ok(Math.abs(ev.vsIndex - 0.01) < 1e-6 && Math.abs(ev.fromBeta - 0.01) < 1e-6 && Math.abs(ev.edge.mean) < 1e-6);
  const ids = statLessons(st).map((l) => l.id);
  assert.ok(ids.includes('beta-driven') && !ids.includes('beta-driven:momentum')); // the same trades: said once
  assert.ok(statLessons(learningStats([...betaOnly, ...betaOnly.map((g) => ({ ...g, ideaType: 'news', symbol: 'O39.SI' }))])).some((l) => l.id === 'beta-driven:momentum'));
  assert.ok(!ids.some((id) => id.startsWith('type-strong')));
  // DBS buys that beat the index but lagged OCBC and UOB: right on banks, wrong bank
  const wrongBank = Array.from({ length: 30 }, (_, k) => g(k, { beta: 1, week: { move: 0.01 + (k % 2 ? 0.001 : -0.001), index: 0, peer: 0.025 } }));
  const peer = statLessons(learningStats(wrongBank)).find((l) => l.id === 'peer-weak:D05.SI|1');
  assert.match(peer.text, /Your DBS buys beat the index but lagged OCBC and UOB: right on banks, wrong bank/);
  // each lesson says what its number measures: a beta-driven one is against the index (its edge is ~0)
  const bd = statLessons(st).find((l) => l.id === 'beta-driven');
  assert.equal(bd.measure, 'index');
  assert.ok(bd.edge > 0.005 && Math.abs(bd.stockEdge) < 1e-6);
  assert.deepEqual([peer.measure, peer.vs], ['peers', 'OCBC and UOB']);
  const forAI = playbookForPrompt({ lessons: [bd, peer] }).lessons;
  assert.ok('vs_index_pct_per_week' in forAI[0] && forAI[0].edge_pct_per_week === 0); // not told the index result is the edge
  assert.ok('vs_peers_pct_per_week' in forAI[1] && forAI[1].peers === 'OCBC and UOB' && !('edge_pct_per_week' in forAI[1]));
  // fees: a round trip taken off the edge, and money made per trade after them
  const fees = learningStats(Array.from({ length: 4 }, (_, k) => g(k, { beta: 1, fee: 0.004, value: 2500, week: { move: 0.01, index: 0, peer: null } }))).byOutcome.traded.ev;
  assert.ok(Math.abs(fees.fees + 0.004) < 1e-9 && Math.abs(fees.edge.mean - 0.006) < 1e-9 && fees.money === 15);
});

test('a lesson stays on until its chance falls below 3 in 4, and one seen before the switch keeps the old measure for a while', () => {
  const graded = Array.from({ length: 10 }, (_, k) => ({
    id: `p${k}`, t: T0 + k * 7 * DAY, symbol: `S${k % 9}`, kind: 'entry', outcome: 'passed', direction: 1, ideaType: 'value', beta: 1, idio: 0.03, fee: 0,
    week: { move: (k % 2 ? 0.02 : -0.003), index: 0, peer: null }, month: null,
  }));
  const est = learningStats(graded).byOutcome.passed.ev.edge;
  assert.ok(est.p >= 0.75 && est.p < 0.97); // not enough for a new lesson...
  assert.ok(!statLessons(learningStats(graded)).some((l) => l.id === 'passed-better'));
  const kept = statLessons(learningStats(graded), { was: ['passed-better'], gated: ['passed-better'] }).find((l) => l.id === 'passed-better');
  assert.equal(kept.confidence, 'Fading'); // ...but one already shown, that passed the gate, stays
  assert.equal(kept.gated, true);
  // one inherited from before the engine (never through the gate) keeps the lower level only during the transition
  assert.ok(statLessons(learningStats(graded), { was: ['passed-better'], transition: true }).some((l) => l.id === 'passed-better'));
  assert.ok(!statLessons(learningStats(graded), { was: ['passed-better'] }).some((l) => l.id === 'passed-better'));
  // a type lesson from before the evidence engine (5 cases, 1%+ behind the index) survives the switch for a while
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  f.playbook = { lessons: [{ id: 'type-weak:news', text: 'old', source: 'results' }] };
  const quotes = { A: q((i) => 100 - i * 0.2), SPY: q((i) => 400 + i) };
  f.decisions = [0, 8, 16, 24, 32].map((d) => ({ time: iso(d), orders: [{ symbol: 'A', action: 'buy', status: 'filled', shares: 10, price: priceOf(quotes.A, d), ideaType: 'news' }] }));
  updatePlaybook(f, quotes, now);
  assert.ok(f.playbook.edgeFrom);
  const l = f.playbook.lessons.find((x) => x.id === 'type-weak:news');
  assert.match(l.evidence, /Kept for now/);
  assert.equal(f.playbook.lessonRecord['type-weak:news'].on, true);
  updatePlaybook(f, quotes, new Date(now.getTime() + 40 * DAY * 1000)); // after the transition: the edge alone decides
  assert.ok(!f.playbook.lessons.some((x) => x.id === 'type-weak:news'));
  // an inherited lesson still on at the end of the transition, never gated: from then on it needs the full gate
  const g = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  g.playbook = { lessons: [], lessonRecord: { 'passed-better': { on: true, since: iso(0), p: 0.8 } }, edgeFrom: iso(0) };
  g.ideaLog = graded.map((x) => ideaRowOf(x));
  updatePlaybook(g, {}, new Date(now.getTime() + 40 * DAY * 1000));
  assert.ok(!g.playbook.lessons.some((x) => x.id === 'passed-better'));
  // the same record, gated: kept (Fading)
  g.playbook.lessonRecord = { 'passed-better': { on: true, since: iso(0), p: 0.98, gated: true } };
  updatePlaybook(g, {}, new Date(now.getTime() + 40 * DAY * 1000));
  const still = g.playbook.lessons.find((x) => x.id === 'passed-better');
  assert.equal(still?.confidence, 'Fading');
  assert.equal(g.playbook.lessonRecord['passed-better'].gated, true);
});

test('pure noise rarely makes a lesson: the Monte Carlo check behind the gate', () => {
  const r = noiseCheck();
  assert.deepEqual(r, NOISE_CHECK); // the figure the page prints
  assert.ok(r.moreThanOne <= 0.05, `pure noise showed 2+ lessons in ${r.moreThanOne * 100}% of runs`);
  // and a real edge is found: ideas passed on that beat the market by 1% a week
  const ideas = noiseFund(seeded(3)).map((i) => (i.outcome === 'passed' ? { ...i, week: { ...i.week, move: i.week.move + 0.01 } } : i));
  assert.ok(statLessons(learningStats(ideas)).some((l) => l.id === 'passed-better'));
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

// Ten stocks that jump 6% on good news on ten different days, then keep drifting up; the index is flat.
function drifting(n = 10, dayOf = (k) => 5 + 2 * k) {
  const quotes = { SPY: q(() => 400) };
  const events = [];
  for (let k = 0; k < n; k++) {
    const s = `S${k}`, d = dayOf(k);
    quotes[s] = q((i) => (i < d ? 100 : 106 + (i - d) * 0.5));
    events.push({ symbol: s, date: new Date((T0 + d * DAY) * 1000).toISOString().slice(0, 10), headline: `Deal ${k}`, type: 'deal', tone: 'positive', from: 'backfill' });
  }
  return { quotes, events };
}

test('market memory: news events are measured after the fact and become lessons with 8+ separate bets', () => {
  const { quotes, events } = drifting();
  const merged = mergeEvents([], [...events, events[0], { symbol: 'ZZZ', date: '2026-03-12', headline: 'x' }], quotes);
  assert.equal(merged.length, 10); // duplicate and unknown stock dropped
  const measured = measureEvents(merged, quotes, 'US');
  assert.ok(Math.abs(measured[0].day.move - 0.06) < 1e-9);
  assert.ok(Math.abs(measured[0].week.move - 2.5 / 106) < 1e-9);
  const memory = buildMemory(merged, quotes, 'US', now);
  const news = memory.lessons.find((l) => l.id === 'US:news-positive');
  assert.match(news.text, /keep going the same way/);
  assert.match(news.evidence, /^10 cases, 10 separate bets on 10 days: 100% kept going/);
  assert.ok(news.confidence && news.bets === 10);
  assert.ok(memory.lessons.some((l) => l.id === 'US:big-up')); // the 6% jumps count as big moves too
  assert.equal(bigMoves(quotes, 'US').length, 10);
  // five stocks on one day are one market-wide event, not five lessons' worth
  const oneDay = drifting(10, () => 10);
  assert.equal(buildMemory(mergeEvents([], oneDay.events, oneDay.quotes), oneDay.quotes, 'US', now).lessons.length, 0);
  assert.deepEqual(eventsFromDigest({ items: [{ symbols: ['A', 'B'], date: '2026-03-12T10:00', headline: 'h', type: 'deal', tone: 'positive' }] }).map((e) => [e.symbol, e.date]), [['A', '2026-03-12'], ['B', '2026-03-12']]);
});

test('earnings dated at a quarter end are ignored, and a narrower lesson on the same cases isn\'t repeated', () => {
  assert.equal(plausibleDate({ type: 'earnings', date: '2025-09-27' }), false); // Apple's fiscal quarter end, not the report day
  assert.equal(plausibleDate({ type: 'earnings', date: '2025-10-30' }), true);
  assert.equal(plausibleDate({ type: 'deal', date: '2025-12-28' }), true);
  const { quotes, events } = drifting();
  const ids = buildMemory(mergeEvents([], events, quotes), quotes, 'US', now).lessons.map((l) => l.id);
  assert.ok(ids.includes('US:news-positive'));
  assert.ok(!ids.includes('US:news-positive-deal')); // same 10 cases
});

// ---------- grading what was really bet, with dividends, and keeping it ----------

test('a repeated idea counts once: repeats within 5 trading days join the first, also when pooling funds', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  const pass = { symbol: 'NVDA', stance: 'long', idea_type: 'momentum', why_not: 'too extended' };
  // four decisions a day, Monday to Friday, all passing on NVDA; then again the Tuesday after
  f.decisions = [0, 1, 2, 3, 4].flatMap((day) => [14, 15, 16, 17].map((h) => ({ time: iso(day, h), orders: [], considered: [pass] })));
  f.decisions.push({ time: iso(8), orders: [{ symbol: 'NVDA', action: 'buy', status: 'filled', shares: 1, price: 100, fee: 1 }], considered: [pass] });
  const ideas = collectIdeas(f);
  assert.deepEqual(ideas.map((i) => [i.outcome, i.repeats, i.t]), [
    ['passed', 20, Date.parse(iso(0, 14)) / 1000], // one idea, with its first time
    ['traded', 1, Date.parse(iso(8)) / 1000], // acting on it is a different idea
    ['passed', 1, Date.parse(iso(8)) / 1000], // 6 trading days later: a new idea
  ]);
  assert.equal(ideas[1].fee, 0.01); // the simulator's fee, as a share of the trade
  // two funds passing on the same stock the same week are one idea when pooled
  const g = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  g.decisions = [{ time: iso(2), orders: [], considered: [pass] }];
  const pooled = poolIdeas([collectIdeas(f), collectIdeas(g)]);
  assert.equal(pooled.length, 3);
  assert.equal(pooled[0].repeats, 21);
});

test('an idea from before the price history is not graded on the wrong days', () => {
  const quotes = { A: q((i) => 100 + i), SPY: q(() => 400) };
  const old = { id: 'o', t: T0 - 200 * DAY, symbol: 'A', direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'news', price: 90 };
  const ok = { ...old, id: 'k', t: T0 + 8 * 3600, price: 100 };
  assert.deepEqual(gradeIdeas([old, ok], quotes, 'USD', now).map((g) => g.id), ['k']);
});

test('dividends count: a buy across a 2% ex-date drop grades about 0, and a short across it gains nothing', () => {
  const div = { dividends: [[T0 + 3 * DAY, 2]] }; // S$2 a share, ex on day 3, when the price drops by it
  const sgx = { ...q((i) => (i < 3 ? 100 : 98), 'SGX', 'SGD'), events: div };
  const quotes = { D05: sgx, 'ES3.SI': q(() => 4, 'SGX', 'SGD') };
  const idea = (direction) => ({ id: `d${direction}`, t: T0 + 8 * 3600 + 3600, symbol: 'D05', direction, kind: 'entry', outcome: 'traded', ideaType: 'value', price: 100 });
  const [long, short] = gradeIdeas([idea(1), idea(-1)], quotes, 'SGD', now);
  assert.ok(Math.abs(long.week.move) < 1e-9);
  assert.ok(Math.abs(long.week.divs - 0.02) < 1e-9);
  assert.ok(Math.abs(short.week.move) < 1e-9); // the short pays the dividend
  // US dividends lose 30% to withholding tax for a long
  const us = { A: { ...q((i) => (i < 3 ? 100 : 98)), events: div }, SPY: q(() => 400) };
  assert.ok(Math.abs(gradeIdeas([{ ...idea(1), symbol: 'A' }], us, 'USD', now)[0].week.move - (-0.02 + 0.014)) < 1e-9);
  // the index's own dividends count too
  const spyDiv = { ...us, SPY: { ...q((i) => (i < 3 ? 400 : 396)), events: { dividends: [[T0 + 3 * DAY, 4]] } } };
  assert.ok(Math.abs(gradeIdeas([{ ...idea(1), symbol: 'A' }], spyDiv, 'USD', now)[0].week.index - (-0.01 + 0.007)) < 1e-9);
});

test('an idea made during an ex-dividend session, priced at the close before, counts that dividend', () => {
  // D05 and the index go ex on day 3 and drop by the dividend: every total return here is 0
  const quotes = {
    D05: { ...q((i) => (i < 3 ? 100 : 98), 'SGX', 'SGD'), events: { dividends: [[T0 + 3 * DAY, 2]] } },
    'ES3.SI': { ...q((i) => (i < 3 ? 4 : 3.92), 'SGX', 'SGD'), events: { dividends: [[T0 + 3 * DAY, 0.08]] } },
    Z74: q(() => 3, 'SGX', 'SGD'),
  };
  const during = T0 + 3 * DAY + 2 * 3600; // two hours into the ex-date's session
  const idea = (symbol, price) => ({ id: symbol, t: during, symbol, direction: 1, kind: 'entry', outcome: 'passed', ideaType: 'value', price });
  const [d05, z74] = gradeIdeas([idea('D05', null), idea('Z74', 3)], quotes, 'SGD', now);
  assert.equal(d05.price, 100); // the close before: it holds the dividend
  assert.ok(Math.abs(d05.week.move) < 1e-9);
  assert.ok(Math.abs(z74.week.index) < 1e-9); // the index's start is also the close before
  assert.ok(Math.abs(z74.week.move - z74.week.index) < 1e-9);
  // a fill price during the session is after the drop: no dividend, and no drop either
  const [filled] = gradeIdeas([idea('D05', 98)], quotes, 'SGD', now);
  assert.ok(Math.abs(filled.week.move) < 1e-9);
});

test('an event released after the close is measured from the next session', () => {
  // the stock jumps on day 11; the results came out on day 10 (a Thursday) at 17:05 New York time
  const quotes = { SPY: q(() => 400), S: q((i) => (i < 11 ? 100 : 110)) };
  const day10 = new Date((T0 + 10 * DAY) * 1000).toISOString().slice(0, 10);
  const [e] = mergeEvents([], [{ symbol: 'S', date: day10, time: `${day10}T21:05:00Z`, headline: 'Results', type: 'earnings', tone: 'positive', from: 'filing' }], quotes);
  assert.equal(e.effectiveDate, new Date((T0 + 11 * DAY) * 1000).toISOString().slice(0, 10));
  const [m] = measureEvents([e], quotes, 'US');
  assert.ok(Math.abs(m.day.move - 0.1) < 1e-9); // the reaction is on the day, not in the week's drift
  const [same] = measureEvents([{ ...e, effectiveDate: undefined }], quotes, 'US');
  assert.equal(same.day.move, 0); // measured on its own date, it would miss the reaction
  assert.equal(effectiveDateOf({ effectiveDate: '2026-03-20' }, 'US'), '2026-03-20');
  assert.equal(effectiveDateOf({ date: day10 }, 'US'), null);
});

test('graded ideas are frozen into a compact log, so learning survives old decisions being trimmed', () => {
  const quotes = { A: q((i) => 100 + i), SPY: q((i) => 400 + i) };
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  f.decisions = [
    { time: iso(1), orders: [{ symbol: 'A', action: 'buy', status: 'filled', shares: 10, price: 101, fee: 2.02, ideaType: 'news', conviction: 'high' }] },
    { time: iso(30), orders: [], considered: [{ symbol: 'A', stance: 'short', idea_type: 'value' }] }, // month not over yet
  ];
  updatePlaybook(f, quotes, now);
  assert.equal(f.ideaLog.length, 1);
  const [row] = f.ideaLog;
  assert.deepEqual(row.slice(0, 7), [Math.floor(Date.parse(iso(1)) / 1000), 'A', 1, CLASS_CODES.indexOf('entry:traded'), TYPE_CODES.indexOf('news'), 3, 1]);
  assert.ok(JSON.stringify(row).length < 100);
  updatePlaybook(f, quotes, now); // no double count
  assert.equal(f.ideaLog.length, 1);
  assert.equal(f.playbook.graded, 2);
  f.decisions = f.decisions.slice(1); // the trade's decision is trimmed away
  updatePlaybook(f, quotes, now);
  assert.equal(f.playbook.graded, 2);
  assert.equal(f.playbook.stats.byOutcome.traded.week.n, 1);
  const [back] = frozenIdeas(f.ideaLog);
  assert.deepEqual([back.action, back.outcome, back.ideaType, back.conviction], ['buy', 'traded', 'news', 'high']);
  assert.ok(Math.abs(back.week.move - 5 / 101) < 1e-4);
  // a later decision within the week of a frozen idea is part of it, not a new one
  const g = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  g.ideaLog = f.ideaLog;
  g.decisions = [{ time: iso(2), orders: [{ symbol: 'A', action: 'buy', status: 'filled', shares: 1, price: 102 }] }];
  updatePlaybook(g, quotes, now);
  assert.equal(g.playbook.graded, 1);
  assert.equal(g.ideaLog.length, 1);
  const full = { ideaLog: Array.from({ length: IDEA_LOG_MAX }, (_, i) => [i, 'A', 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, null]) };
  assert.equal(freezeIdeas(full, [{ ...back, frozen: false, t: 1e10 }]), 1);
  assert.deepEqual([full.ideaLog.length, full.ideaLog[0][0], full.ideaLog.at(-1)[0]], [IDEA_LOG_MAX, 1, 1e10]); // capped, oldest dropped
});

test('decisions are trimmed to the last 500 real ones; skipped ones don\'t push them out', () => {
  const list = Array.from({ length: 900 }, (_, i) => ({ time: String(i), skipped: i % 3 === 0 }));
  const kept = trimDecisions(list);
  assert.equal(kept.filter((d) => !d.skipped).length, 500);
  assert.equal(kept.filter((d) => d.skipped).length, 100);
  assert.equal(kept.at(-1).time, '899');
});

test('review lessons keep an id from their wording, so a removed one stays removed next week', () => {
  const f = newFund({ budget: 1000, currency: 'USD' });
  // a playbook from before: dated review ids, one of them hidden by the owner
  f.playbook = { review: [{ id: 'review:2026-09-20:0', text: 'Cut losers faster.', source: 'weekly review' }, { id: 'review:2026-09-20:1', text: 'Size up winners.', source: 'weekly review' }], hidden: ['review:2026-09-20:0', 'US:big-up'] };
  updatePlaybook(f, {}, now);
  assert.deepEqual(f.playbook.hidden, [reviewLessonId('Cut losers faster.'), 'US:big-up']);
  assert.deepEqual(activeLessons(f.playbook).map((l) => l.text), ['Size up winners.']);
  applyReview(f, [{ text: 'Cut  losers faster!', evidence: '6 cases' }, { text: 'Hold cash before results.' }], 6, new Date(now.getTime() + 7 * DAY * 1000));
  assert.equal(f.playbook.review[0].id, reviewLessonId('Cut losers faster.'));
  assert.deepEqual(activeLessons(f.playbook).map((l) => l.text), ['Hold cash before results.']);
  assert.notEqual(reviewLessonId('Cut losers faster.'), reviewLessonId('Cut winners faster.'));
});

// ---------- beta, peers and fees on real grades ----------

test('grades carry beta and peers, and entry ideas are charged a round trip of fees', () => {
  const quotes = { A: q((i) => 100 + i), B: q((i) => 50 + i * 0.25), SPY: q((i) => 400 + i * 2) };
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date(iso(0)) });
  f.settings.feePlan = 'scb';
  f.proposals = [{ id: 'p1', status: 'rejected' }];
  f.decisions = [{ time: iso(1), orders: [
    { symbol: 'A', action: 'buy', status: 'filled', shares: 10, price: 101, fee: 3 },
    { symbol: 'B', action: 'buy', status: 'awaiting approval', proposalId: 'p1', shares: 40, refPrice: 50.25 },
    { symbol: 'A', action: 'sell', status: 'filled', shares: 5, price: 101 },
  ], considered: [{ symbol: 'B', stance: 'long', idea_type: 'value' }] }];
  const graded = chargeFees(gradeIdeas(collectIdeas(f), quotes, 'USD', now), f, quotes);
  const [fill, declined, exit, passed] = ['traded', 'declined', 'exit', 'passed'].map((o) => graded.find((g) => g.outcome === o));
  assert.equal(fill.beta, 1); // 40 days of prices: too few for a fit, so the plain excess over the index
  assert.ok(Math.abs(fill.week.peer - 1.5 / 50) < 1e-9); // B is A's only peer: its last close before the idea to the week's end
  const sell = (qty, price) => Math.max(10, qty * price * 0.002) * 1.09 + qty * price * 0.0000278;
  assert.ok(Math.abs(fill.fee - (3 + sell(10, 101)) / 1010) < 1e-3); // what the fill paid to get in, the plan's fee to get out
  assert.equal(fill.value, 1010);
  assert.equal(declined.value, 40 * 50.25); // the order's size
  assert.equal(passed.value, Math.floor(2500 / passed.price) * passed.price); // a typical order: the per-order limit
  assert.ok(passed.fee > 0.008); // S$10 minimums on a small trade
  assert.equal(exit.fee, null); // exits aren't charged
});

test('the AI sees each rule-made lesson\'s confidence, edge per week, likely range and separate bets', () => {
  const pb = { lessons: [{ id: 'passed-better', text: 'Act more.', evidence: 'e', source: 'results', confidence: 'Moderate', p: 0.98, measure: 'edge', edge: 0.0079, lo: 0.0042, hi: 0.0117, bets: 119 }], own: [{ id: 'own:1', text: 'Mine.', source: 'owner' }] };
  const p = playbookForPrompt(pb);
  assert.deepEqual(p.lessons[0], { id: 'own:1', lesson: 'Mine.', evidence: null, from: 'owner' }); // the id, for lessons_applied
  assert.deepEqual(p.lessons[1], { id: 'passed-better', lesson: 'Act more.', confidence: 'Moderate', edge_pct_per_week: 0.8, likely_range: [0.4, 1.2], separate_bets: 119, evidence: 'e', from: 'results' });
  const r = statsForReview(learningStats(noiseFund(seeded(2), 10)));
  assert.ok(r.byOutcome.passed.evidence_pct_per_week.separate_bets > 0 && !('tradedBySymbol' in r));
});

test('the wording of cited lessons is kept, so a decision still names a lesson that has since gone', () => {
  const f = newFund({ budget: 1000, currency: 'USD', now: new Date(iso(0)) });
  const shown = { lessons: [{ id: 'cal:overconfident:1', lesson: 'Expect less.' }], market_memory: [{ id: 'US:big-up', lesson: 'Jumps continue.' }] };
  rememberCited(f, ['cal:overconfident:1', 'US:big-up', 'a lesson quoted as text'], shown);
  assert.deepEqual(f.citedLessons, { 'cal:overconfident:1': 'Expect less.', 'US:big-up': 'Jumps continue.' });
  rememberCited(f, Array.from({ length: 70 }, (_, i) => `x${i}`), { lessons: Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, lesson: `L${i}` })) });
  assert.equal(Object.keys(f.citedLessons).length, CITED_MAX);
  assert.equal(f.citedLessons.x69, 'L69');
  const g = newFund({ budget: 1000, currency: 'USD', now: new Date(iso(0)) });
  rememberCited(g, [], shown);
  assert.equal(g.citedLessons, undefined); // nothing cited: nothing stored
});

// ---------- theses, graded for calibration ----------

// A graded order with a thesis: a separate bet each (its own stock and week), moves given per horizon.
const bet = (k, { expected = 6, horizon = 21, move = 0.01, index = 0, at = {}, direction = 1, conviction = 'medium', catalyst = 'deal', stale = false, fee = 0.002, outcome = 'traded' } = {}) => {
  const g = (m) => ({ move: m, index, peer: null });
  return {
    id: `c${k}`, t: T0 + k * 7 * DAY, symbol: `S${k}`, direction, kind: 'entry', outcome, ideaType: 'news', conviction, repeats: 1, fee, beta: 1, idio: 0.03,
    thesis: { expected, horizon, catalyst, catalystDate: '', wrongIf: '', stale },
    week: g(at.week ?? move), month: g(at.month ?? move), quarter: g(at.quarter ?? move),
  };
};
const ids = (c) => (c?.lessons ?? []).map((l) => l.id);
const range = (n, f) => Array.from({ length: n }, (_, k) => f(k));

test('calibration: expected against realised at each idea\'s own horizon, with the formulaic guard', () => {
  const over = range(12, (k) => bet(k, { expected: 4 + (k % 5), move: 0.01 + (k % 3) * 0.002 }));
  const c = calibration(over);
  assert.equal(c.all.bets, 12);
  assert.ok(Math.abs(c.all.expected - 0.0583) < 1e-3 && Math.abs(c.all.realised - 0.012) < 1e-3);
  assert.deepEqual(ids(c), ['cal:overconfident:1']);
  assert.match(c.lessons[0].text, /^Your buys expected \+5\.8% over about a month and realised \+1\.2%\. Expect less, and size smaller\.$/);
  assert.match(c.lessons[0].evidence, /12 separate bets/);
  // 9 bets: too few to judge
  assert.deepEqual(ids(calibration(over.slice(0, 9))), []);
  // the same moves, but every expected move +5%: formulaic, so they aren't judged
  const same = calibration(over.map((g) => ({ ...g, thesis: { ...g.thesis, expected: 5 } })));
  assert.deepEqual(ids(same), ['cal:formulaic']);
  assert.match(same.lessons[0].text, /formulaic \(almost always \+5\.0%\)/);
  // realised about what was expected: nothing to say
  assert.deepEqual(ids(calibration(range(12, (k) => bet(k, { expected: 4 + (k % 5), move: (4 + (k % 5)) / 100 - 0.01 + (k % 2) * 0.02 })))), []);
  // passed-on ideas, ideas without a thesis and ideas whose horizon isn't over aren't counted
  assert.equal(calibration([...over, bet(20, { outcome: 'passed' }), { ...bet(21), thesis: null }, { ...bet(22), month: null }]).all.ideas, 12);
});

test('calibration: a well-calibrated fund rarely gets called overconfident (noise check)', () => {
  const rand = seeded(7);
  let fired = 0;
  for (let s = 0; s < 200; s++) {
    const xs = range(20, (k) => { const e = 2 + 6 * rand(); return bet(k, { expected: e, move: e / 100 + 0.06 * gauss(rand) }); });
    if (ids(calibration(xs)).includes('cal:overconfident:1')) fired++;
  }
  assert.ok(fired / 200 <= 0.05, `fired in ${fired} of 200`);
});

test('calibration rules on pure noise: honest theses rarely get a false calibration lesson (the rate the page prints)', () => {
  const r = calibrationNoiseCheck();
  assert.deepEqual(r, CAL_NOISE_CHECK);
  assert.ok(r.moreThanOne <= 0.05 && r.any <= 0.15, JSON.stringify(r));
});

test('calibration counts separate bets over each idea\'s own horizon, by week, after the market\'s moves', () => {
  // ten different stocks bought in one week, and the market fell 6% that month: one market move, not ten bets
  const oneWeek = range(10, (k) => ({ ...bet(0, { expected: 2 + (k % 5) * 1.5, move: -0.06 + 0.004 * ((k % 3) - 1), index: -0.06 }), id: `w${k}`, symbol: `S${k}`, t: T0 + (k % 5) * DAY }));
  const a = calibration(oneWeek);
  assert.equal(a.byDirection['1'].gap.n, 1); // one week
  assert.deepEqual(ids(a), []);
  // NVDA bought every 6 trading days with a quarter's horizon: the windows overlap, so it's one bet
  const nvda = range(10, (k) => ({ ...bet(0, { horizon: 63, expected: 10 + (k % 4), move: -0.05 + 0.005 * (k % 3) }), id: `n${k}`, symbol: 'NVDA', t: T0 + k * 8 * DAY }));
  const b = calibration(nvda);
  assert.equal(b.all.bets, 1);
  assert.deepEqual(ids(b), []);
  // a real shortfall across many weeks and stocks is still found through the noise
  const rand = seeded(3);
  const over = calibration(range(20, (k) => { const e = 4 + 4 * rand(); return bet(k, { expected: e, move: 0.005 + 0.03 * gauss(rand) }); }));
  assert.ok(ids(over).includes('cal:overconfident:1'));
});

test('calibration: stale catalysts, conviction and horizons need a gap clearly beyond noise', () => {
  const rand = seeded(11);
  const noisy = (k, extra, m = 0) => bet(k, { expected: 2 + (k % 7), move: m + 0.03 * gauss(rand), ...extra });
  // stale ideas a little behind the index on average, but no more than noise would give
  const stale = calibration([...range(8, (k) => noisy(k, { stale: true }, -0.012)), ...range(8, (k) => noisy(10 + k, {}))]);
  assert.ok(stale.stale.vsIndex != null && !ids(stale).includes('cal:stale'));
  assert.ok(stale.stale.vsIndex <= -0.01); // the old rule would have called it
  // high conviction behind low conviction by 1.9 points, but within what noise gives: not a lesson
  const r2 = seeded(19);
  const conv = calibration([...range(8, (k) => bet(k, { expected: 2 + (k % 7), conviction: 'high', move: -0.01 + 0.03 * gauss(r2) })), ...range(8, (k) => bet(10 + k, { expected: 2 + (k % 7), conviction: 'low', move: 0.03 * gauss(r2) }))]);
  assert.ok(conv.byConviction.high.vsIndex - conv.byConviction.low.vsIndex <= -0.01);
  assert.ok(!ids(conv).includes('cal:conviction'));
  // a week's ideas "better" at a month only by noise (the same on average at both)
  const r3 = seeded(3);
  const week = calibration(range(10, (k) => bet(k, { horizon: 5, expected: 2 + k, at: { week: 0.001 + 0.02 * gauss(r3), month: 0.001 + 0.04 * gauss(r3), quarter: 0.004 } })));
  assert.ok(week.byHorizon[5].at.month - week.byHorizon[5].at.week >= 0.01 && !ids(week).includes('cal:horizon:5'));
  // a short's lesson reads as a fall
  const shorts = calibration(range(12, (k) => bet(k, { direction: -1, expected: 4 + (k % 5), move: -0.016 + (k % 3) * 0.002 })));
  assert.match(shorts.lessons.find((l) => l.id === 'cal:overconfident:-1').text, /^Your shorts expected a 5\.8% fall over about a month and got a 1\.4% rise\./);
});

test('calibration: horizon fit, stale catalysts, results catalysts, fees and conviction', () => {
  // ideas given a week that paid at a month
  const week = calibration(range(10, (k) => bet(k, { horizon: 5, expected: 2 + k, at: { week: 0.001, month: 0.014, quarter: 0.004 } })));
  assert.ok(ids(week).includes('cal:horizon:5'));
  assert.match(week.lessons.find((l) => l.id === 'cal:horizon:5').text, /^Ideas you gave a week paid at a month: \+0\.1% vs the index at 5 days, \+1\.4% at 21\./);
  // ideas given a quarter that had done their work by a month
  const quarter = calibration(range(10, (k) => bet(k, { horizon: 63, expected: 2 + k, at: { week: 0.0, month: 0.019, quarter: 0.002 } })));
  assert.match(quarter.lessons.find((l) => l.id === 'cal:horizon:63').text, /had done their work by a month/);
  // stale catalysts lagging the index
  const stale = calibration([...range(8, (k) => bet(k, { expected: 2 + k, stale: true, move: -0.022 })), ...range(8, (k) => bet(10 + k, { expected: 2 + k, move: 0.01 }))]);
  assert.match(stale.lessons.find((l) => l.id === 'cal:stale').text, /catalyst was more than 10 trading days old lagged the index by 2\.2%/);
  // results against the rest
  const results = calibration([...range(8, (k) => bet(k, { expected: 2 + k, catalyst: 'results', move: -0.03 + (k % 2) * 0.004 })), ...range(8, (k) => bet(10 + k, { expected: 2 + k, move: 0.01 + (k % 2) * 0.004 }))]);
  assert.match(results.lessons.find((l) => l.id === 'cal:results').text, /results have lagged your other ideas by 4\.0 points/);
  // expected moves too small for the fees
  const fees = calibration(range(10, (k) => bet(k, { expected: 0.5 + (k % 5), move: 0.01, fee: 0.02 })));
  assert.match(fees.lessons.find((l) => l.id === 'cal:fees').text, /^In 4 of 10 orders the expected move didn't cover the round-trip fee/);
  // high conviction no better than low
  const conv = calibration([...range(8, (k) => bet(k, { expected: 2 + k, conviction: 'high', move: 0.0 })), ...range(8, (k) => bet(10 + k, { expected: 2 + k, conviction: 'low', move: 0.01 }))]);
  assert.ok(ids(conv).includes('cal:conviction'));
  assert.deepEqual(Object.keys(conv.byConviction).sort(), ['high', 'low']);
});

test('calibration lessons: at most 3 reach the AI, the fund\'s own first, else pooled across the market\'s funds', () => {
  const mk = (id) => ({ id, text: id, evidence: '', source: 'calibration' });
  const own = { formulaic: false, lessons: ['cal:conviction', 'cal:horizon:5', 'cal:stale', 'cal:fees'].map(mk) };
  assert.deepEqual(calibrationLessons(own).map((l) => l.id), ['cal:stale', 'cal:fees', 'cal:horizon:5']);
  const pooled = { funds: 2, lessons: [{ ...mk('cal:overconfident:1'), evidence: 'Pooled across the 2 SGD funds.' }, mk('cal:stale')] };
  assert.deepEqual(calibrationLessons({ lessons: [mk('cal:stale')] }, pooled).map((l) => [l.id, l.evidence]), [['cal:overconfident:1', 'Pooled across the 2 SGD funds.'], ['cal:stale', '']]);
  assert.deepEqual(calibrationLessons({ lessons: [] }, { ...pooled, funds: 1 }), []); // one fund: nothing to pool
  // a fund whose own expected moves are formulaic doesn't get pooled lessons judging them
  assert.deepEqual(calibrationLessons({ formulaic: true, lessons: [mk('cal:formulaic')] }, pooled).map((l) => l.id), ['cal:formulaic', 'cal:stale']);
  // the playbook sends them, with their ids, and the owner can hide one
  const pb = { calibrationLessons: [mk('cal:stale')], lessons: [], hidden: [] };
  assert.deepEqual(playbookForPrompt(pb).lessons, [{ id: 'cal:stale', lesson: 'cal:stale', evidence: '', from: 'calibration' }]);
  assert.equal(playbookForPrompt({ ...pb, hidden: ['cal:stale'] }), null);
});

test('theses are graded at a quarter too, frozen compactly, and pooled across funds', () => {
  // 100 trading days of prices; A rises 0.1 a day from 100, the index is flat
  const long = (f) => ({ market: 'US', currency: 'USD', price: f(99), daily: Array.from({ length: 100 }, (_, i) => [T0 + i * DAY, f(i)]), intraday: [] });
  const quotes = { A: long((i) => 100 + i * 0.1), SPY: long(() => 400) };
  const day = (i) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10);
  const calendar = { A: { past: [{ date: day(0) }, { date: day(30), effectiveDate: day(30) }], next: null } };
  const order = (i, extra) => ({ symbol: 'A', action: 'buy', status: 'filled', shares: 10, price: 100 + i * 0.1, fee: 1, ideaType: 'earnings', conviction: 'high',
    thesis: { expected: 8, horizon: 63, catalyst: 'results', catalystDate: day(30), wrongIf: 'guidance cut', age: -29, stale: false }, lessonsApplied: ['cal:stale'], ...extra });
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date(iso(0)) });
  f.decisions = [{ time: iso(1), orders: [order(1)] }];
  // after a month: frozen, but the quarter isn't over
  updatePlaybook(f, quotes, new Date((T0 + 40 * DAY) * 1000), { calendar });
  assert.equal(f.ideaLog.length, 1);
  const row = f.ideaLog[0];
  assert.deepEqual(row.slice(17), [100.1, null, null, 0.08, 63, CATALYST_CODES.indexOf('results'), -29, null, 1]);
  assert.ok(JSON.stringify(row).length < 140);
  assert.equal(f.playbook.calibration.all, null); // its own horizon isn't over
  // a quarter on: the row gets its quarter and whether the results came in time
  f.decisions = []; // the decision is long gone
  updatePlaybook(f, quotes, new Date((T0 + 99 * DAY) * 1000), { calendar });
  const [back] = frozenIdeas(f.ideaLog);
  assert.ok(Math.abs(back.quarter.move - 6.3 / 100.1) < 1e-4);
  assert.equal(back.catalystPassed, true);
  assert.deepEqual([back.thesis.expected, back.thesis.horizon, back.thesis.catalyst, back.thesis.stale, back.lessons], [8, 63, 'results', false, 1]);
  const cal = f.playbook.calibration;
  assert.deepEqual([cal.all.bets, cal.all.expected, cal.catalystChecked], [1, 0.08, { ideas: 1, passed: 1 }]);
  assert.ok(Math.abs(cal.all.realised - 6.3 / 100.1) < 1e-4);
  assert.equal(f.playbook.recent[0].thesis.expected, 8);
  // a live idea is graded at the quarter the same way
  const g = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date(iso(0)) });
  g.decisions = [{ time: iso(2), orders: [order(2, { thesis: { ...order(2).thesis, horizon: 21 } })] }];
  const [live] = gradeIdeas(collectIdeas(g), quotes, 'USD', new Date((T0 + 99 * DAY) * 1000), { calendar });
  assert.ok(live.quarter && live.catalystPassed === false); // the results were on day 30, after its month
  // pooled across both funds of the market: the same bet by two funds in the same week counts once
  Object.assign(f, { id: 'f1' }); Object.assign(g, { id: 'f2' });
  const pooled = poolCalibration([f, g], { [g.id]: [live] });
  assert.deepEqual([pooled.US.funds, pooled.US.all.bets], [2, 1]);
  assert.equal(poolCalibration([f, g], { [g.id]: [{ ...live, t: live.t + 20 * DAY }] }).US.all.bets, 2);
});
