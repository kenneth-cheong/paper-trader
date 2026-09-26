// The AI fund: a portfolio that starts with a fixed budget and is traded by Claude alone, either in the
// simulator or through a Tiger Brokers account (paper or live). Pure functions; the scheduled job
// (scripts/ai-fund.mjs, with scripts/tiger_broker.py for Tiger) loads, updates and saves it.
//
// Safety limits are enforced here, never left to the AI:
//   - the fund's ledger starts with exactly the budget and nothing is ever added, so an order that
//     costs more than its buying power is rejected (see portfolio.js). With Tiger, buys are checked at
//     their limit price (the most they can cost) and open orders count as already spent;
//   - each order is capped at a share of the budget (settings.maxOrderPct);
//   - if the fund loses settings.dailyLossPct in a day, it pauses itself;
//   - shorts need 150% collateral and are covered automatically at a 40% loss;
//   - every trade pays fees (settings.feePlan; with Tiger, what Tiger actually charged), so the
//     budget and profit are after fees;
//   - a paused fund makes no new trades (stop-losses and take-profits still close positions), and its
//     open Tiger orders are cancelled.
// With Tiger and approval 'manual', the AI's trades wait as proposals until an admin approves them;
// a proposal expires after PROPOSAL_MINUTES or if the price moves more than PROPOSAL_MAX_DRIFT.
//
// With Tiger, stop-losses are also held by Tiger itself as standing (GTC) stop orders ("guards", see
// syncGuards), so they trigger at once even if the scheduled job runs late or not at all. Shorts
// always get one at the 40% forced-cover level. While a guard is live at Tiger, this code doesn't
// run its own stop-loss check for that stock (take-profits are still checked here).

import { newPortfolio, applyTrade, summarize } from './portfolio.js';
import { pricePoints } from './rules.js';
import { MARKETS, marketForCurrency, minutesSinceOpen, sessionMinutes, tradingStatus } from './markets.js';

export const SHORT_MAX_LOSS = 0.4;
export const LIMIT_BAND = 0.01; // Tiger limit orders: at most 1% worse than the latest price
export const PROPOSAL_MINUTES = 60;
export const PROPOSAL_MAX_DRIFT = 0.02;
export const DEFAULT_SETTINGS = { broker: 'simulator', approval: 'manual', maxOrderPct: 25, dailyLossPct: 5, feePlan: 'tiger', allowShorts: true, model: null, learning: true, skipQuiet: true };

const OPEN_BROKER = ['queued', 'sent', 'partial'];
const isGuard = (o) => o.source === 'guard';
const isOpen = (o) => OPEN_BROKER.includes(o.status);
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newFund({ budget, currency, decisionsPerDay = 2, settings = {}, now = new Date() }) {
  budget = Number(budget);
  if (!(budget > 0)) throw new Error('The AI fund needs an amount above 0.');
  if (!marketForCurrency(currency)) throw new Error(`Unsupported currency ${currency}.`);
  const fund = {
    version: 1,
    startedAt: now.toISOString(),
    currency,
    budget,
    decisionsPerDay: Number(decisionsPerDay) || 2,
    settings: { ...DEFAULT_SETTINGS },
    portfolio: newPortfolio({ [currency]: budget }),
    protections: {}, // symbol -> { stop_loss_pct, take_profit_pct }
    cursor: Math.floor(now.getTime() / 1000), // last price point checked for protections
    lastDecisionAt: null,
    stoppedAt: null,
    paused: null, // { at, reason } while the kill switch or the daily-loss limit holds trading
    day: null, // { date, startValue } for the daily-loss limit
    decisions: [],
    proposals: [], // trades awaiting approval (Tiger, approval 'manual')
    brokerOrders: [], // orders for Tiger and what became of them
    broker: null, // latest Tiger snapshot: { time, accountType, positions, error }
    events: [],
    history: [], // [isoTime, value] after each run, for the chart
  };
  applySettings(fund, settings, { atStart: true });
  return fund;
}

