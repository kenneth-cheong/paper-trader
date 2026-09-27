import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  askClaude, gatherNews, analyze, recommend, decideFund, buildContext, fundContext, stockStats, parseStrategies, parsePicks,
  BACKFILL_TOOL, REVIEW_TOOL, backfillNews, newsForPrompt, FUND_SYSTEM, PICKS_SYSTEM, NEWS_SYSTEM,
  AIError, STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL, NEWS_TOOL, MOVE_TOOL, explainMove, knownUrls, READING_TOOL, readCalls, ASK_TOOL, askSpec,
} from '../ai.js';
import { resultsCalendar } from '../calendar.js';
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
  assert.equal(s.beta_1y, undefined); // without the index
  const b = stockStats(prices.quotes.AAPL, prices.quotes.SPY).beta_1y;
  assert.ok(typeof b === 'number' && b >= 0 && b <= 3);
  assert.equal(stockStats(prices.quotes.SPY, prices.quotes.SPY).beta_1y, 1);
  assert.match(FUND_SYSTEM, /confidence is computed for you; treat Moderate as a tilt, not a rule/);
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

test('an error after the API answered carries what those answers cost; one before any answer carries nothing', async () => {
  const talk = () => msg([{ type: 'text', text: 'hmm' }], { stop_reason: 'end_turn' }); // 10k in, 2k out, 2 searches each
  const err = await askClaude({ client: fakeClient(talk(), talk()), tool: PICKS_TOOL, maxRounds: 2 }).catch((e) => e);
  assert.match(err.message, /did not return/);
  assert.deepEqual([err.usage.input, err.usage.output, err.usage.searches], [20000, 4000, 4]);
  assert.equal(err.usage.costUsd, 0.08); // Haiku: 20k × US$1/M + 4k × US$5/M + 4 × US$0.01
  const cut = await askClaude({ client: fakeClient(msg([toolUse('submit_picks', {})], { stop_reason: 'max_tokens' })), tool: PICKS_TOOL }).catch((e) => e);
  assert.ok(cut.usage.costUsd > 0);
  const refused = await askClaude({ client: fakeClient(msg([], { stop_reason: 'refusal' })), tool: PICKS_TOOL }).catch((e) => e);
  assert.ok(refused.usage.costUsd > 0);
  // the API unreachable on the first request: nothing billed
  const down = { beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('socket hang up'); } }) } } };
  const none = await askClaude({ client: down, tool: PICKS_TOOL }).catch((e) => e);
  assert.equal(none.usage, undefined);
  // unreachable on the second round, after a billed first one
  let n = 0;
  const flaky = { beta: { messages: { stream: () => ({ finalMessage: async () => { if (n++) throw new Error('socket hang up'); return talk(); } }) } } };
  assert.equal((await askClaude({ client: flaky, tool: PICKS_TOOL, maxRounds: 2 }).catch((e) => e)).usage.input, 10000);
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
  // a fixed clock: the news fixtures are dated, and items over 10 trading days old become background
  const context = buildContext({ prices, portfolio: newPortfolio(), focus: 'NVDA', now: new Date('2026-09-26T00:00:00Z') });
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
  for (const t of [STRATEGIES_TOOL, PICKS_TOOL, FUND_TOOL, NEWS_TOOL, BACKFILL_TOOL, REVIEW_TOOL, MOVE_TOOL, READING_TOOL, ASK_TOOL]) walk(t.input_schema);
});

test('a fund decision puts the shared market data first, cached only when asked, with the playbook in the fund part', async () => {
  const fund = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-01-02T15:00:00Z') });
  const news = { market_summary: 'm', items: [], model: 'claude-haiku-4-5', createdAt: 'x' };
  const answer = () => decisionMsg(FUND_TOOL.name, { outlook: 'o', orders: [], considered: [{ symbol: 'AAPL', stance: 'long', idea_type: 'news', why_not: 'wait' }], protections: [], source_urls: [] });
  const client = fakeClient(answer(), answer());
  const d = await decideFund({ client, fund, quotes: prices.quotes, news, playbook: { lessons: [{ lesson: 'Cut losers.' }] }, cacheShared: true });
  const [shared, own] = client.calls[0].messages[0].content;
  assert.deepEqual(shared.cache_control, { type: 'ephemeral' });
  assert.match(shared.text, /AAPL/);
  assert.doesNotMatch(shared.text, /Cut losers/);
  assert.match(own.text, /Cut losers/);
  assert.equal(d.considered[0].symbol, 'AAPL');
  await decideFund({ client, fund, quotes: prices.quotes, news });
  assert.equal(client.calls[1].messages[0].content[0].cache_control, undefined);
});

