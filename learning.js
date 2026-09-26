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
// An entry idea (buy / short) is graded by the price move in its direction a week (5 trading days) and
// a month (21) later, and against the index over the same days. An exit is graded by what the price
// did next: if the position would have kept gaining, the exit was early.
//
// Lessons come from those grades by fixed rules, each with its evidence, and only from 5 or more cases.
// They form the fund's playbook, which the AI sees at every decision. The owner can hide a lesson or
// add their own. Nothing here changes the fund's hard limits.

import { priceAt, BENCHMARKS } from './benchmark.js';

export const HORIZONS = [{ key: 'week', label: '1 week', days: 5 }, { key: 'month', label: '1 month', days: 21 }];
export const MIN_CASES = 5;
export const REVIEW_EVERY_DAYS = 6;
export const REVIEW_MIN_NEW = 5;
const DAY_CLOSE_S = 7 * 3600;
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

// Every idea in the fund's record, oldest first.
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
      });
    });
    (d.considered ?? []).forEach((c, i) => ideas.push({
      id: `${d.time}#c${i}`, t, symbol: c.symbol, action: c.stance === 'short' ? 'short' : 'buy', direction: c.stance === 'short' ? -1 : 1,
      kind: 'entry', outcome: 'passed', ideaType: c.idea_type ?? 'other', conviction: null, reason: c.why_not ?? '', price: null,
    }));
  }
  for (const e of fund.events ?? []) {
    const why = String(e.why ?? '');
    const m = why.match(/stop-loss|take-profit|forced cover/);
    if (!m || !['sell', 'cover'].includes(e.action) || /^Tiger fill/.test(why)) continue;
    ideas.push({
      id: `e:${e.time}:${e.symbol}`, t: Date.parse(e.time) / 1000, symbol: e.symbol, action: e.action, direction: e.action === 'sell' ? 1 : -1,
      kind: 'exit', outcome: m[0] === 'take-profit' ? 'take-profit' : 'stop-loss', ideaType: 'risk_reduction', conviction: null, reason: why, price: e.price ?? null,
    });
  }
  return ideas.sort((a, b) => a.t - b.t);
}

// ---------- grading ----------

function closeAfter(quote, t, days, nowS) {
  const later = (quote?.daily ?? []).filter(([bt]) => bt > t && bt + DAY_CLOSE_S <= nowS);
  return later[days - 1] ?? null;
}

// { ...idea, week: { move, index } | null, month: ... }: `move` is the price change in the idea's
// direction (for an exit: what the closed position would have made since), `index` the index's
// change in the same direction over the same days.
export function gradeIdeas(ideas, quotes, currency, now = new Date()) {
  const nowS = now.getTime() / 1000;
  const iq = quotes[BENCHMARKS[currency]?.symbol];
  const out = [];
  for (const idea of ideas) {
    const q = quotes[idea.symbol];
    const p0 = idea.price > 0 ? idea.price : priceAt(q, idea.t);
    if (!q || !(p0 > 0)) continue;
    const g = { ...idea, price: p0 };
    for (const h of HORIZONS) {
      const bar = closeAfter(q, idea.t, h.days, nowS);
      if (!bar) { g[h.key] = null; continue; }
      const i0 = priceAt(iq, idea.t), i1 = priceAt(iq, bar[0] + DAY_CLOSE_S);
      g[h.key] = { move: idea.direction * (bar[1] / p0 - 1), index: i0 && i1 ? idea.direction * (i1 / i0 - 1) : null };
    }
    if (g.week) out.push(g);
  }
  return out;
}

// ---------- statistics ----------

// Summary of a group of graded ideas at a horizon: n, average move, hit rate, average vs the index.
export function groupStats(graded, horizon = 'week') {
  const xs = graded.filter((g) => g[horizon]);
  if (!xs.length) return null;
  const avg = (f) => xs.reduce((s, g) => s + f(g), 0) / xs.length;
  const withIndex = xs.filter((g) => g[horizon].index != null);
  return {
    n: xs.length,
    avgMove: avg((g) => g[horizon].move),
    hitRate: xs.filter((g) => g[horizon].move > 0).length / xs.length,
    avgExcess: withIndex.length ? withIndex.reduce((s, g) => s + g[horizon].move - g[horizon].index, 0) / withIndex.length : null,
  };
}

