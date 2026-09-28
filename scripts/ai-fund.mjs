// Runs the AI funds (in GitHub Actions, every price update). See funds.js for how several funds are
// kept together, and fund.js for one fund.
// Usage: node scripts/ai-fund.mjs <ai-fund.json path> [picks.json path]
// Environment:
//   FUND_START_AMOUNT       start a new fund with this budget, alongside any running ones
//   FUND_CURRENCY           USD (US stocks) or SGD (SGX stocks), with FUND_START_AMOUNT
//   FUND_DECISIONS_PER_DAY  1, 2 or 4, with FUND_START_AMOUNT (the app can send 8, 16 or 0, every run, as the command's decisionsPerDay)
//   FUND_STOP=true          close every position of a fund and stop it (FUND_COMMAND's fund, or the only one running)
//   FUND_COMMAND            JSON from the app (in Actions, the workflow's fund_command input, read from the
//                           event file on the runner rather than the step's environment, which the public
//                           log prints: it can hold the owner's notes and reasons). `fund` names the fund
//                           (an id; "all" for pause/resume). With
//                           FUND_START_AMOUNT: { name, style, focus, settings } for the new fund. Otherwise one of
//                           { settings, name, style, focus, decisionsPerDay }, { approve: [ids] }, { reject: [ids], why? } (why: the
//                           owner's reason, a fund.js DECLINE_REASONS key), { pause: true }, { resume: true },
//                           { remove: true } (a stopped fund), { playbook: { add, filter, claim } | { remove } |
//                           { restore } | { keep } } (the owner's lessons, learning.js editPlaybook) or, with fund
//                           "all", { stockNote: { symbol, text } } (the owner's note on a stock, shared by every
//                           fund, dossier.js setStockNote; empty text clears it), { reading: { url?, text? } }
//                           (an article the owner logged, below), { ask: text } (the owner's question, Ask the
//                           data, below) or { strategist: { focus, risk, question, context } } (the AI strategist
//                           for an admin with no key in the browser, below). The app sends the last five, and a
//                           reject with a reason, as 'settings', which reach here whole.
//   READING_PAGE_DIR        where scripts/page_fetch.py downloaded a logged article's page (default raw-page)
//   OHLCV_FILE              the two years of daily prices for the factor lab (default data/ohlcv.json)
//   ANTHROPIC_API_KEY, AI_MODEL (decisions, default Sonnet; a fund can choose its own), AI_NEWS_MODEL (news, default Haiku)
//   DEEPSEEK_API_KEY        for a fund whose model is DeepSeek (its decisions only; its news still comes from Claude)
//   NEWS_DIGEST_MODEL       opt-in: deepseek-flash makes a digest this step gathers DeepSeek's, from the feeds' headlines
//   AI_REVIEW_MODEL         opt-in: the weekly review's model once the fund's market has 150 graded ideas (else the news model)
//   AI_MONTHLY_CAP_USD      skip AI decisions once the month's scheduled AI spend reaches this (ai-spend.json)
//   NEWS_LEADS=off          a digest a fund gathers itself gets no news feed headlines as leads (on otherwise)
//   FUND_PRIVATE=true       print nothing about the funds' trades (the Actions log is public)
// Learning (learning.js, memory.js): every run re-grades each fund's ideas against what prices did next
// and refreshes its playbook (graded ideas are kept in a compact log, fund.ideaLog, so trimming old
// decisions below doesn't lose them); about weekly, a cheap Haiku review adds written lessons when there's enough
// new evidence; code checks each lesson it writes on the fund's graded ideas before keeping it, and the
// lesson book tracks every lesson on the ideas after it (learning.js). The market memory (price moves
// after past news and after big moves) is rebuilt each run,
// with SEC filings and Yahoo's rating changes taking over from the AI's recollection where they exist,
// one event per stock, trading day and tone, and the study of big moves with and without news
// (state/move-news.json, from scripts/fetch-articles.mjs moves); and joined by the ten-year memory
// (memory-long.js, state/memory-long.json, rebuilt weekly by
// scripts/build-history.mjs), whose lessons were checked on held-out years; lessons whose evidence
// covers days like today's regime (the index against its 200-day average, and the VIX) come first.
// Every decision sees the results due in the next 10 trading days and analysts' views (calendar.js,
// analysts.js; state/results-dates.json and state/company-data.json, fetched earlier in the job).
// Your reading (reading.js): an article the owner logs in the app arrives as { reading: { url?, text? } }.
// Its page, downloaded to the runner just before this step (scripts/page_fetch.py), or the text the
// owner pasted is read by the same call as the reading guide's (ai.js readCalls, counted as 'reading' in
// the spend ledger), and its calls are kept with the funds (c.reading), priced now, to be graded a month
// on like the reading guide's. If the page couldn't be read, the app's message asks for its text. The
// article's link, title and text are never printed, and no AI prompt ever sees the owner's reading.
// Ask the data (hypotheses.js): the owner's question arrives as { ask: text }. One cheap call (ai.js
// askSpec, counted as 'ask' in the spend ledger) turns it into a query that code checks against a
// whitelist, or says why the data can't answer it, and it's kept with the funds (c.questions, the newest
// 30) to be answered: one on the funds' own ideas at the end of this step, one on the ten years of prices
// by scripts/build-history.mjs answer, in a later step of this job (within a day). The question's words
// are never printed, the app's message only says how it went, and no AI prompt of the funds sees them.
// The AI strategist, for an admin with no Anthropic key in the browser: the app sends its own part of the
// strategist's data (ai.js strategistRequest: the owner's fees, accounts, holdings, rules and last trades),
// this step adds the stocks from this run's prices and the picks job's news digest when it's fresh, and
// runs the same analysis as the browser (ai.js analyze), counted as 'strategist' in the spend ledger. The
// answer is kept with the funds (c.strategist, the latest one only), so the page shows it only from their
// private copy; the owner's trades and question are never printed.
// Every order and idea carries the AI's thesis (thesis.js); after all funds have run, the theses are
// graded for calibration pooled across each market's funds (c.calibration), which the next run's
// lessons use.
// The factor lab (factors.js): every opening order and idea passed on keeps its stock's factors at that
// moment, measured from bars closed before it (data/ohlcv.json: two years of daily prices, written by
// scripts/fetch-prices.mjs this run and never saved; prices.json's year without it), and ideas from
// before that get theirs from the same prices. After all funds have run, each market's funds' ideas are
// pooled (c.factorLab: the page's "When its ideas work", and at most three lessons on splits fixed in
// advance, which the next run's playbooks take); each fund's revealed style goes in its playbook. A
// lesson from it reaches the AI only while its condition holds today.
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
import { decideFund, reviewPlaybook, readCalls, askSpec, analyze, strategistJobContext, digestFrom, TIERS } from '../ai.js';
import {
  decisionDue, executeDecision, setProtections, checkProtections, recordValue, stopFund,
  approveProposals, rejectProposals, expireProposals, applyBrokerFills, pauseFund, resumeFund, checkDailyLoss, syncGuards, DECLINE_REASONS,
} from '../fund.js';
import { loadFunds, addFund, updateFund, removeFund, targetFund, otherTigerHoldings, activeFunds } from '../funds.js';
import { applyCorporateActions, describeAction } from '../actions.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import {
  updatePlaybook, playbookForPrompt, editPlaybook, reviewDue, reviewExamples, reviewCells, reviewLessonBook, applyReview, reviewModel, marketIdeas,
  quietReason, decisionSnapshot, trimDecisions, poolCalibration, rememberCited, cleanFilter, frozenIdeas, REVIEW_MODEL_MIN,
} from '../learning.js';
import { checkedThesis, lessonsAppliedOf } from '../thesis.js';
import { reportWeek, fileReport, comparableFunds } from '../report.js';
import { buildMemory, marketEvents } from '../memory.js';
import { promptMarketLessons, regimeNow } from '../memory-long.js';
import { resultsCalendar, upcomingResults } from '../calendar.js';
import { factorInputs, factorsAt, factorLab, conditionsNow, LAB } from '../factors.js';
import { scorePicks, summarizeScores } from '../scorecard.js';
import { buildDossiers, stockCards, heldByMarket, setStockNote } from '../dossier.js';
import { MARKETS, marketForCurrency, isOpen } from '../markets.js';
import { recentMonths, digestQuality, addQuality, makeTagger, siteOf } from '../articles.js';
import { pageFacts, readable, ownText, publicUrl, pickOf, addOwn, ownId, loggedLately, READING } from '../reading.js';
import { questionFrom, addQuestion, answerWaitingIdeas, ASK } from '../hypotheses.js';

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
const often = (f) => (f.decisionsPerDay ? `${f.decisionsPerDay} decision(s) a day` : 'deciding at every run');
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
      budget: env.FUND_START_AMOUNT, currency: env.FUND_CURRENCY || 'USD', decisionsPerDay: command.decisionsPerDay ?? (env.FUND_DECISIONS_PER_DAY || 1), now,
    });
    note('start', `Started "${f.name}": ${f.budget} ${f.currency}, ${often(f)}, trading ${where(f)}.`, true, f);
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
  if (command.settings || command.name !== undefined || command.style !== undefined || command.focus !== undefined || command.decisionsPerDay !== undefined) {
    const f = targetFund(c, command.fund);
    updateFund(f, { name: command.name, style: command.style, focus: command.focus, settings: command.settings, decisionsPerDay: command.decisionsPerDay });
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

// An article the owner logged (reading.js): read, and its calls kept with the funds. The messages say
// only how it went: never the article's link, site, title, text or calls (the log is public, and so is
// the funds' copy unless they're kept private).
async function logArticle(r) {
  const pasted = typeof r?.text === 'string' ? r.text.slice(0, READING.pasteMax).trim() : '';
  const url = r?.url ? publicUrl(r.url) : null;
  if (r?.url && !url) return note('reading', 'That link isn\'t to a public web page. Check it, or paste the article\'s text instead.', false);
  if (!url && !pasted) return note('reading', 'Give a link to the article, or paste its text.', false);
  let facts = null;
  if (url) {
    const dir = env.READING_PAGE_DIR || 'raw-page';
    const fetched = await readJson(join(dir, 'page.json'));
    const html = fetched?.status === 200 ? await readFile(join(dir, 'page.html'), 'utf8').catch(() => '') : '';
    facts = html ? pageFacts(html) : null;
    if (!readable(facts) && !pasted) return note('reading', 'Couldn\'t read enough of that page: it may be behind a paywall, or block automated readers. Paste the article\'s text into the box and log it again.', false);
    if (facts?.blocked) facts = null;
  }
  const article = ownText({ facts, pasted });
  const tag = makeTagger(JSON.parse(await readFile(new URL('../symbols.json', import.meta.url), 'utf8')));
  const symbols = tag(`${article.title} ${article.text}`);
  const id = ownId(url, pasted);
  if (!symbols.length) return note('reading', 'That article doesn\'t name a stock on the watchlist, so there\'s nothing to grade: it wasn\'t logged.', false);
  if (loggedLately(c.reading, id, now)) return note('reading', 'You logged that article in the last week, so it wasn\'t added again.', true);
  if (!env.ANTHROPIC_API_KEY) return note('reading', 'ANTHROPIC_API_KEY isn\'t set, so the article couldn\'t be read.', false);
  if (capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) return note('reading', 'This month\'s AI spend has reached the cap, so the article can\'t be read until next month.', false);
  if (!Object.keys(quotes).length) return note('reading', 'There are no prices this run to grade the article from; log it again in a few minutes.', false);
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const names = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.name]));
    const item = { n: 1, source: url ? siteOf(url) : 'pasted text', symbols, text: article.text };
    const res = await readCalls({ client: new Anthropic(), Anthropic, model: env.AI_NEWS_MODEL || TIERS.simple, items: [item], names });
    await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'reading', res.usage?.costUsd, now)));
    const picks = res.calls.map((x) => pickOf(x, quotes[x.symbol], now.getTime() / 1000)).filter(Boolean);
    if (!picks.length) return note('reading', 'That article makes no buy, sell or hold call on a watchlist stock, so there\'s nothing to grade: it wasn\'t logged.', true);
    const entry = {
      id, createdAt: now.toISOString(), site: url ? siteOf(url) : '', title: article.title, ...(url ? { url: url.slice(0, 300) } : {}),
      ...(article.published ? { published: article.published } : {}), picks,
    };
    c.reading = addOwn(c.reading, entry, now).list;
    note('reading', `Logged your article: ${picks.length === 1 ? 'one call' : `${picks.length} calls`}, graded a month from now under Your reading.`, true);
  } catch (err) {
    // what the API billed before it failed still counts (ai.js askClaude)
    if (err?.usage?.costUsd) await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'reading', err.usage.costUsd, now)));
    console.warn(`! Your reading: the article couldn't be read this time (${err?.name ?? 'error'}).`);
    note('reading', 'The AI couldn\'t read the article this time. Try again later.', false);
  }
}
if (command.reading) await logArticle(command.reading);

