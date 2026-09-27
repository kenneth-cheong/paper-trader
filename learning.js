// How an AI fund learns from what happened after its ideas. Pure functions (no AI): the scheduled job
// grades ideas every run, and a cheap weekly review (ai.js reviewPlaybook) only adds wording on top.
//
// Every idea is graded, not just executed trades:
//   traded    orders that filled or went to Tiger
//   declined  trades the owner rejected when asked to approve
//   expired   proposals nobody approved in time, or approvals that couldn't be sent
//   blocked   orders the fund's own limits refused (buying power, order size, shorts not allowed...)
//   passed    ideas the AI considered but didn't act on (it lists up to 3 each decision)
//   exit      its own sells and covers, stop-losses, take-profits and forced covers
// An entry idea (buy / short) is graded by the price move in its direction a week (5 trading days), a
// month (21) and a quarter (63) later, and against the index over the same days. An exit is graded by what the price
// did next: if the position would have kept gaining, the exit was early.
//
// Moves are total returns: dividends that went ex in between count (see actions.js dividendReturn), for
// the stock and for the index, so a buy isn't marked down just because the stock went ex-dividend.
//
// The same idea repeated (say, passing on NVDA at every decision for a week) is one idea, not many:
// a repeat within REPEAT_DAYS trading days joins the first, which keeps its time and price and counts
// the repeats. Once an idea's month grade is final, it's frozen into fund.ideaLog, a compact capped
// log, so learning survives the fund's decisions being trimmed and the 1-year price window moving on.
//
// Each graded idea is split into the market's part (the stock's beta times the index's move), fees (a
// round trip on entries) and what's left, the stock-specific edge; it's also compared with its peers
// (stats.js). Lessons come from those grades by fixed rules, each with its evidence, and only when the
// evidence engine (stats.js estimate) is confident enough: 8+ separate bets (the same stock and side
// within a week is one bet), a 97-in-100 chance and an edge of 0.3% a week. A lesson stays until that
// chance falls below 3 in 4 (pb.lessonRecord remembers which are on), so lessons don't flicker.
// Patterns on their way are "watching", shown only to the owner. They form the fund's playbook, which
// the AI sees at every decision. The owner can hide a lesson or add their own. Nothing here changes
// the fund's hard limits.
//
// Every order and considered idea also carries the AI's thesis (thesis.js): the move it expects, over
// 5, 21 or 63 trading days, the catalyst and what would prove it wrong. Ideas are graded a quarter (63
// trading days) later too, and calibration() compares each thesis with what happened at its own
// horizon: expected against realised, horizon fit, stale catalysts, results catalysts, fees and
// conviction, by fixed rules, pooled across the funds in a market as well as per fund. A rule that
// judges results fires only on a gap clearly beyond noise, after the market's part and counted by the
// weeks the bets started in (calibrationNoiseCheck runs them on honest made-up funds). Where the
// expected moves hardly vary, it says they're formulaic instead of judging them. At most 3 of these
// lessons reach the AI.

import { priceAt, priceAtWithTime, sessionLength, BENCHMARKS } from './benchmark.js';
import { dividendReturn } from './actions.js';
import { planFor } from './fees.js';
import { marketForCurrency } from './markets.js';
import { thesisOf, lessonsAppliedOf, catalystPassed, moveWords, CATALYST_TYPES, HORIZON_DAYS, HORIZON_LABELS, STALE_DAYS } from './thesis.js';
import {
  betaAt, peerBaseline, peerLabel, roundTripFee, separateBets, estimate, difference, lessonStatus, confidenceOf, betsNeeded,
  weekdaysBetween, weeklyMean, isoWeek, seeded, gauss, quantile, GATE, BANKS,
} from './stats.js';

export const HORIZONS = [{ key: 'week', label: '1 week', days: 5 }, { key: 'month', label: '1 month', days: 21 }, { key: 'quarter', label: '1 quarter', days: 63 }];
const HORIZON_KEY = { 5: 'week', 21: 'month', 63: 'quarter' };
export const MIN_CASES = 5; // the old rule's minimum (before the evidence engine), kept for the transition
export const REVIEW_EVERY_DAYS = 6;
export const REVIEW_MIN_NEW = 5;
export const REPEAT_DAYS = 5;
export const IDEA_LOG_MAX = 2000;
export const MAX_DECISIONS = 500;
const OUTCOME_OF_PROPOSAL = { approved: 'traded', rejected: 'declined', expired: 'expired', failed: 'expired' };
export const OUTCOME_LABELS = {
  traded: 'traded', declined: 'declined by you', expired: 'not approved in time', blocked: 'blocked by limits', passed: 'passed on',
  exit: 'its own exit', 'stop-loss': 'stop-loss', 'take-profit': 'take-profit',
};
export const IDEA_LABELS = {
  news: 'news', earnings: 'earnings', momentum: 'momentum', value: 'value', technical: 'technical',
  analyst_pick: 'following an AI pick', risk_reduction: 'risk reduction', other: 'other',
};

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const share = (x) => `${Math.round(x * 100)}%`;

// ---------- ideas ----------

const DAY_S = 86400;

// The same bet: same stock, same direction, same kind and outcome (e.g. passed-on buys of NVDA).
const betKey = (i) => `${i.symbol}|${i.direction}|${i.kind}:${i.outcome}`;

// Merges repeated ideas: a repeat within REPEAT_DAYS trading days of the first joins it, which keeps its
// time and price and gains a `repeats` count. Frozen ideas (from the idea log) are never dropped; live
// ones right after them are the rest of that frozen idea, so they don't add to its count. Works on one
// fund's ideas or on several funds' pooled together (two funds making the same bet count once).
export function mergeRepeats(ideas) {
  const open = new Map();
  const out = [];
  for (const idea of [...ideas].sort((a, b) => a.t - b.t)) {
    const first = open.get(betKey(idea));
    if (first && weekdaysBetween(first.t, idea.t) <= REPEAT_DAYS && !(idea.frozen && !first.frozen)) {
      if (!first.frozen || idea.frozen) first.repeats += idea.repeats ?? 1;
      continue;
    }
    const kept = { ...idea, repeats: idea.repeats ?? 1 };
    open.set(betKey(kept), kept);
    out.push(kept);
  }
  return out;
}

// Several funds' ideas as one list (e.g. every fund in a market), with the same merging.
export const poolIdeas = (lists) => mergeRepeats(lists.flat());

// Every idea in the fund's record (the frozen log and the live decisions, events and proposals),
// repeats merged, oldest first.
export function collectIdeas(fund) {
  const ideas = [];
  const proposals = Object.fromEntries((fund.proposals ?? []).map((p) => [p.id, p]));
  for (const d of fund.decisions ?? []) {
    if (d.skipped || !d.time) continue;
    const t = Date.parse(d.time) / 1000;
    (d.orders ?? []).forEach((o, i) => {
      const exit = o.action === 'sell' || o.action === 'cover';
      let outcome;
      if (o.status === 'filled' || o.status === 'sent to Tiger') outcome = 'traded';
      else if (o.status === 'awaiting approval') outcome = OUTCOME_OF_PROPOSAL[proposals[o.proposalId]?.status] ?? 'pending';
      else outcome = 'blocked';
      if (outcome === 'pending') return;
      ideas.push({
        id: `${d.time}#${i}`, t, symbol: o.symbol, action: o.action,
        // an entry's bet, or for an exit the direction of the position being closed
        direction: o.action === 'buy' || o.action === 'sell' ? 1 : -1,
        kind: exit ? 'exit' : 'entry', outcome: exit && outcome === 'traded' ? 'exit' : outcome,
        ideaType: o.ideaType ?? 'other', conviction: o.conviction ?? null, reason: o.reason ?? '', price: o.price ?? o.refPrice ?? null,
        // what a simulator fill actually paid, as a share of the trade (entries only; exits aren't
        // charged); chargeFees turns it into the round trip
        fee: !exit && o.fee > 0 && o.shares > 0 && o.price > 0 ? o.fee / (o.shares * o.price) : null,
        shares: o.shares > 0 ? o.shares : null,
        thesis: exit ? null : o.thesis ?? null, lessons: o.lessonsApplied?.length ?? 0,
      });
    });
    (d.considered ?? []).forEach((c, i) => ideas.push({
      id: `${d.time}#c${i}`, t, symbol: c.symbol, action: c.stance === 'short' ? 'short' : 'buy', direction: c.stance === 'short' ? -1 : 1,
      kind: 'entry', outcome: 'passed', ideaType: c.idea_type ?? 'other', conviction: null, reason: c.why_not ?? '', price: null, fee: null,
      thesis: c.thesis !== undefined ? c.thesis : thesisOf(c), lessons: c.lessonsApplied?.length ?? lessonsAppliedOf(c).length,
    }));
  }
  for (const e of fund.events ?? []) {
    const why = String(e.why ?? '');
    const m = why.match(/stop-loss|take-profit|forced cover/);
    if (!m || !['sell', 'cover'].includes(e.action) || /^Tiger fill/.test(why)) continue;
    ideas.push({
      id: `e:${e.time}:${e.symbol}`, t: Date.parse(e.time) / 1000, symbol: e.symbol, action: e.action, direction: e.action === 'sell' ? 1 : -1,
      kind: 'exit', outcome: m[0] === 'take-profit' ? 'take-profit' : 'stop-loss', ideaType: 'risk_reduction', conviction: null, reason: why, price: e.price ?? null, fee: null,
    });
  }
  return mergeRepeats([...frozenIdeas(fund.ideaLog), ...ideas]);
}

