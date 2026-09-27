// Runs the AI funds (in GitHub Actions, every price update). See funds.js for how several funds are
// kept together, and fund.js for one fund.
// Usage: node scripts/ai-fund.mjs <ai-fund.json path> [picks.json path]
// Environment:
//   FUND_START_AMOUNT       start a new fund with this budget, alongside any running ones
//   FUND_CURRENCY           USD (US stocks) or SGD (SGX stocks), with FUND_START_AMOUNT
//   FUND_DECISIONS_PER_DAY  1, 2 or 4, with FUND_START_AMOUNT
//   FUND_STOP=true          close every position of a fund and stop it (FUND_COMMAND's fund, or the only one running)
//   FUND_COMMAND            JSON from the app (in Actions, the workflow's fund_command input, read from the
//                           event file on the runner rather than the step's environment, which the public
//                           log prints: it can hold the owner's notes and reasons). `fund` names the fund
//                           (an id; "all" for pause/resume). With
//                           FUND_START_AMOUNT: { name, style, focus, settings } for the new fund. Otherwise one of
//                           { settings, name, style, focus }, { approve: [ids] }, { reject: [ids], why? } (why: the
//                           owner's reason, a fund.js DECLINE_REASONS key), { pause: true }, { resume: true },
//                           { remove: true } (a stopped fund), { playbook: { add, filter, claim } | { remove } |
//                           { restore } | { keep } } (the owner's lessons, learning.js editPlaybook) or, with fund
//                           "all", { stockNote: { symbol, text } } (the owner's note on a stock, shared by every
//                           fund, dossier.js setStockNote; empty text clears it). The app sends the last two, and a
//                           reject with a reason, as 'settings', which reach here whole.
//   ANTHROPIC_API_KEY, AI_MODEL (decisions, default Sonnet; a fund can choose its own), AI_NEWS_MODEL (news, default Haiku)
//   AI_REVIEW_MODEL         opt-in: the weekly review's model once the fund's market has 150 graded ideas (else the news model)
//   AI_MONTHLY_CAP_USD      skip AI decisions once the month's scheduled AI spend reaches this (ai-spend.json)
//   FUND_PRIVATE=true       print nothing about the funds' trades (the Actions log is public)
// Learning (learning.js, memory.js): every run re-grades each fund's ideas against what prices did next
// and refreshes its playbook (graded ideas are kept in a compact log, fund.ideaLog, so trimming old
// decisions below doesn't lose them); about weekly, a cheap Haiku review adds written lessons when there's enough
// new evidence; code checks each lesson it writes on the fund's graded ideas before keeping it, and the
// lesson book tracks every lesson on the ideas after it (learning.js). The market memory (price moves
// after past news and after big moves) is rebuilt each run,
// with SEC filings and Yahoo's rating changes taking over from the AI's recollection where they exist,
// and joined by the ten-year memory (memory-long.js, state/memory-long.json, rebuilt weekly by
// scripts/build-history.mjs), whose lessons were checked on held-out years; lessons whose evidence
// covers days like today's regime (the index against its 200-day average, and the VIX) come first.
// Every decision sees the results due in the next 10 trading days and analysts' views (calendar.js,
// analysts.js; state/results-dates.json and state/company-data.json, fetched earlier in the job).
// Every order and idea carries the AI's thesis (thesis.js); after all funds have run, the theses are
// graded for calibration pooled across each market's funds (c.calibration), which the next run's
// lessons use.
// The weekly report (report.js, "What we learned"): after the last session of each fund's market in
// a week, each fund's week is written up from its graded ideas, its lessons' evidence week by week
// (pb.lessonHistory), the owner's calls on the trades they declined, the stock cards' dates and the
// spend ledger, and kept with the fund (fund.reports); scripts/notify.mjs sends it to Telegram. The
// weekly review's summary for the owner goes in it when the review ran that week.
// Stock cards (dossier.js): each stock's own history and risk, built here every run from the prices,
// the ten-year memory, the results calendar and the picks' record. Each market's funds see the same
// cards (at most 6, chosen once per market per run from what any of its funds holds, the home page's
// picks and the news) in their shared market data, with the owner's notes on stocks (c.stockNotes),
// and each position's risk numbers in their own part. Stop-loss changes are logged with the stock's
// daily move then (fund.js setProtections), and every position's worst and best move is followed
// (fund.js fund.tracks); the owner's notes are never printed.
// To save AI cost, a decision is skipped when nothing has changed since the last one, and funds in the
// same market deciding together on the same model share a cached copy of the market data.
// Every run, for every fund: records Tiger fills (scripts/tiger_broker.py sync runs just before), applies
// splits and dividends, checks stop-loss / take-profit / forced-cover levels and the daily loss limit,
// and, when a decision is due, lets Claude decide. Decisions only happen while the fund's market is
// actually trading. With Tiger, orders are queued here and sent by scripts/tiger_broker.py send.

