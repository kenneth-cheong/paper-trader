// Paper-trading ledger. Pure functions, no DOM, so it can be unit tested with `node --test`.
// Each currency has its own cash account, so SGX trades settle in SGD and US trades in USD
// and exchange-rate moves never leak into the profit or loss.
//
// Positions have a signed quantity: positive is long, negative is short. Selling more than you hold
// opens a short; buying while short covers it. Like a margin account, every open short sets aside
// 150% of its sale value (at the price it was shorted), and that collateral can't be spent on buys.

export const DEFAULT_START = { SGD: 100000, USD: 100000 };
export const SHORT_MARGIN = 1.5;

export function newPortfolio(start = DEFAULT_START) {
  const accounts = {};
  for (const [ccy, amount] of Object.entries(start)) {
    accounts[ccy] = { start: amount, cash: amount, realized: 0 };
  }
  return { version: 1, createdAt: new Date().toISOString(), accounts, positions: {}, trades: [], rules: [], pendingOrders: [] };
}

// Keeps money at 1/10000 of a unit so repeated trades don't drift from floating-point error.
const money = (n) => Math.round(n * 10000) / 10000;

// Cash that is free to spend: cash minus the collateral held against open shorts in that currency.
export function buyingPower(portfolio, currency) {
  let collateral = 0;
  for (const pos of Object.values(portfolio.positions)) {
    if (pos.currency === currency && pos.qty < 0) collateral += -pos.qty * pos.avgCost * SHORT_MARGIN;
  }
  return money((portfolio.accounts[currency]?.cash ?? 0) - collateral);
}

// Returns a new portfolio with the trade applied, or throws an Error whose message is shown to the user.
export function applyTrade(portfolio, { symbol, side, qty, price, currency, time = new Date().toISOString() }) {
  const p = structuredClone(portfolio);
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number of shares.');
  if (!(price > 0)) throw new Error(`There is no price for ${symbol} yet.`);
  if (side !== 'buy' && side !== 'sell') throw new Error(`Unknown side "${side}".`);
  const acct = p.accounts[currency];
  if (!acct) throw new Error(`There is no ${currency} account.`);

  const pos = p.positions[symbol] ?? { qty: 0, avgCost: 0, currency };
  const before = buyingPower(p, currency);
  const q0 = pos.qty;
  const delta = side === 'buy' ? qty : -qty;
  const closing = q0 !== 0 && Math.sign(delta) !== Math.sign(q0) ? Math.min(qty, Math.abs(q0)) : 0;
  const opening = qty - closing;
  const realized = money(closing * (price - pos.avgCost) * Math.sign(q0));
  const q1 = q0 + delta;

  if (q1 === 0) pos.avgCost = 0;
  else if (opening > 0 && closing > 0) pos.avgCost = price; // flipped from long to short or back
  else if (opening > 0) pos.avgCost = (Math.abs(q0) * pos.avgCost + opening * price) / Math.abs(q1);
  pos.qty = q1;

  const value = money(qty * price);
  acct.cash = money(acct.cash - delta * price);
  acct.realized = money(acct.realized + realized);
  if (q1 === 0) delete p.positions[symbol];
  else p.positions[symbol] = pos;

  // Opening or adding to a position must leave buying power at zero or above. Closing is always allowed.
  if (opening > 0 && buyingPower(p, currency) < 0) {
    if (side === 'buy') {
      throw new Error(`Not enough ${currency} cash: this costs ${value.toFixed(2)} and you have ${Math.max(0, before).toFixed(2)} available.`);
    }
    throw new Error(`Not enough ${currency} buying power to short: a short sets aside ${SHORT_MARGIN * 100}% of its value (${money(opening * price * SHORT_MARGIN).toFixed(2)}) and you have ${Math.max(0, before).toFixed(2)} available.`);
  }

  p.trades.push({ time, symbol, side, qty, price, currency, value, realized });
  return p;
}

// ---------- orders placed while a market is closed ----------

// Queues an order to fill at the first price after its market reopens (see fillPendingOrders in rules.js).
// Whether it can be afforded is checked when it fills, at that price.
export function placeOrder(portfolio, { symbol, side, qty, currency, time = new Date().toISOString() }) {
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number of shares.');
  if (side !== 'buy' && side !== 'sell') throw new Error(`Unknown side "${side}".`);
  if (!portfolio.accounts[currency]) throw new Error(`There is no ${currency} account.`);
  const p = structuredClone(portfolio);
  p.pendingOrders ??= [];
  p.pendingOrders.push({ id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, symbol, side, qty, currency, placedAt: time });
  return p;
}

export function cancelOrder(portfolio, id) {
  const p = structuredClone(portfolio);
  p.pendingOrders = (p.pendingOrders ?? []).filter((o) => o.id !== id);
  return p;
}

// Values the portfolio at the given quotes ({ [symbol]: { price } }).
// A holding with no quote is valued at its cost and flagged `unpriced`.
export function summarize(portfolio, quotes = {}) {
  const accounts = {};
  for (const [ccy, a] of Object.entries(portfolio.accounts)) {
    accounts[ccy] = {
      currency: ccy, start: a.start, cash: a.cash, realized: a.realized,
      marketValue: 0, unrealized: 0, buyingPower: buyingPower(portfolio, ccy), hasShorts: false,
    };
  }

  const positions = Object.entries(portfolio.positions).map(([symbol, pos]) => {
    const quote = quotes[symbol];
    const price = quote?.price > 0 ? quote.price : pos.avgCost;
    const marketValue = price * pos.qty; // negative for a short
    const costBasis = pos.avgCost * pos.qty;
    const unrealized = marketValue - costBasis;
    const acct = accounts[pos.currency];
    acct.marketValue += marketValue;
    acct.unrealized += unrealized;
    if (pos.qty < 0) acct.hasShorts = true;
    return {
      symbol, currency: pos.currency, qty: pos.qty, short: pos.qty < 0, avgCost: pos.avgCost, price,
      marketValue, costBasis, unrealized,
      unrealizedPct: costBasis ? unrealized / Math.abs(costBasis) : 0,
      unpriced: !(quote?.price > 0),
    };
  });

  for (const a of Object.values(accounts)) {
    a.equity = a.cash + a.marketValue;
    a.net = a.equity - a.start;
    a.netPct = a.start ? a.net / a.start : 0;
  }
  return { accounts, positions };
}

// Rejects anything that isn't a portfolio this app wrote, before an import replaces the saved one.
export function validatePortfolio(p) {
  const ok = p && p.version === 1 && p.accounts && typeof p.accounts === 'object'
    && p.positions && typeof p.positions === 'object' && Array.isArray(p.trades)
    && Object.values(p.accounts).every((a) => Number.isFinite(a.start) && Number.isFinite(a.cash) && Number.isFinite(a.realized))
    && Object.values(p.positions).every((x) => Number.isInteger(x.qty) && x.qty !== 0 && Number.isFinite(x.avgCost) && p.accounts[x.currency])
    && (p.rules === undefined || (Array.isArray(p.rules) && p.rules.every((r) => r && r.id && r.symbol && r.when && r.action && r.state)))
    && (p.pendingOrders === undefined || (Array.isArray(p.pendingOrders)
      && p.pendingOrders.every((o) => o && o.id && o.symbol && ['buy', 'sell'].includes(o.side) && Number.isInteger(o.qty) && o.qty > 0 && p.accounts[o.currency] && o.placedAt)));
  if (!ok) throw new Error('That file is not a paper-trader portfolio export.');
  p.rules ??= []; // exports from before auto-trading existed
  p.pendingOrders ??= []; // ...and from before orders could wait for the open
  return p;
}
