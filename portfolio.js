// Paper-trading ledger. Pure functions, no DOM, so it can be unit tested with `node --test`.
// Each currency has its own cash account, so SGX trades settle in SGD and US trades in USD
// and exchange-rate moves never leak into the profit or loss.

export const DEFAULT_START = { SGD: 100000, USD: 100000 };

export function newPortfolio(start = DEFAULT_START) {
  const accounts = {};
  for (const [ccy, amount] of Object.entries(start)) {
    accounts[ccy] = { start: amount, cash: amount, realized: 0 };
  }
  return { version: 1, createdAt: new Date().toISOString(), accounts, positions: {}, trades: [] };
}

// Keeps money at 1/10000 of a unit so repeated trades don't drift from floating-point error.
const money = (n) => Math.round(n * 10000) / 10000;

// Returns a new portfolio with the trade applied, or throws an Error whose message is shown to the user.
export function applyTrade(portfolio, { symbol, side, qty, price, currency, time = new Date().toISOString() }) {
  const p = structuredClone(portfolio);
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number of shares.');
  if (!(price > 0)) throw new Error(`There is no price for ${symbol} yet.`);
  const acct = p.accounts[currency];
  if (!acct) throw new Error(`There is no ${currency} account.`);

  const pos = p.positions[symbol] ?? { qty: 0, avgCost: 0, currency };
  const value = money(qty * price);
  let realized = 0;

  if (side === 'buy') {
    if (value > acct.cash) {
      throw new Error(`Not enough ${currency} cash: this costs ${value.toFixed(2)} and you have ${acct.cash.toFixed(2)}.`);
    }
    pos.avgCost = (pos.avgCost * pos.qty + value) / (pos.qty + qty);
    pos.qty += qty;
    acct.cash = money(acct.cash - value);
  } else if (side === 'sell') {
    if (qty > pos.qty) throw new Error(`You only hold ${pos.qty} shares of ${symbol}.`);
    realized = money((price - pos.avgCost) * qty);
    pos.qty -= qty;
    acct.cash = money(acct.cash + value);
    acct.realized = money(acct.realized + realized);
  } else {
    throw new Error(`Unknown side "${side}".`);
  }

  if (pos.qty === 0) delete p.positions[symbol];
  else p.positions[symbol] = pos;
  p.trades.push({ time, symbol, side, qty, price, currency, value, realized });
  return p;
}

// Values the portfolio at the given quotes ({ [symbol]: { price } }).
// A holding with no quote is valued at its cost and flagged `unpriced`.
export function summarize(portfolio, quotes = {}) {
  const accounts = {};
  for (const [ccy, a] of Object.entries(portfolio.accounts)) {
    accounts[ccy] = { currency: ccy, start: a.start, cash: a.cash, realized: a.realized, marketValue: 0, costBasis: 0, unrealized: 0 };
  }

  const positions = Object.entries(portfolio.positions).map(([symbol, pos]) => {
    const quote = quotes[symbol];
    const price = quote?.price > 0 ? quote.price : pos.avgCost;
    const marketValue = price * pos.qty;
    const costBasis = pos.avgCost * pos.qty;
    const acct = accounts[pos.currency];
    acct.marketValue += marketValue;
    acct.costBasis += costBasis;
    acct.unrealized += marketValue - costBasis;
    return {
      symbol, currency: pos.currency, qty: pos.qty, avgCost: pos.avgCost, price,
      marketValue, costBasis, unrealized: marketValue - costBasis,
      unrealizedPct: costBasis ? (marketValue - costBasis) / costBasis : 0,
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
    && Object.values(p.positions).every((x) => Number.isInteger(x.qty) && x.qty > 0 && Number.isFinite(x.avgCost) && p.accounts[x.currency]);
  if (!ok) throw new Error('That file is not a paper-trader portfolio export.');
  return p;
}