export const usesBroker = (fund) => fund.settings?.broker === 'tiger';
const settingsOf = (fund) => ({ ...DEFAULT_SETTINGS, ...(fund.settings ?? {}) });

// Changes approval mode and limits. The broker can only be chosen when a fund starts, so the fund's
// record and the broker account never disagree about what it holds.
export function applySettings(fund, s = {}, { atStart = false } = {}) {
  const next = settingsOf(fund);
  if (s.broker !== undefined) {
    if (!atStart && s.broker !== next.broker) throw new Error('The broker can only be chosen when starting a fund.');
    if (!['simulator', 'tiger'].includes(s.broker)) throw new Error(`Unknown broker ${s.broker}.`);
    next.broker = s.broker;
  }
  if (s.approval !== undefined) {
    if (!['manual', 'auto'].includes(s.approval)) throw new Error(`Unknown approval mode ${s.approval}.`);
    next.approval = s.approval;
  }
  if (s.feePlan !== undefined) {
    if (!['tiger', 'scb', 'none'].includes(s.feePlan)) throw new Error(`Unknown fee plan ${s.feePlan}.`);
    next.feePlan = s.feePlan;
  }
  if (s.maxOrderPct !== undefined) {
    const v = Number(s.maxOrderPct);
    if (!(v >= 1 && v <= 100)) throw new Error('The per-order limit must be between 1% and 100% of the budget.');
    next.maxOrderPct = v;
  }
  if (s.dailyLossPct !== undefined) {
    const v = Number(s.dailyLossPct);
    if (!(v >= 0.5 && v <= 50)) throw new Error('The daily loss limit must be between 0.5% and 50%.');
    next.dailyLossPct = v;
  }
  if (s.allowShorts !== undefined) next.allowShorts = Boolean(s.allowShorts);
  if (s.learning !== undefined) next.learning = Boolean(s.learning);
  if (s.skipQuiet !== undefined) next.skipQuiet = Boolean(s.skipQuiet);
  if (s.model !== undefined) {
    if (s.model && !/^claude-[a-z0-9.-]+$/.test(s.model)) throw new Error(`Unknown model ${s.model}.`);
    next.model = s.model || null; // null: the default model
  }
  // With Tiger, fees are what Tiger actually charges; the Tiger plan is only used to estimate them.
  if (next.broker === 'tiger') next.feePlan = 'tiger';
  fund.settings = next;
  if (fund.portfolio) fund.portfolio.feePlan = next.feePlan;
  return next;
}

// ---------- prices, symbols, ticks ----------

// Tiger names SGX stocks without Yahoo's ".SI" (DBS is D05) and US share classes with a dot (BRK.B).
export const tigerSymbol = (symbol) => (symbol.endsWith('.SI') ? symbol.slice(0, -3) : symbol.replace('-', '.'));

// Smallest price step: SGX uses 0.001 below 0.20, 0.005 up to 1.00 and 0.01 above; US 0.01 (0.0001 below $1).
export function tickSize(market, price) {
  if (market === 'SGX') return price < 0.2 ? 0.001 : price < 1 ? 0.005 : 0.01;
  return price < 1 ? 0.0001 : 0.01;
}

// A limit price at most LIMIT_BAND worse than `price`, on the exchange's price grid.
export function limitPrice(side, price, market) {
  const tick = tickSize(market, price);
  const raw = side === 'buy' ? price * (1 + LIMIT_BAND) : price * (1 - LIMIT_BAND);
  const steps = side === 'buy' ? Math.floor(raw / tick + 1e-9) : Math.ceil(raw / tick - 1e-9);
  return Math.round(steps * tick * 1e6) / 1e6;
}