import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decideFund, reviewPlaybook, TIERS } from '../ai.js';
import {
  decisionDue, executeDecision, setProtections, checkProtections, recordValue, stopFund,
  approveProposals, rejectProposals, expireProposals, applyBrokerFills, pauseFund, resumeFund, checkDailyLoss, syncGuards, DECLINE_REASONS,
} from '../fund.js';
import { loadFunds, addFund, updateFund, removeFund, targetFund, otherTigerHoldings, activeFunds } from '../funds.js';
import { applyCorporateActions, describeAction } from '../actions.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import {
  updatePlaybook, playbookForPrompt, editPlaybook, reviewDue, reviewExamples, reviewCells, reviewLessonBook, applyReview, reviewModel, marketIdeas,
  quietReason, decisionSnapshot, trimDecisions, poolCalibration, rememberCited, cleanFilter, REVIEW_MODEL_MIN,
} from '../learning.js';
import { checkedThesis, lessonsAppliedOf } from '../thesis.js';
import { reportWeek, fileReport, comparableFunds } from '../report.js';
import { buildMemory, marketEvents } from '../memory.js';
import { promptMarketLessons, regimeNow } from '../memory-long.js';
import { resultsCalendar } from '../calendar.js';
import { scorePicks, summarizeScores } from '../scorecard.js';
import { buildDossiers, stockCards, heldByMarket, setStockNote } from '../dossier.js';
import { MARKETS, marketForCurrency, isOpen } from '../markets.js';

const [file, picksFile] = process.argv.slice(2);
if (process.env.FUND_PRIVATE === 'true') console.log = () => {};
const newsFile = join(dirname(file), 'news.json');
const spendFile = join(dirname(file), 'ai-spend.json');
const NEWS_MAX_AGE_MS = 4 * 3600 * 1000; // reuse the picks job's digest when it's this fresh
const env = process.env;
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const now = new Date();

const c = loadFunds(await readJson(file));
const prices = await readJson('data/prices.json');
const quotes = prices?.quotes ?? {};
// The app's command: FUND_COMMAND when it's set (a local run, the tests), else the workflow's
// fund_command input from the event file on the runner (GITHUB_EVENT_PATH). Its text is never printed.
function commandText() {
  if (env.FUND_COMMAND != null) return env.FUND_COMMAND;
  try { return String(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).inputs?.fund_command ?? ''); } catch { return ''; }
}
let command = {};
try { const text = commandText().trim(); command = text ? JSON.parse(text) : {}; } catch { console.warn('! Ignoring the app\'s command: it isn\'t JSON.'); }
if (!command || typeof command !== 'object' || Array.isArray(command)) command = {};

// The result of the app's request, which the app watches for.
const note = (action, message, ok = true, fund = null) => {
  c.lastCommand = { time: now.toISOString(), action, message, ok, fund: fund?.id ?? command.fund ?? null };
  console.log(`${ok ? '' : '! '}${action}: ${message}`);
};
const where = (f) => (f.settings.broker === 'tiger' ? `through Tiger (${f.settings.approval === 'manual' ? 'you approve each trade' : 'automatic'})` : 'in the simulator');
// What the owner did to a fund's lessons, in the words the app shows when it's done (never the lesson itself).
const lessonNote = (p, f) => (p.add ? `Added your lesson to "${f.name}"${Object.keys(cleanFilter(p.filter)).length ? '; the ideas it\'s about are tracked from now on' : ''}.`
  : p.keep ? `Kept the lesson in "${f.name}": it won't expire.`
    : p.restore ? `Restored the lesson in "${f.name}".`
      : p.remove ? `Removed the lesson from "${f.name}".` : `Updated the lessons of "${f.name}".`);

// ---------- commands ----------