// The owner's question (hypotheses.js): turned into a query and kept with the funds, waiting for its
// answer. The messages never hold its words, nor the reason the data can't answer it (that's shown on the
// page, from the funds' copy).
async function askQuestion(raw) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, ASK.maxChars) : '';
  if (!text) return note('ask', 'Type a question first.', false);
  if (!env.ANTHROPIC_API_KEY) return note('ask', 'ANTHROPIC_API_KEY isn\'t set, so the question couldn\'t be read.', false);
  if (capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) return note('ask', 'This month\'s AI spend has reached the cap, so the question can\'t be read until next month.', false);
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const symbols = JSON.parse(await readFile(new URL('../symbols.json', import.meta.url), 'utf8'));
    const res = await askSpec({ client: new Anthropic(), Anthropic, model: env.AI_NEWS_MODEL || TIERS.simple, question: text, symbols });
    await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'ask', res.usage?.costUsd, now)));
    const q = questionFrom(text, res.input, symbols, now);
    c.questions = addQuestion(c.questions, q);
    if (q.status === 'cant-answer') return note('ask', 'Read your question: this data can\'t answer it. The reason is under Ask the data.', true);
    note('ask', q.spec.population === 'fund_ideas' ? 'Read your question: it\'s answered from the funds\' own ideas in this run.' : 'Read your question: it\'s answered from the ten years of prices within a day, usually in this run.', true);
  } catch (err) {
    // what the API billed before it failed still counts (ai.js askClaude)
    if (err?.usage?.costUsd) await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'ask', err.usage.costUsd, now)));
    console.warn(`! Ask the data: the question couldn't be read this time (${err?.name ?? 'error'}).`);
    note('ask', 'The AI couldn\'t read the question this time. Try again later.', false);
  }
}
if (command.ask !== undefined) await askQuestion(command.ask);

