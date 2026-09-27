import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reportWeek, weeklyReport, fileReport, lessonHistoryAfter, reportLines, publicReports, comparableFunds, gradedOn, weekOf, weekStart, lessonName, REPORT,
} from '../report.js';
import { newFund, executeDecision, rejectProposals } from '../fund.js';
import { updatePlaybook } from '../learning.js';

// Week 2026-W40 is Mon 28 Sep to Sun 4 Oct 2026; New York is on summer time (UTC-4), so the US market
// trades 13:30-20:00 UTC, and SGX 01:00-09:00 UTC. Daily bars are stamped at the session's open.
const days = [];
for (let d = Date.parse('2026-06-01T00:00:00Z'); d <= Date.parse('2026-10-02T00:00:00Z'); d += 86400000) {
  const wd = new Date(d).getUTCDay();
  if (wd && wd < 6) days.push(new Date(d).toISOString().slice(0, 10));
}
const bar = (date) => Date.parse(`${date}T13:30:00Z`) / 1000;
const quote = (f) => ({ market: 'US', currency: 'USD', daily: days.map((d, i) => [bar(d), Math.round(f(i) * 100) / 100]), intraday: [], price: f(days.length - 1), time: '2026-10-02T19:59:00Z' });
// SPY rises 0.1% a day; C rises fastest and D falls, so buying C is the week's best trade and D its worst.
const QUOTES = {
  SPY: quote((i) => 500 * (1 + 0.001 * i)), A: quote((i) => 100 * (1 + 0.002 * i)), B: quote((i) => 50 * (1 - 0.002 * i)),
  C: quote((i) => 80 * (1 + 0.008 * i)), D: quote((i) => 40 * (1 - 0.004 * i)), E: quote(() => 30),
};
const FRIDAY = new Date('2026-10-02T20:45:00Z'); // 16:45 in New York, after the week's last close
const time = (date, h = 15) => new Date(`${date}T${h}:00:00Z`);
const thesis = (s) => ({ expected_move_pct: 3, horizon_days: 5, catalyst_type: 'none', catalyst_date: '', wrong_if: `${s} guidance is cut`, lessons_applied: [] });

// A US fund built through the real code: four trades in week 39 (graded in week 40), an idea it passed
// on, and two proposals the owner declined, one as "too risky" and one without a reason.
function fund() {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date('2026-09-01T14:00:00Z') });
  Object.assign(f, { id: 'f1', name: 'Steady', style: 'balanced' });
  const on = (date) => Object.fromEntries(Object.entries(QUOTES).map(([s, q]) => [s, { ...q, price: q.daily.find((b) => b[0] === bar(date))[1] }]));
  for (const [date, symbol, action] of [['2026-09-21', 'A', 'buy'], ['2026-09-22', 'B', 'short'], ['2026-09-23', 'C', 'buy'], ['2026-09-24', 'D', 'buy']]) {
    const orders = executeDecision(f, [{ symbol, action, shares: 20, reason: `reason for ${symbol}`, idea_type: 'news', conviction: 'medium', ...thesis(symbol) }], on(date), time(date));
    f.decisions.push({ time: time(date).toISOString(), outlook: 'x', orders, considered: [{ symbol: 'E', stance: 'long', idea_type: 'value', why_not: 'too early' }], usage: { costUsd: 0.1 } });
  }
  f.proposals = [{ id: 'p1', status: 'awaiting', symbol: 'E', action: 'buy', shares: 10 }, { id: 'p2', status: 'awaiting', symbol: 'B', action: 'buy', shares: 10 }];
  const then = on('2026-09-24');
  f.decisions.push({ time: time('2026-09-24').toISOString(), outlook: 'x', orders: [
    { symbol: 'E', action: 'buy', shares: 10, status: 'awaiting approval', proposalId: 'p1', refPrice: then.E.price, reason: 'cheap', ideaType: 'value' },
    { symbol: 'B', action: 'buy', shares: 10, status: 'awaiting approval', proposalId: 'p2', refPrice: then.B.price, reason: 'bounce', ideaType: 'technical' },
  ] });
  rejectProposals(f, ['p1'], time('2026-09-24', 16), 'risky');
  rejectProposals(f, ['p2'], time('2026-09-24', 16));
  f.history = [['2026-09-25T20:30:00.000Z', 10000], ['2026-10-01T20:30:00.000Z', 10040], ['2026-10-02T20:30:00.000Z', 10080], ['2026-10-05T14:00:00.000Z', 10500]];
  const { graded } = updatePlaybook(f, QUOTES, FRIDAY);
  return { f, graded };
}