// A stop price `pct`% from `avgCost` on the price grid: below it for a sell stop (a long), above it
// for a buy stop (a short), rounded away from the price.
export function stopPriceFor(side, avgCost, pct, market) {
  const raw = side === 'sell' ? avgCost * (1 - pct / 100) : avgCost * (1 + pct / 100);
  const tick = tickSize(market, raw);
  const steps = side === 'sell' ? Math.floor(raw / tick + 1e-9) : Math.ceil(raw / tick - 1e-9);
  return Math.round(steps * tick * 1e6) / 1e6;
}

// ---------- schedule ----------

// Decisions are spread evenly through the market's trading day, starting 15 minutes after the open,
// and only while the market is really trading (`prices` shows today's prices arriving), so the fund
// never decides, or fills at stale prices, on a public holiday or after an early close.
export function decisionDue(fund, now = new Date(), prices = null) {
  if (fund.stoppedAt || fund.paused) return false;
  const market = marketForCurrency(fund.currency);
  if (tradingStatus(market, prices, now) !== 'open') return false;
  const since = minutesSinceOpen(market, now);
  if (since == null || since < 15) return false;
  if (!fund.lastDecisionAt) return true;
  const gapMin = sessionMinutes(market) / fund.decisionsPerDay;
  return (now - new Date(fund.lastDecisionAt)) / 60000 >= gapMin - 10;
}

// ---------- orders ----------

// The fund's ledger as if every open Tiger order had filled at its limit price, so money already
// committed to orders can't be spent twice.
function committedLedger(fund) {
  let p = fund.portfolio;
  for (const o of fund.brokerOrders ?? []) {
    const left = o.qty - (o.appliedQty ?? 0);
    if (!isOpen(o) || isGuard(o) || left <= 0) continue; // a guard only ever closes what's held
    try {
      p = applyTrade(p, { symbol: o.symbol, side: o.side, qty: left, price: o.limitPrice, currency: fund.currency, market: o.market, time: o.createdAt });
    } catch { /* already over-committed; new orders will be refused below */ }
  }
  return p;
}

// Turns an AI order (buy/sell/short/cover) into a ledger side and quantity, given what's held.
function resolveOrder(o, held) {
  if (!Number.isInteger(o.shares) || o.shares <= 0) throw new Error('Shares must be a whole number above 0.');
  if (o.action === 'buy') {
    if (held < 0) throw new Error('Position is short; use cover.');
    return { side: 'buy', qty: o.shares };
  }
  if (o.action === 'sell') {
    if (held <= 0) throw new Error('No long position to sell.');
    return { side: 'sell', qty: Math.min(o.shares, held) };
  }
  if (o.action === 'short') {
    if (held > 0) throw new Error('Position is long; sell it first.');
    return { side: 'sell', qty: o.shares };
  }
  if (o.action === 'cover') {
    if (held >= 0) throw new Error('No short position to cover.');
    return { side: 'buy', qty: Math.min(o.shares, -held) };
  }
  throw new Error(`Unknown action ${o.action}.`);
}

const opens = (action) => action === 'buy' || action === 'short';

