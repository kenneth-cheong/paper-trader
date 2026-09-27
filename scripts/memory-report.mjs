// Prints each market's memory (memory.js): how stocks moved after past news and after big one-day
// moves, and the lessons the AI funds get from it. Read-only, no AI calls, nothing private.
// Usage: node scripts/memory-report.mjs <news-events.json> <prices.json> [results-dates.json] [company-data.json]
// With the last two (SEC filings and Yahoo's company data), they take over from the AI's events as in
// the scheduled job (memory.js marketEvents).

import { readFile } from 'node:fs/promises';
import { buildMemory, marketEvents } from '../memory.js';
import { GATE } from '../stats.js';

const [eventsFile, pricesFile, filingsFile, companyFile] = process.argv.slice(2);
const readJson = async (path) => (path ? JSON.parse(await readFile(path, 'utf8').catch(() => 'null')) : null);
const quotes = JSON.parse(await readFile(pricesFile, 'utf8')).quotes;
const events = marketEvents((await readJson(eventsFile)) ?? [], quotes, { filings: await readJson(filingsFile), company: await readJson(companyFile) });
const pct = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const LABELS = { bigUp: 'After a 4%+ one-day jump', bigDown: 'After a 4%+ one-day drop', positive: 'After good company news', negative: 'After bad company news' };

for (const market of ['SGX', 'US']) {
  const m = buildMemory(events, quotes, market);
  console.log(`\n== ${market}: ${m.events} news events measured, ${m.bigMoves} big one-day moves`);
  for (const [k, v] of Object.entries(m.stats)) {
    if (v) console.log(`  ${LABELS[k].padEnd(28)} ${String(v.n).padStart(3)} cases, ${Math.round(v.continued * 100)}% kept going, next week ${pct(v.avg)} (${pct(v.vsIndex)} vs the index${v.est ? `, ${pct(v.est.edge)} after beta in ${v.est.bets} separate bets, ${Math.round(v.est.p * 100)}% chance` : ''})`);
  }
  console.log(m.lessons.length ? '  Lessons:' : `  No lessons yet (a pattern needs ${GATE.bets}+ separate bets, a drift of ${GATE.edge * 100}% a week after beta and a ${GATE.p * 100}% chance).`);
  for (const l of m.lessons) console.log(`   - ${l.text}\n     ${l.evidence}`);
}