test('a week\'s report is due on the first run after its market\'s last session, once, and caught up if missed', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-09-01T14:00:00Z') });
  const at = (iso) => new Date(iso);
  assert.equal(weekOf('2026-10-02'), '2026-W40');
  assert.equal(weekStart('2026-W40'), '2026-09-28');
  assert.equal(weekStart('2026-W01'), '2025-12-29');
  assert.equal(reportWeek(f, at('2026-10-02T20:31:00Z')), '2026-W40'); // 16:31 on Friday in New York
  assert.equal(reportWeek(f, at('2026-10-03T12:00:00Z')), '2026-W40'); // the weekend
  // before Friday's close + 30 minutes it's the week before, caught up if it was missed
  assert.equal(reportWeek(f, at('2026-10-02T20:10:00Z')), '2026-W39');
  f.reports = [{ week: '2026-W39' }];
  assert.equal(reportWeek(f, at('2026-10-02T20:10:00Z')), null);
  assert.equal(reportWeek(f, at('2026-10-05T15:00:00Z')), '2026-W40'); // Monday: last week's was missed
  f.reports.push({ week: '2026-W40' });
  assert.equal(reportWeek(f, at('2026-10-05T15:00:00Z')), null);
  // a Friday holiday: the prices are coming in, but none from today
  const g = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-09-01T14:00:00Z') });
  const holiday = { updatedAt: '2026-10-02T14:55:00Z', quotes: { SPY: { market: 'US', currency: 'USD', price: 500, time: '2026-10-01T19:59:00Z' } } };
  assert.equal(reportWeek(g, at('2026-10-02T15:00:00Z'), holiday), '2026-W40');
  assert.equal(reportWeek(g, at('2026-10-02T15:00:00Z')), '2026-W39');
  // SGX closes at 17:00 in Singapore
  const s = newFund({ budget: 10000, currency: 'SGD', now: new Date('2026-09-01T02:00:00Z') });
  s.reports = [{ week: '2026-W39' }];
  assert.equal(reportWeek(s, at('2026-10-02T09:10:00Z')), null);
  assert.equal(reportWeek(s, at('2026-10-02T09:31:00Z')), '2026-W40');
  // not for a week it didn't trade in, nor for a stopped fund
  assert.equal(reportWeek(newFund({ budget: 1, currency: 'USD', now: at('2026-10-02T21:00:00Z') }), at('2026-10-03T12:00:00Z')), null);
  assert.equal(reportWeek(newFund({ budget: 1, currency: 'USD', now: at('2026-10-01T15:00:00Z') }), at('2026-10-03T12:00:00Z')), '2026-W40');
  assert.equal(reportWeek({ ...f, reports: [], stoppedAt: '2026-10-01T00:00:00Z' }, at('2026-10-03T12:00:00Z')), null);
});

