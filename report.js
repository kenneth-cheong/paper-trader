// The weekly "What we learned" report for each AI fund, on the fund's page ("This week") and in
// Telegram. Pure functions; the only AI in it is the weekly review's three sentences for the owner
// (ai.js owner_summary), which come only in weeks the review runs anyway. It tells the week with counts
// and trends, not verdicts:
//   - the week's result: the fund against its index, and against the fund of the same currency and
//     style with learning switched the other way (the control), when there is one;
//   - the ideas whose week grade came in that week (learning.js grades each idea 5 trading days on),
//     with the best and the worst against the index, in the words of their reasons;
//   - what changed in its lessons since the last report: each lesson's evidence (separate bets, its
//     number per week and the chance of its sign) is kept week by week in pb.lessonHistory, the latest
//     REPORT.historyWeeks weeks, which also draws the page's trend lines; a lesson is new, got stronger
//     or weaker (by the figures the report prints), held steady, went, or held (or didn't) on new data
//     (the lesson book, learning.js);
//   - what the weekly review did, if it ran that week (and why the check dropped what it dropped), and
//     its summary for the owner in the next full report after it, dated when it's from an earlier week
//     and left out once it's over REPORT.summaryDays old;
//   - the owner's calls: how the trades declined for each reason would have done (learning.js
//     declineCalls), in a week when one of them was graded;
//   - coming up: results and ex-dividend dates for what it holds or has waiting for approval, from the
//     stock cards (dossier.js), whose results dates come from the results calendar;
//   - this month's AI cost: its decisions, and learning (the weekly reviews, the news backfill and the
//     searches behind big moves without news, shared by every fund) from the spend ledger (spend.js).
// A week with fewer than REPORT.minGraded ideas graded gets one line saying so. A report is filed on
// the first run after the last session of the fund's market in an ISO week (reportWeek), whether or
// not the weekly review ran; the latest REPORT.keep stay with the fund (fund.reports), so they're
// private when the fund is, and scripts/public-fund.mjs keeps the latest REPORT.publicKeep, without the
// owner's calls (publicReports).

import { MARKETS, marketForCurrency, marketDate, localClock, tradingStatus } from './markets.js';
import { BENCHMARKS, sessionLength, priceAt } from './benchmark.js';
import { isoWeek, confidenceOf } from './stats.js';
import { activeLessons, lessonKind, claimConfidence, DROP_WORDS } from './learning.js';
import { DECLINE_REASONS } from './fund.js';
import { monthKey } from './spend.js';

export const REPORT = {
  minGraded: 5, // ideas graded in the week for a full report (else one line)
  keep: 12, publicKeep: 4, // reports kept with the fund, and in its public copy
  historyWeeks: 12, // weeks of each lesson's evidence kept (pb.lessonHistory)
  afterCloseMin: 30, // Friday's report waits this long after the close, so its closing prices are in
  aheadDays: 30, aheadMax: 4, // "coming up": results and ex-dates this many days ahead, at most this many
  lessonLines: 5, // lesson changes in a report
  summaryDays: 14, // the weekly review's summary for the owner is left out of a report once it's this old
  words: 90, // an idea's reason, or what would prove it wrong, cut to this many characters
};

const DAY_MS = 86400000;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
// A number per week as the report prints it, in % to a tenth, with its sign (pctW).
const shown = (x) => Number((x * 100).toFixed(1));
const countBy = (xs) => xs.reduce((o, x) => ({ ...o, [x]: (o[x] ?? 0) + 1 }), {});
const r5 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 1e5);
const cents = (x) => Math.round((Number(x) || 0) * 100) / 100;
// `s` cut to `n` characters at a word where it can be, with an ellipsis.
function clip(s, n = REPORT.words) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- weeks ----------