if (Number(env.FUND_START_AMOUNT) > 0) {
  try {
    const f = addFund(c, {
      name: command.name, style: command.style, focus: command.focus, settings: command.settings ?? {},
      budget: env.FUND_START_AMOUNT, currency: env.FUND_CURRENCY || 'USD', decisionsPerDay: env.FUND_DECISIONS_PER_DAY || 1, now,
    });
    note('start', `Started "${f.name}": ${f.budget} ${f.currency}, ${f.decisionsPerDay} decision(s) a day, trading ${where(f)}.`, true, f);
  } catch (err) {
    note('start', `Couldn't start the fund: ${err.message}`, false);
  }
  command = {};
}

try {
  if (env.FUND_STOP === 'true') {
    const f = targetFund(c, command.fund);
    if (!f.stoppedAt) {
      stopFund(f, quotes, now);
      note('stop', `"${f.name}" is stopped; its positions are being closed.`, true, f);
    }
  }
  // Approvals and rejections name proposals, which belong to exactly one fund. A rejection may carry
  // the owner's reason (`why`), which is kept for grading but never printed or put in the message.
  for (const verb of ['approve', 'reject']) {
    const ids = command[verb];
    if (!ids?.length) continue;
    for (const f of c.funds) {
      const mine = ids.filter((id) => (f.proposals ?? []).some((p) => p.id === id));
      if (!mine.length) continue;
      if (verb === 'reject') {
        const done = rejectProposals(f, mine, now, command.why).length;
        const why = Object.hasOwn(DECLINE_REASONS, command.why ?? '');
        if (!done) note('reject', 'That trade was no longer waiting for you: it had expired or been decided already.', false, f);
        else note('reject', why ? `Declined ${done === 1 ? 'the trade' : `${done} trades`} in "${f.name}", with your reason: it counts in your calls.` : `Rejected ${done} proposal(s).`, true, f);
        continue;
      }
      const out = approveProposals(f, mine, quotes, prices, now, { others: otherTigerHoldings(c, f.id) });
      const sent = out.filter((p) => p.status === 'approved').length;
      note('approve', `${sent} of ${mine.length} approved trade(s) sent to Tiger.${out.filter((p) => p.status !== 'approved').map((p) => ` ${p.symbol}: ${p.message}`).join('')}`, sent === mine.length, f);
    }
  }
  if (command.pause || command.resume) {
    const list = command.fund === 'all' || (!command.fund && activeFunds(c).length > 1) ? activeFunds(c) : [targetFund(c, command.fund)];
    for (const f of list) command.pause ? pauseFund(f, 'Paused by its owner.', now) : resumeFund(f);
    const who = list.length === 1 ? `"${list[0].name}" is` : `All ${list.length} funds are`;
    note(command.pause ? 'pause' : 'resume', command.pause ? `${who} paused; open orders are being cancelled.` : `${who} trading again.`, true, list.length === 1 ? list[0] : null);
  }
  if (command.settings || command.name !== undefined || command.style !== undefined || command.focus !== undefined) {
    const f = targetFund(c, command.fund);
    updateFund(f, { name: command.name, style: command.style, focus: command.focus, settings: command.settings });
    note('settings', `Saved "${f.name}".`, true, f);
  }
  if (command.playbook) {
    const f = targetFund(c, command.fund);
    editPlaybook(f, command.playbook, now);
    note('lessons', lessonNote(command.playbook, f), true, f);
  }
  // The owner's note on a stock, shared by every fund (its words are never printed: the log is public)
  if (command.stockNote) {
    const { symbol, text } = command.stockNote;
    c.stockNotes = setStockNote(c.stockNotes, symbol, text, quotes, now);
    note('notes', c.stockNotes[String(symbol).trim()] ? `Saved your note on ${symbol}: the AI sees it from the next decision.` : `Cleared your note on ${symbol}.`);
  }
  if (command.remove) {
    const f = targetFund(c, command.fund);
    removeFund(c, f.id, now);
    note('remove', `Removed "${f.name}".`, true, f);
  }
} catch (err) {
  const what = Object.keys(command).find((k) => k !== 'fund');
  note({ playbook: 'lessons', stockNote: 'notes' }[what] ?? what ?? (env.FUND_STOP === 'true' ? 'stop' : 'command'), err.message, false);
}

// ---------- what every fund learns from ----------

