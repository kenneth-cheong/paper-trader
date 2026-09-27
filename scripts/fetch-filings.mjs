// US results dates from SEC EDGAR (no AI, free and official): each US stock's results releases with
// the exact time they were filed (calendar.js resultsFromSubmissions), in state/results-dates.json.
// Usage: node scripts/fetch-filings.mjs <results-dates.json>
// Environment: SEC_USER_AGENT, the repository variable with your name and email ("Jane Tan
// jane@example.com"). The SEC asks every automated client to identify itself this way and blocks
// those that don't; without it, this does nothing and Yahoo's results dates are used instead.
// Runs at most every 2 hours, and always on the run after the US close. The first time for a stock,
// it also reads EDGAR's older pages back over the year of prices (a one-off backfill). At most about
// 7 requests a second, under the SEC's limit of 10.

import { readFile, writeFile } from 'node:fs/promises';
import { resultsFromSubmissions, mergeFilings, filingsDue } from '../calendar.js';

const ROOT = new URL('..', import.meta.url);
const BACKFILL_DAYS = 400;
const file = process.argv[2];
const ua = (process.env.SEC_USER_AGENT ?? '').trim();
const now = new Date();
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!ua) {
  console.log('SEC filings: skipped (no SEC_USER_AGENT repository variable; Yahoo\'s results dates are used).');
  process.exit(0);
}
const data = (await readJson(file)) ?? { symbols: {}, backfilled: {} };
if (!filingsDue(data, now)) {
  console.log('SEC filings: checked less than 2 hours ago.');
  process.exit(0);
}

async function get(path) {
  await sleep(150);
  const res = await fetch(`https://data.sec.gov/submissions/${path}`, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const stocks = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8')).filter((s) => s.cik);
data.symbols ??= {};
data.backfilled ??= {};
let found = 0, failed = 0;
for (const { symbol, cik } of stocks) {
  try {
    const sub = await get(`CIK${cik}.json`);
    let fresh = resultsFromSubmissions(sub.filings?.recent, symbol, cik);
    if (!data.backfilled[symbol]) {
      const cutoff = new Date(now - BACKFILL_DAYS * 86400000).toISOString().slice(0, 10);
      for (const page of sub.filings?.files ?? []) {
        if (page.filingTo >= cutoff) fresh = fresh.concat(resultsFromSubmissions(await get(page.name), symbol, cik));
      }
      data.backfilled[symbol] = true;
    }
    const known = new Set((data.symbols[symbol] ?? []).map((f) => f.date));
    data.symbols[symbol] = mergeFilings(data.symbols[symbol], fresh);
    found += data.symbols[symbol].filter((f) => !known.has(f.date)).length;
  } catch (err) {
    failed++;
    console.warn(`! ${symbol}: ${err.message}; keeping the last copy.`);
  }
}
data.checkedAt = now.toISOString();
await writeFile(file, JSON.stringify(data));
console.log(`SEC filings: ${stocks.length - failed}/${stocks.length} stocks checked, ${found} new results release(s).`);
