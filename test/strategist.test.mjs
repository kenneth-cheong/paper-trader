import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strategistRequest, strategistJobContext, buildContext, RISK } from '../ai.js';
import { newPortfolio, applyTrade } from '../portfolio.js';

const root = new URL('..', import.meta.url).pathname;
const prices = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8'));

// ---------- what the app sends, and what the job makes of it ----------

test('the app sends only the owner\'s own part of the strategist\'s data; the job adds the stocks from its prices', () => {
  const portfolio = applyTrade(newPortfolio(), { symbol: 'AAPL', side: 'buy', qty: 10, price: prices.quotes.AAPL.price, currency: 'USD', fee: 0 });
  const context = buildContext({ prices, portfolio, focus: 'AAPL', risk: 'cautious', question: 'How do I protect my Apple gains?' });
  const sent = strategistRequest({ context: { ...context, evil: 'x' }, focus: 'AAPL', risk: 'cautious', question: `  ${'q'.repeat(400)}  ` });
  assert.deepEqual(Object.keys(sent.context), ['trading_fees', 'accounts', 'holdings', 'active_rules', 'trading_record']);
  assert.equal(sent.question.length, 300);
  assert.equal(sent.context.holdings[0].symbol, 'AAPL');
  // rebuilt on the runner: the same data the browser would have sent, with the stock list from its prices
  const job = strategistJobContext({ sent: { ...sent, question: 'How do I protect my Apple gains?' }, prices, now: new Date(context.now) });
  assert.deepEqual({ ...job, prices_as_of: context.prices_as_of }, context);
  // a focus that isn't on the watchlist means the whole watchlist; an unknown risk is balanced
  const odd = strategistJobContext({ sent: { focus: 'ZZZ', risk: 'yolo', context: { stocks: [], holdings: [] } }, prices });
  assert.equal(odd.stocks.length, Object.keys(prices.quotes).length);
  assert.equal(odd.risk_profile, RISK.balanced);
  assert.equal(odd.question, null);
  assert.deepEqual(odd.holdings, []);
});

// ---------- the job ----------

