// Ten years of the watchlist's own prices for the market memory (memory-long.js), once a week, and the
// stock cards' public part (dossier.js), with it and once a day.
// Usage: node scripts/build-history.mjs due <memory-long.json>             exit code 0 if a build is due
//        node scripts/build-history.mjs build <raw folder> <memory-long.json>
//        node scripts/build-history.mjs dossiers <dossiers.json>           the stock cards, when a day old
//        node scripts/build-history.mjs asked <ai-fund.json> <raw folder>   exit code 0 if the owner's questions
//                                                                          are due an answer (Ask the data)
//        node scripts/build-history.mjs answer <raw folder> <ai-fund.json>
// scripts/yahoo_fetch.py long downloads the raw data first (ten years of daily prices with dividends
// and splits for every symbol in symbols.json, plus ^VIX). The raw data stays on the runner and is never
// saved; only the compact results are (memory-long.json, under 50 KB, on the ai-state branch, and
// copied to the site for the page). SEC filings (results-dates.json) and Yahoo's company data
// (company-data.json), read from the same folder when they're there, date the results study. If an
// index or most of the stocks didn't come back, last week's results are kept and the build is tried
// again after 6 hours. If less came back than last week (a stock or a market missing, or a stock's
// prices years shorter), last week's results are kept too and it's tried again 6 hours later, up to
// memory-long.js PARTIAL.tries times; then this week's is taken with last week's figures for what's
// missing (memory-long.js carryOver). Everything here is public price data, so the log may say what it
// found.
// The stock cards (state/dossiers.json, copied to the site) come from this run's prices
// (data/prices.json), the ten-year memory, the results calendar (results-dates.json, company-data.json
// and the news events' results dates) and the home page's picks' record (picks-history.json): prices
// and news only, never a fund's own record. They're rebuilt with each weekly build and refreshed when
// a day old (dossier.js dossiersDue); without prices this run, the last ones are kept.
// Ask the data (hypotheses.js): the owner's questions wait in the fund collection (private with the private
// fund store), which the job loads after the weekly step. So a later step, after the AI fund step, answers
// them from the same ten years of raw prices: the weekly download when it ran this time, else a new one
// (yahoo_fetch.py long again) at most once every hypotheses.js ASK.retryHours hours while one waits. Only
// counts are printed, never a question or its answer.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { events } from './fetch-prices.mjs';
import { seriesFrom, cleanSeries, buildLongMemory, longCases, historyDue, fitSize, lostSince, carryOver, PARTIAL, VIX, MAX_BYTES } from '../memory-long.js';
import { buildDossiers, dossiersDue } from '../dossier.js';
import { resultsCalendar } from '../calendar.js';
import { marketEvents } from '../memory.js';
import { scorePicks } from '../scorecard.js';
import { answerDue, answerWaiting, waitingLong } from '../hypotheses.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const [mode, ...args] = process.argv.slice(2);
const now = new Date();

// Must match raw_name() in yahoo_fetch.py.
const rawPath = (dir, symbol) => `${dir}/${encodeURIComponent(symbol)}_10y_1d.json`;

// Every symbol's cleaned ten-year series from the raw folder (with the VIX), and what failed.
async function readSeries(dir, symbols) {
  const series = {};
  const failed = [];
  for (const symbol of [...symbols.map((s) => s.symbol), VIX]) {
    const json = await readJson(rawPath(dir, symbol));
    const result = json?.chart?.result?.[0];
    if (!result) { failed.push(`${symbol} (${json?.error ?? json?.chart?.error?.description ?? 'no data'})`); continue; }
    series[symbol] = cleanSeries(seriesFrom(result, events(result) ?? null), { macro: symbol === VIX });
  }
  return { series, failed };
}

// The stock cards' public part into `file`, from this run's prices, the ten-year memory `long` and the
// state files next to `file`. Returns them, or null (and keeps the last ones) without prices.
async function writeDossiers(file, long) {
  const state = dirname(file);
  const quotes = (await readJson('data/prices.json'))?.quotes ?? {};
  if (!Object.keys(quotes).length) {
    console.log('Stock cards: no prices this run; kept the last ones.');
    return null;
  }
  const company = await readJson(join(state, 'company-data.json'));
  const filings = await readJson(join(state, 'results-dates.json'));
  const events = marketEvents((await readJson(join(state, 'news-events.json'))) ?? [], quotes, { filings, company });
  const calendar = resultsCalendar({ company, filings, quotes, events, now });
  const history = await readJson(join(state, 'picks-history.json'));
  const out = buildDossiers({ quotes, long: long?.stocks ? long : null, calendar, picksScores: history ? scorePicks(history, quotes, now) : [], now });
  const text = JSON.stringify(out);
  await writeFile(file, text);
  console.log(`Stock cards: ${Object.keys(out.stocks).length} stocks, ${(text.length / 1024).toFixed(1)} KB, ${long?.stocks ? `with the ten-year memory of ${long.updatedAt.slice(0, 10)}` : 'without the ten-year memory yet'}.`);
  return out;
}

if (mode === 'dossiers') {
  const [file] = args;
  const long = await readJson(join(dirname(file), 'memory-long.json'));
  if (!dossiersDue(await readJson(file), long, now)) {
    console.log('Stock cards: refreshed within the day.');
    process.exit(0);
  }
  await writeDossiers(file, long);
}

if (mode === 'due') {
  const due = historyDue(await readJson(args[0]), now);
  console.log(due ? 'Ten-year prices: this week\'s update is due.' : 'Ten-year prices: updated within the week (or tried in the last 6 hours).');
  process.exit(due ? 0 : 1);
}

