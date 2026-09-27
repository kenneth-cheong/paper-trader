// Lessons you can check (learning.js, the lesson book): the weekly review's lessons with a filter and a
// claim, checked in code; stable ids; each lesson tracked on the ideas after it was learned; the
// behaviour check; the owner's tracked lessons; the review's input; and the opt-in review model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyReview, updatePlaybook, editPlaybook, activeLessons, playbookForPrompt, ideaRow, reviewCells, reviewLessonBook, reviewExamples,
  cleanFilter, matchesFilter, filterWords, filterLessonId, reviewLessonId, claimEvidence, trackStatus, trackRecord, behaviourCheck, behaviourBase,
  citations, ruleFilter, reviewModel, marketIdeas, isOpinion, holdNoiseCheck, noiseFund, sameIdeasId, FILTER_KEYS, FILTER_VALUES, CLAIMS, BOOK, REVIEW_MODEL_MIN, HOLD_NOISE, NOISE_START,
} from '../learning.js';
import { seeded } from '../stats.js';
import { REVIEW_TOOL, reviewPlaybook } from '../ai.js';
import { newFund } from '../fund.js';

const DAY = 86400, WEEK = 7 * DAY;
const T0 = Date.parse('2026-03-02T14:30:00Z') / 1000; // a Monday
const isoAt = (t) => new Date(t * 1000).toISOString();
const at = (t) => new Date(t * 1000);
const ANY = Object.fromEntries(FILTER_KEYS.map((k) => [k, 'any']));

// A graded idea in week k: its own stock (one of 9) and week, so each is a separate bet; `move` is the
// week's move in its direction, the index flat unless given, beta 1, no fees.
const idea = (k, { outcome = 'traded', ideaType = 'news', direction = 1, symbol = `S${k % 9}`, move = 0, index = 0, conviction = 'medium', thesis = null, t = T0 + k * WEEK } = {}) => ({
  id: `${outcome}${k}`, t, symbol, direction, kind: ['exit', 'stop-loss', 'take-profit'].includes(outcome) ? 'exit' : 'entry', outcome, ideaType, conviction,
  action: direction > 0 ? 'buy' : 'short', repeats: 1, beta: 1, idio: 0.03, fee: 0, reason: '', thesis,
  week: { move: move + (k % 2 ? 0.002 : -0.002), index, peer: null }, month: null,
});
const range = (a, b, f) => Array.from({ length: b - a }, (_, i) => f(a + i));
// A fund whose ideas are all in its frozen log, so updatePlaybook grades them without prices.
const fundWith = (ideas) => {
  const f = newFund({ budget: 10000, currency: 'USD', now: at(T0 - WEEK) });
  f.ideaLog = ideas.map((g) => ideaRow(g));
  return f;
};
const NEWS = { ...ANY, outcome: 'traded', idea_type: 'news' };

test('the review tool: a filter on every lesson, with "any" in every enum, and a claim', () => {
  const item = REVIEW_TOOL.input_schema.properties.lessons.items;
  assert.deepEqual(item.required, ['text', 'evidence', 'filter', 'claim']);
  assert.deepEqual(item.properties.claim.enum, CLAIMS);
  const f = item.properties.filter;
  assert.equal(f.additionalProperties, false);
  assert.deepEqual([...f.required].sort(), [...FILTER_KEYS].sort());
  for (const k of FILTER_KEYS) {
    if (k === 'symbol') { assert.equal(f.properties[k].type, 'string'); continue; }
    assert.equal(f.properties[k].enum[0], 'any', k);
    assert.deepEqual(f.properties[k].enum, FILTER_VALUES[k]);
  }
  assert.ok(FILTER_VALUES.outcome.includes('stop-loss') && FILTER_VALUES.idea_type.includes('analyst_pick') && FILTER_VALUES.catalyst_type.includes('results'));
});