// Runs the AI's orders through every limit. In the simulator they fill at once at the current price.
// With Tiger they become proposals (approval 'manual') or queued limit orders (approval 'auto', or
// `send: true` for approved proposals). Sells and covers go first so they free up money.
// `others`: other Tiger funds' holdings in the same account (funds.js otherTigerHoldings), so this
// fund never opens a position on the other side of theirs.
// Returns one result per order: status 'filled', 'awaiting approval', 'sent to Tiger' or 'rejected'.
export function applyOrders(fund, orders, quotes, now = new Date(), { send = false, others = {} } = {}) {
  const time = now.toISOString();
  const broker = usesBroker(fund);
  const s = settingsOf(fund);
  const rank = { sell: 0, cover: 0, buy: 1, short: 1 };
  const sorted = [...orders].sort((a, b) => (rank[a.action] ?? 2) - (rank[b.action] ?? 2));
  let ledger = broker ? committedLedger(fund) : fund.portfolio;
  const results = [];
  for (const o of sorted) {
    const res = { symbol: o.symbol, action: o.action, shares: o.shares, reason: o.reason ?? '', ideaType: o.idea_type ?? o.ideaType ?? null, conviction: o.conviction ?? null };
    try {
      const q = quotes[o.symbol];
      if (!q || q.currency !== fund.currency) throw new Error(`${o.symbol} is not tradable in this ${fund.currency} fund.`);
      if (q.stale) throw new Error(`No fresh price for ${o.symbol}.`);
      if (fund.paused && opens(o.action)) throw new Error('The fund is paused.');
      if (o.action === 'short' && s.allowShorts === false) throw new Error("This fund's style doesn't allow short selling.");
      const theirs = others[o.symbol] ?? 0;
      if (broker && opens(o.action) && (o.action === 'buy' ? theirs < 0 : theirs > 0)) {
        throw new Error(`Another fund in the same Tiger account is ${theirs > 0 ? 'long' : 'short'} ${o.symbol}; one account can't be long and short the same stock.`);
      }
      const { side, qty } = resolveOrder(o, ledger.positions[o.symbol]?.qty ?? 0);
      const cap = fund.budget * s.maxOrderPct / 100;
      if (opens(o.action) && qty * q.price > cap) {
        throw new Error(`Over the per-order limit of ${s.maxOrderPct}% of the budget (${cap.toFixed(2)} ${fund.currency}).`);
      }
      if (!broker) {
        fund.portfolio = applyTrade(fund.portfolio, { symbol: o.symbol, side, qty, price: q.price, currency: fund.currency, market: q.market, time });
        ledger = fund.portfolio;
        Object.assign(res, { status: 'filled', shares: qty, price: q.price, fee: fund.portfolio.trades.at(-1).fee });
      } else {
        const limit = limitPrice(side, q.price, q.market);
        ledger = applyTrade(ledger, { symbol: o.symbol, side, qty, price: side === 'buy' ? limit : q.price, currency: fund.currency, market: q.market, time });
        Object.assign(res, { side, shares: qty, refPrice: q.price, limitPrice: limit, market: q.market });
        res.status = s.approval === 'manual' && !send ? 'awaiting approval' : 'sent to Tiger';
      }
    } catch (err) {
      Object.assign(res, { status: 'rejected', message: err.message });
    }
    results.push(res);
  }
  return results;
}

function queueBrokerOrder(fund, r, source, now) {
  const order = {
    id: newId('b'), source, createdAt: now.toISOString(),
    symbol: r.symbol, tigerSymbol: tigerSymbol(r.symbol), currency: fund.currency, market: r.market ?? marketForCurrency(fund.currency),
    action: r.action, side: r.side, qty: r.shares, limitPrice: r.limitPrice, refPrice: r.refPrice, reason: r.reason ?? '',
    status: 'queued', filledQty: 0, appliedQty: 0, avgFillPrice: null, tigerOrderId: null, error: null,
  };
  fund.brokerOrders ??= [];
  fund.brokerOrders.push(order);
  return order;
}

// The AI's decision: fills in the simulator, or turns into proposals / queued Tiger orders.
export function executeDecision(fund, orders, quotes, now = new Date(), { others = {} } = {}) {
  const results = applyOrders(fund, orders, quotes, now, { others });
  for (const r of results) {
    if (r.status === 'sent to Tiger') r.brokerOrderId = queueBrokerOrder(fund, r, 'decision', now).id;
    if (r.status === 'awaiting approval') {
      const p = {
        id: newId('p'), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PROPOSAL_MINUTES * 60000).toISOString(),
        symbol: r.symbol, action: r.action, shares: r.shares, refPrice: r.refPrice, limitPrice: r.limitPrice, reason: r.reason, ideaType: r.ideaType, conviction: r.conviction, status: 'awaiting',
      };
      (fund.proposals ??= []).push(p);
      r.proposalId = p.id;
    }
  }
  return results;
}

// Expires proposals that were left too long.
export function expireProposals(fund, now = new Date()) {
  for (const p of fund.proposals ?? []) {
    if (p.status === 'awaiting' && now >= new Date(p.expiresAt)) Object.assign(p, { status: 'expired', decidedAt: now.toISOString() });
  }
}