test('the week\'s report: the fund against its index, the ideas graded that week with the best and worst, your calls, what\'s coming up and the cost', () => {
  const { f, graded } = fund();
  // each idea counts in the week its week grade came in: 5 sessions after it
  assert.equal(gradedOn(graded.find((g) => g.symbol === 'A'), QUOTES), '2026-09-28');
  const dossiers = {
    A: { results: { next: { date: '2026-10-20', source: 'estimated' } } }, C: { results: { next: { date: '2026-12-20', source: 'yahoo' } } },
    D: { dividends: { next: { date: '2026-10-09', estimate: true }, yield_pct: 1.5, drop_vs_dividend: 0.8 }, results: { next: { date: '2026-10-06', source: 'yahoo' } } },
  };
  const spend = { months: { '2026-10': { total: 1.54, fund: 1.2, learning: 0.2, backfill: 0.1, articles: 0.04 } } }; // articles: the searches behind big moves
  const r = fileReport(f, { week: '2026-W40', graded, dossiers, quotes: QUOTES, spend, cap: '30', now: FRIDAY });
  assert.deepEqual([r.week, r.to, r.short, r.graded], ['2026-W40', '2026-10-02', false, 7]);
  assert.equal(r.fund.pct, 0.008); // 10,000 at the end of the week before, 10,080 now (Monday's point is next week's)
  const spy = (d) => QUOTES.SPY.daily.find((b) => b[0] === bar(d))[1];
  assert.ok(Math.abs(r.index.pct - (spy('2026-10-02') / spy('2026-09-25') - 1)) < 1e-4);
  assert.deepEqual([r.best.symbol, r.worst.symbol], ['C', 'D']); // among its trades, against the index after fees
  assert.deepEqual([r.best.reason, r.best.wrongIf], ['reason for C', 'C guidance is cut']);
  assert.deepEqual(r.calls.map((c) => [c.why, c.declined, c.right, c.of]), [['risky', 1, 1, 1], ['none', 1, 1, 1]]); // both would have lost money
  assert.deepEqual(r.comingUp.map((x) => [x.symbol, x.kind, x.date]), [['D', 'results', '2026-10-06'], ['D', 'ex', '2026-10-09'], ['A', 'results', '2026-10-20']]); // C's is too far off
  assert.equal(r.comingUp[1].dropPct, 1.2);
  assert.deepEqual(r.cost, { month: '2026-10', decisions: 0, learning: 0.34, total: 1.54, cap: 30 });
  assert.equal(r.first, true);
  const lines = reportLines(r);
  assert.equal(lines[0].text, `Week to 2 Oct: fund +0.8%, SPY +${(r.index.pct * 100).toFixed(1)}%.`);
  const text = lines.map((l) => l.text).join('\n');
  assert.match(text, /7 ideas graded this week\. Best trade: bought C \("reason for C"\), \+[\d.]+% against SPY a week later, after fees \(it said: wrong if C guidance is cut\)\. Worst trade: bought D/);
  // with no trades among them, the best and worst of its other ideas
  const ideas = weeklyReport(f, { week: '2026-W40', graded: graded.map((g) => (g.outcome === 'traded' ? { ...g, outcome: 'passed' } : g)), quotes: QUOTES, now: FRIDAY });
  assert.match(reportLines(ideas)[1].text, /^7 ideas graded this week, none of them a trade\. Best idea: passed on buying C \("reason for C"\).*Worst idea: /);
  assert.match(text, /When you declined for "too risky", you were right 1 time out of 1 \(the trade would have lost money a week later, after fees\); it would have made −[\d.]+% against SPY\./);
  assert.match(text, /When you declined without giving a reason/);
  assert.match(text, /Coming up: D reports results on 6 Oct; D goes ex-dividend around 9 Oct \(an estimate; the price usually drops about 1\.2% that day\); A reports results around 20 Oct \(an estimate\)\./);
  assert.match(text, /AI cost in October so far: its decisions US\$0\.00; learning US\$0\.34 \(the weekly reviews and news look-ups, shared by every fund\); all scheduled AI US\$1\.54 of the US\$30 cap\./);
  assert.match(text, /From next week, this report says how each lesson's evidence changed/);
  // stored with the fund; the same week isn't filed twice
  assert.equal(f.reports.length, 1);
  assert.equal(reportWeek(f, FRIDAY), null);
});

test('with fewer than 5 ideas graded that week the report is one line, and a new fund\'s says so', () => {
  const { f, graded } = fund();
  const r = weeklyReport(f, { week: '2026-W40', graded: graded.slice(0, 3), quotes: QUOTES, now: FRIDAY });
  assert.equal(r.short, true);
  assert.equal(r.best, undefined);
  const lines = reportLines(r);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Week to 2 Oct: fund \+0\.8%, SPY \+[\d.]+%\. Only 3 ideas graded this week: too few for a report \(it takes 5\)\.$/);
  const young = { ...f, startedAt: '2026-09-30T14:00:00.000Z', history: [['2026-10-02T20:30:00.000Z', 10020]] };
  const y = weeklyReport(young, { week: '2026-W40', graded: [], quotes: QUOTES, now: FRIDAY });
  assert.deepEqual([y.started, y.fund.pct], ['2026-09-30', 0.002]);
  assert.match(reportLines(y)[0].text, /^Week to 2 Oct \(it started on 30 Sep\): fund \+0\.2%, SPY [+−][\d.]+%\. No ideas graded this week: too few for a report \(it takes 5\)\. Ideas are graded 5 trading days after they're made\.$/);
});

test('what changed in its lessons: status on new data first, then new, stronger, weaker, steady and gone, from each lesson\'s history', () => {
  const { f, graded } = fund();
  const lesson = (id, edge, bets, p, extra = {}) => ({ id, text: `Lesson ${id}. More words here.`, source: 'results', confidence: p >= 0.99 ? 'High' : 'Moderate', p, edge, lo: edge - 0.01, hi: edge + 0.01, bets, measure: 'edge', ...extra });
  const pb = {
    lessons: [lesson('shorts-weak', -0.038, 6, 0.98), lesson('passed-better', 0.004, 20, 0.995), lesson('exit-early', 0.005, 9, 0.975), lesson('type-weak:news', -0.004, 10, 0.98)],
    review: [{ ...lesson('review:a', -0.01, 12, 0.995, { source: 'weekly review' }), kind: 'checked', filter: { outcome: 'traded' }, claim: 'worse' }],
    lessonBook: {
      'review:a': { filter: { outcome: 'traded' }, claim: 'worse', status: 'didnt-hold', since: { bets: 9, edge: 0.004 } },
      'shorts-weak': { filter: { outcome: 'traded', direction: 'short' }, status: 'held', since: { bets: 8, edge: -0.02 } },
      'beta-driven': { on: false },
    },
    lessonHistory: {
      'shorts-weak': [{ date: '2026-09-25', bets: 5, edge: -0.031, p: 0.975 }], 'passed-better': [{ date: '2026-09-25', bets: 18, edge: 0.006, p: 0.996 }],
      'type-weak:news': [{ date: '2026-09-25', bets: 8, edge: -0.004, p: 0.98 }], 'review:a': [{ date: '2026-09-25', bets: 11, edge: -0.012, p: 0.99 }],
    },
  };
  const prevSnapshot = { statuses: { 'review:a': 'too-early', 'shorts-weak': 'held' }, names: { 'shorts-weak': 'x', 'passed-better': 'y', 'beta-driven': 'Your trades beat the index mostly because of beta' } };
  const r = weeklyReport(f, { week: '2026-W40', graded, pb, prevSnapshot, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(r.lessons.map((c) => [c.id, c.change]), [['review:a', 'didnt-hold'], ['exit-early', 'new'], ['shorts-weak', 'stronger'], ['passed-better', 'weaker'], ['type-weak:news', 'steady']]);
  assert.equal(r.moreLessons, 1); // and the one that went
  const words = reportLines(r).filter((l) => l.kind === 'lesson').map((l) => l.text);
  assert.deepEqual(words, [
    '"Lesson review:a" didn\'t hold on new data: 9 separate bets since it was learned, +0.4% a week. You can remove it on the page.',
    'New lesson: "Lesson exit-early" (9 separate bets, +0.5% a week, Moderate confidence).',
    '"Lesson shorts-weak" got stronger: 5 → 6 separate bets, −3.1% → −3.8% a week (still Moderate).',
    '"Lesson passed-better" got weaker: 18 → 20 separate bets, +0.6% → +0.4% a week (still High).',
    '"Lesson type-weak:news" held steady: 8 → 10 separate bets, −0.4% → −0.4% a week (still Moderate).',
    '…and 1 more change to its lessons: see What it has learned.',
  ]);
  const all = weeklyReport(f, { week: '2026-W40', graded, pb: { ...pb, lessons: pb.lessons.slice(0, 1), review: [] }, prevSnapshot, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(all.lessons.at(-1), { id: 'beta-driven', name: 'Your trades beat the index mostly because of beta', change: 'gone', why: 'faded' });
  assert.match(reportLines(all).map((l) => l.text).join('\n'), /"Your trades beat the index mostly because of beta" is no longer in force: its evidence faded\./);
  // a review lesson that gave way to the rule-made lesson on the same ideas and claim (learning.js)
  const gave = weeklyReport(f, { week: '2026-W40', graded, pb: { ...pb, lessons: pb.lessons.slice(0, 1), review: [], lessonBook: { ...pb.lessonBook, 'review:b': { ended: 'gave-way', sameAs: 'type-weak:news' } } },
    prevSnapshot: { ...prevSnapshot, names: { ...prevSnapshot.names, 'review:b': 'News trades lag' } }, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(gave.lessons.find((c) => c.id === 'review:b'), { id: 'review:b', name: 'News trades lag', change: 'gone', why: 'same' });
  assert.match(reportLines(gave).map((l) => l.text).join('\n'), /"News trades lag" is no longer in force: a lesson on the same ideas and claim took its place\./);
  // a fund that doesn't learn doesn't report on lessons
  const off = weeklyReport({ ...f, settings: { ...f.settings, learning: false } }, { week: '2026-W40', graded, pb, prevSnapshot, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual([off.lessons, off.first, off.snapshot], [[], undefined, { statuses: {}, names: {} }]);
  assert.equal(lessonName('Your shorts have lost money even after allowing for the market\'s moves (beta) and fees over the past months. Short less.'), 'Your shorts have lost money even after allowing for the market\'s…');
});

test('each lesson\'s evidence is kept week by week for 12 weeks, one point a week', () => {
  const pb = {
    lessons: [{ id: 'a', text: 'A.', source: 'results', confidence: 'High', p: 0.9951, edge: -0.012346, bets: 9 }],
    lessonHistory: {
      a: Array.from({ length: 12 }, (_, i) => ({ date: new Date(Date.parse('2026-07-10T12:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10), bets: i, edge: -0.01, p: 0.98 })),
      gone: [{ date: '2026-06-01', bets: 3, edge: 0.01, p: 0.9 }],
    },
  };
  const h = lessonHistoryAfter(pb, '2026-10-02');
  assert.equal(h.a.length, REPORT.historyWeeks);
  assert.deepEqual(h.a.at(-1), { date: '2026-10-02', bets: 9, edge: -0.01235, p: 0.995 });
  assert.equal(h.a[0].date, '2026-07-17'); // the oldest week dropped
  assert.equal(h.gone, undefined);
  // run again the same week: replaced, not added
  const again = lessonHistoryAfter({ ...pb, lessonHistory: h, lessons: [{ ...pb.lessons[0], bets: 10 }] }, '2026-10-01');
  assert.deepEqual([again.a.length, again.a.at(-1).bets, again.a.at(-1).date], [12, 10, '2026-10-01']);
});

test('the review\'s summary for the owner goes in the next full report after it, with what the review did that week', () => {
  const { f, graded } = fund();
  const at = '2026-09-30T21:00:00.000Z';
  const pb = {
    ...f.playbook, reviewedAt: at, ownerSummary: { at, text: 'Seven ideas were graded. Two lessons were added. Next week will show more.' },
    review: [
      { id: 'review:x', text: 'New checked.', kind: 'checked', bornAt: at, seenAt: at, filter: { outcome: 'traded' }, claim: 'worse' },
      { id: 'review:y', text: 'New opinion.', kind: 'opinion', bornAt: at, seenAt: at },
      { id: 'review:z', text: 'Again.', kind: 'checked', bornAt: '2026-09-01T21:00:00.000Z', seenAt: at, filter: { outcome: 'passed' }, claim: 'better' },
    ],
    lessonBook: { d1: { dropped: 'too-few', droppedAt: at }, d2: { dropped: 'no-match', droppedAt: '2026-09-01T21:00:00.000Z' } },
  };
  const r = weeklyReport(f, { week: '2026-W40', graded, pb, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(r.review, { date: '2026-09-30', added: 2, opinions: 1, again: 1, dropped: 1, droppedFor: { 'too-few': 1 } });
  // a rule-made lesson the review wrote again counts too (learning.js applyReview marks it)
  assert.equal(weeklyReport(f, { week: '2026-W40', graded, pb: { ...pb, lessonBook: { ...pb.lessonBook, 'type-weak:news': { source: 'results', on: true, seenAt: at } } }, quotes: QUOTES, now: FRIDAY }).review.again, 2);
  assert.deepEqual([r.summary, r.summaryAt], [pb.ownerSummary.text, '2026-09-30']);
  const text = reportLines(r).map((l) => l.text).join('\n');
  // why the check dropped it, as the check said
  assert.match(text, /The weekly review \(30 Sep\) added 2 lessons \(one of them an opinion, not checked\), wrote 1 lesson in force again and proposed 1 lesson that the check dropped \(fewer than 8 separate bets\)\./);
  assert.match(text, /In the weekly review's words: Seven ideas were graded\./);
  const mixed = weeklyReport(f, { week: '2026-W40', graded, pb: { ...pb, lessonBook: { ...pb.lessonBook, d3: { dropped: 'contradicted', droppedAt: at }, d4: { dropped: 'too-few', droppedAt: at } } }, quotes: QUOTES, now: FRIDAY });
  assert.match(reportLines(mixed).map((l) => l.text).join('\n'), /proposed 3 lessons that the check dropped \(2: fewer than 8 separate bets; 1: the data said the opposite\)\./);
  // a full report after it has shown it: not again; a one-line report doesn't carry it, so the next full one does
  assert.equal(weeklyReport({ ...f, reports: [{ week: '2026-W39', at: '2026-10-01T21:00:00.000Z', short: false }] }, { week: '2026-W40', graded, pb, quotes: QUOTES, now: FRIDAY }).summary, null);
  assert.equal(weeklyReport({ ...f, reports: [{ week: '2026-W38', at: '2026-09-18T21:00:00.000Z', short: false }, { week: '2026-W39', at: '2026-10-01T21:00:00.000Z', short: true }] }, { week: '2026-W40', graded, pb, quotes: QUOTES, now: FRIDAY }).summary, pb.ownerSummary.text);
  // a summary from a review in an earlier week (whose report was one line) is dated; one over two weeks old is left out
  const earlier = { ...pb, ownerSummary: { at: '2026-09-23T21:00:00.000Z', text: 'Five ideas were graded.' } };
  const withEarlier = weeklyReport({ ...f, reports: [{ week: '2026-W38', at: '2026-09-18T21:00:00.000Z', short: false }] }, { week: '2026-W40', graded, pb: earlier, quotes: QUOTES, now: FRIDAY });
  assert.equal(withEarlier.summaryAt, '2026-09-23');
  assert.ok(reportLines(withEarlier).some((l) => l.text === 'In the words of the weekly review of 23 Sep: Five ideas were graded.'));
  const stale = { ...pb, ownerSummary: { at: '2026-09-10T21:00:00.000Z', text: 'Old words.' } };
  assert.equal(weeklyReport(f, { week: '2026-W40', graded, pb: stale, quotes: QUOTES, now: FRIDAY }).summary, null); // a first report included
});

test('a lesson got stronger or weaker only when the figures the report prints differ', () => {
  const { f, graded } = fund();
  const lesson = (id, edge, bets) => ({ id, text: `Lesson ${id}.`, source: 'results', confidence: 'High', p: 0.995, edge, lo: edge - 0.01, hi: edge + 0.01, bets, measure: 'edge' });
  const point = (bets, edge) => [{ date: '2026-09-25', bets, edge, p: 0.995 }];
  const pb = {
    lessons: [lesson('a', 0.0111, 18), lesson('b', 0.01249, 18), lesson('c', -0.012, 24), lesson('d', -0.001, 12), lesson('e', 0.0127, 30)],
    lessonHistory: { a: point(16, 0.01058), b: point(16, 0.01151), c: point(23, -0.01241), d: point(11, 0.002), e: point(28, 0.0114) },
  };
  const r = weeklyReport(f, { week: '2026-W40', graded, pb, prevSnapshot: { statuses: {}, names: {} }, quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(Object.fromEntries(r.lessons.map((c) => [c.id, c.change])), { a: 'steady', b: 'steady', c: 'steady', d: 'weaker', e: 'stronger' });
  const words = reportLines(r).filter((l) => l.kind === 'lesson').map((l) => l.text);
  assert.ok(words.includes('"Lesson a" held steady: 16 → 18 separate bets, +1.1% → +1.1% a week (still High).'));
  assert.ok(words.includes('"Lesson b" held steady: 16 → 18 separate bets, +1.2% → +1.2% a week (still High).'));
  assert.ok(words.includes('"Lesson d" got weaker: 11 → 12 separate bets, +0.2% → −0.1% a week (still High).'));
  assert.ok(words.includes('"Lesson e" got stronger: 28 → 30 separate bets, +1.1% → +1.3% a week (still High).'));
  assert.equal(REPORT.steady, undefined);
});

test('the fund with learning the other way is compared only with the same currency and style', () => {
  const { f, graded } = fund();
  const other = (id, extra) => ({ ...newFund({ budget: 10000, currency: 'USD', settings: { learning: false }, now: new Date('2026-09-10T14:00:00Z') }), id, name: id, style: 'balanced', ...extra });
  const control = other('Control', { history: [['2026-09-25T20:30:00.000Z', 9900], ['2026-10-02T20:30:00.000Z', 9950]] });
  const funds = [f, control, other('Bold', { style: 'aggressive' }), other('Sing', { currency: 'SGD' }), other('Gone', { stoppedAt: '2026-09-20T00:00:00Z' }), { ...other('Learner'), settings: { learning: true } }];
  assert.deepEqual(comparableFunds(funds, f).map((x) => x.id), ['Control']);
  assert.deepEqual(comparableFunds(funds, control).map((x) => x.id), ['f1', 'Learner']);
  const r = weeklyReport(f, { week: '2026-W40', graded, controlFunds: comparableFunds(funds, f), quotes: QUOTES, now: FRIDAY });
  assert.deepEqual(r.control, [{ name: 'Control', learning: false, pct: 0.0051, since: '2026-09-10', sincePct: -0.005, ownSincePct: 0.008 }]);
  assert.match(reportLines(r).map((l) => l.text).join('\n'), /Without learning, "Control" \(the same style and currency\): \+0\.5% this week; since both were running \(from 10 Sep\), this fund \+0\.8% and "Control" −0\.5%\./);
});

test('the fund keeps its latest 12 reports, only the newest with its snapshot, and the public copy the latest 4 without your calls', () => {
  const { f, graded } = fund();
  f.reports = Array.from({ length: 12 }, (_, i) => ({ week: `2026-W${String(28 + i).padStart(2, '0')}`, to: '2026-09-25', short: true, graded: 0, fund: { pct: 0 }, snapshot: { statuses: {}, names: {} } }));
  fileReport(f, { week: '2026-W40', graded, quotes: QUOTES, now: FRIDAY });
  assert.equal(f.reports.length, REPORT.keep);
  assert.deepEqual([f.reports[0].week, f.reports.at(-1).week], ['2026-W29', '2026-W40']);
  assert.deepEqual(f.reports.map((r) => Boolean(r.snapshot)), [...Array(11).fill(false), true]);
  const pub = publicReports(f.reports);
  assert.equal(pub.length, REPORT.publicKeep);
  assert.ok(pub.every((r) => !('calls' in r) && !('snapshot' in r)));
  assert.ok(f.reports.at(-1).calls.length);
});
