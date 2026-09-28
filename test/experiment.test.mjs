import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyReturns, compareToBaseline, experiments, EXPERIMENT } from '../experiment.js';
import { experimentOf, addFund, loadFunds, MAX_ACTIVE_FUNDS } from '../funds.js';

// A fund with a value at the end of each week (Fridays from 2026-10-02), and AI decisions.
const friday = (i) => new Date(Date.UTC(2026, 9, 2 + 7 * i, 8)).toISOString();
const fund = (values, { currency = 'SGD', costs = [], role = 'B', budget = 10000 } = {}) => ({
  currency, budget, startedAt: '2026-09-28T01:00:00Z',
  history: values.map((v, i) => [friday(i), v]),
  decisions: costs.map((usd, i) => ({ time: friday(i), usage: { costUsd: usd } })),
  experiment: { id: 'exp1', role, tests: role === 'A' ? 'baseline' : 'the model' },
});

test('a week\'s return is its last value over the week before, less that week\'s AI cost in the fund\'s currency', () => {
  const f = fund([10100, 10000], { costs: [10, 0] });
  const r = weeklyReturns(f, { fx: 1.3 });
  // week 1: (10100 − 10000 − US$10 × 1.3) / 10000; week 2: (10000 − 10100) / 10100
  assert.deepEqual([...r.values()].map((x) => Math.round(x * 1e6) / 1e6), [0.0087, -0.009901]);
  assert.equal(weeklyReturns(f, { fx: null }), null); // an SGD fund's AI cost needs the rate
  assert.equal(weeklyReturns(fund([10100], { currency: 'USD', costs: [10] })).values().next().value, 0.009); // USD needs none
});

test('against its baseline: too early before 6 weeks, then a verdict only when clear of noise', () => {
  const base = fund([10000, 10000, 10000, 10000, 10000, 10000], { role: 'A' });
  // 1% better every week, with a little wobble: clear
  const good = fund([10100, 10250, 10330, 10460, 10540, 10660]);
  let r = compareToBaseline(fund(good.history.slice(0, 5).map(([, v]) => v)), base);
  assert.equal(r.verdict, 'too-early');
  assert.equal(r.weeks, 5);
  r = compareToBaseline(good, base);
  assert.equal(r.weeks, EXPERIMENT.minWeeks);
  assert.equal(r.verdict, 'better');
  assert.ok(r.lo > 0 && r.hi > r.lo && r.mean > 0.009);
  // up and down by 2% around the baseline: no clear difference, however long
  const noisy = fund([10200, 9996, 10196, 9992, 10192, 9988]);
  assert.equal(compareToBaseline(noisy, base).verdict, 'unclear');
  // worse every week
  assert.equal(compareToBaseline(fund([9900, 9790, 9700, 9590, 9500, 9400]), base).verdict, 'worse');
  // the AI cost counts: the same values, but a much dearer fund, does worse
  const dear = fund([10000, 10000, 10000, 10000, 10000, 10000], { costs: [30, 30, 30, 30, 30, 30], currency: 'USD' });
  assert.equal(compareToBaseline(dear, fund(base.history.map(([, v]) => v), { currency: 'USD', role: 'A' })).verdict, 'worse');
});

test('experiments group by id and market, baseline first, each judged against its own market\'s baseline', () => {
  const sgA = fund([10000], { role: 'A' }), sgB = fund([10100]), usA = fund([10000], { role: 'A', currency: 'USD' }), usC = fund([9900], { role: 'C', currency: 'USD' });
  const other = { ...fund([10000]), experiment: undefined };
  const ex = experiments([usC, sgB, other, sgA, usA], { fx: 1.3 });
  assert.deepEqual(ex.map((e) => [e.currency, e.funds.map((x) => x.role)]), [['USD', ['A', 'C']], ['SGD', ['A', 'B']]]);
  assert.equal(ex[0].funds[0].result, null); // the baseline isn't compared with itself
  assert.equal(ex[1].funds[1].result.verdict, 'too-early');
  assert.equal(ex[1].baseline, sgA);
});