test('filters: cleaned, matched, put in words, and a stable id from the filter and claim', () => {
  assert.deepEqual(cleanFilter({ ...ANY, outcome: 'traded', symbol: ' nvda ', conviction: 'huge' }), { outcome: 'traded', symbol: 'NVDA' });
  assert.ok(isOpinion(ANY) && isOpinion(null) && !isOpinion({ ...ANY, direction: 'short' }));
  const g = idea(0, { direction: -1, symbol: 'NVDA', thesis: { horizon: 21, catalyst: 'results' } });
  assert.ok(matchesFilter(g, cleanFilter({ ...NEWS, direction: 'short', symbol: 'NVDA', horizon: 'month', catalyst_type: 'results' })));
  assert.ok(!matchesFilter(g, { outcome: 'passed' }) && !matchesFilter(g, { horizon: 'week' }) && !matchesFilter(g, { direction: 'long' }));
  assert.ok(matchesFilter(g, ANY)); // all 'any': every idea
  assert.equal(filterWords({ outcome: 'traded', idea_type: 'news', direction: 'short', symbol: 'NVDA' }), 'Trades (news, short, NVDA)');
  assert.equal(filterWords({ outcome: 'passed', horizon: 'quarter', catalyst_type: 'rate_decision' }), 'Ideas passed on (given a quarter, rate decision catalyst)');
  assert.equal(filterWords({}), 'Ideas');
  // the id: the same filter and claim whatever the wording or how 'any' is written; the claim matters
  assert.equal(filterLessonId(NEWS, 'worse'), filterLessonId({ outcome: 'traded', idea_type: 'news' }, 'worse'));
  assert.notEqual(filterLessonId(NEWS, 'worse'), filterLessonId(NEWS, 'better'));
  assert.notEqual(filterLessonId(NEWS, 'worse'), filterLessonId({ ...NEWS, symbol: 'NVDA' }, 'worse'));
  // the rule-made lessons are about ideas too, so they're tracked
  assert.deepEqual(ruleFilter('type-weak:news'), { filter: { outcome: 'traded', idea_type: 'news' }, claim: 'worse' });
  assert.deepEqual(ruleFilter('stops-tight'), { filter: { outcome: 'stop-loss' }, claim: 'better' });
  assert.deepEqual(ruleFilter('peer-weak:D05.SI|1'), { filter: { outcome: 'traded', symbol: 'D05.SI', direction: 'long' }, claim: 'worse', measure: 'peers' });
  assert.equal(ruleFilter('conviction'), null);
});

// Twelve news trades that lagged by 3% a week, three NVDA trades, twelve ideas passed on that did well.
const history = () => [
  ...range(0, 12, (k) => idea(k, { move: -0.03 })),
  ...range(12, 15, (k) => idea(k, { symbol: 'NVDA', ideaType: 'momentum', move: -0.02 })),
  ...range(0, 12, (k) => idea(k, { outcome: 'passed', ideaType: 'value', move: 0.04, conviction: null, t: T0 + k * WEEK + DAY })),
];

test('the weekly review\'s lessons are checked in code: its numbers replaced, and lessons the data doesn\'t back dropped', () => {
  const graded = history();
  const f = newFund({ budget: 10000, currency: 'USD' });
  const now = at(T0 + 16 * WEEK);
  const out = applyReview(f, [
    { text: 'News trades have lagged: be pickier.', evidence: 'News trades lost 9% on 99 cases.', filter: NEWS, claim: 'worse' },
    { text: 'News trades are your strength.', evidence: '', filter: NEWS, claim: 'better' },
    { text: 'Your NVDA trades lag.', evidence: '', filter: { ...ANY, outcome: 'traded', symbol: 'NVDA' }, claim: 'worse' },
    { text: 'Your ZZZ trades lag.', evidence: '', filter: { ...ANY, symbol: 'ZZZ' }, claim: 'worse' },
    { text: 'Keep each reason specific.', evidence: 'Vague reasons came before the worst trades.', filter: ANY, claim: 'better' },
  ], graded, now);
  assert.deepEqual(out, { added: 2, again: 0, dropped: 3 });
  const pb = f.playbook;
  const [news, opinion] = pb.review;
  assert.equal(news.id, filterLessonId(NEWS, 'worse'));
  assert.equal(news.kind, 'checked');
  assert.doesNotMatch(news.evidence, /99 cases/); // the review's numbers are gone
  assert.match(news.evidence, /^Trades \(news\): 12 ideas, 12 separate bets\. −3\.0% a week vs the index/);
  assert.ok(news.confidence === 'High' && news.bets === 12 && news.edge < 0 && news.hi < 0);
  assert.equal(opinion.id, reviewLessonId('Keep each reason specific.'));
  assert.equal(opinion.kind, 'opinion');
  // what was dropped, and why, is remembered, so the next review can see it
  const dropped = Object.values(pb.lessonBook).filter((e) => e.dropped).map((e) => [e.text, e.dropped]);
  assert.deepEqual(dropped, [['News trades are your strength.', 'contradicted'], ['Your NVDA trades lag.', 'too-few'], ['Your ZZZ trades lag.', 'no-match']]);
  assert.deepEqual(pb.lessonBook[news.id].inSample.range.length, 2);
  // the AI sees the computed numbers, what they were checked on and the opinion as an opinion
  const p = playbookForPrompt(pb).lessons;
  assert.deepEqual(Object.keys(p[0]).sort(), ['confidence', 'edge_pct_per_week', 'from', 'id', 'lesson', 'likely_range', 'separate_bets']);
  assert.deepEqual([p[0].confidence, p[0].separate_bets], ['High', 12]);
  assert.deepEqual(p.at(-1), { id: opinion.id, lesson: 'Keep each reason specific.', status: 'opinion, not checked', from: 'weekly review' });
  // checked lessons come before the rule-made ones, opinions last
  pb.lessons = [{ id: 'passed-better', text: 'Act more.', source: 'results' }];
  assert.deepEqual(activeLessons(pb).map((l) => l.id), [news.id, 'passed-better', opinion.id]);
});