// ---------- the frozen idea log ----------

// Each row: [t, symbol, direction, class, type, conviction, repeats, week move, week index, month move,
// month index, month dividends, fee, beta, weekly stock-specific volatility, week peers' move, trade
// value, price, quarter move, quarter index, expected move, horizon days, catalyst, catalyst age in
// trading days, catalyst came within the horizon (1/0), lessons applied], moves as fractions, the fee a
// round trip. The code lists are append-only: stored rows refer to their positions, and new columns
// only ever go on the end (older rows simply lack them; trailing empty columns are left off). A row is
// frozen at the month, so its quarter columns are filled in later (completeQuarters).
export const CLASS_CODES = ['entry:traded', 'entry:declined', 'entry:expired', 'entry:blocked', 'entry:passed', 'exit:exit', 'exit:stop-loss', 'exit:take-profit', 'exit:declined', 'exit:expired', 'exit:blocked'];
export const TYPE_CODES = ['other', 'news', 'earnings', 'momentum', 'value', 'technical', 'analyst_pick', 'risk_reduction'];
export const CONVICTION_CODES = [null, 'low', 'medium', 'high'];
export const CATALYST_CODES = CATALYST_TYPES; // append-only too
const COL = { price: 17, qMove: 18, qIdx: 19, expected: 20, horizon: 21, catalyst: 22, age: 23, passed: 24, lessons: 25 };
const ACTIONS = { entry: { 1: 'buy', '-1': 'short' }, exit: { 1: 'sell', '-1': 'cover' } };
const r5 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 1e5);

// The time is rounded down, so a frozen idea sorts no later than its live copy and absorbs it.
export function ideaRow(g) {
  const th = g.thesis;
  const row = [
    Math.floor(g.t), g.symbol, g.direction, CLASS_CODES.indexOf(`${g.kind}:${g.outcome}`), Math.max(0, TYPE_CODES.indexOf(g.ideaType)),
    Math.max(0, CONVICTION_CODES.indexOf(g.conviction)), g.repeats ?? 1,
    r5(g.week?.move), r5(g.week?.index), r5(g.month?.move), r5(g.month?.index), r5(g.month?.divs), r5(g.fee),
    g.beta == null ? null : Math.round(g.beta * 100) / 100, g.idio == null ? null : Math.round(g.idio * 1e4) / 1e4, r5(g.week?.peer),
    g.value > 0 ? Math.round(g.value) : null,
    g.price > 0 ? Number(g.price.toPrecision(7)) : null, r5(g.quarter?.move), r5(g.quarter?.index),
    ...(th ? [r5(th.expected == null ? null : th.expected / 100), th.horizon ?? null, Math.max(0, CATALYST_CODES.indexOf(th.catalyst)), th.age ?? null,
      g.catalystPassed == null ? null : Number(g.catalystPassed), g.lessons || null] : []),
  ];
  while (row.length > COL.price && row.at(-1) == null) row.pop();
  return row;
}

// The log's rows as graded ideas (without their reasons, which aren't kept).
export function frozenIdeas(log) {
  return (Array.isArray(log) ? log : []).flatMap((r) => {
    const [t, symbol, direction, cls, type, conv, repeats, wMove, wIdx, mMove, mIdx, divs, fee, beta, idio, wPeer, value,
      price, qMove, qIdx, expected, horizon, catalyst, age, passed, lessons] = r;
    const [kind, outcome] = (CLASS_CODES[cls] ?? '').split(':');
    if (!outcome || wMove == null) return [];
    const thesis = horizon != null || expected != null ? {
      expected: expected == null ? null : Math.round(expected * 1e4) / 100, horizon: horizon ?? null, catalyst: CATALYST_CODES[catalyst] ?? 'none',
      catalystDate: '', wrongIf: '', age: age ?? null, stale: age == null ? null : age > STALE_DAYS,
    } : null;
    return [{
      id: `log:${t}:${symbol}:${cls}`, t, symbol, direction, kind, outcome, action: ACTIONS[kind][direction],
      ideaType: TYPE_CODES[type] ?? 'other', conviction: CONVICTION_CODES[conv] ?? null, repeats: repeats ?? 1, reason: '', price: price ?? null, fee,
      beta: beta ?? null, idio: idio ?? null, value: value ?? null,
      week: { move: wMove, index: wIdx, peer: wPeer ?? null }, month: mMove == null ? null : { move: mMove, index: mIdx, divs },
      quarter: qMove == null ? null : { move: qMove, index: qIdx ?? null }, thesis, catalystPassed: passed == null ? null : passed === 1, lessons: lessons ?? 0, frozen: true,
    }];
  });
}

// Freezes every graded idea whose month grade is final into fund.ideaLog (the newest IDEA_LOG_MAX
// rows). Returns how many were added.
export function freezeIdeas(fund, graded) {
  const fresh = graded.filter((g) => !g.frozen && g.month && CLASS_CODES.includes(`${g.kind}:${g.outcome}`));
  if (!fresh.length) return 0;
  fund.ideaLog = [...(Array.isArray(fund.ideaLog) ? fund.ideaLog : []), ...fresh.map(ideaRow)].sort((a, b) => a[0] - b[0]).slice(-IDEA_LOG_MAX);
  return fresh.length;
}