test('a fund\'s experiment label is checked, and ten funds can run at once', () => {
  assert.deepEqual(experimentOf({ id: 'exp 2026/09', role: 'b', tests: 'x' }), null); // role must be a capital letter
  assert.deepEqual(experimentOf({ id: 'exp-2026-09', role: 'B', tests: ' the model ' }), { id: 'exp-2026-09', role: 'B', tests: 'the model' });
  assert.equal(MAX_ACTIVE_FUNDS, 10);
  const c = loadFunds(null);
  const f = addFund(c, { budget: 10000, currency: 'SGD', decisionsPerDay: 2, experiment: { id: 'e', role: 'A', tests: 'baseline' } });
  assert.deepEqual(f.experiment, { id: 'e', role: 'A', tests: 'baseline' });
  assert.equal(addFund(c, { budget: 1, currency: 'USD' }).experiment, undefined);
});

// ---------- the job: set up an experiment in one run ----------

import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ai-fund.mjs: stopAll then startMany sets up an experiment in one run, printing counts only', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'exp-'));
  for (const d of ['data', 'state']) await mkdir(join(dir, d));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  const c = loadFunds(null);
  addFund(c, { name: 'Old one', budget: 100, currency: 'USD' });
  addFund(c, { name: 'Old two', budget: 1000, currency: 'SGD' });
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify(c));
  const spec = (currency, role, model, decisionsPerDay, extra = {}) => ({
    amount: 10000, currency, decisionsPerDay, name: `${currency === 'SGD' ? 'SGX' : 'US'} ${role} · secret name`, style: 'balanced',
    settings: { model, broker: 'simulator', feePlan: 'tiger', ...extra }, experiment: { id: 'exp-2026-09', role, tests: 'x' },
  });
  const startMany = ['SGD', 'USD'].flatMap((ccy) => [
    spec(ccy, 'A', 'claude-sonnet-5', 2), spec(ccy, 'B', 'deepseek-flash', 2), spec(ccy, 'C', 'deepseek-flash', 0),
    spec(ccy, 'D', 'deepseek-v4-pro', 2), spec(ccy, 'E', 'claude-sonnet-5', 2, { learning: false }),
  ]);
  const { FUND_COMMAND, GITHUB_EVENT_PATH, ...env } = process.env;
  const out = spawnSync('node', [join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...env, ANTHROPIC_API_KEY: '', FUND_PRIVATE: 'true', FUND_COMMAND: JSON.stringify({ fund: 'all', stopAll: true, startMany }) },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Funds: stopped 2\.\nFunds: started 10\./);
  assert.doesNotMatch(out.stdout + out.stderr, /secret name|Old one/);
  const after = JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  assert.equal(after.funds.filter((f) => f.stoppedAt).length, 2);
  const running = after.funds.filter((f) => !f.stoppedAt);
  assert.equal(running.length, 10);
  assert.deepEqual(running.map((f) => `${f.currency}${f.experiment.role}:${f.settings.model}:${f.decisionsPerDay}:${f.settings.learning}`), [
    'SGDA:claude-sonnet-5:2:true', 'SGDB:deepseek-flash:2:true', 'SGDC:deepseek-flash:0:true', 'SGDD:deepseek-v4-pro:2:true', 'SGDE:claude-sonnet-5:2:false',
    'USDA:claude-sonnet-5:2:true', 'USDB:deepseek-flash:2:true', 'USDC:deepseek-flash:0:true', 'USDD:deepseek-v4-pro:2:true', 'USDE:claude-sonnet-5:2:false',
  ]);
  assert.ok(running.every((f) => f.budget === 10000 && f.style === 'balanced' && f.startedAt === running[0].startedAt));
  assert.deepEqual([after.lastCommand.action, after.lastCommand.ok], ['start', true]);
});

test('a difference whose likely range is all on one side, but not yet clear of noise, is "leaning"', () => {
  const base = fund([10000, 10000, 10000, 10000, 10000, 10000], { role: 'A' });
  // about +0.5% a week, wobbling by ±0.6%: the 8-in-10 range stays above zero, the 2.5 bar isn't met
  const r = compareToBaseline(fund([10110, 10100, 10220, 10200, 10320, 10290]), base);
  assert.ok(r.lo > 0 && Math.abs(r.t) < EXPERIMENT.t, JSON.stringify(r));
  assert.equal(r.verdict, 'leaning-better');
});
