import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  askClaude, analyze, recommend, decideFund, buildContext, fundContext, stockStats, parseStrategies, parsePicks,
  AIError, STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL,
} from '../ai.js';
import { newPortfolio, applyTrade } from '../portfolio.js';
import { newFund } from '../fund.js';

const prices = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8'));

const SRC = 'https://news.example.com/nvda';
const searchBlock = { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: SRC, title: 'Nvidia news', page_age: '1 day' }] };
const toolUse = (name, input) => ({ type: 'tool_use', id: 't1', name, input });
const msg = (content, extra = {}) => ({
  stop_reason: 'tool_use', model: 'claude-opus-5', content,
  usage: { input_tokens: 10000, output_tokens: 2000, server_tool_use: { web_search_requests: 2 } }, ...extra,
});

// A fake SDK client that replays the given messages in order and records each request.
const fakeClient = (...messages) => {
  const calls = [];
  return {
    calls,
    beta: { messages: { stream: (req) => { calls.push(structuredClone(req)); const m = messages.shift(); return { finalMessage: async () => m }; } } },
  };
};

const strategies = {
  summary: 'Mixed year.', observations: ['NVDA trends up.'], caveats: 'Past prices only.',
  strategies: [
    {
      title: 'Ride the NVDA trend', symbol: 'NVDA', style: 'trend following', rationale: 'r', risks: 'k', source_urls: [SRC, 'https://made-up.example'],
      rules: [
        { when_type: 'above_ma', when_value: 50, side: 'buy', unit: 'pct_cash', amount: 20, repeat: 'repeat' },
        { when_type: 'below_ma', when_value: 50, side: 'sell', unit: 'all', amount: 0, repeat: 'repeat' },
        { when_type: 'price_below', when_value: 10, side: 'buy', unit: 'all', amount: 0, repeat: 'once' }, // invalid: can't buy "all"
      ],
    },
    { title: 'Made-up stock', symbol: 'FAKE', style: 'other', rationale: '', risks: '', rules: [], source_urls: [] },
  ],
};

test('stockStats summarises a year of closes', () => {
  const s = stockStats(prices.quotes.AAPL);
  assert.equal(s.history_days, 252);
  for (const k of ['return_1y_pct', 'volatility_annual_pct', 'max_drawdown_1y_pct', 'vs_ma200_pct', 'day_change_pct']) assert.equal(typeof s[k], 'number', k);
  assert.ok(s.max_drawdown_1y_pct >= 0);
});