// Fills in the quarter columns of frozen rows once 63 trading days have passed (the row was frozen at
// the month), and for a thesis with a quarter's horizon whether its catalyst came. Needs the row's price.
export function completeQuarters(fund, quotes, currency, now = new Date(), { calendar = null } = {}) {
  const nowS = now.getTime() / 1000;
  const iq = quotes[BENCHMARKS[currency]?.symbol];
  let n = 0;
  for (const row of Array.isArray(fund.ideaLog) ? fund.ideaLog : []) {
    const [t, symbol, direction] = row;
    const q = quotes[symbol];
    if (!(row[COL.price] > 0) || row[COL.qMove] != null || !q?.daily?.length || t < q.daily[0][0]) continue;
    // the row keeps only the price: if it's the close before the idea (a looked-up price, not a
    // fill), dividends count from that close, as when it was graded
    const [looked, closed] = priceAtWithTime(q, t);
    const t0 = looked != null && Number(looked.toPrecision(7)) === row[COL.price] ? closed : t;
    const at = gradeAt(q, iq, quotes, { t, symbol, direction }, row[COL.price], 63, nowS, false, t0);
    if (!at) continue;
    row[COL.qMove] = r5(at.grade.move);
    row[COL.qIdx] = r5(at.grade.index);
    if (row[COL.horizon] === 63) {
      const passed = catalystPassed({ catalyst: CATALYST_CODES[row[COL.catalyst]] }, symbol, t, at.end, { calendar, quote: q });
      if (passed != null) row[COL.passed] = Number(passed);
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    n++;
  }
  return n;
}

// ---------- grading ----------

function closeAfter(quote, t, days, nowS) {
  const later = (quote?.daily ?? []).filter(([bt]) => bt > t && bt + sessionLength(quote) <= nowS);
  return later[days - 1] ?? null;
}

// One idea's grade `days` trading days after it (see gradeIdeas), with the end of that session
// (`end`), or null before then. `p0` is the stock's price at the start, set at unix time `t0` (the
// idea's own time for a fill price; the close it came from for a looked-up one): dividends count from
// then, so an idea made during an ex-dividend session and priced at the day before's close earns it.
function gradeAt(q, iq, quotes, idea, p0, days, nowS, withPeer = true, t0 = idea.t) {
  const bar = closeAfter(q, idea.t, days, nowS);
  if (!bar) return null;
  const end = bar[0] + sessionLength(q);
  const [i0, it0] = priceAtWithTime(iq, idea.t), i1 = priceAt(iq, end);
  const divs = dividendReturn(q, t0, end, idea.direction, p0);
  return {
    end,
    grade: {
      move: idea.direction * (bar[1] / p0 - 1) + divs,
      index: i0 && i1 ? idea.direction * (i1 / i0 - 1) + dividendReturn(iq, it0, end, idea.direction, i0) : null,
      peer: withPeer ? peerBaseline(quotes, idea.symbol, idea.t, end, idea.direction) : null,
      divs,
    },
  };
}

// { ...idea, beta, idio, week: { move, index, peer, divs } | null, month, quarter: ... }: `move` is the total
// return in the idea's direction (for an exit: what the closed position would have made since),
// `index` the index's in the same direction over the same days, `peer` its peers' (stats.js
// peerBaseline), `divs` the part of `move` that came from dividends. `beta` and `idio` (its weekly
// stock-specific volatility) are from the year of closes before the idea. Frozen ideas pass through as
// they are. A live idea from before the price history can't be graded (its closes are gone), so it's
// left out rather than graded on the wrong days. An idea with a thesis also gets `catalystPassed` once
// its own horizon is over: whether its catalyst came in time, where code can tell (thesis.js; results
// dates from `calendar`, calendar.js resultsCalendar), else null.
export function gradeIdeas(ideas, quotes, currency, now = new Date(), { calendar = null } = {}) {
  const nowS = now.getTime() / 1000;
  const iq = quotes[BENCHMARKS[currency]?.symbol];
  const out = [];
  for (const idea of ideas) {
    if (idea.frozen) { out.push(idea); continue; }
    const q = quotes[idea.symbol];
    const first = q?.daily?.[0]?.[0];
    if (first == null || idea.t < first) continue;
    const [p0, t0] = idea.price > 0 ? [idea.price, idea.t] : priceAtWithTime(q, idea.t);
    if (!(p0 > 0)) continue;
    const { beta, idio } = betaAt(q, idea.t, iq);
    const g = { ...idea, price: p0, beta, idio };
    let ownEnd = null;
    for (const h of HORIZONS) {
      // the quarter's peers aren't used, so they're not worked out
      const at = gradeAt(q, iq, quotes, idea, p0, h.days, nowS, h.key !== 'quarter', t0);
      g[h.key] = at?.grade ?? null;
      if (at && h.days === idea.thesis?.horizon) ownEnd = at.end;
    }
    g.catalystPassed = ownEnd ? catalystPassed(idea.thesis, idea.symbol, idea.t, ownEnd, { calendar, quote: q }) : null;
    if (g.week) out.push(g);
  }
  return out;
}

// Charges every live entry idea a round trip of fees, as a share of the trade (`fee`), and records the
// trade's value: what a simulator fill actually paid to get in, else the fund's fee plan (Tiger
// orders, declined, expired, blocked and passed-on ideas), at the order's size, or for an idea passed
// on a typical order (the per-order limit). Exits aren't charged: their entry already was.
export function chargeFees(graded, fund, quotes) {
  const plan = planFor(fund.settings?.feePlan ?? 'tiger');
  const budget = Number(fund.budget) || 0;
  const typical = Math.min(budget, budget * (fund.settings?.maxOrderPct ?? 25) / 100);
  return graded.map((g) => {
    if (g.frozen || g.kind !== 'entry' || !(g.price > 0)) return g;
    const qty = g.shares > 0 ? g.shares : Math.max(1, Math.floor(typical / g.price));
    const value = qty * g.price;
    const fee = roundTripFee(plan, quotes[g.symbol]?.market, g.direction, qty, g.price, g.fee != null ? g.fee * value : null);
    return { ...g, fee: fee ?? g.fee, value };
  });
}

// ---------- statistics ----------

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Summary of a group of graded ideas at a horizon: n, average move, hit rate, average vs the index.
export function groupStats(graded, horizon = 'week') {
  const xs = graded.filter((g) => g[horizon]);
  if (!xs.length) return null;
  const avg = (f) => xs.reduce((s, g) => s + f(g), 0) / xs.length;
  const withIndex = xs.filter((g) => g[horizon].index != null);
  return {
    n: xs.length,
    repeats: xs.reduce((s, g) => s + (g.repeats ?? 1), 0), // how many times these ideas came up in all
    avgMove: avg((g) => g[horizon].move),
    hitRate: xs.filter((g) => g[horizon].move > 0).length / xs.length,
    avgExcess: withIndex.length ? withIndex.reduce((s, g) => s + g[horizon].move - g[horizon].index, 0) / withIndex.length : null,
  };
}

// The evidence behind a group of graded ideas a week later, counted in separate bets (stats.js):
//   vsIndex   the average result against the index, before fees
//   fromBeta  the part of it the stocks' beta explains: (beta - 1) x the index's move
//   fees      the round trip's cost (negative)
//   edge      what's left (vsIndex - fromBeta + fees), the stock-specific edge, as an estimate with its
//             likely range and the chance it has its sign
//   index     the same estimate for the plain result against the index
//   peers     the same against the stock's peers (null without them)
//   money     the average money made per traded idea after fees, in the fund's currency
export function evidenceFor(list, horizon = 'week') {
  const items = list.filter((g) => g[horizon] && g[horizon].index != null).map((g) => ({
    symbol: g.symbol, direction: g.direction, t: g.t, idio: g.idio, h: g[horizon], beta: g.beta ?? 1, fee: g.fee ?? 0,
    value: g.outcome === 'traded' ? g.value : null,
  }));
  if (!items.length) return null;
  const bets = separateBets(items);
  const perBet = (f) => mean(bets.map((b) => mean(b.items.map(f))));
  const worth = items.filter((i) => i.value > 0);
  const peers = estimate(bets, (i) => (i.h.peer == null ? null : i.h.move - i.h.peer));
  return {
    ideas: items.length, bets: bets.length,
    vsIndex: r5(perBet((i) => i.h.move - i.h.index)),
    fromBeta: r5(perBet((i) => (i.beta - 1) * i.h.index)),
    fees: r5(-perBet((i) => i.fee)),
    edge: estimate(bets, (i) => i.h.move - i.beta * i.h.index - i.fee),
    index: estimate(bets, (i) => i.h.move - i.h.index),
    ...(peers ? { peers } : {}),
    money: worth.length ? Math.round(mean(worth.map((i) => (i.h.move - i.fee) * i.value)) * 100) / 100 : null,
  };
}

// The tables the fund page shows and the weekly review reads. `tradedBySymbol` (stock and side) only
// carries the evidence, for the lessons against peers.
export function learningStats(graded) {
  const group = (v) => ({ week: groupStats(v, 'week'), month: groupStats(v, 'month'), ev: evidenceFor(v) });
  const by = (key, list) => {
    const out = {};
    for (const g of list) (out[g[key] ?? 'unknown'] ??= []).push(g);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, group(v)]));
  };
  const entries = graded.filter((g) => g.kind === 'entry');
  const traded = entries.filter((g) => g.outcome === 'traded');
  const bySymbol = {};
  for (const g of traded) (bySymbol[`${g.symbol}|${g.direction}`] ??= []).push(g);
  return {
    graded: graded.length,
    byOutcome: by('outcome', graded),
    tradedByType: by('ideaType', traded),
    tradedByConviction: by('conviction', traded),
    tradedByDirection: by('direction', traded),
    tradedBySymbol: Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, { ev: evidenceFor(v) }]).filter(([, v]) => v.ev?.peers)),
  };
}

// ---------- lessons ----------

export const TRANSITION_DAYS = 28;
export const BETA_DRIVEN = 0.01; // "beta-driven": this far from the index a week while the edge is near zero

// "Traded news ideas: 11 ideas, 6 separate bets. +1.4% a week vs the index: +1.1% of that from beta and
// −0.3% from fees, leaving a stock-specific edge of +0.0% (likely −0.9% to +0.9%)."
export function evidenceText(ev, what) {
  const e = ev.edge;
  return `${what}: ${plural(ev.ideas, 'idea')}, ${plural(ev.bets, 'separate bet')}. ${pct(ev.vsIndex)} a week vs the index: ${pct(ev.fromBeta)} of that from beta${ev.fees ? ` and ${pct(ev.fees)} from fees` : ''}, leaving a stock-specific edge of ${pct(e.edge)} (likely ${pct(e.lo)} to ${pct(e.hi)}).`;
}

// The old rule for a traded idea type (before the evidence engine): 5+ cases a week later, 1%+ against
// the index and the hit rate on the same side. A lesson the owner has seen stays while this holds, for
// TRANSITION_DAYS after the switch, so it doesn't vanish overnight.
function oldTypeRule(st, sign) {
  if (!st || st.n < MIN_CASES || st.avgExcess == null) return false;
  return sign < 0 ? st.avgExcess <= -0.01 && st.hitRate < 0.5 : st.avgExcess >= 0.01 && st.hitRate >= 0.55;
}