const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday ... 6 Saturday
// The ISO week of a market date (YYYY-MM-DD), e.g. '2026-W40'.
export const weekOf = (date) => (date ? isoWeek(Date.parse(`${date}T12:00:00Z`) / 1000) : null);
// The Monday of ISO week `week`.
export function weekStart(week) {
  const [y, w] = String(week).split('-W').map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  return new Date(jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (w - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

// The ISO week whose report `fund` is due now, or null. Week W's report comes on the first run after
// the last session of the fund's market in W: once Friday's close is REPORT.afterCloseMin minutes past,
// on the weekend, or on a Friday its market isn't trading (a holiday, markets.js tradingStatus
// 'no-trading'). A week the job missed is caught up during the next one. Never for a week the fund
// already has, one it didn't trade in (it started after that Friday's close), or a stopped fund.
export function reportWeek(fund, now = new Date(), prices = null) {
  const market = marketForCurrency(fund?.currency);
  if (!market || fund.stoppedAt) return null;
  const today = marketDate(market, now);
  const day = weekday(today);
  const close = MARKETS[market].sessions.at(-1)[1];
  const over = day === 0 || day === 6 || (day === 5 && (localClock(market, now).mins >= close + REPORT.afterCloseMin || tradingStatus(market, prices, now) === 'no-trading'));
  const week = weekOf(over ? today : shift(today, -7));
  if ((fund.reports ?? []).some((r) => r.week === week)) return null;
  const friday = shift(weekStart(week), 4);
  if (fund.startedAt) {
    const start = new Date(fund.startedAt), d = marketDate(market, start);
    if (d > friday || (d === friday && localClock(market, start).mins >= close)) return null;
  }
  return week;
}

// ---------- the week's numbers ----------

// In `list` (oldest first; `timeOf(item)` its time in ms), the index of the last one whose market date
// is on or before `date`, or -1.
function lastOnOrBefore(list, timeOf, market, date) {
  let lo = 0, hi = list.length - 1, out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marketDate(market, new Date(timeOf(list[mid]))) <= date) { out = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return out;
}
// A fund's value at the end of market date `date`: its history's last point that day or before (its
// budget before the first).
function valueOn(fund, market, date) {
  const h = fund.history ?? [];
  const i = lastOnOrBefore(h, (p) => Date.parse(p[0]), market, date);
  return i >= 0 ? h[i][1] : Number(fund.budget) || null;
}
// Its value at an instant (ISO): the last point at or before it, else its budget.
function valueAt(fund, iso) {
  let v = Number(fund.budget) || null;
  for (const [t, x] of fund.history ?? []) { if (t <= iso) v = x; else break; }
  return v;
}
// An index's close at the end of market date `date`.
function closeOn(q, market, date) {
  const bars = q?.daily ?? [];
  const i = lastOnOrBefore(bars, (b) => b[0] * 1000, market, date);
  return i >= 0 ? bars[i][1] : null;
}
const change = (a, b) => (a > 0 && b != null ? r4(b / a - 1) : null);

// The market date an idea's week grade came in: the close of the 5th session after it, as learning.js
// grades a week, or null before then.
export function gradedOn(g, quotes) {
  const q = quotes?.[g.symbol];
  const bars = q?.daily ?? [];
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid][0] > g.t) hi = mid; else lo = mid + 1; }
  const bar = bars[lo + 4];
  return bar ? marketDate(q.market, new Date((bar[0] + sessionLength(q)) * 1000)) : null;
}

// The lessons in force whose evidence has numbers (the rule-made ones and the review's checked ones).
const numbered = (pb) => activeLessons(pb).filter((l) => l.bets != null && l.edge != null && l.p != null);
// A lesson's first sentence, short enough for a line.
export const lessonName = (text) => clip(String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, ''), 70);
// Other funds to compare with: the same currency and style, running, with learning the other way.
export const comparableFunds = (funds, fund) => (funds ?? []).filter((x) => x.id !== fund.id && !x.stoppedAt && x.currency === fund.currency
  && x.style === fund.style && (x.settings?.learning !== false) !== (fund.settings?.learning !== false));

