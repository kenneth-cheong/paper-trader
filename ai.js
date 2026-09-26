// Everything that asks Claude something. Three jobs share one calling pattern:
//   - strategist: proposes auto-trading rules for your own portfolio (runs in your browser with your key)
//   - picks: long/short ideas for the home page (runs on GitHub on a schedule, or in your browser)
//   - fund decisions: the AI fund's trades (runs on GitHub on a schedule)
// Work is split by difficulty to keep costs down: a cheap model (Haiku) searches the web and boils the
// news down to a short digest, then a stronger model (Sonnet by default) makes the actual decision from
// that digest plus price data, without ever reading the long search results. Every answer comes back
// through a "submit" tool whose input the app validates before using anything. Works with the official Anthropic SDK in Node or,
// loaded from a CDN, in the browser.

import { CONDITIONS, UNITS, REPEATS, newRule, checkRule, describeRule } from './rules.js';
import { summarize, buyingPower, SHORT_MARGIN } from './portfolio.js';
import { describeFees, planFor } from './fees.js';
import { STYLES, DEFAULT_STYLE } from './funds.js';
import { EVENT_TYPES, TONES } from './memory.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';

// Cheapest first. Haiku 4.5 uses the basic web search tool and no extended thinking; the newer
// models use web search with dynamic filtering and adaptive thinking at the given effort.
export const MODELS = {
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5 (cheapest)', inPerM: 1, outPerM: 5, search: 'web_search_20250305' },
  'claude-sonnet-5': { label: 'Claude Sonnet 5 (better analysis, about 2x the cost)', inPerM: 2, outPerM: 10, search: 'web_search_20260209', effort: 'medium' },
  'claude-opus-5': { label: 'Claude Opus 5 (best analysis, about 5x the cost)', inPerM: 5, outPerM: 25, search: 'web_search_20260209', effort: 'high' },
};
// simple: gathering and summarising news. advanced: picks, strategies and fund trades.
export const TIERS = { simple: 'claude-haiku-4-5', advanced: 'claude-sonnet-5' };
export const DEFAULT_MODEL = TIERS.simple;
const SEARCH_COST = 0.01; // USD per web search

export class AIError extends Error {}

export async function loadClient(apiKey) {
  const { default: Anthropic } = await import(SDK_URL);
  return { Anthropic, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
}

// ---------- the shared call ----------

// Runs one question to completion: Claude may search the web (server-side), then must call `tool`.
// Returns the tool's input plus the web pages Claude read and what the call cost.
export async function askClaude({ client, Anthropic, model = DEFAULT_MODEL, system, content, tool, maxSearches = 5, maxRounds = 4 }) {
  if (!MODELS[model]) model = DEFAULT_MODEL;
  const spec = MODELS[model];
  const tools = [
    ...(maxSearches > 0 ? [{ type: spec.search, name: 'web_search', max_uses: maxSearches }] : []),
    { ...tool, strict: true, eager_input_streaming: true },
  ];
  const request = { model, max_tokens: 32000, system, tools };
  if (spec.effort) Object.assign(request, { thinking: { type: 'adaptive' }, output_config: { effort: spec.effort } });
  // On Opus 5, if a safety classifier declines, let the API retry on its recommended fallback model.
  if (model === 'claude-opus-5') Object.assign(request, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

  const messages = [{ role: 'user', content }];
  const sources = new Map();
  const usage = { input: 0, output: 0, searches: 0, cacheWrite: 0, cacheRead: 0 };
  let servedBy = model;

  for (let round = 0; round < maxRounds; round++) {
    let message;
    try {
      message = await client.beta.messages.stream({ ...request, messages }).finalMessage();
    } catch (err) {
      throw friendlyError(err, Anthropic);
    }
    servedBy = message.model ?? servedBy;
    const u = message.usage ?? {};
    usage.input += u.input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.searches += u.server_tool_use?.web_search_requests ?? 0;
    for (const block of message.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title ?? r.url, age: r.page_age ?? null });
      }
    }

    if (message.stop_reason === 'refusal') throw new AIError('Claude declined this request.');
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (call && message.stop_reason !== 'max_tokens') {
      const price = spec;
      return {
        input: typeof call.input === 'string' ? parseJson(call.input) : call.input,
        sources: [...sources.values()],
        model: servedBy,
        usage: { ...usage, costUsd: costOf(usage, price) },
      };
    }
    if (message.stop_reason === 'max_tokens') throw new AIError('The answer was cut off before it finished. Try again with a narrower focus.');

    messages.push({ role: 'assistant', content: message.content });
    // pause_turn: the server paused a long search loop; sending the turn back resumes it.
    if (message.stop_reason !== 'pause_turn') messages.push({ role: 'user', content: `Please call ${tool.name} with your answer now.` });
  }
  throw new AIError('Claude did not return an answer. Try again.');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new AIError('Claude\'s answer was not in the expected format. Try again.'); }
}

