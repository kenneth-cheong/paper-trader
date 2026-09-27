// Prints each market's memory (memory.js): how stocks moved after past news and after big one-day
// moves over the past year; with the ten-year memory (memory-long.js, state/memory-long.json), its
// studies with their held-out check and a regime table (each study's cases by regime: the index
// against its 200-day average and, for US stocks, the VIX; and how many separate episodes each period
// held; descriptive only, no lesson depends on it); and the lessons the AI funds get from them.
// Read-only, no AI calls, nothing private.
// Usage: node scripts/memory-report.mjs <news-events.json> <prices.json> [results-dates.json] [company-data.json] [memory-long.json]
// With the SEC filings and Yahoo's company data, they take over from the AI's events as in the
// scheduled job (memory.js marketEvents).

import { readFile } from 'node:fs/promises';
import { buildMemory, marketEvents } from '../memory.js';
import { mergedMarketLessons, studyNumbers, asShown, STUDY_LABELS, LONG, regimeNow, regimeWords } from '../memory-long.js';
import { GATE } from '../stats.js';

const [eventsFile, pricesFile, filingsFile, companyFile, longFile] = process.argv.slice(2);
const readJson = async (path) => (path ? JSON.parse(await readFile(path, 'utf8').catch(() => 'null')) : null);
const prices = JSON.parse(await readFile(pricesFile, 'utf8'));
const quotes = prices.quotes;
const events = marketEvents((await readJson(eventsFile)) ?? [], quotes, { filings: await readJson(filingsFile), company: await readJson(companyFile) });
const long = await readJson(longFile);
const pct = (x) => { if (x == null) return '–'; const v = Math.round(x * 1000) / 10; return `${v > 0 ? '+' : ''}${(v || 0).toFixed(1)}%`; };
const LABELS = { bigUp: 'After a 4%+ one-day jump', bigDown: 'After a 4%+ one-day drop', positive: 'After good company news', negative: 'After bad company news' };
const VERDICT = { held: 'held on the held-out years', 'didnt-hold': 'didn\'t hold on the held-out years', 'no-pattern': 'no reliable pattern', 'too-few': 'too few cases to check' };
const CELLS = { above: 'index above its 200-day average', below: 'index below it', calm: 'VIX under 16', normal: 'VIX 16 to 25', stressed: 'VIX over 25' };

for (const market of ['SGX', 'US']) {
  const m = buildMemory(events, quotes, market);
  console.log(`\n== ${market}: ${m.events} news events measured, ${m.bigMoves} big one-day moves in the past year`);
  for (const [k, v] of Object.entries(m.stats)) {
    if (v) console.log(`  ${LABELS[k].padEnd(28)} ${String(v.n).padStart(3)} cases, ${Math.round(v.continued * 100)}% kept going, next week ${pct(v.avg)} (${pct(v.vsIndex)} vs the index${v.est ? `, ${pct(v.est.edge)} after beta in ${v.est.bets} separate bets, ${Math.round(v.est.p * 100)}% chance` : ''})`);
  }
  const lm = long?.markets?.[market];
  if (lm) {
    const r = regimeNow(quotes, prices.macro, market);
    console.log(`\n  Ten years (${long.from} to ${long.to}, ${lm.stocks} stocks), built ${long.updatedAt.slice(0, 10)}. Regime today: ${r ? regimeWords(r) : 'unknown'}.`);
    for (const [key, st] of Object.entries(lm.studies)) {
      if (key === 'stops') {
        const at = (c, k) => (c ? `${Math.round(c.long[LONG.stopKs.indexOf(k)] * 100)}%` : '–');
        console.log(`  ${'A stop hit within 21 trading days'.padEnd(42)} 2 daily moves away ${at(st.train, 2)} (${at(st.test, 2)} from 2024), 3 away ${at(st.train, 3)} (${at(st.test, 3)}); swings reached ${st.k} moves in 1 hold in 5`);
        continue;
      }
      const { train, test } = studyNumbers(key, st);
      console.log(`  ${STUDY_LABELS[key].padEnd(42)} ${String(st.cases).padStart(4)} cases. ${st.years?.train ?? 'Before 2024'}: ${train ? `${pct(train.edge)} (likely ${pct(train.lo)} to ${pct(train.hi)}, ${train.bets} separate bets, ${Math.round(train.p * 100)}% chance)` : '–'}; ${st.years?.test}: ${test ? `${pct(test.mean)} (${test.bets} bets)` : '–'}. ${VERDICT[st.check.status]}.`);
    }
    const ep = lm.regime?.episodes ?? {};
    console.log(`  Separate episodes: ${Object.entries(ep).map(([k, v]) => `${k === 'stressed' ? 'VIX over 25' : 'index below its 200-day average'} ${v.train} before 2024 and ${v.test} since`).join('; ')}. Descriptive only: no lesson depends on the regime.`);
    if (lm.regime?.rows?.length) {
      console.log('  By regime (separate bets, and the average over each study\'s horizon, read as its lesson reads it):');
      for (const [key, cell, bets, mean] of lm.regime.rows) console.log(`    ${STUDY_LABELS[key].padEnd(42)} ${CELLS[cell].padEnd(32)} ${String(bets).padStart(4)} bets ${pct(asShown(key, lm.studies[key].h, mean))}`);
    }
  }
  const lessons = mergedMarketLessons(m, long, market);
  console.log(lessons.length ? '  Lessons:' : `  No lessons yet (a pattern needs ${GATE.bets}+ separate bets, a drift of ${GATE.edge * 100}% a week after beta and a ${GATE.p * 100}% chance).`);
  for (const l of lessons) console.log(`   - ${l.text}\n     ${l.evidence}`);
}
