// The AI fund page's figures, worked out from the funds (funds.js) and the latest prices, for the page
// to show: each fund's own figures (the switcher's cards and the fund's tiles), the funds ranked as the
// leaderboard ranks them, and the combined view across the funds ("All funds"). Pure functions: the
// page (app.js) only renders what these return.
//
// A fund's own figures stay in its own currency. Combined figures are in one currency: the funds' own
// when they all trade the same market, else SGD, with USD converted at the latest USDSGD rate. Without
// a rate, funds in different currencies can't be added up, so each currency is kept on its own
// (`base` null) rather than guessed.

import { summarize } from './portfolio.js';
import { benchmarkFor, BENCHMARKS } from './benchmark.js';
import { fundAiCost } from './spend.js';
import { planFor } from './fees.js';
import { fundBeta } from './stats.js';
import { marketForCurrency } from './markets.js';

// The switcher's "All funds" choice (state.fundId, and the #fund/all link).
export const ALL = 'all';

export const statusOf = (f) => (f.stoppedAt ? 'stopped' : f.paused ? 'paused' : 'running');

// `amount` in `ccy` as `to`, at `fx` SGD per USD; null when that needs a rate there isn't.
export function convert(amount, ccy, to, fx) {
  if (amount == null) return null;
  if (ccy === to) return amount;
  if (!(fx > 0)) return null;
  if (ccy === 'USD' && to === 'SGD') return amount * fx;
  if (ccy === 'SGD' && to === 'USD') return amount / fx;
  return null;
}

// One fund at today's prices: its account (value, cash, profit), its positions largest first with their
// share of the fund, how many stocks it holds, how much of its money is invested, its index, beta and
// AI cost. "Invested" is the positions' size (a short at its size) against that plus what's still free
// to spend (cash, less what's set aside for shorts), as the fund's "Where the money is" chart shows it.
export function fundFigures(f, quotes = {}, { fx = null } = {}) {
  const { accounts, positions } = summarize(f.portfolio, quotes);
  const a = accounts[f.currency];
  const held = positions.filter((p) => p.currency === f.currency)
    .map((p) => ({ ...p, weight: a.equity > 0 ? Math.abs(p.marketValue) / a.equity : null }))
    .sort((x, y) => Math.abs(y.marketValue) - Math.abs(x.marketValue) || x.symbol.localeCompare(y.symbol));
  const gross = held.reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const free = Math.max(0, a.buyingPower);
  const bench = benchmarkFor({ currency: f.currency, amount: f.budget, since: f.startedAt, quotes, plan: planFor(f.settings?.feePlan ?? 'tiger') });
  const costUsd = fundAiCost(f);
  const cost = convert(costUsd, 'USD', f.currency, fx); // in the fund's currency
  return {
    fund: f, id: f.id, status: statusOf(f), currency: f.currency, market: marketForCurrency(f.currency),
    account: a, positions: held, stocks: held.length, shorts: held.some((p) => p.short),
    gross, free, investedPct: gross + free > 0 ? gross / (gross + free) : 0,
    longs: held.filter((p) => !p.short).reduce((s, p) => s + p.marketValue, 0),
    bench, vsIndex: bench ? a.netPct - bench.pct : null,
    costUsd, cost, afterCost: cost == null ? null : (a.net - cost) / f.budget,
    beta: fundBeta(f.history, quotes[BENCHMARKS[f.currency]?.symbol]),
  };
}

// The leaderboard's order: running (and paused) funds first, best return after the AI's cost first
// (the plain return where the cost can't be converted), then stopped funds the same way.
export function rankFunds(figs) {
  const score = (x) => x.afterCost ?? x.account.netPct;
  return [...figs].sort((x, y) => Number(x.status === 'stopped') - Number(y.status === 'stopped') || score(y) - score(x));
}

// Adds up funds in currency `to`: value, money put in, profit, the same money in their indexes, what's
// invested and free, and the long positions by market. Null when a fund's figures can't be converted.
function totalsIn(figs, to, fx) {
  const t = { currency: to, funds: figs.length, value: 0, invested: 0, net: 0, gross: 0, free: 0, longs: { US: 0, SGX: 0 }, benchValue: 0, benchAmount: 0, benchAll: figs.length > 0, shorts: false };
  for (const x of figs) {
    const c = (v) => convert(v, x.currency, to, fx);
    if (c(1) == null) return null;
    const a = x.account;
    t.value += c(a.equity);
    t.invested += c(a.invested);
    t.net += c(a.net);
    t.gross += c(x.gross);
    t.free += c(x.free);
    t.longs[x.market] += c(x.longs);
    t.shorts ||= x.shorts;
    if (x.bench) { t.benchValue += c(x.bench.value); t.benchAmount += c(x.fund.budget); } else t.benchAll = false;
  }
  t.netPct = t.invested > 0 ? t.net / t.invested : 0;
  t.investedPct = t.gross + t.free > 0 ? t.gross / (t.gross + t.free) : 0;
  // against their indexes only when every fund has its index's prices
  t.benchPct = t.benchAll && t.benchAmount > 0 ? t.benchValue / t.benchAmount - 1 : null;
  t.vsIndex = t.benchPct == null ? null : t.netPct - t.benchPct;
  return t;
}