// Sends approved proposals to Tiger after re-checking them against the current price and every limit.
export function approveProposals(fund, ids, quotes, prices, now = new Date(), { others = {} } = {}) {
  expireProposals(fund, now);
  const market = marketForCurrency(fund.currency);
  const out = [];
  for (const p of fund.proposals ?? []) {
    if (!ids.includes(p.id) || p.status !== 'awaiting') continue;
    p.decidedAt = now.toISOString();
    const q = quotes[p.symbol];
    if (tradingStatus(market, prices, now) !== 'open') {
      Object.assign(p, { status: 'failed', message: `${MARKETS[market].label} isn't trading now, so it wasn't sent. Wait for the next proposal.` });
    } else if (!q || Math.abs(q.price / p.refPrice - 1) > PROPOSAL_MAX_DRIFT) {
      Object.assign(p, { status: 'expired', message: `The price moved more than ${PROPOSAL_MAX_DRIFT * 100}% since it was proposed.` });
    } else {
      const [r] = applyOrders(fund, [{ symbol: p.symbol, action: p.action, shares: p.shares, reason: p.reason }], quotes, now, { send: true, others });
      if (r.status === 'sent to Tiger') Object.assign(p, { status: 'approved', brokerOrderId: queueBrokerOrder(fund, r, 'approved', now).id });
      else Object.assign(p, { status: 'failed', message: r.message });
    }
    out.push(p);
  }
  return out;
}

export function rejectProposals(fund, ids, now = new Date()) {
  for (const p of fund.proposals ?? []) {
    if (ids.includes(p.id) && p.status === 'awaiting') Object.assign(p, { status: 'rejected', decidedAt: now.toISOString() });
  }
}

// Records Tiger fills in the fund's ledger at Tiger's actual prices and fees, once an order is finished
// (filled, or cancelled after filling part), when Tiger's final charges are known. Until then the
// order's money stays reserved (see committedLedger). Without a fee from Tiger, the Tiger plan's
// estimate is used. If a fill can't be recorded (the ledger and Tiger disagree), the fund pauses.
export function applyBrokerFills(fund, now = new Date()) {
  const fills = [];
  for (const o of fund.brokerOrders ?? []) {
    const fresh = (o.filledQty ?? 0) - (o.appliedQty ?? 0);
    if (fresh <= 0 || !(o.avgFillPrice > 0) || !['filled', 'cancelled'].includes(o.status)) continue;
    try {
      fund.portfolio = applyTrade(fund.portfolio, {
        symbol: o.symbol, side: o.side, qty: fresh, price: o.avgFillPrice, currency: fund.currency,
        market: o.market ?? marketForCurrency(fund.currency), fee: o.fee ?? undefined, time: o.filledAt ?? now.toISOString(),
      });
      o.appliedQty = o.filledQty;
      const fee = fund.portfolio.trades.at(-1).fee;
      if (!fund.portfolio.positions[o.symbol]) delete fund.protections?.[o.symbol];
      const what = isGuard(o) ? `stop-loss order held by Tiger triggered at ${o.stopPrice}` : `Tiger fill (${o.source})`;
      const e = { time: now.toISOString(), symbol: o.symbol, action: o.action, shares: fresh, price: o.avgFillPrice, fee, why: `${what}; fees ${fee.toFixed(2)}${o.fee == null ? ' (estimated)' : ''}` };
      fund.events.push(e);
      fills.push(e);
    } catch (err) {
      pauseFund(fund, `A Tiger fill for ${o.symbol} couldn't be recorded (${err.message}). Check the Tiger account.`, now);
    }
  }
  return fills;
}

// ---------- kill switch and daily loss limit ----------