function friendlyError(err, Anthropic) {
  if (!Anthropic) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AIError('Anthropic rejected the API key.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('This API key is not allowed to use that model.');
  if (err instanceof Anthropic.RateLimitError) return new AIError('Rate limited by Anthropic. Wait a minute and try again.');
  if (err instanceof Anthropic.APIConnectionError) return new AIError('Could not reach Anthropic. Check your connection.');
  if (err instanceof Anthropic.APIError) return new AIError(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
  return err;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
// US$ for a call: cache writes cost 1.25x the input price and cache reads 0.1x (5-minute cache).
const costOf = (u, price) => round4(((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * price.inPerM + u.output * price.outPerM) / 1e6 + u.searches * SEARCH_COST);

// Adds up the cost of the news step and the decision step.
export const addUsage = (...us) => us.filter(Boolean).reduce((a, u) => ({
  input: a.input + u.input, output: a.output + u.output, searches: a.searches + u.searches,
  cacheWrite: a.cacheWrite + (u.cacheWrite ?? 0), cacheRead: a.cacheRead + (u.cacheRead ?? 0), costUsd: round4(a.costUsd + u.costUsd),
}), { input: 0, output: 0, searches: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 });
const pct = (x) => Math.round(x * 1000) / 10; // 0.1234 -> 12.3

// Keeps only source links Claude actually got from its searches.
const knownUrls = (urls, sources) => {
  const ok = new Set(sources.map((s) => s.url));
  return (urls ?? []).filter((u) => ok.has(u));
};

// ---------- price statistics ----------

export function stockStats(q) {
  const closes = (q.daily ?? []).map(([, c]) => c);
  if (closes.length < 2) return null;
  const last = q.price ?? closes.at(-1);
  const back = (n) => closes[Math.max(0, closes.length - 1 - n)];
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
  let peak = -Infinity, mdd = 0;
  for (const c of closes) { peak = Math.max(peak, c); mdd = Math.max(mdd, (peak - c) / peak); }
  const avg = (n) => closes.length >= n ? closes.slice(-n).reduce((s, x) => s + x, 0) / n : null;
  const ma50 = avg(50), ma200 = avg(200);
  return {
    last,
    day_change_pct: q.prevClose ? pct(last / q.prevClose - 1) : null,
    return_1m_pct: pct(last / back(21) - 1),
    return_3m_pct: pct(last / back(63) - 1),
    return_6m_pct: pct(last / back(126) - 1),
    return_1y_pct: pct(last / closes[0] - 1),
    volatility_annual_pct: pct(vol),
    max_drawdown_1y_pct: pct(mdd),
    from_52w_high_pct: pct(last / Math.max(...closes) - 1),
    from_52w_low_pct: pct(last / Math.min(...closes) - 1),
    vs_ma50_pct: ma50 ? pct(last / ma50 - 1) : null,
    vs_ma200_pct: ma200 ? pct(last / ma200 - 1) : null,
    history_days: closes.length,
  };
}

// Weekly closes (every 5th trading day), newest last, to show Claude the shape of the year.
const weekly = (q) => (q.daily ?? []).filter((_, i, a) => (a.length - 1 - i) % 5 === 0).map(([t, c]) => [new Date(t * 1000).toISOString().slice(0, 10), c]);

const stockList = (quotes, symbols, withWeekly) => symbols.filter((s) => quotes[s]).map((s) => ({
  symbol: s, name: quotes[s].name, market: quotes[s].market, currency: quotes[s].currency,
  stats: stockStats(quotes[s]),
  ...(withWeekly ? { weekly_closes: weekly(quotes[s]) } : {}),
}));

const NEWS = 'A research assistant has just searched the web; the latest relevant news is in `news` (a market summary plus dated items with links). You have no other news source, so base your views on it and the price data, say when the news is thin, and cite the source_url of the items you rely on.';

// ---------- 0. news digest (simple tier) ----------

export const NEWS_SYSTEM = `You are a markets research assistant. Search the web for the latest news that could move the listed Singapore (SGX) and US stocks: company news and results, sector trends, macro data, central banks, commodities, geopolitics and overall market mood. Prefer reports from the last few days, check dates, and don't speculate or give trading advice: just report what happened, briefly and accurately. Finish by calling submit_news.`;

export const NEWS_TOOL = {
  name: 'submit_news',
  description: 'Submit the news digest.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['market_summary', 'items'],
    properties: {
      market_summary: { type: 'string', description: 'Four to six sentences on what is driving markets now, with key numbers.' },
      items: {
        type: 'array',
        description: 'Up to about 20 of the most relevant recent developments.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbols', 'date', 'headline', 'summary', 'type', 'tone', 'source_url'],
          properties: {
            symbols: { type: 'array', items: { type: 'string' }, description: 'Watchlist symbols affected; empty for market-wide news.' },
            date: { type: 'string', description: 'The day it was announced, e.g. 2026-09-24 (for results, not the end of the period they cover).' },
            headline: { type: 'string' },
            summary: { type: 'string', description: 'One or two sentences of facts and figures.' },
            type: { type: 'string', enum: EVENT_TYPES },
            tone: { type: 'string', enum: TONES, description: 'Good or bad news for the stocks named, as reported.' },
            source_url: { type: 'string' },
          },
        },
      },
    },
  },
};

// Searches and summarises the news for the given stocks (all of them by default) with the cheap model.
export async function gatherNews({ client, Anthropic, model = TIERS.simple, quotes, symbols = Object.keys(quotes), now = new Date(), maxSearches = 5 }) {
  const watchlist = symbols.filter((s) => quotes[s]).map((s) => `${s} (${quotes[s].name}, ${quotes[s].market})`);
  const res = await askClaude({
    client, Anthropic, model,
    system: NEWS_SYSTEM,
    content: `Today is ${now.toUTCString()}. Find the latest news for these stocks and the markets they trade in:\n${watchlist.join('\n')}`,
    tool: NEWS_TOOL,
    maxSearches,
  });
  const ok = new Set(res.sources.map((x) => x.url));
  const items = (res.input.items ?? []).map((i) => ({ ...i, source_url: ok.has(i.source_url) ? i.source_url : null, symbols: (i.symbols ?? []).filter((x) => quotes[x]) }));
  return { market_summary: res.input.market_summary ?? '', items, sources: res.sources, model: res.model, usage: res.usage, createdAt: now.toISOString() };
}

// The part of a digest a decision model sees: no raw search results, just the summary and items.
const newsForPrompt = (news, symbols) => news && {
  gathered_at: news.createdAt,
  market_summary: news.market_summary,
  items: news.items.filter((i) => !symbols || !i.symbols.length || i.symbols.some((x) => symbols.includes(x))),
};
const newsUrls = (news) => (news?.items ?? []).map((i) => ({ url: i.source_url })).filter((x) => x.url);

// ---------- 1. strategist ----------

export const RISK = {
  cautious: 'Cautious: protecting capital matters more than big gains; prefers stop-losses, diversified ETFs and small position sizes.',
  balanced: 'Balanced: accepts normal market swings for steady growth.',
  aggressive: 'Aggressive: accepts large drawdowns in pursuit of higher returns; comfortable with concentrated positions.',
};

export function buildContext({ prices, portfolio, focus = 'all', risk = 'balanced', question = '', now = new Date() }) {
  const quotes = prices.quotes ?? {};
  const symbols = focus === 'all' ? Object.keys(quotes) : [focus];
  const { accounts, positions } = summarize(portfolio, quotes);
  const sells = portfolio.trades.filter((t) => t.side === 'sell' && t.realized !== 0);

  return {
    now: now.toISOString(),
    prices_as_of: prices.updatedAt,
    sample_data: !!prices.sample,
    risk_profile: RISK[risk],
    question: question.trim() || null,
    trading_fees: {
      US: describeFees(portfolio, 'US', 2500),
      SGX: describeFees(portfolio, 'SGX', 5000),
    },
    accounts: Object.values(accounts).map((a) => ({
      currency: a.currency, starting_cash: a.start, cash: round2(a.cash), buying_power: round2(a.buyingPower),
      holdings_value: round2(a.marketValue), net_pl: round2(a.net), net_pl_pct: pct(a.netPct),
    })),
    holdings: positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, short: p.short || undefined, avg_cost: round2(p.avgCost), price: p.price, unrealized_pl_pct: pct(p.unrealizedPct),
    })),
    active_rules: (portfolio.rules ?? []).filter((r) => r.enabled).map((r) => describeRule(r, { currency: quotes[r.symbol]?.currency })),
    trading_record: {
      trades: portfolio.trades.length,
      closing_trades: sells.length,
      winning_closing_trades: sells.filter((t) => t.realized > 0).length,
      realized_by_currency: Object.fromEntries(Object.entries(accounts).map(([c, a]) => [c, round2(a.realized)])),
      recent_trades: portfolio.trades.slice(-40).map((t) => ({
        date: t.time.slice(0, 10), symbol: t.symbol, side: t.side, qty: t.qty, price: t.price,
        realized: t.realized || undefined, by_rule: t.rule ? true : undefined,
      })),
    },
    stocks: stockList(quotes, symbols, true),
  };
}