if (mode === 'build') {
  const [dir, file] = args;
  const started = Date.now();
  const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
  const prev = await readJson(file);
  const { series, failed } = await readSeries(dir, symbols);
  if (failed.length) console.warn(`! Ten-year prices missing for: ${failed.join(', ')}`);
  const stocks = symbols.filter((s) => !s.etf);
  const indexesOk = ['SPY', 'ES3.SI'].every((s) => series[s] && !series[s].leftOut);
  // how many tries in a row have failed (the file keeps it until a build is taken)
  const tries = (prev?.tries ?? 0) + 1;
  if (!indexesOk || stocks.filter((s) => series[s.symbol] && !series[s.symbol].leftOut).length < stocks.length / 2) {
    await writeFile(file, JSON.stringify({ ...(prev ?? {}), triedAt: now.toISOString(), tries }));
    console.log(`Ten-year prices: too little came back (${failed.length} of ${symbols.length + 1} symbols failed); ${prev?.updatedAt ? `kept the build from ${prev.updatedAt.slice(0, 10)}` : 'nothing built yet'}, trying again in 6 hours.`);
    process.exit(0);
  }
  const state = dirname(file);
  let mem = fitSize(buildLongMemory({ series, symbols, filings: await readJson(join(state, 'results-dates.json')), company: await readJson(join(state, 'company-data.json')), now }));
  // less than last week's: keep last week's and try again, and after PARTIAL.tries take this week's with
  // last week's figures for what's missing
  const lost = prev?.updatedAt ? lostSince(prev, mem, symbols) : { stocks: [], markets: [] };
  if (lost.stocks.length || lost.markets.length) {
    const what = [lost.stocks.length ? lost.stocks.join(', ') : '', lost.markets.filter((m) => !mem.markets[m]).map((m) => `every ${m} stock`).join(', ')].filter(Boolean).join('; ');
    if (tries < PARTIAL.tries) {
      await writeFile(file, JSON.stringify({ ...prev, triedAt: now.toISOString(), tries }));
      console.log(`Ten-year prices: less came back than last week (missing or years shorter: ${what}); kept the build from ${prev.updatedAt.slice(0, 10)}, trying again in 6 hours (try ${tries} of ${PARTIAL.tries}).`);
      process.exit(0);
    }
    mem = fitSize(carryOver(prev, mem, lost, now));
    console.log(`Ten-year prices: after ${tries} tries still missing ${what}; taking this week's build with the last figures for them (up to ${PARTIAL.carryDays} days old).`);
  }
  mem.triedAt = now.toISOString();
  const text = JSON.stringify(mem);
  await writeFile(file, text);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Ten-year prices: ${mem.data.stocks} stocks from ${mem.from} to ${mem.to}, ${(text.length / 1024).toFixed(1)} KB${text.length > MAX_BYTES ? ` (over the ${MAX_BYTES / 1000} KB aim)` : ''}, in ${secs}s.`);
  for (const x of mem.data.leftOut) console.log(`  Left out: ${x.symbol}: ${x.why}.`);
  for (const x of mem.data.carried ?? []) console.log(`  Carried over from the build of ${x.asOf.slice(0, 10)}: ${x.symbol}.`);
  for (const x of mem.data.rebuilt) console.log(`  Total return rebuilt from closes and dividends: ${x.symbol} (${x.why}).`);
  const fixes = Object.entries(mem.data.fixes).map(([k, v]) => `${k} ${v}`).join(', ');
  if (fixes) console.log(`  Clean-up: ${fixes}.`);
  for (const [market, m] of Object.entries(mem.markets)) {
    console.log(`  ${market}: ${m.lessons.map((l) => `${l.id.split(':').at(-1)} ${l.status}`).join(', ')}.`);
  }
  await writeDossiers(join(state, 'dossiers.json'), mem);
}

// Ask the data: whether the owner's questions are due an answer now (hypotheses.js answerDue): some wait
// for the ten years of prices, and they're on this runner already or none was tried in the last hours.
if (mode === 'asked') {
  const [fundFile, dir] = args;
  const c = await readJson(fundFile);
  const waiting = waitingLong(c?.questions).length;
  const rawReady = Boolean(await readJson(rawPath(dir, 'SPY')));
  const due = answerDue(c?.questions, { rawReady, now });
  console.log(!waiting ? 'Ask the data: no question waiting.' : due ? `Ask the data: ${waiting} question(s) waiting; answering now${rawReady ? ' from this run\'s ten years of prices' : ''}.` : `Ask the data: ${waiting} question(s) waiting; the ten years of prices were tried within the last hours, trying again later.`);
  process.exit(due ? 0 : 1);
}

// Ask the data: the waiting questions answered from the ten years of raw prices, into the fund collection.
// With too little back (an index or most stocks missing), they're marked tried and wait.
if (mode === 'answer') {
  const [dir, fundFile] = args;
  const c = await readJson(fundFile);
  if (!waitingLong(c?.questions).length) process.exit(0);
  const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
  const { series } = await readSeries(dir, symbols);
  const state = dirname(fundFile);
  const usable = symbols.filter((s) => !s.etf && series[s.symbol] && !series[s.symbol].leftOut).length;
  const enough = ['SPY', 'ES3.SI'].some((s) => series[s] && !series[s].leftOut) && usable >= symbols.filter((s) => !s.etf).length / 2;
  const data = enough ? longCases({ series, symbols, filings: await readJson(join(state, 'results-dates.json')), company: await readJson(join(state, 'company-data.json')) }) : null;
  const { answered, waiting } = answerWaiting(c.questions, data, now);
  await writeFile(fundFile, JSON.stringify(c));
  console.log(`Ask the data: answered ${answered} question(s) from ten years of prices${waiting ? `; ${waiting} wait for prices that didn't come back this time` : ''}.`);
}