// The AI strategist (see the top of this file). What the browser would have spent goes in the ledger instead.
const STRATEGIST_MAX_CHARS = 40000;
async function runStrategist(sent) {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return note('strategist', 'The strategist request was empty.', false);
  if (JSON.stringify(sent).length > STRATEGIST_MAX_CHARS) return note('strategist', 'The strategist request was too large.', false);
  if (!env.ANTHROPIC_API_KEY) return note('strategist', 'ANTHROPIC_API_KEY isn\'t set, so the strategist couldn\'t run.', false);
  if (capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) return note('strategist', 'This month\'s AI spend has reached the cap, so the strategist can\'t run until next month.', false);
  if (!Object.keys(quotes).length) return note('strategist', 'There are no prices this run; try again in a few minutes.', false);
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const context = strategistJobContext({ sent, prices, now });
    const digest = await readJson(newsFile);
    const news = digest && now - Date.parse(digest.createdAt) < NEWS_MAX_AGE_MS ? digest : undefined;
    const res = await analyze({ client: new Anthropic(), Anthropic, model: env.AI_MODEL || TIERS.advanced, newsModel: env.AI_NEWS_MODEL || TIERS.simple, context, quotes, news });
    await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'strategist', res.usage?.costUsd, now)));
    c.strategist = { ...res, sources: (res.sources ?? []).slice(0, 30), focus: context.stocks.length === 1 ? context.stocks[0].symbol : 'all', risk: sent.risk ?? 'balanced', question: context.question };
    note('strategist', `The strategist answered with ${res.strategies.length === 1 ? 'one strategy' : `${res.strategies.length} strategies`}: see the AI strategist tab.`, true);
  } catch (err) {
    // what the API billed before it failed still counts (ai.js askClaude)
    if (err?.usage?.costUsd) await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'strategist', err.usage.costUsd, now)));
    console.warn(`! AI strategist: it couldn't run this time (${err?.name ?? 'error'}).`);
    note('strategist', 'The AI strategist couldn\'t answer this time. Try again later.', false);
  }
}
if (command.strategist !== undefined) await runStrategist(command.strategist);