const conditionHelp = Object.entries(CONDITIONS).map(([k, c]) => `- ${k}: ${c.label} <value> (${c.unit})`).join('\n');
const unitHelp = Object.entries(UNITS).map(([side, u]) => `- ${side}: ${Object.entries(u).map(([k, v]) => `${k} (${v})`).join(', ')}`).join('\n');

export const STRATEGIST_SYSTEM = `You are the strategy coach inside a paper-trading simulator. The user trades Singapore (SGX, in SGD) and US (in USD) stocks with virtual money and wants to learn which tactics would make or lose money.

You receive statistics and weekly closing prices for about the last year, the user's accounts, holdings, active rules and trade record. ${NEWS} If sample_data is true, the prices are synthetic, so don't connect them to real news.

Propose strategies as rules the simulator can run automatically. Each strategy covers one stock and one or more rules. Rules manage long positions only (sells never open shorts). Rule format:
when_type:
${conditionHelp}
side and unit:
${unitHelp}
amount: number of shares, amount of cash, or percentage (ignored for "all")
repeat: ${Object.entries(REPEATS).map(([k, v]) => `${k} (${v})`).join('; ')}

How rules behave: a rule fires on the first 15-minute price where its condition is true; with "repeat" it can fire again only after the condition has been false in between. drop_from_high and rise_from_low measure from the highest/lowest price since the rule started (for sell rules, since the stock was bought). loss_from_cost and gain_from_cost compare with the user's average purchase price. above_ma/below_ma compare the price with the average of the last N daily closes. "every" fires every N calendar days. Price thresholds are in the stock's own currency. Only use symbols from the data.

Each strategy will be backtested on the same year of daily prices, after the user's trading fees (in trading_fees), and shown next to your rationale, so make the rules concrete and self-consistent (for example, pair an entry rule with an exit rule). Fees make frequent small trades expensive: prefer fewer, larger moves, and avoid rules that fire often for small gains. Size positions sensibly against the user's buying power. Mix styles where it makes sense, and include one that protects existing holdings if the user has any. This is an educational simulator; be direct about risk and never promise returns. Finish by calling submit_strategies.`;