// The rule-made lessons and the patterns being watched. `was`: ids of the lessons on last time;
// `gated`: those of them that passed the full gate (GATE.p and GATE.edge) under this engine. A lesson
// on last time stays until its chance falls below GATE.keep only if it was gated, or during the
// transition (`transition`: within TRANSITION_DAYS of the switch to the edge); a lesson inherited from
// before the engine must pass the full gate once the transition is over. Returns { lessons, watching }:
// each lesson with a stable id (so a hidden one stays hidden), its evidence, and its confidence, its
// number per week (`measure`: 'edge', the stock-specific edge; 'index', against the index; 'peers',
// against `vs`; 'diff', high minus low conviction), likely range and separate bets, and `gated`; each
// watched pattern with its chance and about how many more bets it needs.
export function evaluateLessons(stats, { was = [], transition = false, gated = [] } = {}) {
  const on = new Set(was), passedGate = new Set(gated);
  const keeps = (id) => on.has(id) && (transition || passedGate.has(id));
  const lessons = [], watching = [];
  const push = (id, text, evidence, est, { measure = 'edge', vs = null, full = false, extra = {} } = {}) => lessons.push({
    id, text, evidence, source: 'results', confidence: confidenceOf(est.p), p: est.p, measure, ...(vs ? { vs } : {}), edge: est.edge, lo: est.lo, hi: est.hi, bets: est.bets,
    gated: full || passedGate.has(id), ...extra,
  });
  const consider = (id, sign, est, text, evidence, also = true, how = {}) => {
    const status = also ? lessonStatus(est, sign, keeps(id)) : null;
    if (status === 'lesson') push(id, text, evidence, est, { ...how, full: lessonStatus(est, sign, false) === 'lesson' });
    else if (status === 'watching') watching.push({ id, text, p: est.p, bets: est.bets, more: betsNeeded(est), edge: est.edge });
  };

  for (const [type, g] of Object.entries(stats.tradedByType ?? {})) {
    const ev = g.ev;
    if (!ev?.edge) continue;
    const label = IDEA_LABELS[type] ?? type;
    const evidence = evidenceText(ev, `Traded ${label} ideas`);
    for (const [sign, id, text] of [
      [-1, `type-weak:${type}`, `Trades based on ${label} have lagged, even after allowing for the market's moves (beta) and fees. Be more selective with them, or skip them.`],
      [1, `type-strong:${type}`, `Trades based on ${label} have had an edge beyond the market's moves (beta) and fees. Keep favouring them when the setup is clear.`],
    ]) {
      if (transition && on.has(id) && oldTypeRule(g.week, sign) && lessonStatus(ev.edge, sign, true) !== 'lesson') push(id, text, `${evidence} Kept for now: by the old measure (against the index only) it still holds.`, ev.index, { measure: 'index' });
      else consider(id, sign, ev.edge, text, evidence);
    }
  }

  // Beating or lagging the index only because of beta, all traded ideas and by type.
  const betaDriven = (id, ev, what) => {
    const idx = ev?.index;
    if (!idx || !ev.edge || ev.bets < GATE.bets || Math.abs(ev.vsIndex) < BETA_DRIVEN || Math.abs(ev.edge.edge) >= GATE.edge) return;
    // ...and beta explains most of it
    if (Math.sign(ev.vsIndex) !== idx.sign || idx.p < (keeps(id) ? GATE.keep : GATE.p) || ev.fromBeta * idx.sign < Math.abs(ev.vsIndex) / 2) return;
    push(id, idx.sign > 0
      ? `${what} beat the index mostly because they held stocks that swing more than it (beta), not through stock picking. Don't read a rising market as skill.`
      : `${what} lagged the index mostly because of how the stocks move with the market (beta), not poor stock picking.`,
    evidenceText(ev, what), idx, { measure: 'index', full: idx.p >= GATE.p, extra: { stockEdge: ev.edge.edge } });
  };
  const allTraded = stats.byOutcome?.traded?.ev;
  betaDriven('beta-driven', allTraded, 'Your trades');
  for (const [type, g] of Object.entries(stats.tradedByType ?? {})) {
    if (g.ev?.ideas !== allTraded?.ideas) betaDriven(`beta-driven:${type}`, g.ev, `Your ${IDEA_LABELS[type] ?? type} trades`); // not the same ideas again
  }

  const shorts = stats.tradedByDirection?.['-1']?.ev;
  if (shorts?.edge) consider('shorts-weak', -1, shorts.edge, 'Your shorts have lost money even after allowing for the market\'s moves. Short only with a strong, specific reason.', evidenceText(shorts, 'Shorts'));

  const conv = stats.tradedByConviction ?? {};
  const hi = conv.high?.ev?.edge, lo = conv.low?.ev?.edge;
  const diff = difference(hi, lo);
  if (diff && hi.bets >= GATE.bets && lo.bets >= GATE.bets && diff.sign < 0 && Math.abs(diff.edge) >= GATE.edge && diff.p >= (keeps('conviction') ? GATE.keep : GATE.p)) {
    push('conviction', 'Your high-conviction trades have done worse than your low-conviction ones. Don\'t size up just because conviction feels high.',
      `High conviction: ${plural(hi.bets, 'separate bet')}, edge ${pct(hi.edge)} a week. Low: ${plural(lo.bets, 'separate bet')}, edge ${pct(lo.edge)}.`, diff, { measure: 'diff', full: diff.p >= GATE.p });
  }

  const o = stats.byOutcome ?? {};
  const out = (k) => o[k]?.ev;
  const traded = out('traded')?.edge;
  const better = (ev) => !traded || ev.edge.edge > traded.edge;
  const rule = (k, id, sign, text, what, also = () => true) => { const ev = out(k); if (ev?.edge) consider(id, sign, ev.edge, text, evidenceText(ev, what), also(ev)); };
  rule('passed', 'passed-better', 1, 'Ideas you passed on would have done better than the market explains, and better than your trades. You may be too cautious; act on strong ideas instead of only noting them.', 'Ideas passed on', better);
  rule('passed', 'passed-right', -1, 'The ideas you passed on mostly went against you, so your caution has been paying off.', 'Ideas passed on');
  rule('blocked', 'blocked-better', 1, 'Orders your limits blocked would have done well. Size orders so they fit within the per-order limit and buying power.', 'Blocked orders', better);
  rule('declined', 'declined-right', -1, 'Trades your owner declined would mostly have lost money. Expect scrutiny on similar ideas.', 'Declined trades');
  rule('declined', 'declined-good', 1, 'Trades your owner declined would have done well. Explain such ideas clearly in the reason.', 'Declined trades', better);
  rule('exit', 'exit-early', 1, 'Stocks you sold kept rising afterwards (shorts you covered kept falling), beyond what the market explains. You may be exiting too early; let winners run with a stop-loss instead.', 'Your exits');
  rule('stop-loss', 'stops-tight', 1, 'Stocks mostly recovered after your stop-losses. Your stops may be too tight for how much these stocks move; set them wider, and size positions smaller to match.', 'Stop-losses');
  rule('take-profit', 'takes-early', 1, 'Stocks kept rising after hitting take-profit. Consider higher take-profit levels.', 'Take-profits');

  // Right on the market (or banks), wrong stock: beat the index but lagged the stock's peers.
  for (const [key, { ev }] of Object.entries(stats.tradedBySymbol ?? {})) {
    const [symbol, dir] = key.split('|');
    const name = BANKS[symbol] ?? symbol, side = dir === '-1' ? 'shorts' : 'buys';
    const bank = Boolean(BANKS[symbol]);
    consider(`peer-weak:${key}`, -1, ev.peers,
      `Your ${name} ${side} beat the index but lagged ${peerLabel(symbol)}: ${bank ? 'right on banks, wrong bank' : 'right on the market, wrong stock'}. Compare it with ${bank ? 'the other banks' : 'its peers'} before choosing it.`,
      `${name} ${side}: ${plural(ev.ideas, 'idea')}, ${plural(ev.bets, 'separate bet')}. ${pct(ev.vsIndex)} a week vs the index, ${pct(ev.peers.edge)} vs ${peerLabel(symbol)} (likely ${pct(ev.peers.lo)} to ${pct(ev.peers.hi)}).`,
      ev.vsIndex > 0, { measure: 'peers', vs: peerLabel(symbol) });
  }
  return { lessons, watching: watching.sort((a, b) => b.p - a.p) };
}

// The rule-made lessons alone (see evaluateLessons).
export const statLessons = (stats, opts = {}) => evaluateLessons(stats, opts).lessons;

// ---------- checking the rules on pure noise ----------

// A made-up fund with no skill at all, `weeks` long: each week a few trades, ideas passed on, exits,
// stop-losses and the rest, on 8 stocks with betas from 0.6 to 1.6 and their own week-to-week noise;
// every result is the stock's beta times the index plus noise, so any lesson is a false one. Graded
// ideas as gradeIdeas and chargeFees make them (no fees: pure noise shouldn't lose to costs either).
export const NOISE_START = Date.parse('2026-01-05T15:00:00Z') / 1000; // a Monday
export function noiseFund(rand, weeks = 26) {
  const n = 8;
  const stocks = Array.from({ length: n }, (_, i) => ({ symbol: `N${i}`, beta: 0.6 + rand(), idio: 0.02 + 0.025 * rand() }));
  const types = TYPE_CODES.filter((t) => t !== 'risk_reduction');
  const count = (rate) => { let k = 0; for (let p = Math.exp(-rate), s = p, u = rand(); u > s; k++) { p *= rate / (k + 1); s += p; } return k; };
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const ideas = [];
  for (let w = 0; w < weeks; w++) {
    const index = 0.002 + 0.02 * gauss(rand);
    const shock = stocks.map((s) => s.idio * gauss(rand));
    const move = (k) => stocks[k].beta * index + shock[k];
    const plan = [['traded', 3], ['passed', 4], ['exit', 2], ['stop-loss', 0.3], ['take-profit', 0.2], ['declined', 0.4], ['blocked', 0.3], ['expired', 0.2]];
    for (const [outcome, rate] of plan) {
      for (let j = count(rate); j > 0; j--) {
        const k = Math.floor(rand() * n), s = stocks[k];
        const direction = rand() < 0.8 ? 1 : -1;
        const kind = ['exit', 'stop-loss', 'take-profit'].includes(outcome) ? 'exit' : 'entry';
        const others = stocks.map((_, i) => i).filter((i) => i !== k);
        ideas.push({
          id: `n${w}:${ideas.length}`, t: NOISE_START + (w * 7 + Math.floor(rand() * 5)) * DAY_S, symbol: s.symbol, direction, kind, outcome,
          ideaType: kind === 'exit' ? 'risk_reduction' : pick(types), conviction: outcome === 'traded' ? pick(['low', 'medium', 'high']) : null,
          repeats: 1, fee: 0, value: null, beta: Math.max(0, s.beta + 0.1 * gauss(rand)), idio: s.idio,
          week: {
            move: direction * (move(k) + 0.4 * s.idio * gauss(rand)), index: direction * index,
            peer: direction * mean(others.map(move)),
          },
          month: null,
        });
      }
    }
  }
  return ideas.sort((a, b) => a.t - b.t);
}

