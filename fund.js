// The AI fund: a separate paper portfolio that starts with a fixed budget and is traded by Claude alone.
// Pure functions; the scheduled job (scripts/ai-fund.mjs) loads, updates and saves it.
//
// The budget is a hard limit, enforced here rather than trusted to the AI:
//   - the fund's ledger starts with exactly the budget and nothing is ever added, so a buy that
//     costs more than its buying power is rejected (see portfolio.js);
//   - shorts need 150% collateral, and a short that loses 40% is covered automatically, so a short
//     can't lose more than the collateral set aside for it.

import { newPortfolio, applyTrade, summarize } from './portfolio.js';
import { pricePoints } from './rules.js';
import { marketForCurrency, isOpen, minutesSinceOpen, sessionMinutes } from './markets.js';

export const SHORT_MAX_LOSS = 0.4;

export function newFund({ budget, currency, decisionsPerDay = 2, now = new Date() }) {
  budget = Number(budget);
  if (!(budget > 0)) throw new Error('The AI fund needs an amount above 0.');
  if (!marketForCurrency(currency)) throw new Error(`Unsupported currency ${currency}.`);
  return {
    version: 1,
    startedAt: now.toISOString(),
    currency,
    budget,
    decisionsPerDay: Number(decisionsPerDay) || 2,
    portfolio: newPortfolio({ [currency]: budget }),
    protections: {}, // symbol -> { stop_loss_pct, take_profit_pct }
    cursor: Math.floor(now.getTime() / 1000), // last price point checked for protections
    lastDecisionAt: null,
    stoppedAt: null,
    decisions: [],
    events: [],
    history: [], // [isoTime, value] after each run, for the chart
  };
}

// Decisions are spread evenly through the market's trading day, starting 15 minutes after the open.
export function decisionDue(fund, now = new Date()) {
  if (fund.stoppedAt) return false;
  const market = marketForCurrency(fund.currency);
  const since = minutesSinceOpen(market, now);
  if (since == null || since < 15) return false;
  if (!fund.lastDecisionAt) return true;
  const gapMin = sessionMinutes(market) / fund.decisionsPerDay;
  return (now - new Date(fund.lastDecisionAt)) / 60000 >= gapMin - 10;
}

export const fundMarketOpen = (fund, now = new Date()) => isOpen(marketForCurrency(fund.currency), now);

// Executes the AI's orders against current prices. Sells and covers go first so they free up money.
// Returns the orders with a status: filled (with price) or rejected (with the reason).
export function applyOrders(fund, orders, quotes, now = new Date()) {
  const time = now.toISOString();
  const rank = { sell: 0, cover: 0, buy: 1, short: 1 };
  const sorted = [...orders].sort((a, b) => (rank[a.action] ?? 2) - (rank[b.action] ?? 2));
  const results = [];
  for (const o of sorted) {
    const res = { symbol: o.symbol, action: o.action, shares: o.shares, reason: o.reason ?? '' };
    try {
      const q = quotes[o.symbol];
      if (!q || q.currency !== fund.currency) throw new Error(`${o.symbol} is not tradable in this ${fund.currency} fund.`);
      if (q.stale) throw new Error(`No fresh price for ${o.symbol}.`);
      if (!Number.isInteger(o.shares) || o.shares <= 0) throw new Error('Shares must be a whole number above 0.');
      const held = fund.portfolio.positions[o.symbol]?.qty ?? 0;
      let side, qty = o.shares;
      if (o.action === 'buy') {
        if (held < 0) throw new Error('Position is short; use cover.');
        side = 'buy';
      } else if (o.action === 'sell') {
        if (held <= 0) throw new Error('No long position to sell.');
        side = 'sell'; qty = Math.min(qty, held);
      } else if (o.action === 'short') {
        if (held > 0) throw new Error('Position is long; sell it first.');
        side = 'sell';
      } else if (o.action === 'cover') {
        if (held >= 0) throw new Error('No short position to cover.');
        side = 'buy'; qty = Math.min(qty, -held);
      } else {
        throw new Error(`Unknown action ${o.action}.`);
      }
      fund.portfolio = applyTrade(fund.portfolio, { symbol: o.symbol, side, qty, price: q.price, currency: fund.currency, time });
      Object.assign(res, { status: 'filled', shares: qty, price: q.price });
    } catch (err) {
      Object.assign(res, { status: 'rejected', message: err.message });
    }
    results.push(res);
  }
  return results;
}