const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['when_type', 'when_value', 'side', 'unit', 'amount', 'repeat'],
  properties: {
    when_type: { type: 'string', enum: Object.keys(CONDITIONS) },
    when_value: { type: 'number' },
    side: { type: 'string', enum: ['buy', 'sell'] },
    unit: { type: 'string', enum: [...new Set(Object.values(UNITS).flatMap(Object.keys))] },
    amount: { type: 'number' },
    repeat: { type: 'string', enum: Object.keys(REPEATS) },
  },
};

export const STRATEGIES_TOOL = {
  name: 'submit_strategies',
  description: 'Submit your assessment and proposed rule-based strategies.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'observations', 'strategies', 'caveats'],
    properties: {
      summary: { type: 'string', description: 'Two to four sentences: the overall read and the most important thing to do or avoid.' },
      observations: { type: 'array', items: { type: 'string' }, description: 'Specific findings about the stocks, the news and the user\'s own trading habits.' },
      strategies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'symbol', 'style', 'rationale', 'risks', 'rules', 'source_urls'],
          properties: {
            title: { type: 'string' },
            symbol: { type: 'string' },
            style: { type: 'string', enum: ['trend following', 'buy the dip', 'protect gains', 'limit losses', 'regular investing', 'take profit', 'mean reversion', 'other'] },
            rationale: { type: 'string' },
            risks: { type: 'string' },
            rules: { type: 'array', items: RULE_SCHEMA },
            source_urls: { type: 'array', items: { type: 'string' }, description: 'URLs from your searches that support this strategy.' },
          },
        },
      },
      caveats: { type: 'string' },
    },
  },
};