test('a review lesson keeps its id and record week to week; one the owner removed stays removed', () => {
  const graded = history();
  const f = newFund({ budget: 10000, currency: 'USD' });
  const first = at(T0 + 16 * WEEK), next = at(T0 + 17 * WEEK);
  applyReview(f, [{ text: 'News trades have lagged.', evidence: '', filter: NEWS, claim: 'worse' }], graded, first);
  const id = filterLessonId(NEWS, 'worse');
  // next week, in other words: the same lesson, learned when it was first written
  const out = applyReview(f, [{ text: 'Trade news only with a specific catalyst.', evidence: '', filter: { outcome: 'traded', idea_type: 'news' }, claim: 'worse' }], graded, next);
  assert.deepEqual(out, { added: 0, again: 1, dropped: 0 });
  assert.equal(f.playbook.review.length, 1);
  assert.deepEqual([f.playbook.review[0].text, f.playbook.review[0].bornAt, f.playbook.review[0].seenAt], ['Trade news only with a specific catalyst.', first.toISOString(), next.toISOString()]);
  assert.equal(f.playbook.lessonBook[id].bornAt, first.toISOString());
  editPlaybook(f, { remove: id });
  applyReview(f, [{ text: 'News trades lag.', evidence: '', filter: NEWS, claim: 'worse' }], graded, at(T0 + 18 * WEEK));
  assert.deepEqual(activeLessons(f.playbook), []);
  // a Stage 1 lesson (its id from its words) the owner removed: written again with a filter, it stays removed
  const g = newFund({ budget: 10000, currency: 'USD' });
  g.playbook = { review: [{ id: reviewLessonId('News trades have lagged.'), text: 'News trades have lagged.', evidence: '6 cases', source: 'weekly review' }], hidden: [reviewLessonId('News trades have lagged.')] };
  applyReview(g, [{ text: 'News trades have lagged.', evidence: '', filter: NEWS, claim: 'worse' }], graded, first);
  assert.ok(g.playbook.hidden.includes(id));
  assert.deepEqual(activeLessons(g.playbook), []);
  // one in force, cited by its old id: the checked lesson in the same words takes it over, citations too
  // (on medium-conviction news trades: the rule-made lesson on all news trades is on too)
  const h = fundWith(range(0, 12, (k) => idea(k, { move: -0.03 })));
  const old = reviewLessonId('News trades have lagged.');
  const MEDIUM = { ...NEWS, conviction: 'medium' }, mid = filterLessonId(MEDIUM, 'worse');
  h.playbook = { review: [{ id: old, text: 'News trades have lagged.', evidence: '6 cases', source: 'weekly review' }] };
  h.decisions = [{ time: isoAt(T0 + 13 * WEEK), orders: [], considered: [{ symbol: 'S1', stance: 'long', idea_type: 'value', why_not: 'x', lessonsApplied: [old] }] }];
  applyReview(h, [{ text: 'News trades have lagged.', evidence: '', filter: MEDIUM, claim: 'worse' }], updatePlaybook(h, {}, first).graded, first);
  assert.deepEqual(h.playbook.review.map((l) => l.id), [mid]);
  updatePlaybook(h, {}, next);
  assert.equal(h.playbook.lessonBook[mid].cited, 1);
});