const fakeSdk = `
import { appendFileSync } from 'node:fs';
export default class Anthropic {
  constructor() {
    this.beta = { messages: { stream: (req) => {
      if (process.env.FAKE_SDK_LOG) appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(req) + '\\n');
      const tool = req.tools.find((t) => t.input_schema);
      return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't1', name: tool.name, input: JSON.parse(process.env.FAKE_SDK_ANSWER ?? '{}') }], usage: { input_tokens: 2000, output_tokens: 150 } }) };
    } } };
  }
}`;
const hooks = `export async function resolve(s, c, n) { return s === '@anthropic-ai/sdk' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeSdk)}`)}, shortCircuit: true } : n(s, c); }`;
const withFakeSdk = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`)}`;
const { FUND_COMMAND, GITHUB_EVENT_PATH, ...baseEnv } = process.env;

const answer = {
  summary: 'Protect the Apple position.', observations: ['One holding.'], caveats: 'Virtual money.',
  strategies: [{
    title: 'Trail the gains', symbol: 'AAPL', style: 'protect gains', rationale: 'r', risks: 'k', source_urls: [],
    rules: [{ when_type: 'drop_from_high', when_value: 8, side: 'sell', unit: 'all', amount: 0, repeat: 'once' }],
  }],
};

test('ai-fund.mjs: the strategist runs on the runner for an admin, is kept with the funds, and nothing of it is printed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strategist-'));
  for (const d of ['data', 'state']) await mkdir(join(dir, d));
  await writeFile(join(dir, 'data', 'prices.json'), JSON.stringify(prices));
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [], archived: [] }));
  const portfolio = applyTrade(newPortfolio(), { symbol: 'AAPL', side: 'buy', qty: 10, price: prices.quotes.AAPL.price, currency: 'USD', fee: 0 });
  const question = 'How do I protect my Apple gains?';
  const sent = strategistRequest({ context: buildContext({ prices, portfolio, focus: 'AAPL', question }), focus: 'AAPL', risk: 'cautious', question });
  const log = join(dir, 'sdk.log');
  const run = (strategist, env = {}) => spawnSync('node', ['--import', withFakeSdk, join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8',
    env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', FUND_PRIVATE: '', AI_MONTHLY_CAP_USD: '', AI_MODEL: '', AI_NEWS_MODEL: '', FAKE_SDK_LOG: log, FAKE_SDK_ANSWER: JSON.stringify(answer), FUND_COMMAND: JSON.stringify({ fund: 'all', strategist }), ...env },
  });
  const state = async () => JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  const month = new Date().toISOString().slice(0, 7);
  // with the picks job's fresh digest: one call (no news search), whose cost alone is counted
  await writeFile(join(dir, 'state', 'news.json'), JSON.stringify({ market_summary: 'Calm.', items: [], sources: [], model: 'm', usage: { costUsd: 0.05 }, createdAt: new Date().toISOString() }));
  let out = run(sent);
  assert.equal(out.status, 0, out.stderr);
  let c = await state();
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok, c.lastCommand.message], ['strategist', true, 'The strategist answered with one strategy: see the AI strategist tab.']);
  assert.equal(c.strategist.summary, 'Protect the Apple position.');
  assert.deepEqual(c.strategist.strategies.map((s) => [s.symbol, s.rules.length, s.rules[0].enabled]), [['AAPL', 1, false]]);
  assert.deepEqual([c.strategist.focus, c.strategist.risk, c.strategist.question], ['AAPL', 'cautious', question]);
  const reqs = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].tools.map((t) => t.name), ['submit_strategies']);
  const data = JSON.parse(reqs[0].messages[0].content.replace(/^[^{]*/, ''));
  assert.equal(data.question, question);
  assert.deepEqual(data.holdings.map((h) => h.symbol), ['AAPL']);
  assert.deepEqual(data.stocks.map((s) => s.symbol), ['AAPL']);
  const spent = JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8')).months[month];
  assert.ok(spent.strategist > 0 && spent.strategist < 0.05, `strategist ${spent.strategist}`);
  assert.doesNotMatch(out.stdout + out.stderr, /Apple|AAPL|protect/i);
  // the public copy of the funds leaves the answer out
  const pub = join(dir, 'public.json');
  spawnSync('node', [join(root, 'scripts/public-fund.mjs'), join(dir, 'state', 'ai-fund.json'), pub], { cwd: root, encoding: 'utf8', env: baseEnv });
  assert.equal(JSON.parse(await readFile(pub, 'utf8')).strategist, undefined);
  // refused: too large, no key, at the cap; the last answer stays
  run({ ...sent, context: { ...sent.context, trading_record: { recent_trades: 'x'.repeat(50000) } } });
  assert.deepEqual([(await state()).lastCommand.ok, (await state()).lastCommand.message], [false, 'The strategist request was too large.']);
  run(sent, { ANTHROPIC_API_KEY: '' });
  assert.equal((await state()).lastCommand.message, 'ANTHROPIC_API_KEY isn\'t set, so the strategist couldn\'t run.');
  run(sent, { AI_MONTHLY_CAP_USD: '0.001' });
  assert.equal((await state()).lastCommand.message, 'This month\'s AI spend has reached the cap, so the strategist can\'t run until next month.');
  c = await state();
  assert.equal(c.strategist.summary, 'Protect the Apple position.');
  // without a fresh digest it gathers its own news first, and that is counted too
  await writeFile(join(dir, 'state', 'news.json'), JSON.stringify({ items: [], sources: [], usage: { costUsd: 0.05 }, createdAt: '2020-01-01T00:00:00Z' }));
  const before = JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8')).months[month].strategist;
  out = run(sent);
  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8')).months[month].strategist;
  assert.ok(after - before > spent.strategist, 'the news call is counted as well');
});