test('askClaude offers web search plus the submit tool, and prices tokens and searches', async () => {
  const client = fakeClient(msg([searchBlock, toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  const res = await askClaude({ client, system: 's', content: 'c', tool: PICKS_TOOL, maxSearches: 3 });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.deepEqual(req.tools[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
  assert.equal(req.tools[1].name, 'submit_picks');
  assert.equal(req.tools[1].strict, true);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(res.sources, [{ url: SRC, title: 'Nvidia news', age: '1 day' }]);
  assert.equal(res.usage.costUsd, 0.12); // 10k in @ $5/M + 2k out @ $25/M + 2 searches @ $0.01
});

test('askClaude resumes a paused turn and nudges once when Claude answers without the tool', async () => {
  const client = fakeClient(
    msg([searchBlock], { stop_reason: 'pause_turn' }),
    msg([{ type: 'text', text: 'Here are my thoughts' }], { stop_reason: 'end_turn' }),
    msg([toolUse('submit_picks', { market_summary: 'x', picks: [] })]),
  );
  const res = await askClaude({ client, system: 's', content: 'c', tool: PICKS_TOOL });
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[1].messages.at(-1).role, 'assistant'); // resumed with no extra user turn
  assert.match(client.calls[2].messages.at(-1).content, /call submit_picks/);
  assert.equal(res.usage.input, 30000);
});

test('askClaude explains refusals, truncation and giving up', async () => {
  await assert.rejects(askClaude({ client: fakeClient(msg([], { stop_reason: 'refusal' })), tool: PICKS_TOOL }), AIError);
  await assert.rejects(askClaude({ client: fakeClient(msg([toolUse('submit_picks', {})], { stop_reason: 'max_tokens' })), tool: PICKS_TOOL }), /cut off/);
  const talk = () => msg([{ type: 'text', text: 'hmm' }], { stop_reason: 'end_turn' });
  await assert.rejects(askClaude({ client: fakeClient(talk(), talk()), tool: PICKS_TOOL, maxRounds: 2 }), /did not return/);
});

test('askClaude on Sonnet skips the Opus-only fallback option', async () => {
  const client = fakeClient(msg([toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  await askClaude({ client, model: 'claude-sonnet-5', tool: PICKS_TOOL });
  assert.equal(client.calls[0].fallbacks, undefined);
});

test('buildContext includes portfolio, record and focused stock only', () => {
  let p = applyTrade(newPortfolio(), { symbol: 'AAPL', side: 'buy', qty: 10, price: 100, currency: 'USD', time: '2026-01-01T00:00:00Z' });
  p = applyTrade(p, { symbol: 'AAPL', side: 'sell', qty: 5, price: 120, currency: 'USD', time: '2026-01-02T00:00:00Z' });
  const ctx = buildContext({ prices, portfolio: p, focus: 'AAPL', risk: 'cautious', question: ' protect gains? ' });
  assert.equal(ctx.stocks.length, 1);
  assert.equal(ctx.stocks[0].weekly_closes.length, 51);
  assert.equal(ctx.trading_record.winning_closing_trades, 1);
  assert.equal(ctx.question, 'protect gains?');
  assert.equal(ctx.sample_data, true);
  assert.match(ctx.risk_profile, /Cautious/);
  assert.ok(JSON.stringify(ctx).length < 60000);
});

test('parseStrategies keeps valid rules paused, reports invalid ones, drops unknown stocks and unseen links', () => {
  const out = parseStrategies(strategies, prices.quotes, [{ url: SRC }]);
  assert.equal(out.strategies.length, 1);
  const s = out.strategies[0];
  assert.equal(s.rules.length, 2);
  assert.ok(s.rules.every((r) => r.enabled === false && r.symbol === 'NVDA' && r.note === 'Ride the NVDA trend'));
  assert.equal(s.problems.length, 1);
  assert.deepEqual(s.source_urls, [SRC]);
});

test('analyze returns parsed strategies with sources and cost', async () => {
  const client = fakeClient(msg([searchBlock, toolUse(STRATEGIES_TOOL.name, strategies)]));
  const out = await analyze({ client, context: {}, quotes: prices.quotes });
  assert.equal(out.strategies.length, 1);
  assert.equal(out.sources.length, 1);
  assert.ok(out.usage.costUsd > 0);
});

test('parsePicks keeps watchlist stocks once each and records the price at the time', () => {
  const out = parsePicks({
    market_summary: 'm',
    picks: [
      { symbol: 'NVDA', stance: 'long', conviction: 'high', horizon: 'weeks', thesis: 't', news: 'n', risks: 'r', source_urls: [SRC] },
      { symbol: 'NVDA', stance: 'short', conviction: 'low', horizon: 'days', thesis: 't', news: 'n', risks: 'r', source_urls: [] },
      { symbol: 'NOPE', stance: 'long', conviction: 'high', horizon: 'days', thesis: 't', news: 'n', risks: 'r', source_urls: [] },
      { symbol: 'TSLA', stance: 'short', conviction: 'medium', horizon: 'days', thesis: 't', news: 'n', risks: 'r', source_urls: ['https://x.example'] },
    ],
  }, prices.quotes, [{ url: SRC }]);
  assert.deepEqual(out.picks.map((p) => `${p.symbol}:${p.stance}`), ['NVDA:long', 'TSLA:short']);
  assert.equal(out.picks[0].priceAtPick, prices.quotes.NVDA.price);
  assert.deepEqual(out.picks[1].source_urls, []);
});

test('recommend sends the whole watchlist and the date', async () => {
  const client = fakeClient(msg([toolUse('submit_picks', { market_summary: 'm', picks: [] })]));
  const out = await recommend({ client, prices, now: new Date('2026-09-26T00:00:00Z') });
  assert.match(client.calls[0].messages[0].content, /Sat, 26 Sep 2026/);
  assert.equal(JSON.parse(client.calls[0].messages[0].content.split('\n\n')[1]).watchlist.length, 20);
  assert.equal(out.createdAt, '2026-09-26T00:00:00.000Z');
});

test('fund context covers only the fund\'s market and its own state', async () => {
  const fund = newFund({ budget: 10000, currency: 'SGD', now: new Date('2026-01-02T02:00:00Z') });
  const ctx = fundContext({ fund, quotes: prices.quotes, picks: { createdAt: 'x', picks: [{ symbol: 'D05.SI', stance: 'long', conviction: 'high', thesis: 't' }, { symbol: 'AAPL', stance: 'long' }] } });
  assert.ok(ctx.stocks.every((s) => s.currency === 'SGD'));
  assert.equal(ctx.stocks.length, 10);
  assert.equal(ctx.fund.buying_power, 10000);
  assert.deepEqual(ctx.analyst_picks.map((p) => p.symbol), ['D05.SI']);

  const client = fakeClient(msg([toolUse(FUND_TOOL.name, { outlook: 'o', orders: [], protections: [], source_urls: [] })]));
  const d = await decideFund({ client, fund, quotes: prices.quotes });
  assert.equal(d.outlook, 'o');
});

test('every tool schema forbids extra properties and requires every field (strict tool use)', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  for (const t of [STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL]) walk(t.input_schema);
});