test('a review lesson on the same ideas and claim as a rule-made lesson, or one of the owner\'s, is never kept as a second lesson', () => {
  // 20 news trades that lagged 3% a week: the rule-made lesson on news trades (type-weak:news) is on
  const lagging = range(0, 20, (k) => idea(k, { move: -0.03 }));
  const id = filterLessonId(NEWS, 'worse');
  assert.equal(sameIdeasId({ id: 'type-weak:news', source: 'results' }), id);
  assert.equal(sameIdeasId({ id: 'peer-weak:D05.SI|1', source: 'results' }), null); // measured against its peers
  assert.equal(sameIdeasId({ id: 'own:x', source: 'owner', filter: NEWS, claim: 'worse' }), id);
  const f = fundWith(lagging);
  const now = at(T0 + 22 * WEEK);
  const { graded } = updatePlaybook(f, {}, now);
  assert.ok(f.playbook.lessons.some((l) => l.id === 'type-weak:news'));
  // the review proposes it in its own words: written again, not added (the report counts it so)
  assert.deepEqual(applyReview(f, [{ text: 'News-driven buys lagged after fees.', evidence: 'x', filter: NEWS, claim: 'worse' }], graded, now), { added: 0, again: 1, dropped: 0 });
  assert.equal(f.playbook.lessonBook['type-weak:news'].seenAt, now.toISOString());
  updatePlaybook(f, {}, at(T0 + 22 * WEEK + DAY));
  const same = (pb) => activeLessons(pb).filter((l) => ['type-weak:news', id].includes(l.id)).map((l) => l.id);
  assert.deepEqual(same(f.playbook), ['type-weak:news']);
  assert.equal(playbookForPrompt(f.playbook).lessons.filter((l) => /news/i.test(l.lesson)).length, 1);
  // the other way round: a review lesson in force, then the rule-made lesson on the same ideas comes on
  const g = fundWith(lagging);
  applyReview(g, [{ text: 'News trades lag.', evidence: '', filter: NEWS, claim: 'worse' }], lagging, at(T0 + 21 * WEEK));
  assert.deepEqual(g.playbook.review.map((l) => l.id), [id]); // no rule-made lessons yet
  updatePlaybook(g, {}, now);
  assert.deepEqual(g.playbook.review, []);
  assert.deepEqual(same(g.playbook), ['type-weak:news']);
  assert.deepEqual([g.playbook.lessonBook[id].ended, g.playbook.lessonBook[id].sameAs], ['gave-way', 'type-weak:news']);
  const tracked = Object.values(g.playbook.lessonBook).filter((e) => e.filter?.idea_type === 'news' && !e.dropped);
  assert.equal(tracked.length, 2);
  assert.equal(g.playbook.trackRecord.lessons, 1); // one claim, counted once
  assert.match(reviewLessonBook(g.playbook).find((x) => x.id === id).status, /^replaced by type-weak:news, a lesson on the same ideas and claim/);
  // one the owner removed: the rule-made lesson that replaces it is removed too
  const h = fundWith(lagging);
  applyReview(h, [{ text: 'News trades lag.', evidence: '', filter: NEWS, claim: 'worse' }], lagging, at(T0 + 21 * WEEK));
  editPlaybook(h, { remove: id }, at(T0 + 21 * WEEK));
  updatePlaybook(h, {}, now);
  assert.ok(h.playbook.hidden.includes('type-weak:news'));
  assert.deepEqual(same(h.playbook), []);
  // the other way: the owner had removed the rule-made lesson, so the review's (which they kept) stays
  const k = fundWith(lagging);
  k.playbook = { hidden: ['type-weak:news'] };
  applyReview(k, [{ text: 'News trades lag.', evidence: '', filter: NEWS, claim: 'worse' }], lagging, at(T0 + 21 * WEEK));
  updatePlaybook(k, {}, now);
  assert.deepEqual(same(k.playbook), [id]);
  // the owner's own lesson on the same ideas: the review's copy isn't added either
  const o = fundWith(lagging.slice(0, 6));
  editPlaybook(o, { add: 'Skip news trades.', filter: NEWS, claim: 'worse' }, at(T0 + 6 * WEEK));
  assert.deepEqual(applyReview(o, [{ text: 'News trades lag.', evidence: '', filter: NEWS, claim: 'worse' }], lagging, now), { added: 0, again: 1, dropped: 0 });
  assert.deepEqual(o.playbook.review, []);
});