// Stops new trades and asks for open Tiger orders to be cancelled. Stop-losses still work.
export function pauseFund(fund, reason, now = new Date()) {
  if (!fund.paused) fund.paused = { at: now.toISOString(), reason };
  for (const o of fund.brokerOrders ?? []) if (isOpen(o) && !['protection', 'stop', 'guard'].includes(o.source)) o.cancelRequested = true;
  for (const p of fund.proposals ?? []) if (p.status === 'awaiting') Object.assign(p, { status: 'expired', message: 'The fund was paused.' });
}

export function resumeFund(fund) {
  fund.paused = null;
  fund.day = null; // start a fresh day for the loss limit
}

// Pauses the fund if it has lost more than dailyLossPct since the start of today (UTC day).
export function checkDailyLoss(fund, quotes, now = new Date()) {
  const value = summarize(fund.portfolio, quotes).accounts[fund.currency].equity;
  const date = now.toISOString().slice(0, 10);
  if (!fund.day || fund.day.date !== date) fund.day = { date, startValue: value };
  const limit = settingsOf(fund).dailyLossPct / 100;
  if (!fund.paused && value < fund.day.startValue * (1 - limit)) {
    pauseFund(fund, `Lost more than ${settingsOf(fund).dailyLossPct}% today (from ${fund.day.startValue.toFixed(2)} to ${value.toFixed(2)} ${fund.currency}).`, now);
    return true;
  }
  return false;
}

// ---------- protections ----------

// Keeps levels for stocks the fund holds or, with Tiger, is about to hold (an open order or a proposal).
export function setProtections(fund, protections = []) {
  const pending = new Set([
    ...(fund.brokerOrders ?? []).filter((o) => OPEN_BROKER.includes(o.status)).map((o) => o.symbol),
    ...(fund.proposals ?? []).filter((p) => p.status === 'awaiting').map((p) => p.symbol),
  ]);
  for (const p of protections) {
    if (!fund.portfolio.positions[p.symbol] && !pending.has(p.symbol)) continue;
    const stop = Math.max(0, Number(p.stop_loss_pct) || 0);
    const take = Math.max(0, Number(p.take_profit_pct) || 0);
    if (stop || take) fund.protections[p.symbol] = { stop_loss_pct: stop, take_profit_pct: take };
    else delete fund.protections[p.symbol];
  }
}

const hasOpenClose = (fund, symbol) => (fund.brokerOrders ?? []).some((o) => o.symbol === symbol && isOpen(o) && !isGuard(o) && (o.action === 'sell' || o.action === 'cover'));
// A stop order placed at Tiger and not being cancelled: Tiger watches the stop-loss for this stock.
export const guardAtTiger = (fund, symbol) => (fund.brokerOrders ?? []).find((o) => isGuard(o) && o.symbol === symbol && ['sent', 'partial'].includes(o.status) && !o.cancelRequested);

