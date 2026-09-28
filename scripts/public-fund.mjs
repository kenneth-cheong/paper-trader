// Writes the copy of the AI funds that the public website serves (only when they aren't kept private,
// see scripts/fund-store.mjs). Your Tiger account's full list of positions (which may include holdings
// outside the funds) and Tiger's order numbers are left out; only a check of whether Tiger holds what
// the funds think they hold is kept. Each fund's log of graded ideas (learning.js fund.ideaLog) is cut
// to its latest PUBLIC_IDEA_LOG rows, without the columns from PUBLIC_IDEA_COLUMNS on (each idea's
// price, its quarter grade, its thesis: expected move, horizon, catalyst, lessons applied, and its factors
// at the time); the page shows only the calibration and the factor lab (c.factorLab, each playbook's
// style) built from them. Its lesson book (learning.js pb.lessonBook) keeps only the
// records of the lessons in its playbook, without their words (the page shows the lessons themselves):
// the review's dropped proposals and the lessons that have gone are left out, and only the track
// record's counts of them stay.
// For the stock cards (dossier.js): the owner's notes on stocks (c.stockNotes) keep only when each was
// saved, never the words; each fund's stop log (fund.protectionLog) only its latest PUBLIC_STOP_LOG
// changes; each open position's track (fund.tracks) only its worst and best move so far, which the
// page's stops-and-risk table shows (and, for one from before tracking began, when tracking began). Each fund's record on each stock (pb.stocks) is counts and
// estimates from its graded ideas, like the rest of its playbook's statistics, and stays.
// The owner's reasons for declining trades are left out everywhere: on each proposal (declineWhy), in
// the playbook's statistics (pb.stats.declinedByReason, the page's "Your calls") and in the idea log
// (its last column, beyond PUBLIC_IDEA_COLUMNS). The weekly reports (fund.reports, report.js) are cut
// to the latest few, without the owner's calls (report.js publicReports).
// The articles the owner logged (reading.js, c.reading: links, titles and calls) are left out; only how
// many there are stays (c.readingLogged), so the page can tell an admin where to see them.
// The owner's questions (Ask the data, hypotheses.js, c.questions: their words and answers) are left out
// too; only how many there are stays (c.questionsAsked). So is the AI strategist's latest answer for an
// admin (c.strategist), made from the owner's own holdings and trades.
// Usage: node scripts/public-fund.mjs <ai-fund.json> <output.json>

import { readFile, writeFile } from 'node:fs/promises';
import { reconcile } from '../fund.js';
import { loadFunds, reconcileAll } from '../funds.js';
import { publicReports } from '../report.js';

const PUBLIC_IDEA_LOG = 200;
const PUBLIC_IDEA_COLUMNS = 17;
const PUBLIC_STOP_LOG = 50;
const [src, dest] = process.argv.slice(2);
let c;
try { c = loadFunds(JSON.parse(await readFile(src, 'utf8'))); } catch { process.exit(0); }

c.brokerCheck = reconcileAll(c);
delete c.notified;
if (c.stockNotes) c.stockNotes = Object.fromEntries(Object.entries(c.stockNotes).map(([s, n]) => [s, { at: n?.at ?? null }]));
if (c.reading) {
  c.readingLogged = Array.isArray(c.reading) ? c.reading.length : 0;
  delete c.reading;
}
delete c.strategist; // the owner's holdings, trades and question, and the answer to them
if (c.questions) {
  c.questionsAsked = Array.isArray(c.questions) ? c.questions.length : 0;
  delete c.questions;
}
for (const fund of c.funds) {
  if (Array.isArray(fund.protectionLog)) fund.protectionLog = fund.protectionLog.slice(-PUBLIC_STOP_LOG);
  if (fund.tracks) fund.tracks = Object.fromEntries(Object.entries(fund.tracks).map(([s, t]) => [s, { worst: t?.worst ?? null, best: t?.best ?? null, ...(t?.late ? { late: true, openedAt: t.openedAt ?? null } : {}) }]));
  if (fund.broker) fund.broker = { time: fund.broker.time, accountType: fund.broker.accountType, error: fund.broker.error, check: reconcile(fund) };
  for (const o of fund.brokerOrders ?? []) delete o.tigerOrderId;
  delete fund.notified;
  if (Array.isArray(fund.ideaLog)) fund.ideaLog = fund.ideaLog.slice(-PUBLIC_IDEA_LOG).map((r) => r.slice(0, PUBLIC_IDEA_COLUMNS));
  for (const p of fund.proposals ?? []) delete p.declineWhy;
  if (fund.reports) fund.reports = publicReports(fund.reports);
  const pb = fund.playbook;
  if (pb?.stats) delete pb.stats.declinedByReason;
  if (pb?.lessonBook) {
    const shown = new Set([...(pb.own ?? []), ...(pb.review ?? []), ...(pb.calibrationLessons ?? []), ...(pb.conditionLessons ?? []), ...(pb.lessons ?? [])].map((l) => l.id));
    pb.lessonBook = Object.fromEntries(Object.entries(pb.lessonBook).filter(([id]) => shown.has(id)).map(([id, { text, ...e }]) => [id, e]));
  }
}
await writeFile(dest, JSON.stringify(c));