// Runs the lessons weekly, as the scheduled job does (keeping the lessons that are on), over `sims`
// made-up funds with no skill, and counts the distinct lessons each one ever showed: { sims, any
// (share with at least one false lesson), moreThanOne (share with two or more), meanLessons }.
export function noiseCheck({ sims = 200, seed = 1, weeks = 26 } = {}) {
  const counts = [];
  for (let k = 0; k < sims; k++) {
    const ideas = noiseFund(seeded(seed + k * 7919), weeks);
    const fired = new Set();
    let on = [];
    for (let w = 4; w <= weeks; w++) {
      const cut = NOISE_START + (w * 7 - 2) * DAY_S;
      on = statLessons(learningStats(ideas.filter((i) => i.t + 7 * DAY_S <= cut)), { was: on.map((l) => l.id), gated: on.filter((l) => l.gated).map((l) => l.id) });
      for (const l of on) fired.add(l.id);
    }
    counts.push(fired.size);
  }
  const share = (f) => Math.round(counts.filter(f).length / sims * 1000) / 1000;
  return { sims, any: share((c) => c >= 1), moreThanOne: share((c) => c >= 2), meanLessons: Math.round(mean(counts) * 100) / 100 };
}

// The result of noiseCheck() with its defaults, which test/learning.test.mjs re-runs and checks: the
// page prints how often pure noise showed a false lesson.
export const NOISE_CHECK = { sims: 200, any: 0.175, moreThanOne: 0.015, meanLessons: 0.19 };

// ---------- calibration: each thesis against what happened ----------

// The fixed rules' thresholds. Moves are fractions; `formulaicSd` is in percentage points.
export const CALIBRATION = {
  minBets: 10, // separate bets before judging expected against realised, or a horizon
  groupBets: 8, // for comparing a kind of idea (stale, results, conviction)
  overconfident: 0.02, // expected minus realised, at the idea's own horizon
  formulaicSd: 1, // expected moves varying less than this are boilerplate
  horizonGap: 0.01, // another horizon's result against the index this much better
  stale: 0.01, // stale-catalyst ideas lagging the index by this much
  resultsGap: 0.015, // results ideas against the rest, against the index
  convictionGap: 0.01, // high-conviction ideas lagging low-conviction ones, against the index
  feeShare: 0.2, // share of orders whose expected move didn't cover the fees
  maxLessons: 3, // reaching the AI
};
// A gap counts only when it's clearly beyond noise: a 97.5% chance on a t-distribution over `n`
// calendar weeks of separate bets (see thesisGroup). Every rule that judges results passes this.
const clear = (gap, se, n) => n >= 2 && gap != null && se != null && Math.abs(gap) >= quantile(0.995, n - 1) * se;
const clearT = (w, gap = w?.mean) => Boolean(w) && clear(gap, w.se, w.n);

// A graded idea's result at its own horizon (week, month or quarter), or null.
export const ownGrade = (g) => (g.thesis?.horizon ? g[HORIZON_KEY[g.thesis.horizon]] ?? null : null);

const sdOf = (xs) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const excessAt = (h) => (h?.index == null ? null : h.move - h.index);
// The move beyond what the market explains (its beta times the index's move), which the rules judge:
// one market-wide rally or selloff, shared by bets in overlapping weeks, isn't the AI's calibration.
const afterBeta = (g, h) => (h?.index == null ? null : h.move - (g.beta ?? 1) * h.index);

// A group of theses whose own horizon is over, counted in separate bets: ideas on the same stock and
// side whose windows (their own horizon: a week, a month or a quarter) overlap are one bet, at the
// average of its ideas. What's shown: { ideas, bets, weeks, horizon (the usual one), expected,
// realised (at each idea's own horizon), vsIndex (against the index), at: { week, month, quarter }
// (against the index at 5, 21 and 63 trading days: horizon fit), atBets }, averages over the bets.
// What the rules test, by calendar week (stats.js weeklyMean: bets started in the same week count
// once) and after the market's part (beta times the index): gap (expected minus realised), vs (the
// result), shift: { week, month, quarter } (each bet's result at that horizon minus at its own),
// each { mean, se, n }; `shifts` only when asked (for the horizon rule).
function thesisGroup(list, { shifts = false } = {}) {
  const done = list.filter((g) => ownGrade(g));
  if (!done.length) return null;
  // `longer`: bets for comparing with another horizon, whose windows are the longer of the two
  const betsOver = (longer = 0) => HORIZON_DAYS.flatMap((h) => separateBets(done.filter((g) => g.thesis.horizon === h).map((g) => ({ symbol: g.symbol, direction: g.direction, t: g.t, g })), Math.max(h, longer)));
  const bets = betsOver();
  const perBet = (f, list = bets) => list.map((b) => ({ xs: b.items.map((i) => f(i.g)).filter((x) => x != null && Number.isFinite(x)), key: isoWeek(b.t) }))
    .filter((r) => r.xs.length).map((r) => ({ x: mean(r.xs), key: r.key }));
  const avgOf = (rows) => (rows.length ? r5(mean(rows.map((r) => r.x))) : null);
  const exp = perBet((g) => g.thesis.expected / 100), real = perBet((g) => ownGrade(g).move);
  const vs = perBet((g) => excessAt(ownGrade(g)));
  const at = {}, atBets = {}, shift = {};
  for (const h of HORIZON_DAYS) {
    const k = HORIZON_KEY[h];
    const xs = perBet((g) => excessAt(g[k]));
    at[k] = avgOf(xs);
    atBets[k] = xs.length;
    if (shifts) shift[k] = weeklyMean(perBet((g) => (afterBeta(g, g[k]) == null || afterBeta(g, ownGrade(g)) == null ? null : afterBeta(g, g[k]) - afterBeta(g, ownGrade(g))), betsOver(h)));
  }
  const count = {};
  for (const g of done) count[g.thesis.horizon] = (count[g.thesis.horizon] ?? 0) + 1;
  return {
    ideas: done.length, bets: bets.length, weeks: new Set(bets.map((b) => isoWeek(b.t))).size,
    horizon: Number(Object.entries(count).sort((a, b) => b[1] - a[1])[0][0]),
    expected: avgOf(exp), realised: avgOf(real), gap: weeklyMean(perBet((g) => (afterBeta(g, ownGrade(g)) == null ? null : g.thesis.expected / 100 - afterBeta(g, ownGrade(g))))),
    vsIndex: avgOf(vs), vs: weeklyMean(perBet((g) => afterBeta(g, ownGrade(g)))), at, atBets, ...(shifts ? { shift } : {}),
  };
}

const byKey = (list, key, opts) => {
  const out = {};
  for (const g of list) (out[key(g)] ??= []).push(g);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, thesisGroup(v, opts)]).filter(([, v]) => v));
};
const pctPts = (x) => `${Math.abs(x * 100).toFixed(1)} points`;