// The tables the fund page shows and the weekly review reads.
export function learningStats(graded) {
  const by = (key, list) => {
    const out = {};
    for (const g of list) (out[g[key] ?? 'unknown'] ??= []).push(g);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { week: groupStats(v, 'week'), month: groupStats(v, 'month') }]));
  };
  const entries = graded.filter((g) => g.kind === 'entry');
  const traded = entries.filter((g) => g.outcome === 'traded');
  return {
    graded: graded.length,
    byOutcome: by('outcome', graded),
    tradedByType: by('ideaType', traded),
    tradedByConviction: by('conviction', traded),
    tradedByDirection: by('direction', traded),
  };
}

// ---------- lessons ----------

const evidence = (st, what) => `${what}: ${st.n} cases, ${share(st.hitRate)} right, average ${pct(st.avgMove)}${st.avgExcess != null ? `, ${pct(st.avgExcess)} vs the index` : ''} after a week`;

// Lessons by fixed rules, each with a stable id (so a hidden one stays hidden) and its evidence.
export function statLessons(stats) {
  const lessons = [];
  const add = (id, text, ev) => lessons.push({ id, text, evidence: ev, source: 'results' });
  const ok = (st) => st && st.n >= MIN_CASES;

  for (const [type, { week: st }] of Object.entries(stats.tradedByType)) {
    if (!ok(st) || st.avgExcess == null) continue;
    const label = IDEA_LABELS[type] ?? type;
    if (st.avgExcess <= -0.01 && st.hitRate < 0.5) add(`type-weak:${type}`, `Trades based on ${label} have lagged the index. Be more selective with them, or skip them.`, evidence(st, `Traded ${label} ideas`));
    if (st.avgExcess >= 0.01 && st.hitRate >= 0.55) add(`type-strong:${type}`, `Trades based on ${label} have beaten the index. Keep favouring them when the setup is clear.`, evidence(st, `Traded ${label} ideas`));
  }
  const dir = stats.tradedByDirection;
  if (ok(dir['-1']?.week) && dir['-1'].week.avgMove < 0 && dir['-1'].week.hitRate < 0.45) {
    add('shorts-weak', 'Your shorts have mostly lost money. Short only with a strong, specific reason.', evidence(dir['-1'].week, 'Shorts'));
  }
  const conv = stats.tradedByConviction;
  if (ok(conv.high?.week) && ok(conv.low?.week) && conv.high.week.avgMove < conv.low.week.avgMove) {
    add('conviction', 'Your high-conviction trades have done no better than your low-conviction ones. Don\'t size up just because conviction feels high.',
      `High conviction: ${conv.high.week.n} cases, average ${pct(conv.high.week.avgMove)}. Low: ${conv.low.week.n} cases, average ${pct(conv.low.week.avgMove)}, after a week`);
  }
  const o = stats.byOutcome;
  const traded = o.traded?.week;
  const beats = (st) => ok(st) && st.avgExcess != null && st.avgExcess >= 0.015 && (!traded || st.avgMove > traded.avgMove);
  if (beats(o.passed?.week)) add('passed-better', 'Ideas you passed on have done better than the index, and better than your trades. You may be too cautious; act on strong ideas instead of only noting them.', evidence(o.passed.week, 'Ideas passed on'));
  if (ok(o.passed?.week) && o.passed.week.avgMove <= -0.01) add('passed-right', 'The ideas you passed on mostly went against you, so your caution has been paying off.', evidence(o.passed.week, 'Ideas passed on'));
  if (beats(o.blocked?.week)) add('blocked-better', 'Orders your limits blocked would have done well. Size orders so they fit within the per-order limit and buying power.', evidence(o.blocked.week, 'Blocked orders'));
  if (ok(o.declined?.week) && o.declined.week.avgMove <= -0.01) add('declined-right', 'Trades your owner declined would mostly have lost money. Expect scrutiny on similar ideas.', evidence(o.declined.week, 'Declined trades'));
  if (beats(o.declined?.week)) add('declined-good', 'Trades your owner declined would have done well. Explain such ideas clearly in the reason.', evidence(o.declined.week, 'Declined trades'));
  if (ok(o.exit?.week) && o.exit.week.avgMove >= 0.02) add('exit-early', 'Stocks you sold kept rising afterwards (shorts you covered kept falling). You may be exiting too early; let winners run with a stop-loss instead.', `Your exits: ${o.exit.week.n} cases, the position would have made ${pct(o.exit.week.avgMove)} more on average in the following week`);
  if (ok(o['stop-loss']?.week) && o['stop-loss'].week.hitRate >= 0.6) add('stops-tight', 'Most stop-losses were followed by a recovery. Your stops may be too tight for how much these stocks move; set them wider, and size positions smaller to match.', `Stop-losses: ${o['stop-loss'].week.n} cases, ${share(o['stop-loss'].week.hitRate)} recovered within a week, average ${pct(o['stop-loss'].week.avgMove)}`);
  if (ok(o['take-profit']?.week) && o['take-profit'].week.avgMove >= 0.02) add('takes-early', 'Stocks kept rising after hitting take-profit. Consider higher take-profit levels.', `Take-profits: ${o['take-profit'].week.n} cases, average ${pct(o['take-profit'].week.avgMove)} more in the following week`);
  return lessons;
}