test('cached input is priced at its real rate', async () => {
  const client = fakeClient(msg([toolUse('t', { a: 1 })], { usage: { input_tokens: 1000, cache_creation_input_tokens: 8000, cache_read_input_tokens: 0, output_tokens: 1000 } }),
    msg([toolUse('t', { a: 1 })], { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000, output_tokens: 1000 } }));
  const tool = { name: 't', input_schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'number' } } } };
  const first = await askClaude({ client, model: 'claude-sonnet-5', system: 's', content: 'c', tool, maxSearches: 0 });
  const second = await askClaude({ client, model: 'claude-sonnet-5', system: 's', content: 'c', tool, maxSearches: 0 });
  assert.equal(first.usage.costUsd, 0.032); // (1000 + 8000 x 1.25) x $2/M + 1000 x $10/M
  assert.equal(second.usage.costUsd, 0.0136); // (1000 + 8000 x 0.1) x $2/M + 1000 x $10/M
});

test('the news backfill keeps only dated events in the period with a source it really read', async () => {
  const good = 'https://example.com/dbs-results';
  const search = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: good, title: 'DBS results' }] };
  const client = fakeClient(msg([search, toolUse(BACKFILL_TOOL.name, { events: [
    { date: '2026-02-10', headline: 'DBS profit beats', type: 'earnings', tone: 'positive', source_url: good },
    { date: '2026-02-11', headline: 'Made up', type: 'deal', tone: 'positive', source_url: 'https://invented.example' },
    { date: '2024-01-01', headline: 'Too old', type: 'deal', tone: 'negative', source_url: good },
  ] })]));
  const r = await backfillNews({ client, symbol: 'D05.SI', name: 'DBS Group', from: '2025-10-01', to: '2026-09-01' });
  assert.deepEqual(r.events.map((e) => [e.symbol, e.headline, e.from]), [['D05.SI', 'DBS profit beats', 'backfill']]);
  assert.equal(client.calls[0].model, 'claude-haiku-4-5');
});

test('news older than 10 trading days is background, and every item says how old it is', () => {
  const news = { createdAt: 'x', market_summary: 'm', items: [
    { symbols: ['O39.SI'], date: '2026-08-07', headline: 'OCBC results' },
    { symbols: ['D05.SI'], date: '2026-09-25', headline: 'DBS deal' },
    { symbols: [], date: '2026-09-10', headline: 'Fed' }, // 11 trading days before 26 Sep
    { symbols: ['AAPL'], date: 'unknown', headline: 'Undated' },
  ] };
  const out = newsForPrompt(news, ['O39.SI', 'D05.SI', 'AAPL'], new Date('2026-09-26T02:00:00Z'));
  assert.deepEqual(out.items.map((i) => [i.headline, i.age_days]), [['DBS deal', 1], ['Undated', null]]);
  assert.deepEqual(out.background.map((i) => [i.headline, i.age_days]), [['OCBC results', 50], ['Fed', 16]]);
  assert.equal(newsForPrompt({ ...news, items: news.items.slice(1, 2) }, null, new Date('2026-09-26T02:00:00Z')).background, undefined);
  assert.equal(newsForPrompt(null), null);
  assert.match(FUND_SYSTEM, /news\.background/);
  assert.match(PICKS_SYSTEM, /news\.background/);
  assert.match(NEWS_SYSTEM, /only background/);
});