// The fixed rules, as lessons with stable ids (so a hidden one stays hidden). `scope` says where the
// ideas came from, e.g. "pooled across the 3 SGD funds".
function calibrationRules(c, scope) {
  const C = CALIBRATION;
  const out = [];
  const add = (id, text, evidence) => out.push({ id, text, evidence: scope ? `${evidence} Pooled across ${scope}.` : evidence, source: 'calibration' });
  const bets = (x) => plural(x.bets, 'separate bet');
  if (c.formulaic) {
    add('cal:formulaic', `Your expected moves are formulaic (almost always ${pct(c.typicalExpected / 100)}), so calibration can't be judged. Estimate each idea's move on its own merits.`,
      `${plural(c.ideas, 'idea')}; the expected moves vary by only ${c.sdExpected.toFixed(1)} points.`);
  }
  for (const [dir, label] of [['1', 'buys'], ['-1', 'shorts']]) {
    const x = c.byDirection[dir];
    if (c.formulaic || !x || x.bets < C.minBets) continue;
    const gap = x.expected - x.realised;
    if (gap > C.overconfident && x.gap?.mean > C.overconfident && clearT(x.gap)) {
      // a short's moves are in its direction: "expected a 4.2% fall ... and got a 1.6% rise"
      add(`cal:overconfident:${dir}`, dir === '1'
        ? `Your buys expected ${pct(x.expected)} over about ${HORIZON_LABELS[x.horizon]} and realised ${pct(x.realised)}. Expect less, and size smaller.`
        : `Your shorts expected ${moveWords(x.expected, true)} over about ${HORIZON_LABELS[x.horizon]} and got ${moveWords(x.realised, true)}. Expect less, and size smaller.`,
      `${bets(x)} (${plural(x.ideas, 'idea')}) in ${plural(x.gap.n, 'week')}, each at its own horizon; ${pctPts(gap)} short of the expected move.`);
    }
  }
  const st = c.stale;
  if (st && st.bets >= C.groupBets && st.vsIndex != null && st.vsIndex <= -C.stale && st.vs?.mean <= -C.stale && clearT(st.vs)) {
    add('cal:stale', `Ideas whose catalyst was more than ${STALE_DAYS} trading days old lagged the index by ${pct(-st.vsIndex).slice(1)}. Old news is usually in the price already; don't trade on it.`,
      `${bets(st)} in ${plural(st.vs.n, 'week')}, at each idea's own horizon${c.fresh?.vsIndex != null ? `; ideas with a fresh catalyst: ${pct(c.fresh.vsIndex)} vs the index (${bets(c.fresh)})` : ''}.`);
  }
  if (!c.formulaic && c.fees.ideas >= C.minBets && c.fees.notCovered / c.fees.ideas >= C.feeShare) {
    add('cal:fees', `In ${c.fees.notCovered} of ${c.fees.ideas} orders the expected move didn't cover the round-trip fee. Only trade when the expected gain clearly beats the fees.`,
      'The round trip at the fund\'s fee plan and each order\'s size.');
  }
  for (const h of HORIZON_DAYS) {
    const x = c.byHorizon[h];
    const own = HORIZON_KEY[h];
    if (!x || x.bets < C.minBets || x.at[own] == null) continue;
    // the same bets at another horizon, compared bet by bet, clearly better than at their own
    const best = ['week', 'month', 'quarter'].filter((k) => k !== own && x.atBets[k] >= C.minBets && x.at[k] > 0 && x.at[k] - x.at[own] >= C.horizonGap
      && x.shift?.[k]?.mean >= C.horizonGap && clearT(x.shift[k]))
      .sort((a, b) => x.at[b] - x.at[a])[0];
    if (!best) continue;
    const days = { week: 5, month: 21, quarter: 63 }[best];
    add(`cal:horizon:${h}`, days > h
      ? `Ideas you gave ${HORIZON_LABELS[h]} paid at ${HORIZON_LABELS[days]}: ${pct(x.at[own])} vs the index at ${h} days, ${pct(x.at[best])} at ${days}. Give such ideas more time.`
      : `Ideas you gave ${HORIZON_LABELS[h]} had done their work by ${HORIZON_LABELS[days]}: ${pct(x.at[best])} vs the index at ${days} days, ${pct(x.at[own])} at ${h}. Take profits sooner or set a shorter horizon.`,
    `${bets(x)} with ${HORIZON_LABELS[h]}'s horizon, in ${plural(x.shift[best].n, 'week')}.`);
  }
  // two kinds of ideas against the index: the gap between them, clearly beyond noise
  const apart = (a, b, min) => {
    if (!a?.vs || !b?.vs || a.bets < C.groupBets || b.bets < C.groupBets) return null;
    const diff = a.vs.mean - b.vs.mean;
    return Math.abs(diff) >= min && clear(diff, Math.hypot(a.vs.se, b.vs.se), Math.min(a.vs.n, b.vs.n)) ? diff : null;
  };
  const r = c.byCatalyst.results, o = c.byCatalyst.other;
  const rDiff = apart(r, o, C.resultsGap);
  if (rDiff != null) {
    add('cal:results', rDiff < 0
      ? `Your ideas built on results have lagged your other ideas by ${pctPts(rDiff)} against the index. Results are hard to call; size them smaller.`
      : `Your ideas built on results have beaten your other ideas by ${pctPts(rDiff)} against the index; that's where your analysis has paid.`,
    `Results: ${bets(r)}, ${pct(r.vsIndex)} vs the index; other catalysts: ${bets(o)}, ${pct(o.vsIndex)}; each at its own horizon.`);
  }
  const hi = c.byConviction.high, lo = c.byConviction.low;
  const cDiff = apart(hi, lo, C.convictionGap);
  if (cDiff != null && cDiff < 0) {
    add('cal:conviction', 'Your high-conviction ideas have done worse than your low-conviction ones, so conviction isn\'t telling you much yet. Don\'t size by it.',
      `High: ${bets(hi)}, ${pct(hi.vsIndex)} vs the index; low: ${bets(lo)}, ${pct(lo.vsIndex)}; each at its own horizon.`);
  }
  return out;
}

// Each thesis against what happened, for the fund's orders (entries it traded, or you declined, or
// that expired or its limits blocked; not ideas it passed on), by fixed rules (CALIBRATION): overall
// and by side, conviction, horizon and catalyst, stale catalysts against fresh ones, whether the
// catalyst came in time, and orders whose expected move didn't cover the fees. When the expected moves
// hardly vary (sd under CALIBRATION.formulaicSd points over 10+ orders), they're "formulaic" and the
// rules that judge them are left out. Pure; null without a thesis. `scope`: where the ideas came from,
// for the lessons' evidence ("the 3 SGD funds" when pooled).
export function calibration(graded, { scope = '' } = {}) {
  const xs = graded.filter((g) => g.kind === 'entry' && g.outcome !== 'passed' && g.thesis?.horizon && g.thesis.expected != null);
  if (!xs.length) return null;
  const exp = xs.map((g) => g.thesis.expected);
  const sd = sdOf(exp);
  const priced = xs.filter((g) => g.fee != null);
  const checked = xs.filter((g) => g.catalystPassed != null);
  const c = {
    ideas: xs.length, sdExpected: Math.round(sd * 100) / 100, typicalExpected: median(exp),
    formulaic: xs.length >= CALIBRATION.minBets && sd < CALIBRATION.formulaicSd,
    all: thesisGroup(xs),
    byDirection: byKey(xs, (g) => g.direction),
    byConviction: byKey(xs, (g) => g.conviction ?? 'unknown'),
    byHorizon: byKey(xs, (g) => g.thesis.horizon, { shifts: true }),
    byCatalyst: byKey(xs, (g) => (g.thesis.catalyst === 'results' ? 'results' : 'other')),
    stale: thesisGroup(xs.filter((g) => g.thesis.stale === true)), fresh: thesisGroup(xs.filter((g) => g.thesis.stale === false)),
    catalystChecked: { ideas: checked.length, passed: checked.filter((g) => g.catalystPassed).length },
    fees: { ideas: priced.length, notCovered: priced.filter((g) => g.thesis.expected / 100 < g.fee).length },
  };
  c.lessons = calibrationRules(c, scope);
  return c;
}

// ---------- checking the calibration rules on pure noise ----------

// A made-up fund whose theses are honest and carry no information, `weeks` long: 2 to 4 orders a week
// on 8 stocks (a fifth of them shorts), each expecting its drift over a week, a month or a quarter
// (about +4%, varying by 2 points), which is what it then drifts. On top: the index's daily moves times
// the stock's beta and the stock's own daily noise, shared by every idea on the same stock and days.
// Conviction, catalyst and staleness are drawn at random. So every calibration lesson is a false one.
// Graded ideas as calibration() gets them, with `due`: the time each horizon's grade is known.
export function calibrationNoiseFund(rand, weeks = 26) {
  const days = weeks * 5 + 70;
  const walk = (sd) => { const out = [0]; for (let d = 1; d <= days; d++) out.push(out[d - 1] + sd * gauss(rand)); return out; };
  const index = walk(0.009);
  const stocks = Array.from({ length: 8 }, (_, i) => ({ symbol: `C${i}`, beta: 0.6 + rand(), own: walk(0.018) }));
  const ideas = [];
  for (let w = 0; w < weeks; w++) {
    for (let j = 2 + Math.floor(rand() * 3); j > 0; j--) {
      const s = stocks[Math.floor(rand() * stocks.length)];
      const day = w * 5 + Math.floor(rand() * 5);
      const direction = rand() < 0.8 ? 1 : -1;
      const horizon = HORIZON_DAYS[Math.floor(rand() * 3)];
      const expected = Math.round((4 + 2 * gauss(rand)) * 10) / 10;
      const grade = (n) => {
        const idx = index[day + n] - index[day];
        const raw = s.beta * idx + s.own[day + n] - s.own[day];
        return { move: expected / 100 * Math.min(1, n / horizon) + direction * raw, index: direction * idx, peer: null };
      };
      const t = NOISE_START + (w * 7 + (day - w * 5)) * DAY_S + 3600;
      ideas.push({
        id: `k${w}:${ideas.length}`, t, symbol: s.symbol, direction, kind: 'entry', outcome: 'traded', ideaType: 'other',
        conviction: ['low', 'medium', 'high'][Math.floor(rand() * 3)], repeats: 1, fee: null, beta: Math.max(0, s.beta + 0.1 * gauss(rand)),
        thesis: { expected, horizon, catalyst: rand() < 0.3 ? 'results' : 'valuation', catalystDate: '', wrongIf: '', stale: rand() < 0.3 },
        week: grade(5), month: grade(21), quarter: grade(63),
        due: { week: t + 7 * DAY_S, month: t + 29 * DAY_S, quarter: t + 89 * DAY_S },
      });
    }
  }
  return ideas;
}