test('the review\'s lessons in force are capped: the ones proposed longest ago make room, never a kept one or one that didn\'t hold', () => {
  const graded = history();
  const f = newFund({ budget: 10000, currency: 'USD' });
  const opinions = (n, week) => range(0, n, (i) => ({ text: `Opinion ${week}-${i}.`, evidence: '', filter: ANY, claim: 'better' }));
  applyReview(f, opinions(4, 1), graded, at(T0 + 16 * WEEK));
  editPlaybook(f, { keep: reviewLessonId('Opinion 1-0.') });
  applyReview(f, [...opinions(4, 2), { text: 'News trades have lagged.', evidence: '', filter: NEWS, claim: 'worse' }], graded, at(T0 + 17 * WEEK));
  const texts = activeLessons(f.playbook).map((l) => l.text);
  assert.equal(texts.length, BOOK.reviewMax);
  assert.deepEqual(texts.filter((t) => t.startsWith('Opinion 1')), ['Opinion 1-0.']); // the kept one stays
  assert.ok(texts.includes('News trades have lagged.'));
  assert.equal(f.playbook.lessonBook[reviewLessonId('Opinion 1-1.')].ended, 'gave-way');
});

test('each lesson is tracked on the ideas after it was learned: held, didn\'t hold (the owner decides) or too early', () => {
  const before = range(0, 12, (k) => idea(k, { move: -0.03 }));
  const born = T0 + 12 * WEEK;
  // (a review lesson on medium-conviction news trades: the rule-made lesson on all news trades is on too)
  const MEDIUM = { ...NEWS, conviction: 'medium' };
  const check = (after) => {
    const f = fundWith(before);
    updatePlaybook(f, {}, at(born));
    applyReview(f, [{ text: 'News trades have lagged.', evidence: '', filter: MEDIUM, claim: 'worse' }], updatePlaybook(f, {}, at(born)).graded, at(born));
    f.ideaLog = [...before, ...after].map((g) => ideaRow(g));
    updatePlaybook(f, {}, at(born + 20 * WEEK));
    return f.playbook;
  };
  const id = filterLessonId(MEDIUM, 'worse');
  // still lagging on 12 new bets: held
  let pb = check(range(13, 25, (k) => idea(k, { move: -0.03 })));
  assert.deepEqual([pb.lessonBook[id].status, pb.lessonBook[id].since.bets], ['held', 12]);
  assert.ok(pb.lessonBook[id].since.p >= BOOK.p);
  assert.equal(playbookForPrompt(pb).lessons.find((l) => l.id === id).status, 'held on new data');
  // beating the index on 12 new bets: didn't hold, and it stays until the owner removes it
  pb = check(range(13, 25, (k) => idea(k, { move: 0.04 })));
  assert.equal(pb.lessonBook[id].status, 'didnt-hold');
  assert.ok(activeLessons(pb).some((l) => l.id === id));
  assert.equal(playbookForPrompt(pb).lessons.find((l) => l.id === id).status, 'didn\'t hold on new data');
  // three new bets: too early to tell
  pb = check(range(13, 16, (k) => idea(k, { move: 0.04 })));
  assert.deepEqual([pb.lessonBook[id].status, pb.lessonBook[id].since.bets], ['too-early', 3]);
  assert.equal(playbookForPrompt(pb).lessons.find((l) => l.id === id).status, undefined);
  // the rule-made lesson on news trades is tracked the same way, from when it came on
  const rule = pb.lessonBook['type-weak:news'];
  assert.deepEqual([rule.source, rule.claim, rule.filter], ['results', 'worse', { outcome: 'traded', idea_type: 'news' }]);
  assert.ok(rule.bornAt && rule.inSample.bets > 0);
  assert.deepEqual([trackStatus(null), trackStatus({ bets: 9, p: 0.5 }), trackStatus({ bets: 9, p: 0.1 }), trackStatus({ bets: 9, p: 0.95 })], ['too-early', 'unclear', 'didnt-hold', 'held']);
});

