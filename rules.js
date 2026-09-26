// Auto-trading rules: "when <condition> on <stock>, <buy/sell> <amount>".
// Pure functions, no DOM. The same engine runs live (over 15-minute bars) and in backtests (over daily bars).
//
// A rule fires on the first price bar where its condition is true. With repeat "once" it then switches off;
// with repeat "every time" it waits until the condition has been false again before it can fire again
// (so a stop-loss doesn't sell on every bar while the price stays low). Scheduled rules ("every N days")
// fire whenever N days have passed since they last fired.

import { applyTrade, newPortfolio, buyingPower } from './portfolio.js';

export const CONDITIONS = {
  price_below:    { label: 'price is at or below',                   unit: 'price' },
  price_above:    { label: 'price is at or above',                   unit: 'price' },
  loss_from_cost: { label: 'is down from my average cost by',        unit: '%' },
  gain_from_cost: { label: 'is up from my average cost by',          unit: '%' },
  drop_from_high: { label: 'falls from its recent high by',          unit: '%' },
  rise_from_low:  { label: 'rises from its recent low by',           unit: '%' },
  above_ma:       { label: 'moves above its moving average of',      unit: 'days' },
  below_ma:       { label: 'moves below its moving average of',      unit: 'days' },
  every:          { label: 'on a schedule, every',                   unit: 'days' },
};

export const UNITS = {
  buy:  { shares: 'shares', cash: 'worth of shares', pct_cash: '% of my cash' },
  sell: { shares: 'shares', pct_holding: '% of my holding', all: 'all my shares' },
};

export const REPEATS = { once: 'once, then switch off', repeat: 'every time it happens' };

const DAY = 86400;