const CHANGE_ORDER = ['didnt-hold', 'held', 'new', 'stronger', 'weaker', 'steady', 'gone'];

// The report for ISO week `week` (see the header). `graded`: this run's graded ideas (learning.js
// updatePlaybook); `pb`: the playbook; `prevSnapshot`: the previous report's snapshot (the lessons'
// names and statuses then), or null for the first; `controlFunds`: comparableFunds; `dossiers`: { symbol:
// card } (dossier.js); `quotes`: prices.json quotes; `spend`: the spend ledger and `cap` its monthly cap.
export function weeklyReport(fund, { week, graded = [], pb = fund.playbook ?? null, prevSnapshot = null, controlFunds = [], dossiers = {}, quotes = {}, spend = null, cap = null, now = new Date() } = {}) {
  const market = marketForCurrency(fund.currency);
  const monday = weekStart(week), sunday = shift(monday, 6);
  const index = BENCHMARKS[fund.currency]?.symbol ?? null;
  const iq = quotes[index];
  const startDate = fund.startedAt ? marketDate(market, new Date(fund.startedAt)) : null;
  const started = startDate && startDate >= monday ? startDate : null;
  // the week's last session: the index's last day that week, else its Friday
  const lastBar = lastOnOrBefore(iq?.daily ?? [], (b) => b[0] * 1000, market, sunday);
  const lastDay = lastBar >= 0 ? marketDate(market, new Date(iq.daily[lastBar][0] * 1000)) : null;
  const to = lastDay && lastDay >= monday ? lastDay : [shift(monday, 4), marketDate(market, now)].sort()[0];
  const end = valueOn(fund, market, sunday);
  const fundPct = change(started ? Number(fund.budget) : valueOn(fund, market, shift(monday, -1)), end);
  const indexPct = change(started ? priceAt(iq, Date.parse(fund.startedAt) / 1000) : closeOn(iq, market, shift(monday, -1)), closeOn(iq, market, sunday));

  const thisWeek = graded.filter((g) => g.week && !g.frozen && weekOf(gradedOn(g, quotes)) === week);
  const short = thisWeek.length < REPORT.minGraded;
  const learning = fund.settings?.learning !== false;
  const book = pb?.lessonBook ?? {};
  const inForce = learning ? activeLessons(pb) : [];
  const tracked = learning ? numbered(pb) : [];
  const snapshot = {
    statuses: Object.fromEntries(inForce.filter((l) => book[l.id]?.filter && book[l.id]?.status).map((l) => [l.id, book[l.id].status])),
    names: Object.fromEntries(tracked.map((l) => [l.id, lessonName(l.text)])),
  };
  const head = {
    week, to, at: now.toISOString(), ...(started ? { started } : {}),
    fund: { pct: fundPct }, index: indexPct == null ? null : { symbol: index, pct: indexPct }, graded: thisWeek.length, short,
  };
  if (short) return { ...head, snapshot };

  // the best and the worst: of its trades if it made any, else of all its entry ideas, against the index after fees
  const vs = (g) => (g.week.index == null ? null : g.week.move - (g.fee ?? 0) - g.week.index);
  const entries = thisWeek.filter((g) => g.kind === 'entry' && vs(g) != null);
  const traded = entries.filter((g) => g.outcome === 'traded');
  const ranked = [...(traded.length ? traded : entries)].sort((a, b) => vs(b) - vs(a) || a.t - b.t);
  const idea = (g) => (g ? {
    symbol: g.symbol, action: g.action, outcome: g.outcome, vsIndex: r4(vs(g)), reason: clip(g.reason), ...(g.thesis?.wrongIf ? { wrongIf: clip(g.thesis.wrongIf) } : {}),
  } : null);

  // what changed in its lessons since the last report (nothing to compare with on the first)
  const history = pb?.lessonHistory ?? {};
  const hidden = new Set(pb?.hidden ?? []);
  const conf = (l, p) => (l.source === 'weekly review' ? claimConfidence(p) : confidenceOf(p));
  const changes = [];
  if (prevSnapshot && learning) {
    const statusChanged = new Set();
    for (const l of inForce) {
      const e = book[l.id];
      if (!e?.filter || !['held', 'didnt-hold'].includes(e.status) || prevSnapshot.statuses?.[l.id] === e.status) continue;
      statusChanged.add(l.id);
      changes.push({ id: l.id, name: lessonName(l.text), change: e.status, since: { bets: e.since?.bets ?? 0, edge: r5(e.since?.edge) } });
    }
    for (const l of tracked) {
      if (statusChanged.has(l.id)) continue;
      const was = (history[l.id] ?? []).filter((p) => p.date < to).at(-1);
      const cur = { bets: l.bets, edge: r5(l.edge), confidence: l.confidence };
      if (!was) { changes.push({ id: l.id, name: lessonName(l.text), change: 'new', to: cur }); continue; }
      // stronger or weaker by the figures the report prints (to a tenth of a point), so it never says
      // one got stronger between two equal numbers; turning to the other side is weaker
      const grew = Math.abs(l.edge) - Math.abs(was.edge);
      const [a, b] = [shown(was.edge), shown(l.edge)];
      const kind = a * b < 0 ? 'weaker' : Math.abs(b) > Math.abs(a) ? 'stronger' : Math.abs(b) < Math.abs(a) ? 'weaker' : 'steady';
      const from = { bets: was.bets, edge: was.edge, confidence: conf(l, was.p) };
      if (kind === 'steady' && from.bets === cur.bets && from.confidence === cur.confidence) continue;
      changes.push({ id: l.id, name: lessonName(l.text), change: kind, from, to: cur, by: Math.abs(grew) });
    }
    const live = new Set(tracked.map((l) => l.id));
    for (const [id, name] of Object.entries(prevSnapshot.names ?? {})) {
      if (live.has(id)) continue;
      const why = hidden.has(id) ? 'removed' : book[id]?.sameAs ? 'same' : book[id]?.ended === 'gave-way' ? 'gave-way' : book[id]?.on === false ? 'faded' : 'went';
      changes.push({ id, name, change: 'gone', why });
    }
    changes.sort((a, b) => CHANGE_ORDER.indexOf(a.change) - CHANGE_ORDER.indexOf(b.change) || (b.by ?? 0) - (a.by ?? 0));
  }

  // the weekly review, if it ran this week (with why the check dropped what it dropped), and its summary
  // for the owner if no full report has shown it and it's under REPORT.summaryDays old, with its date
  const reviewDay = learning && pb?.reviewedAt ? marketDate(market, new Date(pb.reviewedAt)) : null;
  const dropped = Object.values(book).filter((e) => e.dropped && e.droppedAt === pb?.reviewedAt);
  const review = reviewDay && reviewDay >= monday && reviewDay <= sunday ? {
    date: reviewDay, added: (pb.review ?? []).filter((l) => l.bornAt === pb.reviewedAt).length,
    opinions: (pb.review ?? []).filter((l) => l.bornAt === pb.reviewedAt && lessonKind(l) === 'opinion').length,
    // its own lessons written again, and the rule-made or owner's lessons it wrote again (learning.js applyReview)
    again: (pb.review ?? []).filter((l) => l.seenAt === pb.reviewedAt && l.bornAt !== pb.reviewedAt).length
      + Object.values(book).filter((e) => e.source !== 'weekly review' && e.seenAt === pb.reviewedAt).length,
    dropped: dropped.length, ...(dropped.length ? { droppedFor: countBy(dropped.map((e) => e.dropped)) } : {}),
  } : null;
  const lastFull = (fund.reports ?? []).filter((r) => !r.short).at(-1);
  const os = learning ? pb?.ownerSummary : null;
  const summarized = os?.text && (!lastFull || os.at > lastFull.at) && now - Date.parse(os.at) <= REPORT.summaryDays * DAY_MS;
  const summary = summarized ? os.text : null;

  // the owner's calls, for the reasons of the declined trades graded this week (their record so far)
  const reasons = [...new Set(thisWeek.filter((g) => g.outcome === 'declined').map((g) => g.declineWhy ?? 'none'))];
  const calls = reasons.map((why) => {
    const c = pb?.stats?.declinedByReason?.[why];
    return c?.week ? { why, declined: c.ideas, right: c.week.right, of: c.week.n, vsIndex: c.week.vsIndex } : null;
  }).filter(Boolean).sort((a, b) => b.declined - a.declined || Number(a.why === 'none') - Number(b.why === 'none') || a.why.localeCompare(b.why));

  // coming up: results and ex-dates within REPORT.aheadDays for what it holds or has waiting
  const horizon = shift(to, REPORT.aheadDays);
  const soon = (d) => d && d > to && d <= horizon;
  const comingUp = [];
  const symbols = [...new Set([...Object.keys(fund.portfolio?.positions ?? {}), ...(fund.proposals ?? []).filter((p) => p.status === 'awaiting').map((p) => p.symbol)])];
  for (const symbol of symbols.sort()) {
    const d = dossiers?.[symbol];
    const r = d?.results?.next;
    if (r && soon(r.effectiveDate ?? r.date)) comingUp.push({ symbol, kind: 'results', date: r.date, source: r.source, ...(r.effectiveDate ? { effectiveDate: r.effectiveDate } : {}) });
    const x = d?.dividends?.next;
    if (x && soon(x.date)) comingUp.push({ symbol, kind: 'ex', date: x.date, dropPct: d.dividends.yield_pct == null ? null : Math.round(d.dividends.yield_pct * (d.dividends.drop_vs_dividend ?? 1) * 10) / 10 });
  }
  comingUp.sort((a, b) => (a.effectiveDate ?? a.date).localeCompare(b.effectiveDate ?? b.date) || a.symbol.localeCompare(b.symbol));

  // the fund of the same currency and style with learning the other way, this week and since both ran
  const control = controlFunds.filter((x) => x.startedAt && fund.startedAt).map((x) => {
    const xStart = marketDate(market, new Date(x.startedAt));
    const since = [fund.startedAt, x.startedAt].sort().at(-1);
    const xEnd = valueOn(x, market, sunday);
    return {
      name: x.name ?? 'AI fund', learning: x.settings?.learning !== false, pct: change(xStart >= monday ? Number(x.budget) : valueOn(x, market, shift(monday, -1)), xEnd),
      since: marketDate(market, new Date(since)), sincePct: change(valueAt(x, since), xEnd), ownSincePct: change(valueAt(fund, since), end),
    };
  });

  // this month's AI cost: its own decisions, and learning (shared by every fund) from the spend ledger
  const month = monthKey(now);
  const m = spend?.months?.[month] ?? {};
  const cost = {
    month, decisions: cents((fund.decisions ?? []).filter((d) => String(d.time ?? '').startsWith(month)).reduce((s, d) => s + (d.usage?.costUsd ?? 0), 0)),
    learning: cents((m.learning ?? 0) + (m.backfill ?? 0) + (m.articles ?? 0)), total: cents(m.total), cap: Number(cap) > 0 ? Number(cap) : null,
  };

  return {
    ...head, pool: traded.length ? 'trades' : 'ideas', best: idea(ranked[0]), worst: ranked.length > 1 ? idea(ranked.at(-1)) : null,
    lessons: changes.slice(0, REPORT.lessonLines).map(({ by, ...c }) => c), moreLessons: Math.max(0, changes.length - REPORT.lessonLines),
    ...(learning && !prevSnapshot ? { first: true } : {}), review, summary, ...(summary ? { summaryAt: marketDate(market, new Date(os.at)) } : {}),
    calls, comingUp: comingUp.slice(0, REPORT.aheadMax), control, cost, snapshot,
  };
}