// Replays price points since the last check and closes positions that hit a stop-loss, a take-profit
// or (for shorts) the 40% forced-cover limit. In the simulator they close at that price; with Tiger a
// closing limit order is sent straight away (no approval needed, since it reduces risk).
export function checkProtections(fund, quotes, now = new Date()) {
  const broker = usesBroker(fund);
  const points = [];
  for (const symbol of Object.keys(fund.portfolio.positions)) {
    for (const [t, price] of pricePoints(quotes[symbol])) if (t > fund.cursor) points.push({ t, symbol, price });
  }
  points.sort((a, b) => a.t - b.t);
  const events = [];
  for (const { t, symbol, price } of points) {
    const pos = fund.portfolio.positions[symbol];
    if (!pos || (broker && hasOpenClose(fund, symbol))) continue;
    const move = (price - pos.avgCost) / pos.avgCost * Math.sign(pos.qty); // + is profit
    const prot = fund.protections[symbol] ?? {};
    const guarded = broker && guardAtTiger(fund, symbol); // Tiger's stop order handles the losses
    let why = null;
    if (!guarded && pos.qty < 0 && move <= -SHORT_MAX_LOSS) why = 'forced cover: short down 40%';
    else if (!guarded && prot.stop_loss_pct && move <= -prot.stop_loss_pct / 100) why = `stop-loss at -${prot.stop_loss_pct}%`;
    else if (prot.take_profit_pct && move >= prot.take_profit_pct / 100) why = `take-profit at +${prot.take_profit_pct}%`;
    if (!why) continue;
    const time = new Date(t * 1000).toISOString();
    const side = pos.qty > 0 ? 'sell' : 'buy';
    const action = pos.qty > 0 ? 'sell' : 'cover';
    if (broker) {
      const limit = limitPrice(side, price, quotes[symbol]?.market);
      queueBrokerOrder(fund, { symbol, action, side, shares: Math.abs(pos.qty), refPrice: price, limitPrice: limit, market: quotes[symbol]?.market, reason: why }, 'protection', now);
    } else {
      fund.portfolio = applyTrade(fund.portfolio, { symbol, side, qty: Math.abs(pos.qty), price, currency: fund.currency, market: quotes[symbol]?.market, time });
    }
    delete fund.protections[symbol];
    const e = { time, symbol, action, shares: Math.abs(pos.qty), price, why: broker ? `${why}; closing order sent to Tiger` : why };
    fund.events.push(e);
    events.push(e);
  }
  if (points.length) fund.cursor = points.at(-1).t;
  return events;
}

// Keeps one standing stop order at Tiger per protected position, matching its size and stop level:
// cancels ones that no longer match and queues replacements (scripts/tiger_broker.py send places them,
// cancelling the old one first). A position being closed by another order gets no guard meanwhile, and
// one with an open order adding to it keeps its current guard until that order finishes. A stop Tiger
// refused isn't retried for GUARD_RETRY_HOURS; this code's own stop-loss check covers it meanwhile.
export const GUARD_RETRY_HOURS = 6;
export function syncGuards(fund, quotes = {}, now = new Date()) {
  if (!usesBroker(fund) || fund.stoppedAt) return [];
  const orders = (fund.brokerOrders ??= []);
  const changes = [];
  const symbols = new Set([...Object.keys(fund.portfolio.positions), ...orders.filter((o) => isGuard(o) && isOpen(o)).map((o) => o.symbol)]);
  for (const symbol of symbols) {
    const pos = fund.portfolio.positions[symbol];
    const live = orders.filter((o) => isGuard(o) && o.symbol === symbol && isOpen(o) && !o.cancelRequested);
    let want = null;
    if (pos) {
      const side = pos.qty > 0 ? 'sell' : 'buy';
      const others = orders.filter((o) => !isGuard(o) && o.symbol === symbol && isOpen(o));
      const closingNow = others.some((o) => o.side === side);
      if (!closingNow && others.length && live.length) continue; // adding to the position: keep the guard until it fills
      let pct = Number(fund.protections?.[symbol]?.stop_loss_pct) || 0;
      if (pos.qty < 0) pct = Math.min(pct || Infinity, SHORT_MAX_LOSS * 100);
      if (pct > 0 && !closingNow) {
        const market = quotes[symbol]?.market ?? marketForCurrency(fund.currency);
        want = { side, action: pos.qty > 0 ? 'sell' : 'cover', qty: Math.abs(pos.qty), stopPrice: stopPriceFor(side, pos.avgCost, pct, market), pct, market };
      }
    }
    const keep = want && live.find((o) => o.side === want.side && o.qty === want.qty && o.stopPrice === want.stopPrice && o.status !== 'partial');
    for (const o of live) {
      if (o === keep) continue;
      o.cancelRequested = true;
      changes.push({ symbol, change: 'cancel', orderId: o.id });
    }
    if (!want || keep) continue;
    const refused = orders.some((o) => isGuard(o) && o.symbol === symbol && ['rejected', 'failed'].includes(o.status)
      && o.qty === want.qty && o.stopPrice === want.stopPrice && now - new Date(o.createdAt) < GUARD_RETRY_HOURS * 3600000);
    if (refused) continue;
    const why = pos.qty < 0 && want.pct === SHORT_MAX_LOSS * 100 ? 'forced cover at a 40% loss' : `stop-loss at -${want.pct}%`;
    const o = queueBrokerOrder(fund, { symbol, action: want.action, side: want.side, shares: want.qty, refPrice: quotes[symbol]?.price ?? null, limitPrice: null, market: want.market, reason: `${why}, held by Tiger` }, 'guard', now);
    Object.assign(o, { type: 'stop', stopPrice: want.stopPrice, timeInForce: 'GTC' });
    changes.push({ symbol, change: 'place', orderId: o.id, stopPrice: want.stopPrice, qty: want.qty });
  }
  return changes;
}