// Runs calibration() weekly over `sims` such funds, as the scheduled job would, and counts the distinct
// calibration lessons each one ever showed: { sims, any, moreThanOne, meanLessons }, like noiseCheck.
export function calibrationNoiseCheck({ sims = 200, seed = 1, weeks = 26 } = {}) {
  const counts = [];
  for (let k = 0; k < sims; k++) {
    const ideas = calibrationNoiseFund(seeded(seed + k * 7919), weeks);
    const fired = new Set();
    for (let w = 4; w <= weeks + 12; w++) {
      const cut = NOISE_START + w * 7 * DAY_S;
      const graded = ideas.filter((i) => i.due.week <= cut).map((i) => ({
        ...i, week: i.week, month: i.due.month <= cut ? i.month : null, quarter: i.due.quarter <= cut ? i.quarter : null,
      }));
      for (const l of calibration(graded)?.lessons ?? []) fired.add(l.id);
    }
    counts.push(fired.size);
  }
  const share = (f) => Math.round(counts.filter(f).length / sims * 1000) / 1000;
  return { sims, any: share((c) => c >= 1), moreThanOne: share((c) => c >= 2), meanLessons: Math.round(mean(counts) * 100) / 100 };
}

// The result of calibrationNoiseCheck() with its defaults, which test/learning.test.mjs re-runs and
// checks: the page prints it next to NOISE_CHECK.
export const CAL_NOISE_CHECK = { sims: 200, any: 0.105, moreThanOne: 0, meanLessons: 0.11 };

// Calibration pooled across every fund in each market (the same AI, so the same habits), by market:
// { US: { funds, ...calibration }, SGX: ... }. `gradedBy`: this run's graded ideas by fund id; a fund
// without them (stopped) counts with its frozen idea log. Ideas repeated across funds count once.
export function poolCalibration(funds, gradedBy = {}) {
  const out = {};
  for (const ccy of [...new Set(funds.map((f) => f.currency))]) {
    const mine = funds.filter((f) => f.currency === ccy);
    const c = calibration(poolIdeas(mine.map((f) => gradedBy[f.id] ?? frozenIdeas(f.ideaLog))), { scope: `the ${mine.length} ${ccy} funds` });
    if (c) out[marketForCurrency(ccy)] = { funds: mine.length, ...c };
  }
  return out;
}

// The calibration lessons for a fund, at most CALIBRATION.maxLessons, most useful first: its own where
// a rule fires on its ideas, else the market's pooled one (with 2+ funds). A fund whose own expected
// moves are formulaic gets that lesson instead of pooled ones judging expected moves.
const CAL_ORDER = ['cal:formulaic', 'cal:overconfident:1', 'cal:overconfident:-1', 'cal:stale', 'cal:fees', 'cal:horizon:5', 'cal:horizon:21', 'cal:horizon:63', 'cal:results', 'cal:conviction'];
export function calibrationLessons(own, pooled = null) {
  const mine = new Map((own?.lessons ?? []).map((l) => [l.id, l]));
  const theirs = new Map(pooled?.funds >= 2 ? (pooled.lessons ?? []).map((l) => [l.id, l]) : []);
  const out = [];
  for (const id of CAL_ORDER) {
    const l = mine.get(id) ?? (own?.formulaic && /^cal:(overconfident|fees)/.test(id) ? null : theirs.get(id));
    if (l) out.push(l);
  }
  return out.slice(0, CALIBRATION.maxLessons);
}

// ---------- the playbook ----------

export const emptyPlaybook = () => ({
  updatedAt: null, graded: 0, stats: null, lessons: [], review: [], reviewedAt: null, reviewGraded: 0, own: [], hidden: [], recent: [],
  watching: [], lessonRecord: {}, edgeFrom: null, calibration: null, calibrationLessons: [],
});

// The record of each rule-made lesson's state, shared by every run: { id: { on, since, p, gated } }
// for the lessons on and the patterns being watched (`gated`: passed the full gate at some point). A
// playbook from before the evidence engine has none, so its lessons count as on, ungated (and the
// switch starts the transition period).
function lessonsOn(pb) {
  if (pb.lessonRecord && Object.keys(pb.lessonRecord).length) return Object.entries(pb.lessonRecord).filter(([, r]) => r.on).map(([id]) => id);
  return (pb.lessons ?? []).map((l) => l.id);
}
const lessonsGated = (pb) => Object.entries(pb.lessonRecord ?? {}).filter(([, r]) => r.on && r.gated).map(([id]) => id);

// Re-grades everything and refreshes the rule-made lessons and the calibration. Keeps the review, the
// owner's lessons and hidden ids. `recent`: the latest graded ideas, for the fund page. `calendar`:
// calendar.js resultsCalendar, for checking results catalysts; `pooled`: the market's pooled
// calibration (poolCalibration, from the last run), for the calibration lessons.
export function updatePlaybook(fund, quotes, now = new Date(), { calendar = null, pooled = null } = {}) {
  const pb = migratePlaybook({ ...emptyPlaybook(), ...(fund.playbook ?? {}) });
  completeQuarters(fund, quotes, fund.currency, now, { calendar });
  const graded = chargeFees(gradeIdeas(collectIdeas(fund), quotes, fund.currency, now, { calendar }), fund, quotes);
  freezeIdeas(fund, graded);
  pb.calibration = calibration(graded);
  pb.calibrationLessons = calibrationLessons(pb.calibration, pooled);
  pb.stats = learningStats(graded);
  pb.graded = graded.length;
  // Merging repeats can lower the count; don't let that hold the weekly review back for weeks.
  if ((pb.reviewGraded ?? 0) > pb.graded) pb.reviewGraded = pb.graded;
  const was = lessonsOn(pb);
  // Lessons shown before the switch to the stock-specific edge keep the old measure for a while.
  if (!pb.edgeFrom) pb.edgeFrom = was.length && !Object.keys(pb.lessonRecord ?? {}).length ? now.toISOString() : '';
  const transition = Boolean(pb.edgeFrom) && now - Date.parse(pb.edgeFrom) < TRANSITION_DAYS * 86400000;
  const { lessons, watching } = evaluateLessons(pb.stats, { was, transition, gated: lessonsGated(pb) });
  const record = {};
  for (const l of lessons) record[l.id] = { on: true, since: pb.lessonRecord?.[l.id]?.on ? pb.lessonRecord[l.id].since : now.toISOString(), p: l.p, ...(l.gated ? { gated: true } : {}) };
  for (const w of watching) record[w.id] = { on: false, since: pb.lessonRecord?.[w.id]?.on === false ? pb.lessonRecord[w.id].since : now.toISOString(), p: w.p };
  pb.lessonRecord = record;
  pb.lessons = lessons;
  pb.watching = watching.slice(0, 10);
  pb.recent = graded.slice(-40).reverse().map((g) => ({
    time: new Date(g.t * 1000).toISOString(), symbol: g.symbol, action: g.action, outcome: g.outcome, ideaType: g.ideaType, reason: g.reason,
    repeats: g.repeats ?? 1, week: g.week, month: g.month, quarter: g.quarter ?? null,
    ...(g.thesis ? { thesis: { expected: g.thesis.expected, horizon: g.thesis.horizon } } : {}),
  }));
  pb.updatedAt = now.toISOString();
  fund.playbook = pb;
  return { pb, graded };
}

// The lessons in force: the owner's first, then the review's, calibration's and the rule-made ones,
// minus hidden ones.
export function activeLessons(pb) {
  if (!pb) return [];
  const hidden = new Set(pb.hidden ?? []);
  return [...(pb.own ?? []), ...(pb.review ?? []), ...(pb.calibrationLessons ?? []), ...(pb.lessons ?? [])].filter((l) => !hidden.has(l.id) && String(l.text ?? '').trim() && l.text !== 'undefined').slice(0, 12);
}

// A rule-made lesson's numbers for the AI (percent a week), named for what they measure, or nothing
// for the owner's and the review's.
const pct1 = (x) => Math.round(x * 1000) / 10;
const MEASURE_KEYS = { edge: 'edge_pct_per_week', index: 'vs_index_pct_per_week', peers: 'vs_peers_pct_per_week', diff: 'high_minus_low_conviction_pct_per_week' };
function lessonNumbers(l) {
  if (!l.confidence) return {};
  return {
    confidence: l.confidence, [MEASURE_KEYS[l.measure] ?? MEASURE_KEYS.edge]: pct1(l.edge), ...(l.measure === 'peers' && l.vs ? { peers: l.vs } : {}),
    ...(l.stockEdge != null ? { edge_pct_per_week: pct1(l.stockEdge) } : {}), likely_range: [pct1(l.lo), pct1(l.hi)], separate_bets: l.bets,
  };
}