// Turns Claude's answer into strategies with ready-to-use (paused) rules.
// Rules that fail the app's own checks are dropped and reported, never silently kept.
export function parseStrategies(json, quotes, sources = []) {
  const symbols = Object.keys(quotes);
  const strategies = (json.strategies ?? []).filter((s) => quotes[s.symbol]).map((s) => {
    const rules = [];
    const problems = [];
    for (const r of s.rules ?? []) {
      const rule = newRule({
        symbol: s.symbol,
        when: { type: r.when_type, value: r.when_value },
        action: { side: r.side, unit: r.unit, amount: r.amount },
        repeat: r.repeat,
        enabled: false,
        note: s.title,
      });
      const errs = checkRule(rule, symbols);
      if (errs.length) problems.push(errs.join(' '));
      else rules.push(rule);
    }
    return { ...s, source_urls: knownUrls(s.source_urls, sources), rules, problems };
  });
  return { summary: json.summary ?? '', observations: json.observations ?? [], caveats: json.caveats ?? '', strategies };
}

export async function analyze({ client, Anthropic, model = TIERS.advanced, newsModel = TIERS.simple, context, quotes, news }) {
  const symbols = context.stocks.map((s) => s.symbol);
  news ??= await gatherNews({ client, Anthropic, model: newsModel, quotes, symbols, maxSearches: 4 });
  const res = await askClaude({
    client, Anthropic, model,
    system: STRATEGIST_SYSTEM,
    content: `Here is my simulator data as JSON. Analyse it and propose strategies.\n\n${JSON.stringify({ ...context, news: newsForPrompt(news, symbols) })}`,
    tool: STRATEGIES_TOOL,
    maxSearches: 0,
  });
  return {
    ...parseStrategies(res.input, quotes, newsUrls(news)), sources: news.sources,
    model: res.model, newsModel: news.model, usage: addUsage(news.usage, res.usage), createdAt: new Date().toISOString(),
  };
}

// ---------- 2. home-page picks ----------

export const PICKS_SYSTEM = `You are the market analyst for a paper-trading simulator covering a watchlist of Singapore (SGX) and US stocks and ETFs. Your job is to say which of these stocks look best to go long (buy) and which look best to short (bet on a fall) right now, for a horizon of days to a few months.

${NEWS} Combine it with the price statistics provided. Only pick from the watchlist, include only stocks where you have a real view (it's fine to have few shorts), and rank by conviction. Keep each thesis concrete: what is happening, why it should move the price, and what would prove you wrong. Cite the pages you relied on. This is an educational simulator with virtual money; be honest about uncertainty and never promise returns. Finish by calling submit_picks.`;