test('results due soon and analysts reach the AI, the shared market data stays identical across funds', async () => {
  const now = new Date('2026-01-02T21:30:00Z'); // a Friday evening; the sample prices end that day
  const company = { symbols: {
    AAPL: { next: { date: '2026-01-06', estimate: false }, past: [], ratings: { strongBuy: 6, buy: 19, hold: 13, sell: 3, strongSell: 3 }, target: { mean: 352.29, n: 44 }, changes: [] },
    NVDA: { next: { date: '2026-01-08', estimate: true }, past: [] },
    'D05.SI': { next: { date: '2026-01-05', estimate: false }, past: [] },
  } };
  const calendar = resultsCalendar({ company, quotes: prices.quotes, now });
  const holder = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: new Date('2026-01-02T15:00:00Z') });
  holder.portfolio.positions.AAPL = { qty: 10, avgCost: 300, currency: 'USD' };
  const other = newFund({ budget: 50000, currency: 'USD', style: 'aggressive', now: new Date('2026-01-02T15:00:00Z') });
  const news = { market_summary: 'm', items: [], model: 'claude-haiku-4-5', createdAt: 'x' };
  const answer = () => decisionMsg(FUND_TOOL.name, { outlook: 'o', orders: [], considered: [], protections: [], source_urls: [] });
  const client = fakeClient(answer(), answer());
  for (const fund of [holder, other]) await decideFund({ client, fund, quotes: prices.quotes, news, company, calendar, cacheShared: true, now });
  const [a, b] = client.calls.map((c) => c.messages[0].content);
  assert.equal(a[0].text, b[0].text); // one cached copy for both funds
  assert.equal(client.calls[0].system, client.calls[1].system);
  const market = JSON.parse(a[0].text.split('\n\n')[1]);
  assert.deepEqual(market.upcoming_results.map((u) => [u.symbol, u.days_away, u.source]), [['AAPL', 2, 'yahoo'], ['NVDA', 4, 'estimated']]);
  const aaplStats = market.stocks.find((s) => s.symbol === 'AAPL');
  assert.deepEqual(aaplStats.analysts, { n: 44, buy_hold_sell: [25, 13, 6], consensus_target: 352.29, implied_upside_pct: 10, rating_changes_10d: [] });
  assert.equal(market.stocks.find((s) => s.symbol === 'MSFT').analysts, undefined); // no data, nothing sent
  const own = JSON.parse(a[1].text.split('\n\n')[1]);
  const pos = own.positions.find((p) => p.symbol === 'AAPL');
  assert.equal(pos.results_soon.days_away, 2);
  assert.equal(pos.results_soon.share_of_fund_pct, 24.3); // 10 x 320.26 of 13,202.60
  assert.match(FUND_SYSTEM, /upcoming_results/);
  // without the files the context is as before
  const plain = fundContext({ fund: holder, quotes: prices.quotes, news, now });
  assert.equal(plain.upcoming_results, undefined);
  assert.equal(plain.positions[0].results_soon, undefined);
});

// ---------- the news feeds' headlines as leads, and the search behind a big move ----------

const LEAD = 'https://www.businesstimes.com.sg/companies-markets/dbs-posts-record-profit';
const feedArticles = [
  { id: 'a1', symbols: ['D05.SI'], source: 'businesstimes.com.sg', feed: 'bt', pubDate: '2026-09-25T09:00:00Z', headline: 'DBS posts record profit', url: LEAD },
  { id: 'a2', symbols: ['NVDA'], source: 'cnbc.com', feed: 'cnbc-top', pubDate: '2026-09-25T20:00:00Z', headline: 'Nvidia wows Wall Street', url: 'https://www.cnbc.com/nvda.html' },
  { id: 'a3', symbols: ['D05.SI'], source: 'x.example', feed: 'f', pubDate: '2026-09-10T09:00:00Z', headline: 'Too old', url: 'https://x.example/old' },
];

