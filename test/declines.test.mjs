// The owner's reasons for declining trades (fund.js DECLINE_REASONS): stored on the proposal, carried
// through the idea log, graded as "your calls" (learning.js), shown to the AI from 5 cases, sent by the
// app through the settings passthrough (scripts/ai-fund.mjs) and left out of the public copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { newFund, executeDecision, rejectProposals, DECLINE_REASONS } from '../fund.js';
import {
  collectIdeas, ideaRow, frozenIdeas, learningStats, declineCalls, declinesForPrompt, playbookForPrompt, applyReview, DECLINE_CODES, DECLINE_MIN_CASES,
} from '../learning.js';
import { FUND_SYSTEM, REVIEW_TOOL, reviewPlaybook } from '../ai.js';

const root = new URL('..', import.meta.url).pathname;
const at = (hhmm) => new Date(`2026-01-07T${hhmm}:00Z`);
const q = (price) => ({ currency: 'USD', market: 'US', price, daily: [], intraday: [], time: at('15:40').toISOString() });
const tiger = () => newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger' }, now: at('14:00') });
const buy = (symbol, shares) => ({ symbol, action: 'buy', shares, reason: 'r' });

test('Reject keeps the owner\'s reason on the proposal; a reason it doesn\'t know, or none, declines it without one', () => {
  assert.deepEqual(Object.keys(DECLINE_REASONS), ['risky', 'timing', 'stock', 'other']);
  assert.deepEqual(DECLINE_CODES.slice(1), Object.keys(DECLINE_REASONS)); // the idea log's codes, in the same order
  const f = tiger();
  executeDecision(f, [buy('A', 1), buy('A', 2), buy('A', 3), buy('A', 4)], { A: q(100) }, at('15:50'));
  const [p1, p2, p3] = f.proposals;
  assert.deepEqual(rejectProposals(f, [p1.id], at('15:55'), 'risky').map((p) => [p.status, p.declineWhy]), [['rejected', 'risky']]);
  rejectProposals(f, [p2.id], at('15:55'), 'toString');
  rejectProposals(f, [p3.id], at('15:55'));
  assert.deepEqual([p2.status, p2.declineWhy, p3.status, p3.declineWhy], ['rejected', undefined, 'rejected', undefined]);
  assert.deepEqual(rejectProposals(f, [p1.id], at('15:56'), 'timing'), []); // already decided: unchanged
  assert.equal(p1.declineWhy, 'risky');
});

test('the reason travels with the idea: collected, frozen into the idea log\'s last column and read back', () => {
  const f = tiger();
  f.proposals = [{ id: 'p1', status: 'rejected', declineWhy: 'timing' }, { id: 'p2', status: 'rejected' }, { id: 'p3', status: 'expired', declineWhy: 'risky' }];
  f.decisions = [{ time: at('15:00').toISOString(), orders: [
    { symbol: 'A', action: 'buy', status: 'awaiting approval', proposalId: 'p1', refPrice: 10 },
    { symbol: 'B', action: 'sell', status: 'awaiting approval', proposalId: 'p2', refPrice: 20 },
    { symbol: 'C', action: 'buy', status: 'awaiting approval', proposalId: 'p3', refPrice: 30 },
  ] }];
  const ideas = collectIdeas(f);
  assert.deepEqual(ideas.map((i) => [i.symbol, i.outcome, i.declineWhy]), [['A', 'declined', 'timing'], ['B', 'declined', undefined], ['C', 'expired', undefined]]);
  const graded = { ...ideas[0], price: 10, week: { move: 0.01, index: 0 }, month: { move: 0.02, index: 0, divs: 0 } };
  const row = ideaRow(graded);
  assert.equal(row.length, 27);
  assert.equal(row[26], DECLINE_CODES.indexOf('timing'));
  assert.deepEqual(row.slice(20, 26), [null, null, null, null, null, null]); // no thesis
  assert.equal(frozenIdeas([row])[0].declineWhy, 'timing');
  assert.equal(frozenIdeas([row])[0].thesis, null);
  const withThesis = ideaRow({ ...graded, thesis: { expected: 5, horizon: 21, catalyst: 'results', age: 2 }, lessons: 1 });
  assert.equal(frozenIdeas([withThesis])[0].declineWhy, 'timing');
  assert.equal(frozenIdeas([withThesis])[0].thesis.horizon, 21);
  assert.equal(ideaRow({ ...graded, declineWhy: undefined }).length, 18); // none: the row ends as before
});