export const PICKS_TOOL = {
  name: 'submit_picks',
  description: 'Submit the market summary and long/short picks.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['market_summary', 'picks'],
    properties: {
      market_summary: { type: 'string', description: 'Three to five sentences on what is driving markets right now.' },
      picks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'stance', 'conviction', 'horizon', 'thesis', 'news', 'risks', 'source_urls'],
          properties: {
            symbol: { type: 'string' },
            stance: { type: 'string', enum: ['long', 'short'] },
            conviction: { type: 'string', enum: ['high', 'medium', 'low'] },
            horizon: { type: 'string', enum: ['days', 'weeks', 'months'] },
            thesis: { type: 'string' },
            news: { type: 'string', description: 'The recent development(s) behind the view, with dates.' },
            risks: { type: 'string', description: 'What would make this call wrong.' },
            source_urls: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

export function parsePicks(json, quotes, sources = []) {
  const seen = new Set();
  const picks = (json.picks ?? []).filter((p) => {
    if (!quotes[p.symbol] || seen.has(p.symbol) || !['long', 'short'].includes(p.stance)) return false;
    seen.add(p.symbol);
    return true;
  }).map((p) => ({ ...p, source_urls: knownUrls(p.source_urls, sources), priceAtPick: quotes[p.symbol].price }));
  return { market_summary: json.market_summary ?? '', picks };
}

// Pass a fresh `news` digest to reuse it; otherwise one is gathered first with the cheap model.
export async function recommend({ client, Anthropic, model = TIERS.advanced, newsModel = TIERS.simple, prices, news, now = new Date() }) {
  const quotes = prices.quotes ?? {};
  const fresh = !news;
  news ??= await gatherNews({ client, Anthropic, model: newsModel, quotes, now });
  const context = {
    now: now.toISOString(), prices_as_of: prices.updatedAt, sample_data: !!prices.sample,
    news: newsForPrompt(news), watchlist: stockList(quotes, Object.keys(quotes), false),
  };
  const res = await askClaude({
    client, Anthropic, model,
    system: PICKS_SYSTEM,
    content: `Today is ${now.toUTCString()}. Here are the latest news and the watchlist with price statistics as JSON. Give your long and short picks.\n\n${JSON.stringify(context)}`,
    tool: PICKS_TOOL,
    maxSearches: 0,
  });
  return {
    ...parsePicks(res.input, quotes, newsUrls(news)), sources: news.sources, model: res.model, newsModel: news.model,
    usage: addUsage(fresh ? news.usage : null, res.usage), createdAt: now.toISOString(), news: fresh ? news : undefined,
  };
}

// ---------- 3. AI fund decisions ----------

export const FUND_SYSTEM = `You are the portfolio manager of an autonomous paper-trading fund inside a simulator. Your objective is to make as much profit as possible on the fund's money, measured by its value in its own currency, while following the fund's mandate (its style and focus, set by its owner, in the context). You decide on your own.

Hard limits, enforced by the simulator (orders that break them are rejected):
- You can only use the fund's own money. A buy must fit within buying power; there is never any extra money.
- Short selling is allowed unless mandate.short_selling_allowed is false. Each short sets aside ${SHORT_MARGIN * 100}% of its sale value from buying power, and any short that is 40% under water is covered automatically.
- Only the listed stocks can be traded, all in the fund's currency. Orders fill at the latest price shown, in whole shares, in this order: sells and covers first, then buys and shorts.
- No single order may be worth more than max_order_value.
- Every trade pays broker fees (see trading_fees), and they come out of the fund's money. Only trade when the expected gain clearly beats the round-trip cost; frequent small trades lose money to fees.

${NEWS} Use the price statistics, your positions and your earlier decisions (you are called again at the next decision time; stop-loss and take-profit levels you set are checked every 15 minutes in between). Doing nothing is a valid decision when nothing is compelling. Keep reasons short and specific.

If the context has a playbook, it holds lessons from grading all your earlier ideas against what prices did afterwards: trades made, trades the owner declined or your limits blocked, ideas you passed on, and your exits. Weigh each lesson by its evidence (a handful of cases is weak), and never let one override the hard limits. Finish by calling submit_decision.`;

// The kinds of reasoning behind a trade idea, so results can be graded by kind (learning.js).
export const IDEA_TYPES = ['news', 'earnings', 'momentum', 'value', 'technical', 'analyst_pick', 'risk_reduction', 'other'];

export const FUND_TOOL = {
  name: 'submit_decision',
  description: 'Submit this round\'s orders and protective levels.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['outlook', 'orders', 'considered', 'protections', 'source_urls'],
    properties: {
      outlook: { type: 'string', description: 'Your current view and plan, in two to four sentences.' },
      orders: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'action', 'shares', 'reason', 'idea_type', 'conviction'],
          properties: {
            symbol: { type: 'string' },
            action: { type: 'string', enum: ['buy', 'sell', 'short', 'cover'], description: 'buy/sell for long positions; short opens or adds to a short; cover buys a short back.' },
            shares: { type: 'integer' },
            reason: { type: 'string' },
            idea_type: { type: 'string', enum: IDEA_TYPES, description: 'The main kind of reasoning behind this order.' },
            conviction: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      considered: {
        type: 'array',
        description: 'Up to 3 other trades you seriously considered this round but did not make (so they can be graded later too). Empty if none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'stance', 'idea_type', 'why_not'],
          properties: {
            symbol: { type: 'string' },
            stance: { type: 'string', enum: ['long', 'short'] },
            idea_type: { type: 'string', enum: IDEA_TYPES },
            why_not: { type: 'string', description: 'A few words.' },
          },
        },
      },
      protections: {
        type: 'array',
        description: 'Stop-loss / take-profit levels for positions you hold after these orders. Use 0 for none. Replaces earlier levels for that stock.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'stop_loss_pct', 'take_profit_pct'],
          properties: {
            symbol: { type: 'string' },
            stop_loss_pct: { type: 'number', description: 'Close the position if it loses this % from its average price.' },
            take_profit_pct: { type: 'number', description: 'Close the position if it gains this % from its average price.' },
          },
        },
      },
      source_urls: { type: 'array', items: { type: 'string' } },
    },
  },
};