// What the AI sees in its decision context, or null when there's nothing to say. Each lesson has its
// id, which the AI cites in an order's lessons_applied.
export function playbookForPrompt(pb, { picksRecord = null, marketLessons = [] } = {}) {
  const lessons = activeLessons(pb);
  const hidden = new Set(pb?.hidden ?? []);
  const market = marketLessons.filter((l) => !hidden.has(l.id)).slice(0, 6);
  if (!lessons.length && !picksRecord && !market.length) return null;
  return {
    graded_ideas: pb?.graded ?? 0,
    lessons: lessons.map((l) => ({ id: l.id, lesson: l.text, ...lessonNumbers(l), evidence: l.evidence ?? null, from: l.source })),
    ...(market.length ? { market_memory: market.map((l) => ({ id: l.id, lesson: l.text, ...lessonNumbers(l), evidence: l.evidence })) } : {}),
    ...(picksRecord ? { home_page_picks_record: picksRecord } : {}),
  };
}

// The wording of the lessons decisions cited (lessons_applied), from what the AI was shown
// (playbookForPrompt), so the page can still name a lesson that has since gone: fund.citedLessons,
// { id: text }, the newest CITED_MAX.
export const CITED_MAX = 60;
export function rememberCited(fund, ids, playbook) {
  const shown = new Map([...(playbook?.lessons ?? []), ...(playbook?.market_memory ?? [])].map((l) => [l.id, l.lesson]));
  const kept = { ...(fund.citedLessons ?? {}) };
  for (const id of ids ?? []) {
    if (!shown.has(id)) continue;
    delete kept[id]; // newest last
    kept[id] = String(shown.get(id)).slice(0, 300);
  }
  const entries = Object.entries(kept);
  if (entries.length) fund.citedLessons = Object.fromEntries(entries.slice(-CITED_MAX));
}

// The owner's edits: { add: text } or { remove: lessonId } (hides a rule/review lesson, deletes an own one).
export function editPlaybook(fund, edit, now = new Date()) {
  const pb = { ...emptyPlaybook(), ...(fund.playbook ?? {}) };
  if (edit.add) {
    const text = String(edit.add).trim().slice(0, 300);
    if (!text) throw new Error('Write the lesson first.');
    pb.own = [...pb.own, { id: `own:${now.getTime().toString(36)}`, text, evidence: 'Added by the owner', source: 'owner', addedAt: now.toISOString() }].slice(-10);
  }
  if (edit.remove) {
    if (pb.own.some((l) => l.id === edit.remove)) pb.own = pb.own.filter((l) => l.id !== edit.remove);
    else pb.hidden = [...new Set([...pb.hidden, edit.remove])];
  }
  if (edit.restore) pb.hidden = pb.hidden.filter((id) => id !== edit.restore);
  fund.playbook = pb;
}

// Whether the weekly review should run: learning on, enough new graded ideas, and a week since the last.
export function reviewDue(fund, now = new Date()) {
  const pb = fund.playbook;
  if (fund.settings?.learning === false || !pb) return false;
  if (pb.graded - (pb.reviewGraded ?? 0) < REVIEW_MIN_NEW) return false;
  return !pb.reviewedAt || now - new Date(pb.reviewedAt) >= REVIEW_EVERY_DAYS * 86400000;
}

// The statistics for the weekly review, compact: each group's week and month summary, and its evidence
// as separate bets, vs the index, from beta, fees and the stock-specific edge with its likely range and
// chance (percent a week). Leaves out the per-stock groups, to keep the review cheap.
export function statsForReview(stats) {
  const p1 = (x) => (x == null ? null : Math.round(x * 1000) / 10);
  const ev = (e) => (e?.edge ? { separate_bets: e.bets, vs_index: p1(e.vsIndex), from_beta: p1(e.fromBeta), fees: p1(e.fees), edge: p1(e.edge.edge), likely: [p1(e.edge.lo), p1(e.edge.hi)], chance: e.edge.p } : null);
  const table = (t) => Object.fromEntries(Object.entries(t ?? {}).map(([k, v]) => [k, { week: v.week, month: v.month, evidence_pct_per_week: ev(v.ev) }]));
  return {
    graded: stats?.graded ?? 0, byOutcome: table(stats?.byOutcome), tradedByType: table(stats?.tradedByType),
    tradedByConviction: table(stats?.tradedByConviction), tradedByDirection: table(stats?.tradedByDirection),
  };
}

// The most telling graded ideas for the review: the biggest wins and misses against the index.
export function reviewExamples(graded, n = 16) {
  return [...graded]
    .sort((a, b) => Math.abs((b.week.move - (b.week.index ?? 0))) - Math.abs((a.week.move - (a.week.index ?? 0))))
    .slice(0, n)
    .map((g) => ({
      symbol: g.symbol, action: g.action, outcome: OUTCOME_LABELS[g.outcome] ?? g.outcome, idea_type: g.ideaType, reason: g.reason,
      week_move: pct(g.week.move), week_vs_index: g.week.index == null ? null : pct(g.week.move - g.week.index),
    }));
}

// A review lesson's id comes from its wording (lower case, letters and digits only), so the same lesson
// written again next week keeps its id, and stays hidden if the owner removed it.
export function reviewLessonId(text) {
  const norm = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < norm.length; i++) h = Math.imul(h ^ norm.charCodeAt(i), 0x01000193) >>> 0;
  return `review:${h.toString(36)}`;
}

// Older playbooks gave review lessons dated ids (review:<date>:<n>): switch the current ones to
// wording ids, carrying over any the owner hid.
export function migratePlaybook(pb) {
  const renamed = new Map();
  // A review lesson that came back without its text (saved as 'undefined') is dropped.
  pb.review = (pb.review ?? []).filter((l) => String(l.text ?? '').trim() && l.text !== 'undefined').map((l) => {
    if (!/^review:\d{4}-\d{2}-\d{2}:\d+$/.test(l.id ?? '')) return l;
    const id = reviewLessonId(l.text);
    renamed.set(l.id, id);
    return { ...l, id };
  });
  if (renamed.size) pb.hidden = [...new Set((pb.hidden ?? []).map((id) => renamed.get(id) ?? id))];
  return pb;
}

export function applyReview(fund, lessons, gradedCount, now = new Date()) {
  const pb = migratePlaybook({ ...emptyPlaybook(), ...(fund.playbook ?? {}) });
  const seen = new Set();
  pb.review = (lessons ?? []).filter((l) => String(l?.text ?? '').trim()).slice(0, 6)
    .map((l) => ({ id: reviewLessonId(l.text), text: String(l.text).slice(0, 300), evidence: String(l.evidence ?? '').slice(0, 300), source: 'weekly review' }))
    .filter((l) => !seen.has(l.id) && seen.add(l.id));
  pb.reviewedAt = now.toISOString();
  pb.reviewGraded = gradedCount;
  fund.playbook = pb;
}

// ---------- skipping quiet decisions ----------

export const QUIET = { stockMove: 0.025, indexMove: 0.01, maxSkips: 2 };

// Keeps the last MAX_DECISIONS real decisions, and only the last `skipped` skipped ones, so quiet runs
// don't push real decisions (and the ideas in them) out of the record.
export function trimDecisions(decisions, skipped = 100) {
  const list = decisions ?? [];
  let real = 0, quiet = 0;
  const keep = new Set();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].skipped ? ++quiet <= skipped : ++real <= MAX_DECISIONS) keep.add(i);
  }
  return list.filter((_, i) => keep.has(i));
}

// What a decision saw, so the next one can tell whether anything changed.
export function decisionSnapshot(fund, quotes, { picksAt = null, newsAt = null } = {}) {
  const index = BENCHMARKS[fund.currency]?.symbol;
  const symbols = [...new Set([...Object.keys(fund.portfolio.positions), index].filter(Boolean))];
  return {
    prices: Object.fromEntries(symbols.filter((s) => quotes[s]?.price).map((s) => [s, quotes[s].price])),
    picksAt, newsAt, events: (fund.events ?? []).length, cash: fund.portfolio.accounts[fund.currency]?.cash ?? null,
  };
}

// A reason to skip this decision (nothing has changed since the last one), or null to decide.
// Never skips more than QUIET.maxSkips in a row, so the fund still reconsiders at least daily or so.
export function quietReason(fund, quotes, marks) {
  if (fund.settings?.skipQuiet === false) return null;
  const last = [...(fund.decisions ?? [])].reverse().find((d) => !d.skipped && d.snapshot);
  if (!last || (fund.skipStreak ?? 0) >= QUIET.maxSkips) return null;
  const now = decisionSnapshot(fund, quotes, marks);
  const was = last.snapshot;
  if (now.picksAt !== was.picksAt || now.newsAt !== was.newsAt || now.events !== was.events || now.cash !== was.cash) return null;
  if (Object.keys(now.prices).join() !== Object.keys(was.prices).join()) return null;
  const index = BENCHMARKS[fund.currency]?.symbol;
  for (const [s, p] of Object.entries(now.prices)) {
    const move = Math.abs(p / was.prices[s] - 1);
    if (move >= (s === index ? QUIET.indexMove : QUIET.stockMove)) return null;
  }
  return 'Skipped to save AI cost: no new news or picks, no fills, and the fund\'s stocks and the index have barely moved since the last decision.';
}