test('the behaviour check: the share of ideas matching a lesson before and after it, with counts; citations shown alongside', () => {
  const born = T0 + 10 * WEEK;
  const ideas = [
    ...range(0, 10, (k) => idea(k, { ideaType: k < 4 ? 'news' : 'value' })),
    ...range(10, 20, (k) => idea(k, { ideaType: k < 11 ? 'news' : 'value' })),
    ...range(0, 6, (k) => idea(k, { outcome: 'passed', t: T0 + k * WEEK + DAY })),
    ...range(0, 4, (k) => idea(k, { outcome: 'stop-loss', t: T0 + k * WEEK + 2 * DAY })),
  ];
  assert.deepEqual(behaviourCheck(ideas, NEWS, isoAt(born)), { before: [4, 10], after: [1, 10] });
  assert.equal(behaviourBase(NEWS), 'its trades');
  // on the outcome alone: among every idea of that kind
  assert.deepEqual(behaviourCheck(ideas, { outcome: 'passed' }, isoAt(born)), { before: [6, 16], after: [0, 10] });
  assert.equal(behaviourBase({ outcome: 'passed' }), 'its ideas');
  assert.deepEqual(behaviourCheck(ideas, { outcome: 'stop-loss' }, isoAt(born)), { before: [4, 4], after: [0, 0] });
  assert.equal(behaviourBase({ outcome: 'stop-loss' }), 'its exits');
  const decisions = [
    { orders: [{ lessonsApplied: ['type-weak:news', 'cal:stale'] }], considered: [{ lessonsApplied: ['type-weak:news'] }] },
    { orders: [{}], considered: [] },
  ];
  assert.deepEqual(citations(decisions), { 'type-weak:news': 2, 'cal:stale': 1 });
  // in the playbook: each lesson's record has both
  const f = fundWith(range(0, 12, (k) => idea(k, { move: -0.03 })));
  f.decisions = decisions.map((d, i) => ({ time: isoAt(T0 + (13 + i) * WEEK), ...d }));
  updatePlaybook(f, {}, at(T0 + 12 * WEEK));
  updatePlaybook(f, {}, at(T0 + 14 * WEEK));
  const e = f.playbook.lessonBook['type-weak:news'];
  assert.equal(e.cited, 2);
  assert.deepEqual(e.behaviour, { before: [12, 12], after: [0, 0] });
});

test('the owner\'s lessons can take a filter from the page, so they\'re tracked too', () => {
  const f = fundWith(range(0, 12, (k) => idea(k, { move: -0.03 })));
  const added = at(T0 + 12 * WEEK);
  editPlaybook(f, { add: 'Skip news trades.', filter: { ...NEWS }, claim: 'worse' }, added);
  editPlaybook(f, { add: 'Avoid airlines before results.' }, added);
  assert.throws(() => editPlaybook(f, { add: 'Hmm.', filter: NEWS }), /better or worse/);
  const [tracked, plain] = f.playbook.own;
  assert.deepEqual([tracked.filter, tracked.claim, plain.filter], [{ outcome: 'traded', idea_type: 'news' }, 'worse', undefined]);
  updatePlaybook(f, {}, at(T0 + 13 * WEEK));
  const e = f.playbook.lessonBook[tracked.id];
  assert.deepEqual([e.source, e.bornAt, e.inSample.bets, e.status], ['owner', added.toISOString(), 12, 'too-early']);
  assert.equal(f.playbook.lessonBook[plain.id].filter, undefined);
  // the AI gets the owner's words only: no numbers or status to argue with them
  assert.deepEqual(playbookForPrompt(f.playbook).lessons[0], { id: tracked.id, lesson: 'Skip news trades.', evidence: 'Added by the owner', from: 'owner' });
  // deleted by the owner: its record stays in the track record
  editPlaybook(f, { remove: tracked.id });
  updatePlaybook(f, {}, at(T0 + 14 * WEEK));
  assert.equal(f.playbook.lessonBook[tracked.id].ended, 'removed');
});