test('your calls: how the trades declined for each reason would have done, after fees; a declined sale is right when the stock kept going', () => {
  const g = (extra) => ({ symbol: 'A', direction: 1, t: 1767794400, kind: 'entry', outcome: 'declined', fee: 0.004, month: null, ...extra });
  const calls = declineCalls([
    g({ week: { move: 0.01, index: 0.002 }, month: { move: 0.03, index: 0.01 } }), // +0.6% after fees: you were wrong
    g({ symbol: 'B', week: { move: 0.003, index: 0 } }), // −0.1% after fees: right
    g({ symbol: 'C', kind: 'exit', fee: null, week: { move: 0.02, index: 0.005 } }), // holding made 2%: declining the sale was right
  ]);
  assert.deepEqual(calls, { ideas: 3, bets: 3, week: { n: 3, right: 2, vsIndex: -0.004 }, month: { n: 1, right: 0, vsIndex: 0.016 } });
  const stats = learningStats([
    ...Array.from({ length: DECLINE_MIN_CASES }, (_, i) => g({ symbol: `S${i}`, declineWhy: 'risky', week: { move: 0.03, index: 0 } })),
    g({ declineWhy: 'timing', week: { move: -0.01, index: 0 } }),
    ...Array.from({ length: 6 }, (_, i) => g({ symbol: `N${i}`, week: { move: -0.01, index: 0 } })), // no reason given
  ]);
  assert.deepEqual(Object.keys(stats.declinedByReason).sort(), ['none', 'risky', 'timing']);
  // the AI sees a reason only from 5 declines, never "no reason"
  assert.deepEqual(declinesForPrompt(stats), [{ reason: 'too risky', declined: 5, lost_money_a_week_later: 0, vs_index_pct_a_week_later: 2.6 }]);
  const pb = { stats, lessons: [], review: [], own: [], hidden: [] };
  assert.deepEqual(playbookForPrompt(pb).owner_declines, declinesForPrompt(stats)); // enough on its own for a playbook
  assert.equal(playbookForPrompt({ ...pb, stats: learningStats([g({ declineWhy: 'risky', week: { move: 0.03, index: 0 } })]) }), null);
  assert.match(FUND_SYSTEM, /owner_declines counts the trades the owner declined/);
});

test('the weekly review writes three sentences for the owner, kept for the report', async () => {
  assert.ok(REVIEW_TOOL.input_schema.required.includes('owner_summary'));
  const calls = [];
  const input = { lessons: [], owner_summary: '  Nine ideas were graded.  Two lessons held.\nNext week shows more. ' };
  const client = { beta: { messages: { stream: (req) => { calls.push(req); return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', name: 'submit_lessons', input }], usage: { input_tokens: 10, output_tokens: 1 } }) }; } } } };
  const f = newFund({ budget: 10000, currency: 'USD' });
  const r = await reviewPlaybook({ client, fund: f, cells: [], examples: [], lessons: [] });
  assert.equal(r.summary, 'Nine ideas were graded.  Two lessons held.\nNext week shows more.');
  assert.match(calls[0].system, /owner_summary: three short, plain sentences for the fund's owner/);
  applyReview(f, [], [], at('22:00'), { summary: r.summary });
  assert.deepEqual(f.playbook.ownerSummary, { at: at('22:00').toISOString(), text: 'Nine ideas were graded. Two lessons held. Next week shows more.' });
  applyReview(f, [], [], at('23:00'), { summary: ' ' });
  assert.equal(f.playbook.ownerSummary.at, at('22:00').toISOString()); // an empty one doesn't replace it
});

test('a rejection with a reason reaches the job through the settings passthrough; the reason is never printed or put in the message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'declines-'));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'state'));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  const f = newFund({ budget: 10000, currency: 'USD', settings: { broker: 'tiger' } });
  Object.assign(f, { id: 'f1', name: 'Steady', style: 'balanced', focus: '' });
  const now = new Date();
  executeDecision(f, [buy('AAPL', 1), buy('AAPL', 2)], { AAPL: { ...q(100), time: now.toISOString() } }, now);
  const [p1, p2] = f.proposals;
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [f], archived: [] }));
  const run = (command) => execFileSync('node', [join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', FUND_COMMAND: JSON.stringify(command), FUND_PRIVATE: '' },
  });
  const read = async () => JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  const out = run({ fund: 'f1', reject: [p1.id], why: 'risky' });
  let c = await read();
  assert.deepEqual([c.funds[0].proposals[0].status, c.funds[0].proposals[0].declineWhy], ['rejected', 'risky']);
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok, c.lastCommand.fund], ['reject', true, 'f1']);
  assert.match(c.lastCommand.message, /^Declined the trade in "Steady", with your reason/);
  assert.doesNotMatch(out + c.lastCommand.message, /risky/);
  run({ reject: [p2.id], fund: 'f1' }); // a plain Reject still works
  c = await read();
  assert.deepEqual([c.funds[0].proposals[1].status, c.funds[0].proposals[1].declineWhy, c.lastCommand.message], ['rejected', undefined, 'Rejected 1 proposal(s).']);
  run({ fund: 'f1', reject: [p2.id], why: 'timing' }); // no longer waiting
  c = await read();
  assert.deepEqual([c.lastCommand.ok, c.funds[0].proposals[1].declineWhy], [false, undefined]);
  assert.match(c.lastCommand.message, /no longer waiting/);
});