// ---------- what every fund learns from ----------

const spent = async () => readJson(spendFile);
const newsFor = {}; // a digest gathered this run for one market, reused by that market's other funds
const company = await readJson(join(dirname(file), 'company-data.json'));
const filings = await readJson(join(dirname(file), 'results-dates.json'));
const newsEvents = marketEvents((await readJson(join(dirname(file), 'news-events.json'))) ?? [], quotes, { filings, company });
const calendar = resultsCalendar({ company, filings, quotes, events: newsEvents, now });
// with the study of big moves with and without news (state/move-news.json, scripts/fetch-articles.mjs moves)
const moveNews = await readJson(join(dirname(file), 'move-news.json'));
if (Object.keys(quotes).length) c.marketMemory = Object.fromEntries(Object.keys(MARKETS).map((m) => [m, buildMemory(newsEvents, quotes, m, now, c.marketMemory?.[m], { moveNews })]));
const longMemory = await readJson(join(dirname(file), 'memory-long.json'));
if (longMemory?.updatedAt && now - Date.parse(longMemory.updatedAt) > 30 * 86400000) console.warn(`! The ten-year memory is from ${longMemory.updatedAt.slice(0, 10)}: its weekly update keeps failing.`);
const regimes = Object.fromEntries(Object.keys(MARKETS).map((m) => [m, regimeNow(quotes, prices?.macro, m)]));
// The factor lab's prices (factors.js): the two years in data/ohlcv.json, or prices.json's year without it.
const factorData = Object.keys(quotes).length ? factorInputs({ ohlcv: await readJson(env.OHLCV_FILE || 'data/ohlcv.json'), quotes, calendar, macro: prices?.macro }) : null;
const factorsNow = (symbol) => (factorData ? factorsAt(factorData, symbol, now.getTime() / 1000) : null);
const withFactors = (symbol) => { const f = factorsNow(symbol); return f ? { factors: f } : {}; };
// What holds today for the factor lab's lessons: the regime, and which stocks report within 5 trading days.
const conditionsFor = (market, currency) => conditionsNow(regimes[market], calendar ? upcomingResults(calendar, quotes, Object.keys(quotes).filter((s) => quotes[s].currency === currency), now, LAB.window + 1) : [], market);
const picksHistory = await readJson(join(dirname(file), 'picks-history.json'));
const picksScores = picksHistory ? scorePicks(picksHistory, quotes, now) : [];
const picksSum = picksHistory && summarizeScores(picksScores).week;
const picksRecord = picksSum?.n >= 5 ? `The home page's AI picks, a week after being made: ${picksSum.n} scored, ${Math.round(picksSum.right * 100)}% right${picksSum.beat == null ? '' : `, ${Math.round(picksSum.beat * 100)}% beat the index`}.` : null;
const picks = await readJson(picksFile);
const cachedNews = await readJson(newsFile);
const marks = { picksAt: picks?.createdAt ?? null, newsAt: cachedNews?.createdAt ?? null };
// The news feeds' tagged headlines (state/articles), read when a fund gathers its own digest: its leads,
// unless NEWS_LEADS is 'off'. Each such digest's quality joins news-quality.json (counts only), except
// when the funds are private: its time would say when a fund decided.
const leadsOn = env.NEWS_LEADS !== 'off';
let feedArticles = null;
const leadArticles = async () => (leadsOn ? (feedArticles ??= (await Promise.all(recentMonths(now, 2).map((m) => readJson(join(dirname(file), 'articles', `${m}.json`))))).flat().filter(Boolean)) : null);
const qualityFile = join(dirname(file), 'news-quality.json');

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
    gradedBy[fund.id] = updatePlaybook(fund, quotes, now, { calendar, pooled: c.calibration?.[marketForCurrency(fund.currency)], factors: factorData, lab: c.factorLab?.[marketForCurrency(fund.currency)] }).graded;
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
        const message = `This month's AI spend (about US$${monthSpend(await spent(), now).toFixed(2)}) reached the US$${env.AI_MONTHLY_CAP_USD} cap, so the AI isn't deciding until next month. Stop-losses still work. Raise the cap with the AI_MONTHLY_CAP_USD repository variable.`;
        if (fund.aiCapped?.message !== message) fund.aiCapped = { time: now.toISOString(), message };
        log(message);
      } else {
        fund.aiCapped = null;
        try {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const news = newsFor[fund.currency] ?? (cachedNews && now - Date.parse(cachedNews.createdAt) < NEWS_MAX_AGE_MS ? cachedNews : undefined);
          const market = marketForCurrency(fund.currency);
          const playbook = fund.settings.learning === false ? null
            : playbookForPrompt(fund.playbook, {
              picksRecord, marketLessons: promptMarketLessons(c.marketMemory?.[market], longMemory, market, { hidden: fund.playbook?.hidden }), regime: regimes[market],
              conditions: conditionsFor(market, fund.currency),
            });
          const d = await decideFund({
            client: new Anthropic(), Anthropic, fund, quotes, picks, news, now, playbook, company, calendar, macro: prices?.macro ?? null,
            cards: cardsFor(market), notes: c.stockNotes ?? null, dossiers, articles: news ? null : await leadArticles(),
            model: modelOf(fund), newsModel: env.AI_NEWS_MODEL || TIERS.simple,
            cacheShared: (deciding[`${fund.currency}|${modelOf(fund)}`] ?? 0) >= 2,
            deepseek: { apiKey: env.DEEPSEEK_API_KEY }, digest: digestFrom(env),
          });
          if (d.news) {
            newsFor[fund.currency] = d.news;
            if (env.FUND_PRIVATE !== 'true') await writeFile(qualityFile, JSON.stringify(addQuality(await readJson(qualityFile), digestQuality(d.news, { by: 'fund', on: leadsOn }))));
          }
          await writeFile(spendFile, JSON.stringify(addSpend(await spent(), 'fund', d.usage?.costUsd, now)));
          const orders = executeDecision(fund, d.orders ?? [], quotes, now, { others: otherTigerHoldings(c, fund.id), calendar, factorsOf: factorsNow });
          // ideas it passed on keep their thesis, checked like an order's (a stale catalyst)
          const considered = (d.considered ?? []).slice(0, 3).map((x) => ({
            symbol: x.symbol, stance: x.stance, idea_type: x.idea_type, why_not: x.why_not,
            thesis: checkedThesis(x, x.symbol, { calendar, quotes, now }), ...(lessonsAppliedOf(x).length ? { lessonsApplied: lessonsAppliedOf(x) } : {}),
            ...withFactors(x.symbol),
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
          // what the API billed before it failed still counts (ai.js askClaude, askDeepSeek)
          if (err?.usage?.costUsd) {
            await writeFile(spendFile, JSON.stringify(addSpend(await spent(), 'fund', err.usage.costUsd, now)));
            fund.failedAiCost = Math.round(((fund.failedAiCost ?? 0) + err.usage.costUsd) * 1e4) / 1e4; // spend.js fundAiCost
          }
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
// Each market's funds' ideas pooled by factor and regime (factors.js factorLab); the next run's playbooks
// take its lessons. Counts only in the log.
if (factorData) {
  c.factorLab = factorLab(c.funds, gradedBy, (f) => frozenIdeas(f.ideaLog));
  for (const [m, lab] of Object.entries(c.factorLab)) console.log(`Factor lab, ${m}: ${lab.cases} case(s), ${lab.lessons.length} lesson(s).`);
}
// The owner's questions on the funds' own ideas (hypotheses.js), from the same graded ideas. Counts only.
const askedIdeas = answerWaitingIdeas(c.questions, { funds: c.funds, gradedBy, frozen: (f) => frozenIdeas(f.ideaLog), now });
if (askedIdeas) console.log(`Ask the data: answered ${askedIdeas} question(s) from the funds' own ideas.`);

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
    const { pb, graded } = updatePlaybook(fund, quotes, now, { calendar, pooled: c.calibration?.[marketForCurrency(fund.currency)], factors: factorData });
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