const spent = async () => readJson(spendFile);
const newsFor = {}; // a digest gathered this run for one market, reused by that market's other funds
const company = await readJson(join(dirname(file), 'company-data.json'));
const filings = await readJson(join(dirname(file), 'results-dates.json'));
const newsEvents = marketEvents((await readJson(join(dirname(file), 'news-events.json'))) ?? [], quotes, { filings, company });
const calendar = resultsCalendar({ company, filings, quotes, events: newsEvents, now });
if (Object.keys(quotes).length) c.marketMemory = Object.fromEntries(Object.keys(MARKETS).map((m) => [m, buildMemory(newsEvents, quotes, m, now, c.marketMemory?.[m])]));
const longMemory = await readJson(join(dirname(file), 'memory-long.json'));
if (longMemory?.updatedAt && now - Date.parse(longMemory.updatedAt) > 30 * 86400000) console.warn(`! The ten-year memory is from ${longMemory.updatedAt.slice(0, 10)}: its weekly update keeps failing.`);
const regimes = Object.fromEntries(Object.keys(MARKETS).map((m) => [m, regimeNow(quotes, prices?.macro, m)]));
const picksHistory = await readJson(join(dirname(file), 'picks-history.json'));
const picksScores = picksHistory ? scorePicks(picksHistory, quotes, now) : [];
const picksSum = picksHistory && summarizeScores(picksScores).week;
const picksRecord = picksSum?.n >= 5 ? `The home page's AI picks, a week after being made: ${picksSum.n} scored, ${Math.round(picksSum.right * 100)}% right${picksSum.beat == null ? '' : `, ${Math.round(picksSum.beat * 100)}% beat the index`}.` : null;
const picks = await readJson(picksFile);
const cachedNews = await readJson(newsFile);
const marks = { picksAt: picks?.createdAt ?? null, newsAt: cachedNews?.createdAt ?? null };

// Every stock's card (dossier.js), in memory: the same as state/dossiers.json, but with this run's prices.
const dossiers = Object.keys(quotes).length ? buildDossiers({ quotes, long: longMemory, calendar, picksScores, now }).stocks : {};
const dailyMoves = Object.fromEntries(Object.entries(dossiers).map(([s, d]) => [s, d.daily_move_pct]));
// The cards each market's funds see, chosen once per market per run: from what its funds hold before any
// of them trades this run, the home page's picks and the news the first of them reads (every fund in a
// market reads the same digest), so the cached market data is the same for all of them.
const heldNow = heldByMarket(c.funds, quotes);
const cardsBy = {};
const cardsFor = (market) => (news) => (cardsBy[market] ??= stockCards(market, { dossiers, quotes, held: heldNow[market] ?? {}, picks, news, now }));

// Funds that will ask Claude this run, by market and model: two or more share a cached copy of the market data.
const modelOf = (f) => f.settings.model || env.AI_MODEL || TIERS.advanced;
const deciding = {};
for (const f of c.funds) {
  if (!f.stoppedAt && decisionDue(f, now, prices) && !quietReason(f, quotes, marks)) deciding[`${f.currency}|${modelOf(f)}`] = (deciding[`${f.currency}|${modelOf(f)}`] ?? 0) + 1;
}

// ---------- every fund ----------