test('the public copy leaves out the reasons: on proposals, in the statistics and the idea log, and cuts the reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-declines-'));
  const f = newFund({ budget: 1000, currency: 'USD', now: at('14:00') });
  f.id = 'f1';
  f.proposals = [{ id: 'p1', status: 'rejected', declineWhy: 'risky' }];
  f.playbook = { stats: { byOutcome: {}, declinedByReason: { risky: { ideas: 1 } } } };
  f.ideaLog = [[1767794400, 'A', 1, 1, 0, 0, 1, 0.01, 0, 0.02, 0, 0, 0.004, 1, 0.03, null, 1000, 10, null, null, null, null, null, null, null, null, 1]];
  f.reports = Array.from({ length: 6 }, (_, i) => ({ week: `2026-W3${i}`, calls: [{ why: 'risky' }], snapshot: { names: {} }, graded: 7 }));
  await writeFile(join(dir, 'in.json'), JSON.stringify({ version: 2, funds: [f], archived: [] }));
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'in.json'), join(dir, 'out.json')], { cwd: root });
  const out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')).funds[0];
  assert.equal(out.proposals[0].declineWhy, undefined);
  assert.equal(out.playbook.stats.declinedByReason, undefined);
  assert.equal(out.ideaLog[0].length, 17);
  assert.deepEqual(out.reports.map((r) => r.week), ['2026-W32', '2026-W33', '2026-W34', '2026-W35']);
  assert.ok(out.reports.every((r) => !r.calls && !r.snapshot && r.graded === 7));
  assert.doesNotMatch(JSON.stringify(out), /risky/);
});

test('the job files the week\'s report on its first run after Friday\'s close, and doesn\'t print what\'s in it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-run-'));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'state'));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-09-01T14:00:00Z') });
  Object.assign(f, { id: 'f1', name: 'Steady', style: 'balanced', focus: '', lastDecisionAt: '2026-10-02T19:00:00Z' });
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [f], archived: [] }));
  // the clock pinned to Friday 2 Oct 2026, 16:45 in New York
  const pin = 'data:text/javascript,const F=Date.parse("2026-10-02T20:45:00Z");const R=Date;globalThis.Date=class extends R{constructor(...a){if(a.length)super(...a);else super(F)}static now(){return F}};';
  const run = () => execFileSync('node', ['--import', pin, join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', FUND_COMMAND: '', FUND_PRIVATE: '' },
  });
  const out = run();
  const c = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.deepEqual(c.funds[0].reports.map((r) => [r.week, r.short]), [['2026-W40', true]]);
  assert.match(out, /\[Steady\] Weekly report for 2026-W40: one line, too few ideas graded this week\./);
  assert.doesNotMatch(out, /Week to|fund [+−]/);
  run(); // once a week
  assert.equal(JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8')).funds[0].reports.length, 1);
});
