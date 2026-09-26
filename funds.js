// Several AI funds side by side. The scheduled job keeps them together in one file / one Supabase
// row: { version: 2, funds: [fund, ...], archived: [summary, ...] } (see fund.js for a single fund).
// Each fund has an id, a name, a style and an optional focus, which become the AI's mandate, and its
// own amount, currency, broker, limits and model. Up to MAX_ACTIVE_FUNDS can run at once; a stopped
// fund stays listed until it is removed.
//
// Funds trading through Tiger share one Tiger account, so:
//   - one account can't be long and short the same stock: a fund can't open a position on the
//     opposite side of another Tiger fund's position or open order (see otherTigerHoldings);
//   - whether Tiger holds what the funds think is checked for all of them together (reconcileAll).

import { newFund, applySettings, reconcile, tigerSymbol } from './fund.js';

export const MAX_ACTIVE_FUNDS = 5;
const OPEN = ['queued', 'sent', 'partial'];

// A style sets the AI's brief and the fund's default limits (which can still be changed).
export const STYLES = {
  cautious: {
    label: 'Cautious',
    brief: 'Protect the money first, then grow it. Prefer large, established, less volatile companies; build positions gradually; always set a stop-loss; hold more cash when the outlook is unclear. No short selling.',
    defaults: { maxOrderPct: 10, dailyLossPct: 3, allowShorts: false },
  },
  balanced: {
    label: 'Balanced',
    brief: 'Aim for steady growth with sensible risk: a spread of positions, stop-losses on every one, and shorts only with a clear reason.',
    defaults: { maxOrderPct: 25, dailyLossPct: 5, allowShorts: true },
  },
  aggressive: {
    label: 'Aggressive',
    brief: 'Go for the biggest gains: concentrated positions in the strongest ideas, momentum and news-driven trades, and shorts when a stock looks weak. Accept bigger swings, but still cut losing trades.',
    defaults: { maxOrderPct: 40, dailyLossPct: 8, allowShorts: true },
  },
};
export const DEFAULT_STYLE = 'balanced';

const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// Any saved shape -> a collection. A file from before multiple funds held one fund object.
export function loadFunds(raw) {
  if (raw?.version === 2 && Array.isArray(raw.funds)) {
    raw.archived ??= [];
    return raw;
  }
  const c = { version: 2, funds: [], archived: [] };
  if (raw?.portfolio) {
    const { previousFunds, ...fund } = raw;
    c.funds.push({ id: 'f1', name: 'AI fund', style: DEFAULT_STYLE, focus: '', ...fund });
    c.archived = (previousFunds ?? []).map((p) => ({ name: 'AI fund', ...p }));
  }
  return c;
}

export const activeFunds = (c) => c.funds.filter((f) => !f.stoppedAt);
export const findFund = (c, id) => c.funds.find((f) => f.id === id) ?? null;

// Which fund a command is for: the one named, or the only running one. Throws if that's unclear.
export function targetFund(c, id) {
  if (id) {
    const f = findFund(c, id);
    if (!f) throw new Error('That fund no longer exists.');
    return f;
  }
  const running = activeFunds(c);
  if (running.length === 1) return running[0];
  throw new Error(running.length ? 'Several funds are running: choose one.' : 'No fund is running.');
}

// Starts a new fund alongside the others. `style` fills in limits not given in `settings`.
export function addFund(c, { name, style = DEFAULT_STYLE, focus = '', budget, currency, decisionsPerDay, settings = {}, now = new Date() }) {
  if (activeFunds(c).length >= MAX_ACTIVE_FUNDS) throw new Error(`Up to ${MAX_ACTIVE_FUNDS} funds can run at once. Stop one first.`);
  if (!STYLES[style]) throw new Error(`Unknown style ${style}.`);
  const fund = newFund({ budget, currency, decisionsPerDay, settings: { ...STYLES[style].defaults, ...settings }, now });
  const n = c.funds.length + c.archived.length + 1;
  Object.assign(fund, {
    id: newId(),
    name: String(name ?? '').trim().slice(0, 40) || `${STYLES[style].label} ${currency} fund ${n}`,
    style,
    focus: String(focus ?? '').trim().slice(0, 300),
  });
  c.funds.push(fund);
  return fund;
}

// Changes a fund's name, style, focus and settings. A new style doesn't change limits by itself.
export function updateFund(fund, { name, style, focus, settings } = {}) {
  if (style !== undefined) {
    if (!STYLES[style]) throw new Error(`Unknown style ${style}.`);
    fund.style = style;
  }
  if (name !== undefined) fund.name = String(name).trim().slice(0, 40) || fund.name;
  if (focus !== undefined) fund.focus = String(focus).trim().slice(0, 300);
  if (settings) applySettings(fund, settings);
}

// Removes a stopped fund, keeping a one-line summary of how it did.
export function removeFund(c, id, now = new Date()) {
  const f = findFund(c, id);
  if (!f) throw new Error('That fund no longer exists.');
  if (!f.stoppedAt) throw new Error('Stop the fund before removing it.');
  if ((f.brokerOrders ?? []).some((o) => OPEN.includes(o.status))) throw new Error('Wait for its last Tiger orders to finish.');
  c.funds = c.funds.filter((x) => x !== f);
  c.archived.push({ name: f.name, style: f.style, startedAt: f.startedAt, endedAt: f.stoppedAt ?? now.toISOString(), currency: f.currency, budget: f.budget, finalValue: f.history.at(-1)?.[1] ?? f.budget });
  c.archived = c.archived.slice(-50);
}

// Shares of each stock held (or about to be, through open orders) by the other Tiger funds, signed.
export function otherTigerHoldings(c, fundId) {
  const out = {};
  for (const f of c.funds) {
    if (f.id === fundId || f.settings?.broker !== 'tiger') continue;
    for (const [s, p] of Object.entries(f.portfolio.positions)) out[s] = (out[s] ?? 0) + p.qty;
    for (const o of f.brokerOrders ?? []) {
      if (!OPEN.includes(o.status) || o.source === 'guard') continue;
      const left = o.qty - (o.appliedQty ?? 0);
      if (left > 0 && !f.portfolio.positions[o.symbol]) out[o.symbol] = (out[o.symbol] ?? 0) + (o.side === 'buy' ? left : -left);
    }
  }
  return out;
}

// Tiger's account against every Tiger fund together (Tiger may hold more, never less or the other side).
export function reconcileAll(c) {
  const tigerFunds = c.funds.filter((f) => f.settings?.broker === 'tiger' && f.broker);
  const snap = tigerFunds.map((f) => f.broker).sort((a, b) => String(b.time).localeCompare(String(a.time)))[0];
  if (!snap || !Array.isArray(snap.positions) || snap.error) return tigerFunds.length === 1 ? reconcile(tigerFunds[0]) : null;
  const held = Object.fromEntries(snap.positions.map((p) => [p.symbol, Number(p.qty) || 0]));
  const want = {};
  for (const f of tigerFunds) for (const [s, p] of Object.entries(f.portfolio.positions)) want[s] = (want[s] ?? 0) + p.qty;
  const mismatches = [];
  for (const [symbol, qty] of Object.entries(want)) {
    if (!qty) continue;
    const t = held[tigerSymbol(symbol)] ?? 0;
    if (qty > 0 ? t < qty : t > qty) mismatches.push({ symbol, fund: qty, tiger: t });
  }
  return { checkedAt: snap.time, ok: mismatches.length === 0, mismatches };
}
