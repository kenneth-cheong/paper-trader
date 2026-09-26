import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  askClaude, gatherNews, analyze, recommend, decideFund, buildContext, fundContext, stockStats, parseStrategies, parsePicks,
  AIError, STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL, NEWS_TOOL,
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

const digest = {
  market_summary: 'Oil is up and the Fed hiked.',
  items: [
    { symbols: ['NVDA'], date: '2026-09-25', headline: 'AI capex beats', summary: 'Hyperscalers raised capex.', source_url: SRC },
    { symbols: ['FAKE', 'TSLA'], date: '2026-09-24', headline: 'Deliveries cut', summary: 'Estimates cut.', source_url: 'https://never-searched.example' },
    { symbols: [], date: '2026-09-16', headline: 'Fed hikes', summary: 'First hike since 2023.', source_url: SRC },
  ],
};
// A news step (Haiku, with web search) followed by a decision step (no search).
const newsMsg = () => msg([searchBlock, toolUse(NEWS_TOOL.name, digest)]);
const decisionMsg = (name, input) => msg([toolUse(name, input)], { usage: { input_tokens: 10000, output_tokens: 2000 } });

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

test('askClaude defaults to Haiku with basic web search, no thinking, and prices tokens and searches', async () => {
  const client = fakeClient(msg([searchBlock, toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  const res = await askClaude({ client, system: 's', content: 'c', tool: PICKS_TOOL, maxSearches: 3 });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
  assert.equal(req.tools[1].name, 'submit_picks');
  assert.equal(req.tools[1].strict, true);
  assert.equal(req.thinking, undefined);
  assert.equal(req.output_config, undefined);
  assert.equal(req.fallbacks, undefined);
  assert.deepEqual(res.sources, [{ url: SRC, title: 'Nvidia news', age: '1 day' }]);
  assert.equal(res.usage.costUsd, 0.04); // 10k in @ $1/M + 2k out @ $5/M + 2 searches @ $0.01
});

test('askClaude on Opus uses dynamic web search, adaptive thinking and the refusal fallback', async () => {
  const client = fakeClient(msg([toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  const res = await askClaude({ client, model: 'claude-opus-5', tool: PICKS_TOOL });
  const req = client.calls[0];
  assert.equal(req.tools[0].type, 'web_search_20260209');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.deepEqual(req.output_config, { effort: 'high' });
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(res.usage.costUsd, 0.12); // 10k in @ $5/M + 2k out @ $25/M + 2 searches
});

test('askClaude on Sonnet uses medium effort and no Opus-only fallback; unknown models fall back to the default', async () => {
  let client = fakeClient(msg([toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  await askClaude({ client, model: 'claude-sonnet-5', tool: PICKS_TOOL });
  assert.deepEqual(client.calls[0].output_config, { effort: 'medium' });
  assert.equal(client.calls[0].fallbacks, undefined);
  client = fakeClient(msg([toolUse('submit_picks', { market_summary: 'x', picks: [] })]));
  await askClaude({ client, model: 'claude-made-up', tool: PICKS_TOOL });
  assert.equal(client.calls[0].model, 'claude-haiku-4-5');
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

test('gatherNews uses Haiku with web search and drops unseen links and unknown symbols', async () => {
  const client = fakeClient(newsMsg());
  const news = await gatherNews({ client, quotes: prices.quotes, symbols: ['NVDA', 'TSLA'], now: new Date('2026-09-26T00:00:00Z') });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.tools[0].type, 'web_search_20250305');
  assert.match(req.messages[0].content, /NVDA \(Nvidia, US\)\nTSLA/);
  assert.equal(news.items[1].source_url, null);
  assert.deepEqual(news.items[1].symbols, ['TSLA']);
  assert.equal(news.sources.length, 1);
  assert.equal(news.model, 'claude-opus-5'); // whatever the API reports serving (the fake echoes a fixed id)
});

test('analyze gathers news with Haiku, then decides with Sonnet from the digest only', async () => {
  const client = fakeClient(newsMsg(), decisionMsg(STRATEGIES_TOOL.name, strategies));
  const context = buildContext({ prices, portfolio: newPortfolio(), focus: 'NVDA' });
  const out = await analyze({ client, context, quotes: prices.quotes });
  assert.equal(client.calls[0].model, 'claude-haiku-4-5');
  const decide = client.calls[1];
  assert.equal(decide.model, 'claude-sonnet-5');
  assert.deepEqual(decide.tools.map((t) => t.name), ['submit_strategies']); // no web search
  const sent = JSON.parse(decide.messages[0].content.split('\n\n')[1]);
  assert.deepEqual(sent.news.items.map((i) => i.headline), ['AI capex beats', 'Fed hikes']); // NVDA + market-wide
  assert.equal(out.strategies.length, 1);
  assert.equal(out.usage.input, 20000); // both steps counted
  assert.equal(out.usage.searches, 2);
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

test('recommend gathers news once, then picks from it without searching', async () => {
  const client = fakeClient(newsMsg(), msg([toolUse('submit_picks', {
    market_summary: 'm',
    picks: [{ symbol: 'NVDA', stance: 'long', conviction: 'high', horizon: 'weeks', thesis: 't', news: 'n', risks: 'r', source_urls: [SRC, 'https://never-searched.example'] }],
  })]));
  const out = await recommend({ client, prices, now: new Date('2026-09-26T00:00:00Z') });
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].messages[0].content, /Sat, 26 Sep 2026/);
  const sent = JSON.parse(client.calls[1].messages[0].content.split('\n\n')[1]);
  assert.equal(sent.watchlist.length, 20);
  assert.equal(sent.news.items.length, 3);
  assert.deepEqual(out.picks[0].source_urls, [SRC]);
  assert.equal(out.news.items.length, 3); // returned so the fund can reuse it
  assert.equal(out.createdAt, '2026-09-26T00:00:00.000Z');
});

test('recommend reuses a digest it is given and only pays for the decision', async () => {
  const client = fakeClient(decisionMsg('submit_picks', { market_summary: 'm', picks: [] }));
  const out = await recommend({ client, prices, news: { ...digest, sources: [], model: 'claude-haiku-4-5', usage: { input: 1, output: 1, searches: 1, costUsd: 9 } } });
  assert.equal(client.calls.length, 1);
  assert.equal(out.usage.costUsd, 0.04); // decision only: 10k in @ $2/M + 2k out @ $10/M on Sonnet
  assert.equal(out.news, undefined);
});

test('fund context covers only the fund\'s market and its own state', async () => {
  const fund = newFund({ budget: 10000, currency: 'SGD', now: new Date('2026-01-02T02:00:00Z') });
  const ctx = fundContext({ fund, quotes: prices.quotes, picks: { createdAt: 'x', picks: [{ symbol: 'D05.SI', stance: 'long', conviction: 'high', thesis: 't' }, { symbol: 'AAPL', stance: 'long' }] } });
  assert.ok(ctx.stocks.every((s) => s.currency === 'SGD'));
  assert.equal(ctx.stocks.length, 10);
  assert.equal(ctx.fund.buying_power, 10000);
  assert.deepEqual(ctx.analyst_picks.map((p) => p.symbol), ['D05.SI']);

  const client = fakeClient(newsMsg(), msg([toolUse(FUND_TOOL.name, { outlook: 'o', orders: [], protections: [], source_urls: [SRC] })]));
  const d = await decideFund({ client, fund, quotes: prices.quotes });
  assert.equal(d.outlook, 'o');
  assert.match(client.calls[0].messages[0].content, /D05\.SI/);
  assert.doesNotMatch(client.calls[0].messages[0].content, /AAPL/); // news only for the fund's market
  assert.equal(client.calls[1].model, 'claude-sonnet-5');
  assert.deepEqual(d.source_urls, [SRC]);
  assert.ok(d.news);
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
  for (const t of [STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL, NEWS_TOOL]) walk(t.input_schema);
});