export function setProtections(fund, protections = []) {
  for (const p of protections) {
    if (!fund.portfolio.positions[p.symbol]) continue;
    const stop = Math.max(0, Number(p.stop_loss_pct) || 0);
    const take = Math.max(0, Number(p.take_profit_pct) || 0);
    if (stop || take) fund.protections[p.symbol] = { stop_loss_pct: stop, take_profit_pct: take };
    else delete fund.protections[p.symbol];
  }
}

// Replays price points since the last check and closes positions that hit a stop-loss, a take-profit
// or (for shorts) the 40% forced-cover limit. Returns the events that happened.
export function checkProtections(fund, quotes) {
  const points = [];
  for (const symbol of Object.keys(fund.portfolio.positions)) {
    for (const [t, price] of pricePoints(quotes[symbol])) if (t > fund.cursor) points.push({ t, symbol, price });
  }
  points.sort((a, b) => a.t - b.t);
  const events = [];
  for (const { t, symbol, price } of points) {
    const pos = fund.portfolio.positions[symbol];
    if (!pos) continue;
    const move = (price - pos.avgCost) / pos.avgCost * Math.sign(pos.qty); // + is profit
    const prot = fund.protections[symbol] ?? {};
    let why = null;
    if (pos.qty < 0 && move <= -SHORT_MAX_LOSS) why = 'forced cover: short down 40%';
    else if (prot.stop_loss_pct && move <= -prot.stop_loss_pct / 100) why = `stop-loss at -${prot.stop_loss_pct}%`;
    else if (prot.take_profit_pct && move >= prot.take_profit_pct / 100) why = `take-profit at +${prot.take_profit_pct}%`;
    if (!why) continue;
    const time = new Date(t * 1000).toISOString();
    const side = pos.qty > 0 ? 'sell' : 'buy';
    fund.portfolio = applyTrade(fund.portfolio, { symbol, side, qty: Math.abs(pos.qty), price, currency: fund.currency, time });
    delete fund.protections[symbol];
    const e = { time, symbol, action: pos.qty > 0 ? 'sell' : 'cover', shares: Math.abs(pos.qty), price, why };
    fund.events.push(e);
    events.push(e);
  }
  if (points.length) fund.cursor = points.at(-1).t;
  return events;
}

export function recordValue(fund, quotes, now = new Date()) {
  const a = summarize(fund.portfolio, quotes).accounts[fund.currency];
  const value = Math.round(a.equity * 100) / 100;
  const last = fund.history.at(-1);
  if (!last || last[1] !== value || now - new Date(last[0]) > 6 * 3600 * 1000) fund.history.push([now.toISOString(), value]);
  if (fund.history.length > 3000) fund.history.splice(0, fund.history.length - 3000);
  return value;
}

// Closes every position at current prices and stops the fund.
export function stopFund(fund, quotes, now = new Date()) {
  const orders = Object.entries(fund.portfolio.positions).map(([symbol, pos]) => ({
    symbol, action: pos.qty > 0 ? 'sell' : 'cover', shares: Math.abs(pos.qty), reason: 'Fund stopped',
  }));
  const results = applyOrders(fund, orders, quotes, now);
  fund.stoppedAt = now.toISOString();
  fund.decisions.push({ time: fund.stoppedAt, outlook: 'Fund stopped by its owner; all positions closed.', orders: results, source_urls: [] });
  return results;
}