// ---------- the playbook ----------

export const emptyPlaybook = () => ({ updatedAt: null, graded: 0, stats: null, lessons: [], review: [], reviewedAt: null, reviewGraded: 0, own: [], hidden: [], recent: [] });

// Re-grades everything and refreshes the rule-made lessons. Keeps the review, the owner's lessons and
// hidden ids. `recent`: the latest graded ideas, for the fund page.
export function updatePlaybook(fund, quotes, now = new Date()) {
  const pb = { ...emptyPlaybook(), ...(fund.playbook ?? {}) };
  const graded = gradeIdeas(collectIdeas(fund), quotes, fund.currency, now);
  pb.stats = learningStats(graded);
  pb.graded = graded.length;
  pb.lessons = statLessons(pb.stats);
  pb.recent = graded.slice(-40).reverse().map((g) => ({
    time: new Date(g.t * 1000).toISOString(), symbol: g.symbol, action: g.action, outcome: g.outcome, ideaType: g.ideaType, reason: g.reason,
    week: g.week, month: g.month,
  }));
  pb.updatedAt = now.toISOString();
  fund.playbook = pb;
  return { pb, graded };
}

// The lessons in force: the owner's first, then the review's and the rule-made ones, minus hidden ones.
export function activeLessons(pb) {
  if (!pb) return [];
  const hidden = new Set(pb.hidden ?? []);
  return [...(pb.own ?? []), ...(pb.review ?? []), ...(pb.lessons ?? [])].filter((l) => !hidden.has(l.id)).slice(0, 12);
}

// What the AI sees in its decision context, or null when there's nothing to say.
export function playbookForPrompt(pb, { picksRecord = null, marketLessons = [] } = {}) {
  const lessons = activeLessons(pb);
  const hidden = new Set(pb?.hidden ?? []);
  const market = marketLessons.filter((l) => !hidden.has(l.id)).slice(0, 6);
  if (!lessons.length && !picksRecord && !market.length) return null;
  return {
    graded_ideas: pb?.graded ?? 0,
    lessons: lessons.map((l) => ({ lesson: l.text, evidence: l.evidence ?? null, from: l.source })),
    ...(market.length ? { market_memory: market.map((l) => ({ lesson: l.text, evidence: l.evidence })) } : {}),
    ...(picksRecord ? { home_page_picks_record: picksRecord } : {}),
  };
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

export function applyReview(fund, lessons, gradedCount, now = new Date()) {
  const pb = { ...emptyPlaybook(), ...(fund.playbook ?? {}) };
  const stamp = now.toISOString().slice(0, 10);
  pb.review = (lessons ?? []).slice(0, 6).map((l, i) => ({ id: `review:${stamp}:${i}`, text: String(l.text).slice(0, 300), evidence: String(l.evidence ?? '').slice(0, 300), source: 'weekly review' }));
  pb.reviewedAt = now.toISOString();
  pb.reviewGraded = gradedCount;
  fund.playbook = pb;
}

// ---------- skipping quiet decisions ----------

export const QUIET = { stockMove: 0.025, indexMove: 0.01, maxSkips: 2 };

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
