// Company data from Yahoo Finance's quoteSummary, once a day: next results dates, earnings surprises,
// analysts' ratings, price targets and rating changes (analysts.js), in state/company-data.json.
// Usage: node scripts/company-data.mjs due <company-data.json>              exit code 0 if a fetch is due
//        node scripts/company-data.mjs build <raw folder> <company-data.json>
// scripts/yahoo_fetch.py summary downloads the raw answers first (Yahoo blocks Node's HTTP client on
// cloud servers). A stock that failed keeps yesterday's record. All of it is public market data.

import { readFile, writeFile } from 'node:fs/promises';
import { parseCompany, summaryDue } from '../analysts.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const [mode, ...args] = process.argv.slice(2);
const now = new Date();

// Must match summary_name() in yahoo_fetch.py.
const summaryPath = (dir, symbol) => `${dir}/${encodeURIComponent(symbol)}_summary.json`;

if (mode === 'due') {
  const due = summaryDue(await readJson(args[0]), now);
  console.log(due ? 'Company data: fetching today\'s.' : 'Company data: already fetched today.');
  process.exit(due ? 0 : 1);
}

if (mode === 'build') {
  const [dir, file] = args;
  const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8')).filter((s) => !s.etf);
  const prev = (await readJson(file)) ?? {};
  const out = { ...prev, triedAt: now.toISOString(), symbols: { ...(prev.symbols ?? {}) } };
  let ok = 0;
  for (const { symbol, market } of symbols) {
    const json = await readJson(summaryPath(dir, symbol));
    const result = json?.quoteSummary?.result?.[0];
    if (!result) {
      console.warn(`! ${symbol}: ${json?.error ?? json?.quoteSummary?.error?.description ?? 'no data'}; keeping the last copy.`);
      continue;
    }
    const before = prev.symbols?.[symbol];
    const rec = parseCompany(result, now, before);
    // US stocks normally have hundreds of rows; none means Yahoo left the module out this time.
    if (market === 'US' && before?.ratingRows > 0 && rec.ratingRows === 0) {
      console.warn(`::warning::${symbol}: Yahoo returned no rating history today (it had ${before.ratingRows} rows).`);
    }
    out.symbols[symbol] = rec;
    ok++;
  }
  if (ok) out.fetchedAt = now.toISOString();
  await writeFile(file, JSON.stringify(out));
  console.log(`Company data: ${ok}/${symbols.length} stocks updated.`);
}