// The market data every fund in that market sees (identical for them, so it can be cached).
export function marketContext({ currency, quotes, picks, news }) {
  const symbols = Object.keys(quotes).filter((s) => quotes[s].currency === currency);
  return {
    analyst_picks: picks?.picks?.filter((p) => quotes[p.symbol]?.currency === currency)
      .map((p) => ({ symbol: p.symbol, stance: p.stance, conviction: p.conviction, thesis: p.thesis, as_of: picks.createdAt })) ?? [],
    news: newsForPrompt(news, symbols),
    stocks: stockList(quotes, symbols, false),
  };
}

// The fund's own part: mandate, money, positions, recent decisions and (if learning) its playbook.
export function fundContext({ fund, quotes, picks, news, playbook = null, now = new Date() }) {
  return { ...ownContext({ fund, quotes, playbook, now }), ...marketContext({ currency: fund.currency, quotes, picks, news }) };
}

function ownContext({ fund, quotes, playbook, now }) {
  const ccy = fund.currency;
  const market = ccy === 'SGD' ? 'SGX' : 'US';
  const { accounts, positions } = summarize(fund.portfolio, quotes);
  const a = accounts[ccy];
  const style = STYLES[fund.style] ?? STYLES[DEFAULT_STYLE];
  return {
    now: now.toISOString(),
    ...(playbook ? { playbook } : {}),
    mandate: {
      name: fund.name ?? 'AI fund', style: style.label, style_brief: style.brief, owner_focus: fund.focus || null,
      short_selling_allowed: fund.settings?.allowShorts !== false,
    },
    fund: {
      currency: ccy, budget: fund.budget, value: round2(a.equity), profit: round2(a.net), profit_pct: pct(a.netPct),
      cash: round2(a.cash), buying_power: round2(buyingPower(fund.portfolio, ccy)), started: fund.startedAt,
      decisions_per_day: fund.decisionsPerDay, fees_paid: round2(a.fees ?? 0),
      max_order_value: round2(fund.budget * (fund.settings?.maxOrderPct ?? 25) / 100),
    },
    trading_fees: describeFees(planFor(fund.settings?.feePlan ?? 'tiger'), market, Math.min(fund.budget, fund.budget * (fund.settings?.maxOrderPct ?? 25) / 100)),
    positions: positions.map((p) => ({
      symbol: p.symbol, shares: p.qty, side: p.short ? 'short' : 'long', avg_price: round2(p.avgCost), price: p.price,
      value: round2(p.marketValue), unrealized_pl_pct: pct(p.unrealizedPct), protection: fund.protections[p.symbol] ?? null,
    })),
    recent_decisions: fund.decisions.filter((d) => !d.skipped).slice(-5).map((d) => ({
      time: d.time, outlook: d.outlook,
      orders: d.orders.map((o) => `${o.action} ${o.shares} ${o.symbol}: ${o.status}${o.message ? ` (${o.message})` : ''}`),
    })),
    recent_automatic_events: fund.events.slice(-10),
  };
}

// `news` should be a recent digest (the scheduled job shares one between picks and the fund);
// without one, a digest for the fund's market is gathered first with the cheap model.
// `cacheShared`: several funds in this market decide now on the same model, so the market data (the
// bulk of the prompt) is marked for caching and the others read it at a tenth of the price.
export async function decideFund({ client, Anthropic, model = TIERS.advanced, newsModel = TIERS.simple, fund, quotes, picks, news, playbook = null, cacheShared = false, now = new Date() }) {
  const fresh = !news;
  if (fresh) {
    const symbols = Object.keys(quotes).filter((s) => quotes[s].currency === fund.currency);
    news = await gatherNews({ client, Anthropic, model: newsModel, quotes, symbols, now, maxSearches: 3 });
  }
  const shared = { type: 'text', text: `Market data as JSON: news, analyst picks and price statistics for the ${fund.currency} market.\n\n${JSON.stringify(marketContext({ currency: fund.currency, quotes, picks, news }))}` };
  if (cacheShared) shared.cache_control = { type: 'ephemeral' };
  const res = await askClaude({
    client, Anthropic, model,
    system: FUND_SYSTEM,
    content: [shared, { type: 'text', text: `Decision time. The fund's state as JSON:\n\n${JSON.stringify(ownContext({ fund, quotes, playbook, now }))}` }],
    tool: FUND_TOOL,
    maxSearches: 0,
  });
  return {
    ...res.input, source_urls: knownUrls(res.input.source_urls, newsUrls(news)),
    model: res.model, newsModel: news.model, usage: addUsage(fresh ? news.usage : null, res.usage), news: fresh ? news : undefined,
  };
}