test('the track record, and the lesson book as the weekly review reads it', () => {
  const book = {
    a: { filter: { outcome: 'passed' }, status: 'held' }, b: { filter: { outcome: 'exit' }, status: 'didnt-hold' }, c: { filter: { outcome: 'traded' }, status: 'too-early' },
    d: { source: 'weekly review', filter: { outcome: 'traded' }, dropped: 'contradicted' }, e: { source: 'weekly review', ended: 'expired' }, f: { source: 'calibration' },
  };
  assert.deepEqual(trackRecord(book), { lessons: 3, held: 1, 'didnt-hold': 1, unclear: 0, 'too-early': 1, opinions: 1, dropped: 1, droppedFor: { contradicted: 1 } });
  // a review lesson that gave way to the rule-made lesson on the same ideas counts once, as that one
  assert.equal(trackRecord({ ...book, g: { filter: { outcome: 'passed' }, status: 'held', ended: 'gave-way', sameAs: 'a' } }).lessons, 3);
  const graded = history();
  const f = newFund({ budget: 10000, currency: 'USD' });
  applyReview(f, [
    { text: 'News trades have lagged.', evidence: '', filter: NEWS, claim: 'worse' },
    { text: 'News trades win.', evidence: '', filter: NEWS, claim: 'better' },
    { text: 'Keep reasons specific.', evidence: '', filter: ANY, claim: 'better' },
  ], graded, at(T0 + 16 * WEEK));
  editPlaybook(f, { remove: reviewLessonId('Keep reasons specific.') });
  assert.deepEqual(f.playbook.trackRecord.droppedFor, { contradicted: 1 });
  const read = reviewLessonBook(f.playbook);
  assert.deepEqual(read.map((x) => [x.lesson, x.status]), [
    ['News trades have lagged.', 'in force; since it was learned: too early to tell'],
    ['Keep reasons specific.', 'removed by the owner'],
    ['News trades win.', 'dropped when proposed: the data said the opposite'],
  ]);
  assert.deepEqual(read[0].filter, { outcome: 'traded', idea_type: 'news' });
  assert.equal(f.playbook.trackRecord.dropped, 1);
});

test('the review reads cells computed by code: ideas, separate bets, edge, its standard error and whether it\'s significant', () => {
  const cells = reviewCells(history());
  const cell = (filter) => cells.find((c) => JSON.stringify(c.filter) === JSON.stringify(filter));
  const news = cell({ outcome: 'traded', idea_type: 'news' });
  assert.deepEqual([news.ideas, news.separate_bets, news.significant], [12, 12, true]);
  assert.ok(news.edge_pct_per_week < -1 && news.se_pct > 0);
  assert.equal(cell({ outcome: 'traded' }).separate_bets, 15);
  assert.equal(cell({ outcome: 'traded', symbol: 'NVDA' }).significant, false); // 3 bets
  assert.equal(cell({ outcome: 'passed', idea_type: 'value' }).separate_bets, 12);
  assert.equal(cell({ outcome: 'passed', conviction: 'medium' }), undefined); // ideas passed on have no conviction
  assert.equal(reviewCells(history(), { minBets: 4 }).some((c) => c.filter.symbol === 'NVDA'), false);
  // examples give the values filters use
  const [ex] = reviewExamples([idea(0, { thesis: { horizon: 21, catalyst: 'results' }, move: 0.05 })]);
  assert.deepEqual([ex.outcome, ex.idea_type, ex.conviction, ex.horizon, ex.catalyst_type], ['traded', 'news', 'medium', 'month', 'results']);
});