test('the digest gets the feeds\' freshest headlines as leads, and may cite their links', async () => {
  const cited = { market_summary: 'm', items: [
    { symbols: ['D05.SI'], date: '2026-09-25', headline: 'DBS record profit', summary: 's', type: 'earnings', tone: 'positive', source_url: `${LEAD}?utm_source=rss` },
    { symbols: ['NVDA'], date: '2026-09-25', headline: 'AI capex beats', summary: 's', type: 'earnings', tone: 'positive', source_url: SRC },
    { symbols: ['NVDA'], date: '2026-09-25', headline: 'Made up', summary: 's', type: 'other', tone: 'mixed', source_url: 'https://never-given.example' },
  ] };
  const client = fakeClient(msg([searchBlock, toolUse(NEWS_TOOL.name, cited)]));
  const now = new Date('2026-09-26T00:00:00Z');
  const news = await gatherNews({ client, quotes: prices.quotes, symbols: ['D05.SI', 'NVDA'], now, articles: feedArticles });
  const content = client.calls[0].messages[0].content;
  assert.match(content, /Leads \(headlines only\)/);
  assert.match(content, /- \[NVDA\] Nvidia wows Wall Street \(cnbc\.com, 4h ago\) https:\/\/www\.cnbc\.com\/nvda\.html/);
  assert.match(content, /- \[D05\.SI\] DBS posts record profit/);
  assert.doesNotMatch(content, /Too old/); // over 4 days old
  assert.equal(client.calls[0].system, NEWS_SYSTEM); // the system prompt doesn't change
  assert.deepEqual(news.items.map((i) => i.source_url), [LEAD, SRC, null]); // a lead's link counts, as it was given
  assert.deepEqual(news.leads.map((l) => l.url), ['https://www.cnbc.com/nvda.html', LEAD]);
  // without articles (the page, or NEWS_LEADS=off) the request is as before
  const plain = fakeClient(newsMsg());
  const without = await gatherNews({ client: plain, quotes: prices.quotes, symbols: ['D05.SI', 'NVDA'], now });
  assert.doesNotMatch(plain.calls[0].messages[0].content, /Leads/);
  assert.equal(without.leads, undefined);
  // and a digest for one market gets only its own stocks' leads
  const us = fakeClient(newsMsg());
  await gatherNews({ client: us, quotes: prices.quotes, symbols: ['NVDA', 'AAPL'], now, articles: feedArticles });
  assert.doesNotMatch(us.calls[0].messages[0].content, /DBS/);
});

test('known links: a page it read, or a lead, also when cited with tracking parameters', () => {
  const seen = [{ url: SRC }, { url: LEAD }];
  assert.deepEqual(knownUrls([SRC, `${LEAD}?.tsrc=rss`, `${LEAD}#comments`, 'https://never-seen.example', null], seen), [SRC, LEAD, LEAD]);
  assert.deepEqual(knownUrls(undefined, seen), []);
});

test('recommend passes the feeds\' headlines to the digest it gathers', async () => {
  const client = fakeClient(newsMsg(), msg([toolUse('submit_picks', { market_summary: 'm', picks: [] })]));
  const out = await recommend({ client, prices, articles: feedArticles, now: new Date('2026-09-26T00:00:00Z') });
  assert.match(client.calls[0].messages[0].content, /Leads \(headlines only\)/);
  assert.equal(out.news.leads.length, 2);
});

test('a big move without news gets one search; what it finds counts only with a source it read, dated near the move', async () => {
  const good = 'https://example.com/nvda-deal';
  const read = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: good, title: 'Nvidia deal' }] };
  const answer = (input) => fakeClient(msg([read, toolUse(MOVE_TOOL.name, input)], { usage: { input_tokens: 8000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } } }));
  const found = { found: true, date: '2026-09-29', headline: 'Nvidia to buy a chip designer', type: 'deal', tone: 'positive', source_url: good };
  let client = answer(found);
  const r = await explainMove({ client, symbol: 'NVDA', name: 'Nvidia', market: 'US', date: '2026-09-30', excess: 0.061 });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 1 });
  assert.match(req.messages[0].content, /On 2026-09-30 it moved up 6\.1% more than its index/);
  assert.deepEqual(r.event, { symbol: 'NVDA', date: '2026-09-29', headline: 'Nvidia to buy a chip designer', type: 'deal', tone: 'positive', source_url: good, from: 'search' });
  assert.equal(r.found, true);
  assert.equal(r.usage.costUsd, 0.0195); // 8k in @ $1/M + 300 out @ $5/M + 1 search @ $0.01
  // a source it didn't read, a date two sessions away, or nothing found: no event
  for (const bad of [{ ...found, source_url: 'https://invented.example' }, { ...found, date: '2026-09-25' }, { found: false, date: '', headline: '', type: 'other', tone: 'mixed', source_url: '' }]) {
    client = answer(bad);
    const x = await explainMove({ client, symbol: 'NVDA', name: 'Nvidia', market: 'US', date: '2026-09-30', excess: -0.05 });
    assert.deepEqual([x.found, x.event], [false, null]);
  }
});