// pb.lessonHistory after this week's report (dated `date`, the week's last session): each lesson in
// force with numbers gets this week's point { date, bets, edge, p } (replacing one from the same week);
// points older than REPORT.historyWeeks weeks go, and so does a lesson with none left.
export function lessonHistoryAfter(pb, date) {
  const week = weekOf(date), oldest = shift(date, -7 * REPORT.historyWeeks);
  const out = {};
  for (const [id, pts] of Object.entries(pb?.lessonHistory ?? {})) {
    const kept = (Array.isArray(pts) ? pts : []).filter((p) => p?.date > oldest && weekOf(p.date) !== week);
    if (kept.length) out[id] = kept;
  }
  for (const l of numbered(pb)) (out[l.id] ??= []).push({ date, bets: l.bets, edge: r5(l.edge), p: Math.round(l.p * 1000) / 1000 });
  for (const id of Object.keys(out)) out[id] = out[id].sort((a, b) => a.date.localeCompare(b.date)).slice(-REPORT.historyWeeks);
  return out;
}

// Files week `week`'s report (weeklyReport, with the previous one's snapshot): adds it to fund.reports
// (the latest REPORT.keep; only the latest keeps its snapshot) and, for a fund that learns, this week's
// point to pb.lessonHistory. Returns the report.
export function fileReport(fund, { week, graded = [], controlFunds = [], dossiers = {}, quotes = {}, spend = null, cap = null, now = new Date() } = {}) {
  const reports = fund.reports ?? [];
  const pb = fund.playbook ?? null;
  const report = weeklyReport(fund, { week, graded, pb, prevSnapshot: reports.at(-1)?.snapshot ?? null, controlFunds, dossiers, quotes, spend, cap, now });
  if (pb && fund.settings?.learning !== false) pb.lessonHistory = lessonHistoryAfter(pb, report.to);
  fund.reports = [...reports.filter((r) => r.week !== week).map(({ snapshot, ...r }) => r), report].slice(-REPORT.keep);
  return report;
}