test('the review reaches Claude with the cells, examples and lesson book, on the model it\'s given', async () => {
  const calls = [];
  const client = { beta: { messages: { stream: (req) => { calls.push(req); return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', name: 'submit_lessons', input: { lessons: [] } }], usage: { input_tokens: 10, output_tokens: 1 } }) }; } } } };
  const f = newFund({ budget: 10000, currency: 'SGD' });
  await reviewPlaybook({ client, model: 'claude-sonnet-5', fund: f, cells: reviewCells(history()), examples: [], lessons: [{ id: 'x', status: 'removed by the owner' }] });
  const sent = JSON.parse(calls[0].messages[0].content.split('\n\n')[1]);
  assert.deepEqual(Object.keys(sent), ['cells', 'examples', 'lesson_book']);
  assert.equal(calls[0].model, 'claude-sonnet-5');
  assert.match(calls[0].system, /filter/);
  assert.match(calls[0].system, /opinion and expires after 4 weeks/);
  assert.match(calls[0].system, /Don't propose a lesson with the same filter and claim as a rule-made lesson or one of the owner's/);
  // its summary for the owner is written before code checks the lessons, so it doesn't report them
  assert.doesNotMatch(calls[0].system, /what you wrote or kept/);
  assert.match(calls[0].system, /Don't say which lessons you wrote or kept/);
  assert.match(REVIEW_TOOL.input_schema.properties.owner_summary.description, /not which lessons you wrote/);
});

test('the weekly review moves to AI_REVIEW_MODEL only once its market has 150 graded ideas', () => {
  assert.equal(reviewModel({ optIn: '', cheap: 'cheap', graded: 1000 }), 'cheap');
  assert.equal(reviewModel({ optIn: 'strong', cheap: 'cheap', graded: REVIEW_MODEL_MIN - 1 }), 'cheap');
  assert.equal(reviewModel({ optIn: 'strong', cheap: 'cheap', graded: REVIEW_MODEL_MIN }), 'strong');
  // counted across the market's funds, the same idea in two funds once
  const a = { id: 'a', currency: 'USD' }, b = { id: 'b', currency: 'USD' }, c = { id: 'c', currency: 'SGD' };
  const same = idea(0);
  assert.equal(marketIdeas([a, b, c], { a: [same, idea(1)], b: [same], c: [idea(2)] }, 'USD').length, 2);
});

test('claims are checked against the right side, and the public copy keeps only the lessons shown', async () => {
  const graded = history();
  assert.ok(claimEvidence(graded, NEWS, 'worse').p > 0.99);
  assert.ok(claimEvidence(graded, NEWS, 'better').p < 0.01);
  assert.equal(claimEvidence(graded, { symbol: 'ZZZ' }, 'worse'), null);
  assert.equal(claimEvidence(graded, NEWS, 'worse', { after: T0 + 20 * WEEK }), null);
  // scripts/public-fund.mjs trims the lesson book: the records of the lessons in the playbook, without their words
  const f = fundWith(range(0, 12, (k) => idea(k, { move: -0.03 })));
  f.id = 'f1';
  updatePlaybook(f, {}, at(T0 + 12 * WEEK));
  const MEDIUM = { ...NEWS, conviction: 'medium' }; // (the rule-made lesson is on all news trades)
  applyReview(f, [{ text: 'News trades lag.', evidence: '', filter: MEDIUM, claim: 'worse' }, { text: 'News trades win.', evidence: '', filter: NEWS, claim: 'better' }],
    updatePlaybook(f, {}, at(T0 + 12 * WEEK)).graded, at(T0 + 12 * WEEK));
  const dir = await mkdtemp(join(tmpdir(), 'lessons-'));
  await writeFile(join(dir, 'in.json'), JSON.stringify({ version: 2, funds: [f] }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'in.json'), join(dir, 'out.json')], { cwd: new URL('..', import.meta.url).pathname });
  const pub = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')).funds[0].playbook;
  const ids = Object.keys(pub.lessonBook);
  assert.deepEqual(ids.sort(), [filterLessonId(MEDIUM, 'worse'), 'type-weak:news'].sort());
  assert.ok(Object.values(pub.lessonBook).every((e) => e.text === undefined));
  assert.deepEqual(pub.trackRecord, f.playbook.trackRecord); // the counts stay
});

test('on pure noise a lesson rarely gets a verdict on new data, and a real edge never shows as "didn\'t hold"', () => {
  const r = holdNoiseCheck();
  assert.deepEqual(r, HOLD_NOISE); // the rate the page prints
  assert.ok(r.held <= 0.05 && r.didntHold <= 0.05, JSON.stringify(r));
  // passed-on ideas that beat the market by 1% a week, learned half-way through a year: mostly held
  let held = 0, failed = 0;
  for (let k = 0; k < 40; k++) {
    const ideas = noiseFund(seeded(1 + k * 7919), 52).map((i) => (i.outcome === 'passed' ? { ...i, week: { ...i.week, move: i.week.move + 0.01 } } : i));
    const c = claimEvidence(ideas, { outcome: 'passed' }, 'better', { after: NOISE_START + 13 * WEEK });
    const status = trackStatus({ bets: c.est.bets, p: c.p });
    if (status === 'held') held++;
    if (status === 'didnt-hold') failed++;
  }
  assert.equal(failed, 0);
  assert.ok(held >= 36, `held in ${held} of 40`);
});