const gradedBy = {}; // this run's graded ideas by fund, for the pooled calibration
for (const fund of c.funds) {
  const log = (text) => console.log(`[${fund.name}] ${text}`);

  // Splits and dividends on what the fund holds (with Tiger, Tiger adjusts the real account itself)
  const actions = applyCorporateActions(fund.portfolio, quotes, now);
  fund.portfolio = actions.portfolio;
  for (const a of actions.applied) {
    fund.events.push({ time: a.time, symbol: a.symbol, action: a.kind, shares: a.qty, price: a.perShare ?? null, why: describeAction(a) });
    log(`Corporate action: ${describeAction(a)}`);
  }

  // Tiger fills that scripts/tiger_broker.py sync just brought back
  for (const e of applyBrokerFills(fund, now)) log(`Tiger fill: ${e.action} ${e.shares} ${e.symbol} at ${e.price}`);
  expireProposals(fund, now);

  if (!fund.stoppedAt) {
    for (const e of checkProtections(fund, quotes, now)) log(`Protection: ${e.action} ${e.shares} ${e.symbol} at ${e.price} (${e.why})`);
    if (Object.keys(quotes).length && checkDailyLoss(fund, quotes, now)) log(`! Daily loss limit hit: ${fund.paused.reason}`);

    // re-grade its ideas (free)
    gradedBy[fund.id] = updatePlaybook(fund, quotes, now, { calendar, pooled: c.calibration?.[marketForCurrency(fund.currency)] }).graded;
    const quiet = decisionDue(fund, now, prices) && quietReason(fund, quotes, marks);
    if (quiet) {
      fund.decisions.push({ time: now.toISOString(), outlook: quiet, orders: [], skipped: true });
      fund.lastDecisionAt = now.toISOString();
      fund.skipStreak = (fund.skipStreak ?? 0) + 1;
      fund.decisions = trimDecisions(fund.decisions);
      log(quiet);
    } else if (decisionDue(fund, now, prices)) {
      if (!Object.keys(quotes).length) {
        log('A decision is due but there are no prices this run; waiting for the next one.');
      } else if (!env.ANTHROPIC_API_KEY) {
        log('A decision is due but ANTHROPIC_API_KEY is not set.');
      } else if (capReached(await spent(), env.AI_MONTHLY_CAP_USD, now)) {
        const message = `This month's AI spend (about US$${monthSpend(await spent(), now)}) reached the US$${env.AI_MONTHLY_CAP_USD} cap, so the AI isn't deciding until next month. Stop-losses still work. Raise the cap with the AI_MONTHLY_CAP_USD repository variable.`;
        if (fund.aiCapped?.message !== message) fund.aiCapped = { time: now.toISOString(), message };
        log(message);
      } else {
        fund.aiCapped = null;
        try {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const news = newsFor[fund.currency] ?? (cachedNews && now - Date.parse(cachedNews.createdAt) < NEWS_MAX_AGE_MS ? cachedNews : undefined);
          const market = marketForCurrency(fund.currency);
          const playbook = fund.settings.learning === false ? null
            : playbookForPrompt(fund.playbook, { picksRecord, marketLessons: promptMarketLessons(c.marketMemory?.[market], longMemory, market, { hidden: fund.playbook?.hidden }), regime: regimes[market] });
          const d = await decideFund({
            client: new Anthropic(), Anthropic, fund, quotes, picks, news, now, playbook, company, calendar, macro: prices?.macro ?? null,
            cards: cardsFor(market), notes: c.stockNotes ?? null, dossiers,
            model: modelOf(fund), newsModel: env.AI_NEWS_MODEL || TIERS.simple,
            cacheShared: (deciding[`${fund.currency}|${modelOf(fund)}`] ?? 0) >= 2,
          });
          if (d.news) newsFor[fund.currency] = d.news;
          await writeFile(spendFile, JSON.stringify(addSpend(await spent(), 'fund', d.usage?.costUsd, now)));
          const orders = executeDecision(fund, d.orders ?? [], quotes, now, { others: otherTigerHoldings(c, fund.id), calendar });
          // ideas it passed on keep their thesis, checked like an order's (a stale catalyst)
          const considered = (d.considered ?? []).slice(0, 3).map((x) => ({
            symbol: x.symbol, stance: x.stance, idea_type: x.idea_type, why_not: x.why_not,
            thesis: checkedThesis(x, x.symbol, { calendar, quotes, now }), ...(lessonsAppliedOf(x).length ? { lessonsApplied: lessonsAppliedOf(x) } : {}),
          }));
          setProtections(fund, d.protections, { now, dailyMoves });
          fund.decisions.push({
            time: now.toISOString(), outlook: d.outlook, orders, considered, protections: d.protections,
            source_urls: d.source_urls, model: d.model, newsModel: d.newsModel, usage: d.usage, learned: Boolean(playbook),
            snapshot: decisionSnapshot(fund, quotes, marks),
          });
          // the wording of the lessons it cited, for the page once they've gone
          rememberCited(fund, [...orders, ...considered].flatMap((x) => x.lessonsApplied ?? []), playbook);
          fund.skipStreak = 0;
          fund.decisions = trimDecisions(fund.decisions);
          fund.lastDecisionAt = now.toISOString();
          fund.lastError = null;
          // the thesis checks are only logged; neither blocks an order
          const flags = (o) => `${o.thesis?.stale ? ' [catalyst over 10 trading days old]' : ''}${o.thesis?.beatsFees === false ? ' [expected move under the round-trip fee]' : ''}`;
          for (const o of orders) log(`Order: ${o.action} ${o.shares} ${o.symbol} -> ${o.status}${o.message ? ` (${o.message})` : ''}${flags(o)}`);
        } catch (err) {
          fund.lastError = { time: now.toISOString(), message: err.message };
          console.warn(`! [${fund.name}] AI decision failed (will retry next run): ${err.message}`);
        }
      }
    }
  }

  // Stop orders held by Tiger, matched to what the fund now holds (Tiger funds only)
  for (const x of syncGuards(fund, quotes, now)) {
    log(x.change === 'place' ? `Tiger stop order: ${x.symbol} ${x.qty} shares at ${x.stopPrice}` : `Tiger stop order for ${x.symbol}: cancelling the old one`);
  }

  // Keep the last 200 proposals, and every one from the last 60 days: an idea's outcome (declined,
  // expired) is read from its proposal until the idea is graded a month later and frozen.
  const proposals = fund.proposals ?? [];
  fund.proposals = proposals.filter((p, i) => i >= proposals.length - 200 || p.status === 'awaiting' || now - Date.parse(p.createdAt) < 60 * 86400000);
  // Keep the last 500 Tiger orders, and always every open one (a stop order can stand for months).
  const orders = fund.brokerOrders ?? [];
  fund.brokerOrders = orders.filter((o, i) => i >= orders.length - 500 || ['queued', 'sent', 'partial'].includes(o.status));
  log(`Value: ${recordValue(fund, quotes, now)} ${fund.currency} (budget ${fund.budget}).`);
}