// The reports in the fund's public copy (scripts/public-fund.mjs): the latest REPORT.publicKeep,
// without the owner's calls on the trades they declined.
export const publicReports = (reports) => (Array.isArray(reports) ? reports : []).slice(-REPORT.publicKeep).map(({ calls, snapshot, ...r }) => r);

// ---------- in words (the page and Telegram) ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "2 Oct"
export const dayWords = (date) => `${Number(String(date).slice(8, 10))} ${MONTHS[Number(String(date).slice(5, 7)) - 1]}`;
// "+1.2%", "−0.4%", "0.0%": the sign only when the rounded figure has one
const pctW = (x) => {
  if (x == null || !Number.isFinite(x)) return '–';
  const s = Math.abs(x * 100).toFixed(1);
  return s === '0.0' ? '0.0%' : `${x > 0 ? '+' : '−'}${s}%`;
};
const usd = (x) => `US$${(Number(x) || 0).toFixed(2)}`;
const indexName = (symbol) => String(symbol ?? '').replace(/\.SI$/, '');
const DONE = { buy: 'bought', short: 'shorted', sell: 'sold', cover: 'covered' };
const DOING = { buy: 'buying', short: 'shorting', sell: 'selling', cover: 'covering' };
const GONE = { removed: 'you removed it', same: 'a lesson on the same ideas and claim took its place', 'gave-way': 'it made room for newer lessons', faded: 'its evidence faded', went: 'it went' };

