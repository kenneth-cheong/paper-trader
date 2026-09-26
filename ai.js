// Everything that asks Claude something. Three jobs share one calling pattern:
//   - strategist: proposes auto-trading rules for your own portfolio (runs in your browser with your key)
//   - picks: long/short ideas for the home page (runs on GitHub on a schedule, or in your browser)
//   - fund decisions: the AI fund's trades (runs on GitHub on a schedule)
// Each call lets Claude search the web for current news, then answer through a "submit" tool whose
// input the app validates before using anything. Works with the official Anthropic SDK in Node or,
// loaded from a CDN, in the browser.

import { CONDITIONS, UNITS, REPEATS, newRule, checkRule, describeRule } from './rules.js';
import { summarize, buyingPower, SHORT_MARGIN } from './portfolio.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';

export const MODELS = {
  'claude-opus-5': { label: 'Claude Opus 5 (best analysis)', inPerM: 5, outPerM: 25 },
  'claude-sonnet-5': { label: 'Claude Sonnet 5 (cheaper, faster)', inPerM: 2, outPerM: 10 },
};
export const DEFAULT_MODEL = 'claude-opus-5';
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
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches },
    { ...tool, strict: true, eager_input_streaming: true },
  ];
  const request = {
    model,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system,
    tools,
  };
  // On Opus 5, if a safety classifier declines, let the API retry on its recommended fallback model.
  if (model === 'claude-opus-5') Object.assign(request, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

  const messages = [{ role: 'user', content }];
  const sources = new Map();
  const usage = { input: 0, output: 0, searches: 0 };
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
    usage.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
      const price = MODELS[model] ?? MODELS[DEFAULT_MODEL];
      return {
        input: typeof call.input === 'string' ? parseJson(call.input) : call.input,
        sources: [...sources.values()],
        model: servedBy,
        usage: { ...usage, costUsd: round2((usage.input * price.inPerM + usage.output * price.outPerM) / 1e6 + usage.searches * SEARCH_COST) },
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

const NEWS = 'Use web search to check the latest news that moves these stocks: company news, sector trends, macro data, central banks, geopolitics and overall market mood in Singapore and the US. Prefer sources from the last few days and say what you found.';

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

Each strategy will be backtested on the same year of daily prices and shown next to your rationale, so make the rules concrete and self-consistent (for example, pair an entry rule with an exit rule). Size positions sensibly against the user's buying power. Mix styles where it makes sense, and include one that protects existing holdings if the user has any. This is an educational simulator; be direct about risk and never promise returns. Finish by calling submit_strategies.`;

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

export async function analyze({ client, Anthropic, model, context, quotes }) {
  const res = await askClaude({
    client, Anthropic, model,
    system: STRATEGIST_SYSTEM,
    content: `Here is my simulator data as JSON. Analyse it and propose strategies.\n\n${JSON.stringify(context)}`,
    tool: STRATEGIES_TOOL,
  });
  return { ...parseStrategies(res.input, quotes, res.sources), sources: res.sources, model: res.model, usage: res.usage, createdAt: new Date().toISOString() };
}

// ---------- 2. home-page picks ----------

export const PICKS_SYSTEM = `You are the market analyst for a paper-trading simulator covering a watchlist of Singapore (SGX) and US stocks and ETFs. Your job is to say which of these stocks look best to go long (buy) and which look best to short (bet on a fall) right now, for a horizon of days to a few months.

${NEWS} Combine what you find with the price statistics provided. Only pick from the watchlist, include only stocks where you have a real view (it's fine to have few shorts), and rank by conviction. Keep each thesis concrete: what is happening, why it should move the price, and what would prove you wrong. Cite the pages you relied on. This is an educational simulator with virtual money; be honest about uncertainty and never promise returns. Finish by calling submit_picks.`;

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

export async function recommend({ client, Anthropic, model, prices, now = new Date() }) {
  const quotes = prices.quotes ?? {};
  const context = { now: now.toISOString(), prices_as_of: prices.updatedAt, sample_data: !!prices.sample, watchlist: stockList(quotes, Object.keys(quotes), false) };
  const res = await askClaude({
    client, Anthropic, model,
    system: PICKS_SYSTEM,
    content: `Today is ${now.toUTCString()}. Here is the watchlist with price statistics as JSON. Research the latest news, then give your long and short picks.\n\n${JSON.stringify(context)}`,
    tool: PICKS_TOOL,
    maxSearches: 8,
  });
  return { ...parsePicks(res.input, quotes, res.sources), sources: res.sources, model: res.model, usage: res.usage, createdAt: now.toISOString() };
}

// ---------- 3. AI fund decisions ----------

export const FUND_SYSTEM = `You are the portfolio manager of an autonomous paper-trading fund inside a simulator. Your only objective is to make as much profit as possible on the fund's money, measured by its value in its own currency. You decide on your own; nobody approves your trades.

Hard limits, enforced by the simulator (orders that break them are rejected):
- You can only use the fund's own money. A buy must fit within buying power; there is never any extra money.
- Short selling is allowed. Each short sets aside ${SHORT_MARGIN * 100}% of its sale value from buying power, and any short that is 40% under water is covered automatically.
- Only the listed stocks can be traded, all in the fund's currency. Orders fill at the latest price shown, in whole shares, in this order: sells and covers first, then buys and shorts.

${NEWS} Use the price statistics, your positions and your earlier decisions (you are called again at the next decision time; stop-loss and take-profit levels you set are checked every 15 minutes in between). Doing nothing is a valid decision when nothing is compelling. Keep reasons short and specific. Finish by calling submit_decision.`;

export const FUND_TOOL = {
  name: 'submit_decision',
  description: 'Submit this round\'s orders and protective levels.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['outlook', 'orders', 'protections', 'source_urls'],
    properties: {
      outlook: { type: 'string', description: 'Your current view and plan, in two to four sentences.' },
      orders: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'action', 'shares', 'reason'],
          properties: {
            symbol: { type: 'string' },
            action: { type: 'string', enum: ['buy', 'sell', 'short', 'cover'], description: 'buy/sell for long positions; short opens or adds to a short; cover buys a short back.' },
            shares: { type: 'integer' },
            reason: { type: 'string' },
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

export function fundContext({ fund, quotes, picks, now = new Date() }) {
  const ccy = fund.currency;
  const symbols = Object.keys(quotes).filter((s) => quotes[s].currency === ccy);
  const { accounts, positions } = summarize(fund.portfolio, quotes);
  const a = accounts[ccy];
  return {
    now: now.toISOString(),
    fund: {
      currency: ccy, budget: fund.budget, value: round2(a.equity), profit: round2(a.net), profit_pct: pct(a.netPct),
      cash: round2(a.cash), buying_power: round2(buyingPower(fund.portfolio, ccy)), started: fund.startedAt,
      decisions_per_day: fund.decisionsPerDay,
    },
    positions: positions.map((p) => ({
      symbol: p.symbol, shares: p.qty, side: p.short ? 'short' : 'long', avg_price: round2(p.avgCost), price: p.price,
      value: round2(p.marketValue), unrealized_pl_pct: pct(p.unrealizedPct), protection: fund.protections[p.symbol] ?? null,
    })),
    recent_decisions: fund.decisions.slice(-5).map((d) => ({
      time: d.time, outlook: d.outlook,
      orders: d.orders.map((o) => `${o.action} ${o.shares} ${o.symbol}: ${o.status}${o.message ? ` (${o.message})` : ''}`),
    })),
    recent_automatic_events: fund.events.slice(-10),
    analyst_picks: picks?.picks?.filter((p) => quotes[p.symbol]?.currency === ccy)
      .map((p) => ({ symbol: p.symbol, stance: p.stance, conviction: p.conviction, thesis: p.thesis, as_of: picks.createdAt })) ?? [],
    stocks: stockList(quotes, symbols, false),
  };
}

export async function decideFund({ client, Anthropic, model, fund, quotes, picks, now = new Date() }) {
  const context = fundContext({ fund, quotes, picks, now });
  const res = await askClaude({
    client, Anthropic, model,
    system: FUND_SYSTEM,
    content: `Decision time. Here is the fund's state and the market data as JSON.\n\n${JSON.stringify(context)}`,
    tool: FUND_TOOL,
    maxSearches: 5,
  });
  return { ...res.input, source_urls: knownUrls(res.input.source_urls, res.sources), model: res.model, usage: res.usage };
}