// Each market's theses graded for calibration across all its funds; the next run's lessons use it.
if (Object.keys(quotes).length) c.calibration = poolCalibration(c.funds, gradedBy);

// ---------- the weekly review (cheap model, only with enough new evidence, after the market closes) ----------
// It reads cells computed from the graded ideas and the lesson book with each lesson's status, and each
// lesson it writes is checked on the fund's graded ideas before it's kept (learning.js applyReview).
// AI_REVIEW_MODEL, if set, takes over from the cheap model once the fund's market has REVIEW_MODEL_MIN
// graded ideas across its funds: before that, sample size, not the model, limits what it can find.

for (const fund of c.funds) {
  if (fund.stoppedAt || !reviewDue(fund, now) || isOpen(marketForCurrency(fund.currency), now) || !env.ANTHROPIC_API_KEY) continue;
  if (capReached(await spent(), env.AI_MONTHLY_CAP_USD, now)) break;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { pb, graded } = updatePlaybook(fund, quotes, now, { calendar, pooled: c.calibration?.[marketForCurrency(fund.currency)] });
    const inMarket = marketIdeas(c.funds, gradedBy, fund.currency).length;
    const model = reviewModel({ optIn: env.AI_REVIEW_MODEL, cheap: env.AI_NEWS_MODEL || TIERS.simple, graded: inMarket });
    if (env.AI_REVIEW_MODEL && model !== env.AI_REVIEW_MODEL) console.log(`[${fund.name}] Weekly review on the cheap model: AI_REVIEW_MODEL takes over once the market has ${REVIEW_MODEL_MIN} graded ideas (${inMarket} so far).`);
    const r = await reviewPlaybook({ client: new Anthropic(), Anthropic, model, fund, cells: reviewCells(graded), examples: reviewExamples(graded), lessons: reviewLessonBook(pb) });
    const out = applyReview(fund, r.lessons, graded, now, { summary: r.summary });
    await writeFile(spendFile, JSON.stringify(addSpend(await spent(), 'learning', r.usage?.costUsd, now)));
    console.log(`[${fund.name}] Weekly review: ${r.lessons.length} lesson(s) written, ${out.added} new and ${out.again} again kept, ${out.dropped} dropped by the check on its graded ideas, about US$${r.usage?.costUsd}.`);
  } catch (err) {
    console.warn(`! [${fund.name}] Weekly review failed (tries again next run): ${err.message}`);
  }
}

// ---------- the weekly report (no AI; after the review, so it has the review's summary) ----------
// On the first run after the last session of each fund's market in a week (report.js reportWeek).

for (const fund of c.funds) {
  const week = reportWeek(fund, now, prices);
  if (!week || !gradedBy[fund.id] || !Object.keys(quotes).length) continue;
  const r = fileReport(fund, { week, graded: gradedBy[fund.id], controlFunds: comparableFunds(c.funds, fund), dossiers, quotes, spend: await spent(), cap: env.AI_MONTHLY_CAP_USD, now });
  console.log(`[${fund.name}] Weekly report for ${r.week}${r.short ? ': one line, too few ideas graded this week' : ''}.`);
}

if (!c.funds.length) console.log('No AI fund. Start one from the app or the Actions tab.');
await writeFile(file, JSON.stringify(c));