function ideaWords(x, idx) {
  const doing = `${DOING[x.action] ?? x.action} ${x.symbol}`;
  const what = {
    traded: `${DONE[x.action] ?? x.action} ${x.symbol}`, passed: `passed on ${doing}`, declined: `you declined ${doing}`,
    expired: `the proposal to ${x.action} ${x.symbol} expired`, blocked: `its limits blocked ${doing}`,
  }[x.outcome] ?? doing;
  return `${what}${x.reason ? ` ("${x.reason}")` : ''}, ${pctW(x.vsIndex)} against ${idx} a week later, after fees${x.wrongIf ? ` (it said: wrong if ${x.wrongIf})` : ''}`;
}

function lessonWords(c) {
  const bets = (n) => plural(n, 'separate bet');
  if (c.change === 'new') return `New lesson: "${c.name}" (${bets(c.to.bets)}, ${pctW(c.to.edge)} a week, ${c.to.confidence} confidence).`;
  if (c.change === 'held') return `"${c.name}" held on new data: ${bets(c.since.bets)} since it was learned, ${pctW(c.since.edge)} a week.`;
  if (c.change === 'didnt-hold') return `"${c.name}" didn't hold on new data: ${bets(c.since.bets)} since it was learned, ${pctW(c.since.edge)} a week. You can remove it on the page.`;
  if (c.change === 'gone') return `"${c.name}" is no longer in force: ${GONE[c.why] ?? GONE.went}.`;
  const verb = { stronger: 'got stronger', weaker: 'got weaker', steady: 'held steady' }[c.change];
  const level = c.from.confidence === c.to.confidence ? `still ${c.to.confidence}` : `now ${c.to.confidence}`;
  return `"${c.name}" ${verb}: ${c.from.bets} → ${c.to.bets} separate bets, ${pctW(c.from.edge)} → ${pctW(c.to.edge)} a week (${level}).`;
}