test('the reading guide\'s call: the articles in one message on the cheap model, no web search, and only calls that hold up', async () => {
  const items = [
    { n: 1, source: 'fool.com', symbols: ['NVDA', 'BRK-B'], text: '3 Reasons Why Nvidia Fits Warren Buffett\'s Investment Style — The chipmaker has a wide moat.' },
    { n: 2, source: 'sg.finance.yahoo.com', symbols: ['D05.SI'], text: 'Singapore\'s gold hub plan gets lift with DBS vault expansion' },
  ];
  const answer = { calls: [
    { item: 1, symbol: 'NVDA', call: 'buy', target_price: 0, reasons_cited: ['growth', 'valuation'] },
    { item: 1, symbol: 'BRK-B', call: 'none', target_price: 0, reasons_cited: [] },
    { item: 2, symbol: 'D05.SI', call: 'none', target_price: 0, reasons_cited: [] },
    { item: 2, symbol: 'O39.SI', call: 'sell', target_price: 0, reasons_cited: [] }, // not a stock that item names
  ] };
  const client = fakeClient(msg([toolUse(READING_TOOL.name, answer)], { usage: { input_tokens: 4000, output_tokens: 1200 } }));
  const r = await readCalls({ client, items, names: { NVDA: 'Nvidia', 'D05.SI': 'DBS Group' } });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools.map((t) => t.name), ['submit_calls']); // no web search
  assert.equal(req.messages[0].content, `Items (number, site, the stocks it names, its text):
[1] fool.com | NVDA (Nvidia), BRK-B | 3 Reasons Why Nvidia Fits Warren Buffett's Investment Style — The chipmaker has a wide moat.
[2] sg.finance.yahoo.com | D05.SI (DBS Group) | Singapore's gold hub plan gets lift with DBS vault expansion`);
  assert.match(req.system, /reports what a broker, analyst or fund manager said or did .* without making it its own view/);
  assert.deepEqual(r.calls, [{ item: 1, symbol: 'NVDA', call: 'buy', target: 0, reasons: ['growth', 'valuation'] }]);
  assert.equal(r.usage.costUsd, 0.01); // 4k in @ $1/M + 1.2k out @ $5/M
});

test('askSpec: the owner\'s question on the cheap model, no web search, with the watchlist; the query comes back for code to check', async () => {
  const query = { answerable: true, reason: '', population: 'ex_dividend', market: 'SGX', symbols: ['D05.SI'], direction: 'any', size: 'any', volume: 'any', vix: 'any', index_trend: 'any', results: 'any', horizon: '1_month', expect: 'up' };
  const client = fakeClient(msg([toolUse(ASK_TOOL.name, query)], { usage: { input_tokens: 2000, output_tokens: 150 } }));
  const symbols = [{ symbol: 'D05.SI', name: 'DBS Group', market: 'SGX' }, { symbol: 'ES3.SI', name: 'SPDR STI ETF', market: 'SGX', etf: true }];
  const res = await askSpec({ client, question: 'Does DBS recover after going ex-dividend?', symbols });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools.map((t) => t.name), ['submit_query']);
  assert.equal(req.messages[0].content, 'The watchlist\'s stocks: D05.SI (DBS Group, SGX).\n\nThe owner\'s question:\nDoes DBS recover after going ex-dividend?');
  assert.match(req.system, /never answer the question yourself/);
  assert.deepEqual(res.input, query);
  assert.equal(res.usage.costUsd, 0.0028); // 2k in @ $1/M + 150 out @ $5/M
});
