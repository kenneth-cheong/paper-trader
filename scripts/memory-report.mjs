// Prints each market's memory (memory.js): how stocks moved after past news and after big one-day
// moves, and the lessons the AI funds get from it. Read-only, no AI calls, nothing private.
// Usage: node scripts/memory-report.mjs <news-events.json> <prices.json>

import { readFile } from 'node:fs/promises';
import { buildMemory } from '../memory.js';

const [eventsFile, pricesFile] = process.argv.slice(2);
const events = JSON.parse(await readFile(eventsFile, 'utf8').catch(() => '[]'));
const quotes = JSON.parse(await readFile(pricesFile, 'utf8')).quotes;
const pct = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const LABELS = { bigUp: 'After a 4%+ one-day jump', bigDown: 'After a 4%+ one-day drop', positive: 'After good company news', negative: 'After bad company news' };

for (const market of ['SGX', 'US']) {
  const m = buildMemory(events, quotes, market);
  console.log(`\n== ${market}: ${m.events} news events measured, ${m.bigMoves} big one-day moves`);
  for (const [k, v] of Object.entries(m.stats)) {
    if (v) console.log(`  ${LABELS[k].padEnd(28)} ${String(v.n).padStart(3)} cases, ${Math.round(v.continued * 100)}% kept going, next week ${pct(v.avg)} (${pct(v.vsIndex)} vs the index)`);
  }
  console.log(m.lessons.length ? '  Lessons:' : '  No lessons yet (a pattern needs 5+ cases and a clear tilt).');
  for (const l of m.lessons) console.log(`   - ${l.text}\n     ${l.evidence}`);
}