// ---------- learning: the one-off news backfill and the weekly review (both on the cheap model) ----------

const BACKFILL_SYSTEM = `You research company news history for a trading simulator. Search the web and list the most important company-specific news events for one stock over the period given: earnings results, guidance changes, deals, products, legal or regulatory news, management changes and big analyst moves. Give each event's date as the day it was announced or first reported (for results, the announcement day, never the end of the quarter or financial year they cover), a factual headline, its type, and whether it was good or bad news for the company as reported at the time. Do not describe how the share price reacted; that is measured separately. Only include events you found a source for. Finish by calling submit_events.`;

export const BACKFILL_TOOL = {
  name: 'submit_events',
  description: 'Submit the news events found.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        description: 'Up to 8 events, most important first.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['date', 'headline', 'type', 'tone', 'source_url'],
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD, the day it was announced (not the end of the period it covers).' },
            headline: { type: 'string' },
            type: { type: 'string', enum: EVENT_TYPES },
            tone: { type: 'string', enum: TONES },
            source_url: { type: 'string' },
          },
        },
      },
    },
  },
};

// Past news events for one stock between `from` and `to` (YYYY-MM-DD), for the market memory.
export async function backfillNews({ client, Anthropic, model = TIERS.simple, symbol, name, from, to, maxSearches = 3 }) {
  const res = await askClaude({
    client, Anthropic, model, system: BACKFILL_SYSTEM, tool: BACKFILL_TOOL, maxSearches,
    content: `Stock: ${name} (${symbol}). Period: ${from} to ${to}. List its most important news events in that period.`,
  });
  const ok = new Set(res.sources.map((x) => x.url));
  const events = (res.input.events ?? []).filter((e) => e.date >= from && e.date <= to && ok.has(e.source_url))
    .map((e) => ({ ...e, symbol, from: 'backfill' }));
  return { events, usage: res.usage, model: res.model };
}

const REVIEW_SYSTEM = `You coach the AI manager of a paper-trading fund. You get statistics that grade all of its earlier ideas against what prices did afterwards (trades it made, trades its owner declined, orders its limits blocked, ideas it passed on, and its exits and stop-losses), plus the most telling examples with the manager's own reasons, and lessons already derived from the numbers. Write up to 6 short, specific, practical lessons the manager should apply to future decisions, each citing its evidence from the data (numbers of cases and results). Only draw a lesson from 5 or more cases; say nothing rather than guess. Don't repeat lessons already derived unless you sharpen them. Finish by calling submit_lessons.`;

export const REVIEW_TOOL = {
  name: 'submit_lessons',
  description: 'Submit the lessons.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['lessons'],
    properties: {
      lessons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'evidence'],
          properties: {
            text: { type: 'string', description: 'One or two sentences addressed to the manager.' },
            evidence: { type: 'string', description: 'The numbers behind it.' },
          },
        },
      },
    },
  },
};

// The weekly review: a few written lessons on top of the rule-made ones (learning.js).
export async function reviewPlaybook({ client, Anthropic, model = TIERS.simple, fund, stats, examples, lessons }) {
  const style = STYLES[fund.style] ?? STYLES[DEFAULT_STYLE];
  const res = await askClaude({
    client, Anthropic, model, system: REVIEW_SYSTEM, tool: REVIEW_TOOL, maxSearches: 0,
    content: `The fund: "${fund.name ?? 'AI fund'}", ${style.label} style${fund.focus ? `, focus: ${fund.focus}` : ''}, trading ${fund.currency === 'SGD' ? 'SGX' : 'US'} stocks.\n\n${JSON.stringify({ stats, examples, lessons_already_derived: lessons.map((l) => l.text) })}`,
  });
  return { lessons: res.input.lessons ?? [], usage: res.usage, model: res.model };
}