export function newRule(fields, now = Date.now()) {
  return {
    id: fields.id ?? `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol: fields.symbol,
    when: { type: fields.when.type, value: Number(fields.when.value) },
    action: { side: fields.action.side, unit: fields.action.unit, amount: Number(fields.action.amount) || 0 },
    repeat: fields.repeat ?? 'once',
    enabled: fields.enabled ?? true,
    note: fields.note ?? '',
    createdAt: new Date(now).toISOString(),
    state: freshState(now),
  };
}

export function freshState(now = Date.now()) {
  return { cursor: Math.floor(now / 1000), armed: true, fires: 0, peak: null, trough: null, lastFiredAt: null, lastError: null };
}

// Returns a list of problems; empty means the rule is usable.
export function checkRule(rule, symbols) {
  const errs = [];
  if (!symbols.includes(rule.symbol)) errs.push(`Unknown stock ${rule.symbol}.`);
  if (!CONDITIONS[rule.when?.type]) errs.push('Pick a condition.');
  else if (!(rule.when.value > 0)) errs.push('The condition needs a number above 0.');
  else if (CONDITIONS[rule.when.type].unit === 'days' && !Number.isInteger(rule.when.value)) errs.push('Days must be a whole number.');
  if (!UNITS[rule.action?.side]?.[rule.action.unit]) errs.push('Pick what to buy or sell.');
  else if (rule.action.unit !== 'all' && !(rule.action.amount > 0)) errs.push('The amount must be above 0.');
  else if (rule.action.unit.startsWith('pct') && rule.action.amount > 100) errs.push('A percentage can be at most 100.');
  else if (rule.action.unit === 'shares' && !Number.isInteger(rule.action.amount)) errs.push('Shares must be a whole number.');
  if (!REPEATS[rule.repeat]) errs.push('Pick how often it can fire.');
  return errs;
}

export function describeRule(rule, { currency = '', name = '' } = {}) {
  const c = CONDITIONS[rule.when.type];
  const v = rule.when.value;
  const value = c.unit === 'price' ? `${v.toFixed(2)} ${currency}`.trim() : c.unit === '%' ? `${v}%` : `${v} days`;
  const who = `${rule.symbol}${name ? ` (${name})` : ''}`;
  const cond = rule.when.type === 'every' ? `Every ${v} days` : `When ${who} ${c.label} ${value}`;
  const a = rule.action;
  const amount = a.unit === 'all' ? 'all my shares'
    : a.unit === 'cash' ? `${a.amount.toLocaleString()} ${currency} worth`
    : a.unit === 'shares' ? `${a.amount.toLocaleString()} shares`
    : `${a.amount}% of my ${a.unit === 'pct_cash' ? `${currency} cash` : 'holding'}`;
  const target = rule.when.type === 'every' ? ` of ${who}` : '';
  return `${cond}, ${a.side} ${amount}${target}, ${rule.repeat === 'once' ? 'once' : 'every time'}.`;
}

// Average of the last `n` daily closes from days before the bar at time `t`.
function movingAverage(daily, t, n) {
  const past = [];
  for (const [bt, c] of daily ?? []) {
    if (bt < t - 12 * 3600) past.push(c); // earlier sessions only; today's daily bar opened < 12 h ago
  }
  if (past.length < n) return null;
  const slice = past.slice(-n);
  return slice.reduce((s, x) => s + x, 0) / n;
}

function conditionTrue(rule, price, pos, t, quote) {
  const { type, value } = rule.when;
  const s = rule.state;
  switch (type) {
    case 'price_below': return price <= value;
    case 'price_above': return price >= value;
    case 'loss_from_cost': return pos?.qty > 0 && price <= pos.avgCost * (1 - value / 100);
    case 'gain_from_cost': return pos?.qty > 0 && price >= pos.avgCost * (1 + value / 100);
    case 'drop_from_high': return price <= s.peak * (1 - value / 100);
    case 'rise_from_low': return price >= s.trough * (1 + value / 100);
    case 'above_ma': { const ma = movingAverage(quote.daily, t, value); return ma != null && price > ma; }
    case 'below_ma': { const ma = movingAverage(quote.daily, t, value); return ma != null && price < ma; }
    case 'every': return s.lastFiredAt == null || t - s.lastFiredAt >= value * DAY - 3600;
    default: return false;
  }
}

// How many shares the rule's action means right now. null = nothing to do (a sell with nothing held).
// Rules never open shorts: sells only ever reduce a long holding.
function orderQty(rule, price, portfolio, currency) {
  const { side, unit, amount } = rule.action;
  const held = Math.max(0, portfolio.positions[rule.symbol]?.qty ?? 0); // rules manage long holdings
  const cash = Math.max(0, buyingPower(portfolio, currency));
  if (side === 'sell') {
    if (!held) return null;
    if (unit === 'all') return held;
    if (unit === 'shares') return Math.min(amount, held);
    return Math.max(1, Math.floor(held * amount / 100));
  }
  if (unit === 'shares') return amount;
  const budget = unit === 'cash' ? amount : cash * amount / 100;
  const qty = Math.floor(budget / price);
  if (qty < 1) throw new Error(`${budget.toFixed(2)} ${currency} buys less than one share at ${price.toFixed(2)}.`);
  return qty;
}

// Price points for one stock, oldest first: its 15-minute bars plus the latest quote if newer.
export function pricePoints(quote) {
  const pts = (quote?.intraday ?? []).slice();
  const qt = quote?.time ? Math.floor(Date.parse(quote.time) / 1000) : null;
  if (qt && quote.price > 0 && (!pts.length || qt > pts.at(-1)[0])) pts.push([qt, quote.price]);
  return pts;
}

// Runs every enabled rule over each price point it hasn't seen yet, in time order across all stocks.
// Returns { portfolio, log } where log lists what happened: { ruleId, time, trade } or { ruleId, time, error }.
// `afterPoint(portfolio, point)` is called after every point (backtests use it to track equity).
export function runRules(portfolio, quotes, { afterPoint } = {}) {
  let p = structuredClone(portfolio);
  const rules = p.rules ?? [];
  const log = [];
  const points = [];
  for (const symbol of new Set(rules.filter((r) => r.enabled).map((r) => r.symbol))) {
    for (const [t, price] of pricePoints(quotes[symbol])) points.push({ t, symbol, price });
  }
  points.sort((a, b) => a.t - b.t);

  for (const pt of points) {
    for (const rule of rules) {
      if (!rule.enabled || rule.symbol !== pt.symbol || pt.t <= rule.state.cursor) continue;
      rule.state.cursor = pt.t;
      const quote = quotes[pt.symbol];
      const currency = quote.currency;
      const s = rule.state;
      const pos = p.positions[rule.symbol];

      // Track the high/low the %-move conditions measure from. For a sell rule that only
      // counts while you hold the stock, so a trailing stop starts from your purchase.
      if (rule.action.side === 'sell' && !(pos?.qty > 0)) {
        s.peak = s.trough = pt.price;
      } else {
        s.peak = Math.max(s.peak ?? pt.price, pt.price);
        s.trough = Math.min(s.trough ?? pt.price, pt.price);
      }

      const cond = conditionTrue(rule, pt.price, pos, pt.t, quote);
      const scheduled = rule.when.type === 'every';
      if (!cond) {
        if (!scheduled) s.armed = true;
        continue;
      }
      if (!scheduled && !s.armed) continue;

      const time = new Date(pt.t * 1000).toISOString();
      try {
        const qty = orderQty(rule, pt.price, p, currency);
        if (qty == null) continue; // nothing to sell yet; stay armed
        const next = applyTrade(p, { symbol: rule.symbol, side: rule.action.side, qty, price: pt.price, currency, time });
        next.trades.at(-1).rule = rule.id;
        next.rules = rules;
        p = next;
        s.fires++;
        s.lastError = null;
        log.push({ ruleId: rule.id, time, trade: p.trades.at(-1) });
      } catch (err) {
        s.lastError = `${time.slice(0, 16).replace('T', ' ')} UTC: ${err.message}`;
        log.push({ ruleId: rule.id, time, error: err.message });
      }
      s.lastFiredAt = pt.t;
      s.armed = false;
      s.peak = s.trough = pt.price;
      if (rule.repeat === 'once') rule.enabled = false;
    }
    afterPoint?.(p, pt);
  }
  p.rules = rules;
  return { portfolio: p, log };
}

// Replays rules for one stock over its daily closes (about a year) with a fresh account.
// If none of the rules buy, the test starts fully invested, since sell rules need shares to act on.
// Compares the result with simply buying on day one and holding.
export function backtest(rules, quote, { startCash = 10000 } = {}) {
  const daily = quote?.daily ?? [];
  if (daily.length < 20) return { error: 'Not enough price history to test.' };
  const ccy = quote.currency;
  const symbol = rules[0].symbol;
  const [t0, p0] = daily[0];

  let p = newPortfolio({ [ccy]: startCash });
  const startInvested = !rules.some((r) => r.action.side === 'buy');
  if (startInvested) {
    p = applyTrade(p, { symbol, side: 'buy', qty: Math.floor(startCash / p0), price: p0, currency: ccy, time: new Date(t0 * 1000).toISOString() });
  }
  p.rules = rules.map((r) => ({ ...structuredClone(r), enabled: true, state: { ...freshState(), cursor: t0 } }));

  const curve = [];
  const bars = { ...quote, intraday: daily.slice(1), time: null };
  const equity = (pf, price) => pf.accounts[ccy].cash + (pf.positions[symbol]?.qty ?? 0) * price;
  const { portfolio, log } = runRules(p, { [symbol]: bars }, { afterPoint: (pf, pt) => curve.push(equity(pf, pt.price)) });

  const last = daily.at(-1)[1];
  const final = equity(portfolio, last);
  let peak = -Infinity, maxDrawdown = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }
  return {
    from: new Date(t0 * 1000).toISOString(),
    to: new Date(daily.at(-1)[0] * 1000).toISOString(),
    startCash, currency: ccy, startInvested,
    finalEquity: final,
    returnPct: final / startCash - 1,
    buyHoldPct: last / p0 - 1,
    trades: log.filter((l) => l.trade).length,
    skipped: log.filter((l) => l.error).length,
    maxDrawdown,
    curve,
  };
}