// Every stock the funds hold, the same stock in several funds as one row: which funds hold it, its value
// in `to`, its weight of `total` (the funds' combined value) and its profit or loss since bought, all the
// funds' positions in it together (after the fees on buying). Largest first. A stock one fund holds long
// and another short gets a row for each side, so the two don't cancel out into a row worth nothing.
function mergeHoldings(figs, to, fx, total) {
  const rows = new Map();
  for (const x of figs) {
    for (const p of x.positions) {
      const c = (v) => convert(v, p.currency, to, fx);
      const key = `${p.symbol}|${p.qty < 0 ? 'short' : 'long'}`;
      const r = rows.get(key) ?? { symbol: p.symbol, currency: p.currency, market: x.market, funds: [], qty: 0, value: 0, cost: 0, unrealized: 0 };
      r.funds.push({ id: x.id, name: x.fund.name });
      r.qty += p.qty;
      r.value += c(p.marketValue);
      r.cost += c(Math.abs(p.costBasis));
      r.unrealized += c(p.unrealized);
      rows.set(key, r);
    }
  }
  return [...rows.values()].map((r) => ({ ...r, short: r.qty < 0, weight: total > 0 ? Math.abs(r.value) / total : null, plPct: r.cost ? r.unrealized / r.cost : 0 }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.symbol.localeCompare(b.symbol));
}

// The holdings' stocks, each once (a stock held both long and short is one stock), with every fund that
// holds it, in the holdings' order.
function uniqueStocks(holdings) {
  const stocks = new Map();
  for (const h of holdings) {
    const s = stocks.get(h.symbol) ?? { symbol: h.symbol, funds: [] };
    for (const f of h.funds) if (!s.funds.some((y) => y.id === f.id)) s.funds.push(f);
    stocks.set(h.symbol, s);
  }
  return [...stocks.values()];
}

// All the funds together, for the "All funds" view. Stopped funds are listed (byFund) but not counted:
// their money is no longer at work. `base` is the currency of the combined figures (null: funds in
// different currencies and no exchange rate, so `currencies` has each currency's own); `fx` is the
// rate used, when one was. Each fund in `byFund` has its value in `base` and its share of the total.
export function combine(figs, { fx = null } = {}) {
  const counted = figs.filter((x) => x.status !== 'stopped');
  const ccys = [...new Set(counted.map((x) => x.currency))].sort();
  const base = ccys.length <= 1 ? (ccys[0] ?? null) : fx > 0 ? 'SGD' : null;
  const currencies = ccys.map((ccy) => {
    const own = counted.filter((x) => x.currency === ccy);
    const totals = totalsIn(own, ccy, fx);
    return { ...totals, holdings: mergeHoldings(own, ccy, fx, totals.value) };
  });
  const totals = base ? totalsIn(counted, base, fx) : null;
  const holdings = base ? mergeHoldings(counted, base, fx, totals.value) : currencies.flatMap((t) => t.holdings);
  const byFund = figs.map((x) => {
    const inBase = base ? convert(x.account.equity, x.currency, base, fx) : null;
    const pool = base ? totals.value : currencies.find((t) => t.currency === x.currency)?.value;
    const value = base ? inBase : x.account.equity;
    return { ...x, inBase, share: x.status === 'stopped' || !(pool > 0) ? null : value / pool };
  });
  const stocks = uniqueStocks(holdings);
  return {
    // `running` counts the paused funds too (their money is still at work); `paused` says how many of them are
    base, fx: ccys.length > 1 && base ? fx : null, running: counted.length, stopped: figs.length - counted.length,
    paused: counted.filter((x) => x.status === 'paused').length,
    totals, currencies, holdings, byFund,
    stocks: stocks.length, positions: counted.reduce((s, x) => s + x.stocks, 0),
    shared: stocks.filter((h) => h.funds.length > 1),
    costUsd: Math.round(figs.reduce((s, x) => s + x.costUsd, 0) * 100) / 100,
  };
}

// The AI fund page's data: every fund's figures, ranked, and the combined view when there are two or
// more funds (with one, the fund's own page is the combined view).
export function fundsOverview(c, quotes = {}, { fx = null } = {}) {
  const funds = rankFunds((c?.funds ?? []).map((f) => fundFigures(f, quotes, { fx })));
  return { funds, combined: funds.length >= 2 ? combine(funds, { fx }) : null };
}