export function recordValue(fund, quotes, now = new Date()) {
  const a = summarize(fund.portfolio, quotes).accounts[fund.currency];
  const value = Math.round(a.equity * 100) / 100;
  const last = fund.history.at(-1);
  if (!last || last[1] !== value || now - new Date(last[0]) > 6 * 3600 * 1000) fund.history.push([now.toISOString(), value]);
  if (fund.history.length > 3000) fund.history.splice(0, fund.history.length - 3000);
  return value;
}

// Closes every position and stops the fund. In the simulator at current prices; with Tiger by sending
// closing limit orders (and cancelling any other open ones).
export function stopFund(fund, quotes, now = new Date()) {
  const broker = usesBroker(fund);
  if (broker) {
    for (const o of fund.brokerOrders ?? []) if (OPEN_BROKER.includes(o.status)) o.cancelRequested = true;
    for (const p of fund.proposals ?? []) if (p.status === 'awaiting') Object.assign(p, { status: 'expired', message: 'The fund was stopped.' });
  }
  const results = [];
  for (const [symbol, pos] of Object.entries(fund.portfolio.positions)) {
    const action = pos.qty > 0 ? 'sell' : 'cover';
    const q = quotes[symbol];
    if (broker) {
      if (!q) { results.push({ symbol, action, shares: Math.abs(pos.qty), status: 'rejected', message: 'No price to close at.' }); continue; }
      const side = pos.qty > 0 ? 'sell' : 'buy';
      const o = queueBrokerOrder(fund, { symbol, action, side, shares: Math.abs(pos.qty), refPrice: q.price, limitPrice: limitPrice(side, q.price, q.market), market: q.market, reason: 'Fund stopped' }, 'stop', now);
      results.push({ symbol, action, shares: o.qty, status: 'sent to Tiger', limitPrice: o.limitPrice, reason: 'Fund stopped' });
    } else {
      results.push(...applyOrders(fund, [{ symbol, action, shares: Math.abs(pos.qty), reason: 'Fund stopped' }], quotes, now));
    }
  }
  fund.stoppedAt = now.toISOString();
  fund.decisions.push({ time: fund.stoppedAt, outlook: `Fund stopped by its owner; ${broker ? 'closing orders sent to Tiger' : 'all positions closed'}.`, orders: results, source_urls: [] });
  return results;
}

// Whether Tiger holds what the fund thinks it holds: { checkedAt, ok, mismatches: [{ symbol, fund, tiger }] },
// or null without a Tiger snapshot. Tiger may hold more (your own shares), never less or the other side.
export function reconcile(f) {
  const tiger = f.broker?.positions;
  if (!Array.isArray(tiger) || f.broker?.error) return null;
  const held = Object.fromEntries(tiger.map((p) => [p.symbol, Number(p.qty) || 0]));
  const mismatches = [];
  for (const [symbol, pos] of Object.entries(f.portfolio?.positions ?? {})) {
    const t = held[tigerSymbol(symbol)] ?? 0;
    if (pos.qty > 0 ? t < pos.qty : t > pos.qty) mismatches.push({ symbol, fund: pos.qty, tiger: t });
  }
  return { checkedAt: f.broker.time, ok: mismatches.length === 0, mismatches };
}