// Why the check dropped the review's proposals ({ reason: count }, learning.js DROP_WORDS), in brackets
// (the page's track record says it the same way).
export function droppedWords(by) {
  const reasons = Object.entries(by ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!reasons.length) return '';
  return ` (${reasons.length === 1 ? DROP_WORDS[reasons[0][0]] ?? reasons[0][0] : reasons.map(([k, n]) => `${n}: ${DROP_WORDS[k] ?? k}`).join('; ')})`;
}

function comingWords(x) {
  if (x.kind === 'ex') return `${x.symbol} goes ex-dividend around ${dayWords(x.date)} (an estimate${x.dropPct ? `; the price usually drops about ${x.dropPct.toFixed(1)}% that day` : ''})`;
  if (x.source === 'filing') return `${x.symbol}'s results are out (the market trades on them from ${dayWords(x.effectiveDate ?? x.date)})`;
  return `${x.symbol} reports results ${x.source === 'estimated' ? `around ${dayWords(x.date)} (an estimate)` : `on ${dayWords(x.date)}`}`;
}

// A report as plain sentences, each { kind, text } (a lesson's also has its `id`), for the page and
// Telegram: the week's result first, then (for a full report) what was graded, what changed in its
// lessons, the review's summary, the owner's calls, the control fund, what's coming up and the cost.
export function reportLines(r) {
  const idx = r.index ? indexName(r.index.symbol) : 'the index';
  const head = `Week to ${dayWords(r.to)}${r.started ? ` (it started on ${dayWords(r.started)})` : ''}: fund ${pctW(r.fund?.pct)}${r.index ? `, ${idx} ${pctW(r.index.pct)}` : ''}.`;
  if (r.short) {
    const why = r.graded ? `Only ${plural(r.graded, 'idea')} graded this week` : 'No ideas graded this week';
    return [{ kind: 'head', text: `${head} ${why}: too few for a report (it takes ${REPORT.minGraded}).${r.started ? ' Ideas are graded 5 trading days after they\'re made.' : ''}` }];
  }
  const out = [{ kind: 'head', text: head }];
  const add = (kind, text, extra = {}) => { if (text) out.push({ kind, text, ...extra }); };
  // the best and worst of its trades, or of its other ideas when none of them was a trade
  const trades = r.pool !== 'ideas', what = trades ? 'trade' : 'idea';
  const best = r.best ? ` ${r.worst ? `Best ${what}` : trades ? 'Its only trade' : 'The only new idea'}: ${ideaWords(r.best, idx)}.` : '';
  add('graded', `${plural(r.graded, 'idea')} graded this week${trades || !r.best ? '' : ', none of them a trade'}.${best}${r.worst ? ` Worst ${what}: ${ideaWords(r.worst, idx)}.` : ''}`);
  for (const c of r.lessons ?? []) add('lesson', lessonWords(c), { id: c.id, change: c.change });
  if (r.moreLessons) add('lesson', `…and ${plural(r.moreLessons, 'more change')} to its lessons: see What it has learned.`);
  if (r.first) add('lesson', 'From next week, this report says how each lesson\'s evidence changed since the week before.');
  const rv = r.review;
  if (rv) {
    const parts = [
      rv.added ? `added ${plural(rv.added, 'lesson')}${rv.opinions ? ` (${rv.opinions === rv.added ? (rv.added === 1 ? 'an opinion' : 'all opinions') : rv.opinions === 1 ? 'one of them an opinion' : `${rv.opinions} of them opinions`}, not checked)` : ''}` : '',
      rv.again ? `wrote ${plural(rv.again, 'lesson')} in force again` : '',
      rv.dropped ? `proposed ${plural(rv.dropped, 'lesson')} that the check dropped${droppedWords(rv.droppedFor)}` : '',
    ].filter(Boolean);
    add('review', `The weekly review (${dayWords(rv.date)}) ${parts.length ? `${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts.at(-1)}` : 'wrote nothing new'}.`);
  }
  // the review's own words: from this week's review, or dated when it ran in an earlier week
  if (r.summary) add('summary', r.summaryAt && r.summaryAt < weekStart(r.week) ? `In the words of the weekly review of ${dayWords(r.summaryAt)}: ${r.summary}` : `In the weekly review's words: ${r.summary}`);
  for (const c of r.calls ?? []) {
    const what = c.why === 'none' ? 'When you declined without giving a reason' : `When you declined for "${DECLINE_REASONS[c.why] ?? c.why}"`;
    const one = c.of === 1;
    add('calls', `${what}, you were right ${c.right} ${c.right === 1 ? 'time' : 'times'} out of ${c.of} (${one ? 'the trade' : 'those trades'} would have lost money a week later, after fees)${c.vsIndex == null ? '' : `; ${one ? 'it' : 'on average they'} would have made ${pctW(c.vsIndex)} against ${idx}`}.`);
  }
  for (const x of r.control ?? []) {
    add('control', `${x.learning ? 'With' : 'Without'} learning, "${x.name}" (the same style and currency): ${pctW(x.pct)} this week; since both were running (from ${dayWords(x.since)}), this fund ${pctW(x.ownSincePct)} and "${x.name}" ${pctW(x.sincePct)}.`);
  }
  if (r.comingUp?.length) add('coming', `Coming up: ${r.comingUp.map(comingWords).join('; ')}.`);
  const c = r.cost;
  if (c) {
    const month = MONTH_NAMES[Number(c.month.slice(5, 7)) - 1];
    add('cost', `AI cost in ${month} so far: its decisions ${usd(c.decisions)}; learning ${usd(c.learning)} (the weekly reviews and news look-ups, shared by every fund)${c.total ? `; all scheduled AI ${usd(c.total)}${c.cap ? ` of the US$${c.cap} cap` : ''}` : ''}.`);
  }
  return out;
}

// "Week to 2 Oct", for the page's week picker.
export const reportLabel = (r) => `Week to ${dayWords(r.to)}`;
