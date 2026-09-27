import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  factorInputs, factorsAt, factorsOf, relVolume, bucketOf, SPLITS, splitTest, labCases, factorLab, conditionsNow, conditionHolds, revealedStyle,
  conditionNoiseCheck, COND_NOISE_CHECK, FACTOR_KEYS, BUCKETS, LAB,
} from '../factors.js';
import {
  ideaRow, frozenIdeas, completeFactors, updatePlaybook, playbookForPrompt, activeLessons, collectIdeas, emptyPlaybook, CLASS_CODES,
} from '../learning.js';
import { applyOrders, newFund } from '../fund.js';
import { stockStats } from '../ai.js';
import { toQuote, toMacro, ohlcvBars, lastYear } from '../scripts/fetch-prices.mjs';
import { regimeNow } from '../memory-long.js';
import { betaAt, seeded, gauss } from '../stats.js';
import { loadFunds, addFund } from '../funds.js';

const root = new URL('..', import.meta.url).pathname;
const DAY = 86400;
const US_OPEN = Date.parse('2025-01-06T14:30:00Z') / 1000; // a Monday, the US open in winter
const SESSION = 6.5 * 3600;
// `n` weekday bar times from `start` (unix seconds)
function weekdays(n, start = US_OPEN) {
  const out = [];
  for (let d = 0; out.length < n; d++) { const t = start + d * DAY; if (![0, 6].includes(new Date(t * 1000).getUTCDay())) out.push(t); }
  return out;
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// Two years of a rising stock (100, 101, ...) with a volume of 1,000 a day, its index, the VIX and USD/SGD.
function market(n = 330) {
  const ts = weekdays(n);
  const bars = (f, v = () => 1000) => ts.map((t, i) => [t, null, null, null, f(i), v(i)]);
  return {
    ts,
    ohlcv: {
      symbols: {
        AAPL: { market: 'US', bars: bars((i) => 100 + i) },
        MSFT: { market: 'US', bars: bars((i) => 200 + 2 * Math.sin(i / 5)) },
        SPY: { market: 'US', etf: true, bars: bars((i) => 400 + 0.5 * i) },
      },
      macro: { '^VIX': ts.map((t) => [t, 18]) },
    },
  };
}

// ---------- the factors ----------

test('the six factors and the regime are measured from bars that closed before the idea, never later', () => {
  const { ts, ohlcv } = market();
  const k = 280;
  ohlcv.symbols.AAPL.bars[k][5] = 3000; // a heavy last session
  // Yahoo's next results date, 4 sessions after bar k's day: a US company reports after the close, so the
  // first session that trades on them is the 5th
  const results = { AAPL: { past: [{ date: dateOf(ts[k - 40]) }], next: { date: dateOf(ts[k + 4]) } } };
  const inputs = factorInputs({ ohlcv, calendar: results });
  const afterClose = ts[k] + SESSION + 60;
  const f = factorsOf(factorsAt(inputs, 'AAPL', afterClose));
  const c = (i) => 100 + i;
  near(f.ma50, r(c(k) / (Array.from({ length: 50 }, (_, j) => c(k - j)).reduce((s, x) => s + x) / 50) - 1, 3));
  assert.equal(f.high52, 0); // a rising stock is at its high
  assert.equal(f.volume20, 3);
  const rets = Array.from({ length: 60 }, (_, j) => Math.log(c(k - j) / c(k - j - 1)));
  const m = rets.reduce((s, x) => s + x) / 60, sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / 59);
  near(f.move1m, r((c(k) / c(k - 21) - 1) / (sd * Math.sqrt(21)), 2));
  assert.equal(f.results, 5);
  const idx = (i) => 400 + 0.5 * i;
  near(f.index200, r(idx(k) / (Array.from({ length: 200 }, (_, j) => idx(k - j)).reduce((s, x) => s + x) / 200) - 1, 3));
  assert.equal(f.vix, 18);
  assert.equal(f.usdsgd1m, null); // US stocks have none

  // during the next session, that session's bar (in progress) isn't used: the same factors as after bar k's close
  const during = ts[k + 1] + 3600;
  assert.deepEqual(factorsAt(inputs, 'AAPL', during).slice(0, 4), factorsAt(inputs, 'AAPL', afterClose).slice(0, 4));
  // and nothing after the idea changes it: a wild later price, volume or VIX
  const later = structuredClone(ohlcv);
  for (const b of later.symbols.AAPL.bars.slice(k + 1)) { b[4] *= 3; b[5] = 99999; }
  for (const b of later.macro['^VIX'].slice(k + 1)) b[1] = 80;
  assert.deepEqual(factorsAt(factorInputs({ ohlcv: later, calendar: results }), 'AAPL', during), factorsAt(inputs, 'AAPL', during));
  // days since results when they're nearer than the next ones; nothing beyond a quarter; index funds have none
  const since = factorInputs({ ohlcv, calendar: { AAPL: { past: [{ date: dateOf(ts[k - 3]) }], next: { date: dateOf(ts[k + 30]) } } } });
  assert.equal(factorsOf(factorsAt(since, 'AAPL', ts[k] + 3600)).results, -2); // released after the close on k-3, traded from k-2
  const sgxSince = factorInputs({ quotes: { 'D05.SI': { market: 'SGX', daily: ts.map((t, i) => [t, 40 + i / 100, 1000]) } }, calendar: { 'D05.SI': { past: [{ date: dateOf(ts[k - 3]) }], next: null } } });
  assert.equal(factorsOf(factorsAt(sgxSince, 'D05.SI', ts[k] + 3600)).results, -3); // an SGX date is used as it is
  const far = factorInputs({ ohlcv, calendar: { AAPL: { past: [{ date: dateOf(ts[k - 100]) }], next: null } } });
  assert.equal(factorsOf(factorsAt(far, 'AAPL', afterClose)).results, null);
  const withFiling = factorInputs({ ohlcv, calendar: { AAPL: { past: [], next: { date: dateOf(ts[k + 1]), effectiveDate: dateOf(ts[k + 2]) } } } });
  assert.equal(factorsOf(factorsAt(withFiling, 'AAPL', afterClose)).results, 2); // counted to the first session that trades on them
  assert.equal(factorsOf(factorsAt(factorInputs({ ohlcv, calendar: { SPY: results.AAPL } }), 'SPY', afterClose)).results, null);
  // too little history: the 52-week high needs 240 sessions, the 50-day average 50
  const early = factorsOf(factorsAt(inputs, 'AAPL', ts[100] + SESSION));
  assert.equal(early.high52, null);
  assert.ok(early.ma50 > 0);
  assert.equal(factorsAt(inputs, 'AAPL', ts[0]), null); // before any bar closed
  assert.equal(factorsAt(inputs, 'NOPE', afterClose), null);
  // a VIX that stopped updating isn't today's
  const stale = structuredClone(ohlcv);
  stale.macro['^VIX'] = stale.macro['^VIX'].slice(0, k - 10);
  assert.equal(factorsOf(factorsAt(factorInputs({ ohlcv: stale }), 'AAPL', afterClose)).vix, null);
});

test('SGX stocks get USD/SGD\'s move over a month; the inputs take the two years of ohlcv.json, else prices.json\'s year', () => {
  const ts = weekdays(300, Date.parse('2025-01-06T01:00:00Z') / 1000);
  const fxTs = weekdays(300, Date.parse('2025-01-06T00:00:00Z') / 1000);
  const ohlcv = {
    symbols: { 'D05.SI': { market: 'SGX', bars: ts.map((t, i) => [t, null, null, null, 30 + i / 100, 5e6]) }, 'ES3.SI': { market: 'SGX', etf: true, bars: ts.map((t, i) => [t, null, null, null, 3 + i / 1000, 1e6]) } },
    macro: { 'SGD=X': fxTs.map((t, i) => [t, 1.3 + i / 1000]) },
  };
  const t = ts[250] + 3600; // during the SGX session: USD/SGD's bar from the day before has closed
  const f = factorsOf(factorsAt(factorInputs({ ohlcv }), 'D05.SI', t));
  near(f.usdsgd1m, r((1.3 + 249 / 1000) / (1.3 + 228 / 1000) - 1, 4));
  assert.equal(f.vix, null);
  // prices.json's year when there's no ohlcv.json (volumes where the bars have them)
  const quotes = { 'D05.SI': { market: 'SGX', currency: 'SGD', daily: ts.slice(-252).map((x, i) => [x, 30 + i / 100]) } };
  const fromQuotes = factorInputs({ quotes });
  assert.equal(fromQuotes.series['D05.SI'].t.length, 252);
  assert.equal(fromQuotes.series['D05.SI'].v[0], null);
  assert.equal(factorInputs({ ohlcv, quotes }).series['D05.SI'].t.length, 300); // the longer of the two
});

test('each value falls in a bucket fixed in advance, and the three splits have their sides', () => {
  assert.deepEqual([-0.04, -0.03, 0, 0.03, 0.2].map((v) => bucketOf('ma50', v)), [0, 1, 1, 2, 2]);
  assert.deepEqual([-0.3, -0.15, -0.1, -0.05, 0].map((v) => bucketOf('high52', v)), [0, 1, 1, 2, 2]);
  assert.deepEqual([0.5, 0.8, 1.49, 1.5].map((v) => bucketOf('volume20', v)), [0, 1, 1, 2]);
  assert.deepEqual([-8, 0, 1, 5, 6, -1, -5, -6].map((v) => bucketOf('results', v)), [2, 1, 0, 0, 2, 1, 1, 2]);
  assert.deepEqual([15.9, 16, 25, 25.1].map((v) => bucketOf('vix', v)), [0, 1, 1, 2]);
  assert.deepEqual([-0.001, 0].map((v) => bucketOf('index200', v)), [0, 1]);
  assert.equal(bucketOf('ma50', null), null);
  for (const k of FACTOR_KEYS) assert.ok(BUCKETS[k].length >= 2, k);
  const side = Object.fromEntries(SPLITS.map((s) => [s.id, s.side]));
  assert.deepEqual([1, 5, 0, 6, -2, null].map(side.results), ['before', 'before', 'other', 'other', 'other', null]);
  assert.deepEqual([-0.01, 0, null].map(side.index), ['below', 'above', null]);
  assert.deepEqual([12, 20, 30].map(side.vix), ['calm', null, 'stressed']); // a normal VIX is on neither side
  assert.deepEqual(SPLITS.find((s) => s.id === 'vix').markets, ['US']);
});

test('stockStats adds the last finished session\'s volume against its 20-day average', () => {
  const ts = weekdays(40);
  const q = { market: 'US', daily: ts.map((t, i) => [t, 100 + i, i === 38 ? 2500 : i === 39 ? 100 : 1000]) };
  assert.equal(stockStats(q).rel_volume_20d, 0.09); // without a clock, the last bar counts as finished: 100 against 1,075
  assert.equal(stockStats(q, null, new Date((ts[39] + 3600) * 1000)).rel_volume_20d, 2.5); // today's session is still trading
  assert.equal(stockStats(q, null, new Date((ts[39] + SESSION) * 1000)).rel_volume_20d, 0.09);
  assert.equal(relVolume([1, 2, 3], 2), null); // too few sessions before it
});

// ---------- cases, buckets and the three splits ----------

// Cases on 8 stocks, `perWeek` a week for weeks[0]..weeks[1], each with factors from `f(week)` and a
// stock-specific edge from `x(week)` plus a little noise.
function makeCases({ weeks = [0, 40], perWeek = 3, f, x, noise = 0.004, seed = 1, fund = 'a', start = US_OPEN }) {
  const rand = seeded(seed), out = [];
  let k = 0;
  for (let w = weeks[0]; w < weeks[1]; w++) {
    for (let j = 0; j < perWeek; j++) {
      const t = start + w * 7 * DAY + j * DAY + 3600;
      const e = x(w) + noise * gauss(rand);
      out.push({ fund, symbol: `S${k++ % 8}`, direction: 1, t, idio: 0.03, ideaType: 'other', x: e, made: e, f: f(w) });
    }
  }
  return out;
}
const regimeCases = (below, xBelow, xAbove, opts = {}) => makeCases({ f: (w) => ({ index200: below(w) ? -0.05 : 0.05 }), x: (w) => (below(w) ? xBelow(w) : xAbove(w)), ...opts });
const index = SPLITS.find((s) => s.id === 'index');

test('a split becomes a lesson only with 20+ bets from 6+ weeks and 2+ episodes on each side, |t| of 2.5 and the same sign in both halves', () => {
  const twice = (w) => (w >= 0 && w < 10) || (w >= 20 && w < 30); // below the average for two spells
  const ok = splitTest(index, regimeCases(twice, () => -0.02, () => 0.01));
  assert.equal(ok.passes, true, JSON.stringify(ok));
  assert.deepEqual(ok.sides.map((s) => [s.side, s.bets, s.weeks, s.episodes]), [['below', 60, 20, 2], ['above', 60, 20, 2]]);
  assert.ok(ok.diff < -0.025 && ok.t < -LAB.t && ok.halves.every((h) => h < 0));
  // each gate, one at a time
  assert.equal(splitTest(index, regimeCases((w) => w < 20, () => -0.02, () => 0.01)).why, 'episodes'); // one long spell below
  assert.equal(splitTest(index, regimeCases(twice, () => -0.02, () => 0.01, { weeks: [0, 5] })).why, 'bets'); // 15 bets a side
  const crowded = regimeCases((w) => w % 2 === 0, () => -0.02, () => 0.01, { weeks: [0, 10], perWeek: 5 }); // 25 bets in 5 weeks a side
  assert.equal(splitTest(index, crowded).why, 'weeks');
  assert.equal(splitTest(index, regimeCases(twice, () => 0, () => 0, { noise: 0.02 })).why, 't');
  const flips = regimeCases(twice, (w) => (w < 20 ? -0.06 : 0.004), () => 0, { noise: 0.002 }); // all of it in the first half
  const s = splitTest(index, flips);
  assert.ok(Math.abs(s.t) >= LAB.t, JSON.stringify(s));
  assert.equal(s.why, 'halves');
  assert.equal(splitTest(index, []).passes, false);
});

test('the lab pools a market\'s funds, one case per fund, stock and side per 5 trading days, and writes a lesson about the side that did worse', () => {
  const twice = (w) => (w >= 0 && w < 10) || (w >= 20 && w < 30);
  // graded ideas as learning.js makes them, for two US funds and one SGD fund
  const graded = (cases) => cases.map((c) => ({
    t: c.t, symbol: c.symbol, direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'momentum', beta: 1, fee: 0.001, idio: 0.03,
    week: { move: c.x + 0.001 + 0.01, index: 0.01 }, factors: FACTOR_KEYS.map((k) => c.f[k] ?? null),
  }));
  const cases = regimeCases(twice, () => -0.02, () => 0.01);
  const a = graded(cases.filter((_, i) => i % 2 === 0)), b = graded(cases.filter((_, i) => i % 2 === 1));
  // a repeat within 5 trading days is the same case; passed-on ideas, exits and ideas without factors aren't cases
  const extra = [{ ...a[0], t: a[0].t + 2 * DAY }, { ...a[1], outcome: 'passed' }, { ...a[2], kind: 'exit', outcome: 'exit' }, { ...a[3], factors: undefined }];
  assert.equal(labCases([...a, ...extra], 'A').length, a.length);
  const funds = [{ id: 'A', currency: 'USD' }, { id: 'B', currency: 'USD' }, { id: 'C', currency: 'SGD', ideaLog: [] }];
  const lab = factorLab(funds, { A: [...a, ...extra], B: b });
  assert.deepEqual(Object.keys(lab).sort(), ['SGX', 'US']);
  assert.equal(lab.US.cases, cases.length);
  assert.equal(lab.US.funds, 2);
  assert.equal(lab.SGX.cases, 0);
  assert.deepEqual(lab.SGX.splits.map((s) => s.id), ['results', 'index']); // no VIX split for SGX stocks
  assert.ok(!lab.SGX.rows.some((row) => row.key === 'vix'));
  const [lesson] = lab.US.lessons;
  assert.equal(lab.US.lessons.length, 1);
  assert.equal(lesson.id, 'cond:index:below');
  assert.deepEqual(lesson.condition, { split: 'index', side: 'below' });
  assert.equal(lesson.source, 'conditions');
  assert.match(lesson.text, /^With SPY below its 200-day average, its ideas have done worse than when SPY was above it, beyond what the market explains: −[12]\.\d% a week against \+1\.\d%/);
  assert.match(lesson.evidence, /the 2 USD funds' ideas pooled.*60 separate bets from 20 weeks in 2 episodes, against 60 separate bets from 20 weeks in 2 episodes/);
  assert.ok(lesson.edge < -0.025 && lesson.lo < lesson.hi && lesson.bets === 60);
  // the page's rows: every bucket with cases, index200's two
  const idxRows = lab.US.rows.filter((row) => row.key === 'index200');
  assert.deepEqual(idxRows.map((row) => [row.bucket, row.n, row.bets, row.weeks, row.episodes]), [[0, 60, 60, 20, 2], [1, 60, 60, 20, 2]]);
  assert.ok(idxRows[0].mean < 0 && idxRows[1].mean > 0 && idxRows[0].right < 0.1);
  assert.ok(JSON.stringify(lab).length < 6000);
});

test('results day of a US stock: the value stored on the day is the value worked out again after the filing', () => {
  // An idea during the session of Yahoo's results date D (the release comes after the close) is before
  // results; once the SEC filing lands the calendar says { date: D, effectiveDate: D+1 }, and a recompute
  // (completeFactors) must give the same value and side.
  const { ts, ohlcv } = market();
  const k = 280, D = dateOf(ts[k + 1]);
  const during = ts[k + 1] + 3600;
  const stored = factorsOf(factorsAt(factorInputs({ ohlcv, calendar: { AAPL: { next: { date: D, source: 'yahoo' }, past: [] } } }), 'AAPL', during));
  const later = factorsOf(factorsAt(factorInputs({ ohlcv, calendar: { AAPL: { next: null, past: [{ date: D, effectiveDate: dateOf(ts[k + 2]), source: 'filing' }] } } }), 'AAPL', during));
  assert.equal(stored.results, 1);
  assert.equal(later.results, stored.results);
  assert.equal(SPLITS[0].side(stored.results), 'before');
  // five sessions before D: 6 away either way, just outside the window
  const early = ts[k - 4] + 3600;
  assert.equal(factorsOf(factorsAt(factorInputs({ ohlcv, calendar: { AAPL: { next: { date: D, source: 'yahoo' }, past: [] } } }), 'AAPL', early)).results, 6);
  // and the lessons' condition counts the same way: a Yahoo date today is 1 away, 5 away is 6
  const up = [{ symbol: 'AAPL', date: D, days_away: 0, source: 'yahoo' }, { symbol: 'MSFT', date: dateOf(ts[k + 6]), days_away: 5, source: 'estimated' },
    { symbol: 'NVDA', date: D, days_away: 1, source: 'filing' }, { symbol: 'META', date: D, days_away: 0, source: 'filing' }];
  assert.deepEqual(conditionsNow({}, up, 'US').resultsSoon, ['AAPL', 'NVDA']);
  // SGX dates are used as they are
  assert.deepEqual(conditionsNow({}, up.map((u) => ({ ...u, source: 'yahoo' })), 'SGX').resultsSoon, ['MSFT', 'NVDA']);
});

test('the AI sees a lab lesson only while its condition holds, with applies_now', () => {
  const lesson = (split, side) => ({ id: `cond:${split}:${side}`, source: 'conditions', measure: 'split', condition: { split, side }, text: `${split} ${side}`, evidence: 'e', edge: -0.02, lo: -0.03, hi: -0.01, bets: 25, p: 0.99, confidence: 'High' });
  const pb = { ...emptyPlaybook(), graded: 100, conditionLessons: [lesson('index', 'below'), lesson('vix', 'stressed'), lesson('results', 'before'), lesson('results', 'other')] };
  const upcoming = [{ symbol: 'NVDA', days_away: 2 }, { symbol: 'AAPL', days_away: 0 }, { symbol: 'MSFT', days_away: 7 }];
  const now = conditionsNow({ trend: 'below', level: 'calm' }, upcoming);
  assert.deepEqual(now, { trend: 'below', level: 'calm', resultsSoon: ['NVDA'] });
  const shown = playbookForPrompt(pb, { conditions: now }).lessons;
  assert.deepEqual(shown.map((l) => [l.id, l.applies_now]), [
    ['cond:index:below', 'yes: the index is below its 200-day average today'], ['cond:results:before', 'yes: NVDA report within 5 trading days'], ['cond:results:other', 'yes'],
  ]);
  assert.equal(shown[0].vs_the_other_side_pct_per_week, -2);
  assert.deepEqual(shown[0].likely_range, [-3, -1]);
  assert.equal(conditionHolds({ split: 'vix', side: 'stressed' }, { level: 'stressed' }), 'yes: the VIX is stressed today');
  // nothing known about today: only the lesson that always holds
  assert.deepEqual(playbookForPrompt(pb, {}).lessons.map((l) => l.id), ['cond:results:other']);
  // the owner can remove one; the page lists them all
  assert.deepEqual(playbookForPrompt({ ...pb, hidden: ['cond:index:below'] }, { conditions: now }).lessons.map((l) => l.id), ['cond:results:before', 'cond:results:other']);
  assert.equal(activeLessons(pb).length, 4);
  // a lesson whose condition doesn't hold today doesn't take one of the 12 places: with a full book,
  // the rule-made lesson after it is still sent
  const own = Array.from({ length: 11 }, (_, i) => ({ id: `own${i}`, source: 'owner', text: `mine ${i}` }));
  const full = { ...emptyPlaybook(), graded: 100, own, conditionLessons: [lesson('index', 'below')], lessons: [{ id: 'rule1', source: 'rules', text: 'a rule-made lesson', edge: -0.01, lo: -0.02, hi: -0.005, bets: 30, p: 0.99, confidence: 'High' }] };
  const sent = playbookForPrompt(full, { conditions: conditionsNow({ trend: 'above' }) }).lessons.map((l) => l.id);
  assert.equal(sent.length, 12);
  assert.ok(sent.includes('rule1') && !sent.includes('cond:index:below'));
  // while it holds, it's in and the book's cap still applies
  assert.deepEqual(playbookForPrompt(full, { conditions: conditionsNow({ trend: 'below' }) }).lessons.map((l) => l.id).slice(-1), ['cond:index:below']);
  // the page lists every lesson, whether or not it holds today
  assert.ok(activeLessons(full).some((l) => l.id === 'cond:index:below'));
});

// ---------- the idea log and the playbook ----------

test('factors go in the frozen idea log as columns, older rows keep working and get theirs from the prices', () => {
  const { ts, ohlcv } = market();
  const inputs = factorInputs({ ohlcv });
  const t = ts[270] + 3600;
  const g = { t, symbol: 'AAPL', direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'news', repeats: 1, price: 370, week: { move: 0.01, index: 0.005, peer: null }, month: { move: 0.02, index: 0.01, divs: 0 }, fee: 0.001, beta: 1.1, idio: 0.02 };
  const withF = { ...g, factors: factorsAt(inputs, 'AAPL', t) };
  const row = ideaRow(withF);
  assert.equal(row.length, 27 + FACTOR_KEYS.length - 1); // the last (USD/SGD, SGX only) is left off when empty
  assert.deepEqual(frozenIdeas([row])[0].factors, withF.factors);
  // an old row, without the columns: read as before, then completed from the prices
  const old = ideaRow(g);
  assert.equal(old.length, 18);
  assert.equal(frozenIdeas([old])[0].factors, undefined);
  const fund = { ideaLog: [old, ideaRow({ ...g, kind: 'exit', outcome: 'exit' })] };
  assert.equal(completeFactors(fund, inputs), 1); // entries only
  assert.deepEqual(frozenIdeas([fund.ideaLog[0]])[0].factors, withF.factors);
  assert.equal(fund.ideaLog[0][26], null); // the columns before them are padded
  assert.equal(completeFactors(fund, inputs), 0); // done once
  assert.deepEqual(frozenIdeas(fund.ideaLog).map((i) => i.week.move), [0.01, 0.01]);
});

test('orders and ideas passed on keep their factors from the decision; updatePlaybook fills in older ones, the style and the lab\'s lessons', () => {
  const { ts, ohlcv } = market();
  const inputs = factorInputs({ ohlcv });
  const now = new Date((ts[290] + 3600) * 1000);
  const quotes = {
    AAPL: { market: 'US', currency: 'USD', price: 389, daily: ohlcv.symbols.AAPL.bars.slice(-252).map((b) => [b[0], b[4], b[5]]), intraday: [] },
    MSFT: { market: 'US', currency: 'USD', price: 200, daily: ohlcv.symbols.MSFT.bars.slice(-252).map((b) => [b[0], b[4], b[5]]), intraday: [] },
    SPY: { market: 'US', currency: 'USD', price: 545, etf: true, daily: ohlcv.symbols.SPY.bars.slice(-252).map((b) => [b[0], b[4], b[5]]), intraday: [] },
  };
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date((ts[250] + 3600) * 1000) });
  const at = (s) => factorsAt(inputs, s, now.getTime() / 1000);
  const res = applyOrders(f, [
    { symbol: 'AAPL', action: 'buy', shares: 2, reason: 'r', idea_type: 'momentum', conviction: 'high' },
    { symbol: 'AAPL', action: 'sell', shares: 1, reason: 'r' },
  ], quotes, now, { factorsOf: at });
  const [buy, sell] = ['buy', 'sell'].map((a) => res.find((o) => o.action === a));
  assert.deepEqual(buy.factors, at('AAPL'));
  assert.equal(sell.factors, undefined); // exits keep none
  // an older decision without factors, and one with them
  const before = new Date((ts[270] + 3600) * 1000);
  f.decisions = [
    { time: before.toISOString(), orders: [{ symbol: 'MSFT', action: 'buy', status: 'filled', price: 199, shares: 5, fee: 1, ideaType: 'value' }], considered: [] },
    { time: new Date((ts[272] + 3600) * 1000).toISOString(), orders: [], considered: [{ symbol: 'AAPL', stance: 'long', idea_type: 'news', why_not: 'x', factors: [0.1, 0, 1, 1, null, 0.1, 18] }] },
  ];
  assert.deepEqual(collectIdeas(f).map((i) => i.factors ?? null), [null, [0.1, 0, 1, 1, null, 0.1, 18]]);
  const lab = { lessons: [{ id: 'cond:index:above', source: 'conditions', condition: { split: 'index', side: 'above' }, text: 'x', measure: 'split', edge: -0.01, lo: -0.02, hi: 0, bets: 20, p: 0.99, confidence: 'High' }] };
  const { pb, graded } = updatePlaybook(f, quotes, now, { factors: inputs, lab });
  assert.deepEqual(graded.find((g) => g.symbol === 'MSFT').factors, factorsAt(inputs, 'MSFT', before.getTime() / 1000));
  assert.equal(pb.style.buys.cases, 1); // the passed-on idea isn't part of its style
  assert.equal(pb.style.buys.topType, 'value');
  assert.deepEqual(pb.conditionLessons.map((l) => l.id), ['cond:index:above']);
  assert.equal(pb.lessonBook['cond:index:above'].source, 'conditions');
  // without this run's lab (the review's second pass), the lessons stay as they were
  assert.deepEqual(updatePlaybook(f, quotes, now, { factors: inputs }).pb.conditionLessons.map((l) => l.id), ['cond:index:above']);
  assert.deepEqual(updatePlaybook(f, quotes, now, { lab: { lessons: [] } }).pb.conditionLessons, []);
});

test('its revealed style: the average within-market percentile of the stocks it chose, and what it called them', () => {
  const ts = weekdays(300);
  const inputs = factorInputs({
    ohlcv: {
      symbols: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((s, k) => [s, { market: 'US', bars: ts.map((t, i) => [t, null, null, null, 100 * (1 + k * 0.002) ** i, 1000]) }])),
    },
  });
  const t = ts[280] + 3600;
  const idea = (symbol, direction, ideaType) => ({ t, symbol, direction, kind: 'entry', outcome: 'traded', ideaType, week: { move: 0, index: 0 }, factors: factorsAt(inputs, symbol, t) });
  const style = revealedStyle([idea('E', 1, 'value'), { ...idea('D', 1, 'value'), t: t + 7 * DAY }, idea('A', -1, 'momentum')], inputs);
  // E rises fastest: above all four others on its 50-day average and month's move; D above three of four
  assert.equal(style.buys.cases, 2);
  assert.equal(style.buys.percentile.ma50, Math.round(((4 + 3) / 2 / 4) * 100));
  assert.deepEqual([style.buys.topType, style.buys.topShare], ['value', 1]);
  assert.equal(style.shorts.percentile.ma50, 0);
  assert.equal(style.buys.indexAbove, null); // no index in these prices
  assert.equal(revealedStyle([], inputs), null);
});

test('pure noise rarely makes a lab lesson, and the page prints the rate', () => {
  assert.deepEqual(conditionNoiseCheck(), COND_NOISE_CHECK);
  assert.ok(COND_NOISE_CHECK.any <= 0.1 && COND_NOISE_CHECK.moreThanOne <= 0.01);
});

// ---------- the prices: two years for the scripts, a year for everyone else ----------

// A Yahoo chart answer for `ts` with closes from `f`.
const chart = (ts, f, extra = {}) => ({
  meta: { currency: 'USD', regularMarketPrice: f(ts.length - 1), regularMarketTime: ts.at(-1) + 3600, ...extra.meta },
  timestamp: ts, indicators: { quote: [{ open: ts.map((_, i) => f(i) - 1), high: ts.map((_, i) => f(i) + 1), low: ts.map((_, i) => f(i) - 2), close: ts.map((_, i) => f(i)), volume: ts.map(() => 1000) }] },
  ...(extra.events ? { events: extra.events } : {}),
});

test('two years are requested: prices.json keeps the last year and its dividends, ohlcv.json the two years of OHLCV', () => {
  const ts = weekdays(504);
  const events = { dividends: { a: { date: ts[10], amount: 0.2 }, b: { date: ts[400], amount: 0.25 } } };
  const q = toQuote(chart(ts, (i) => 100 + i / 10, { events }));
  const first = q.daily[0][0];
  assert.ok(q.daily.length >= 252 && q.daily.length <= 262, String(q.daily.length));
  assert.ok(ts.at(-1) - first <= 366 * DAY);
  assert.deepEqual(q.events, { dividends: [[ts[400], 0.25]], splits: [] }); // the year's dividends only
  assert.equal(q.prevClose, 100 + 502 / 10);
  assert.equal(toMacro(chart(ts, () => 17)).daily.length, q.daily.length);
  assert.deepEqual(ohlcvBars(chart(ts.slice(0, 2), (i) => 10 + i)), [[ts[0], 9, 11, 8, 10, 1000], [ts[1], 10, 12, 9, 11, 1000]]);
  assert.deepEqual(lastYear([]), []);
});

test('fetch-prices.mjs writes a year to prices.json and two years to ohlcv.json, which every reader of prices.json still sees as a year', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ohlcv-'));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'raw'));
  await copyFile(join(root, 'scripts/fetch-prices.mjs'), join(dir, 'scripts/fetch-prices.mjs'));
  const symbols = [{ symbol: 'AAPL', name: 'Apple', market: 'US' }, { symbol: 'SPY', name: 'SPDR S&P 500 ETF', market: 'US', etf: true }];
  await writeFile(join(dir, 'symbols.json'), JSON.stringify(symbols));
  const ts = weekdays(504, Math.floor(Date.now() / 1000 / DAY) * DAY - 730 * DAY + 14.5 * 3600);
  const raw = (s, range, interval, body) => writeFile(join(dir, 'raw', `${encodeURIComponent(s)}_${range}_${interval}.json`), JSON.stringify({ chart: { result: [body] } }));
  await raw('AAPL', '2y', '1d', chart(ts, (i) => 100 + i / 10));
  await raw('SPY', '2y', '1d', chart(ts, (i) => 400 + i / 5));
  await raw('AAPL', '5d', '15m', chart([ts.at(-1)], () => 150.3));
  await raw('SPY', '5d', '15m', chart([ts.at(-1)], () => 500.8));
  await raw('^VIX', '2y', '1d', chart(ts, () => 15, { meta: { regularMarketTime: Math.floor(Date.now() / 1000) } }));
  await raw('SGD=X', '1y', '1d', chart(ts.slice(-252), (i) => 1.28 + i / 10000, { meta: { regularMarketPrice: 1.3051 } }));
  const out = execFileSync('node', ['scripts/fetch-prices.mjs'], { cwd: dir, env: { ...process.env, YAHOO_RAW_DIR: 'raw' }, encoding: 'utf8' });
  assert.match(out, /Wrote 2\/2 quotes \(0 failed\), USDSGD=1\.3051/);
  const prices = JSON.parse(await readFile(join(dir, 'data/prices.json'), 'utf8'));
  const ohlcv = JSON.parse(await readFile(join(dir, 'data/ohlcv.json'), 'utf8'));
  assert.deepEqual(prices.fx, { USDSGD: 1.3051 }); // still the latest rate
  const year = prices.quotes.AAPL.daily.length;
  assert.ok(year >= 252 && year <= 262, String(year));
  assert.equal(prices.macro['^VIX'].daily.length, year);
  assert.equal(ohlcv.symbols.AAPL.bars.length, 504);
  assert.deepEqual(ohlcv.symbols.AAPL.bars[0], [ts[0], 99, 101, 98, 100, 1000]);
  assert.equal(ohlcv.symbols.SPY.etf, true);
  assert.equal(ohlcv.macro['^VIX'].length, 504);
  assert.equal(ohlcv.macro['SGD=X'].length, 252);
  assert.equal(JSON.stringify(prices).includes('ohlcv'), false);
  // the readers of prices.json see about a year, as before: beta, the regime, the price statistics
  assert.ok(betaAt(prices.quotes.AAPL, Infinity, prices.quotes.SPY).beta > 0);
  assert.equal(regimeNow(prices.quotes, prices.macro, 'US').trend, 'above');
  assert.equal(stockStats(prices.quotes.AAPL).history_days, year);
  // and the factor lab sees the two years
  assert.equal(factorInputs({ ohlcv, quotes: prices.quotes }).series.AAPL.t.length, 504);
});

test('ohlcv.json never reaches the site: git ignores it and the workflow copies only named files', () => {
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^data\/ohlcv\.json$/m);
  const wf = readFileSync(join(root, '.github/workflows/prices.yml'), 'utf8');
  const collect = wf.slice(wf.indexOf('- name: Collect site files'), wf.indexOf('uses: actions/upload-pages-artifact'));
  assert.doesNotMatch(collect, /ohlcv|cp data\/\*|cp -r data/);
  assert.match(collect, /cp data\/prices\.json _site\/data\//);
});

// ---------- the AI fund job ----------

// A stand-in for the Anthropic SDK (loaded through Node's module hooks, as in reading.test.mjs): it answers
// every call with FAKE_SDK_ANSWER and logs each request to FAKE_SDK_LOG.
const fakeSdk = `
import { appendFileSync } from 'node:fs';
export default class Anthropic {
  constructor() {
    this.beta = { messages: { stream: (req) => {
      appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(req) + '\\n');
      const tool = req.tools.find((t) => t.input_schema);
      return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't1', name: tool.name, input: JSON.parse(process.env.FAKE_SDK_ANSWER) }], usage: { input_tokens: 1000, output_tokens: 100 } }) };
    } } };
  }
}`;
const hooks = `export async function resolve(s, c, n) { return s === '@anthropic-ai/sdk' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeSdk)}`)}, shortCircuit: true } : n(s, c); }`;
const withFakeSdk = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`)}`;
const pinClock = (iso) => `data:text/javascript,const F=Date.parse("${iso}");const R=Date;globalThis.Date=class extends R{constructor(...a){if(a.length)super(...a);else super(F)}static now(){return F}};`;
const { FUND_COMMAND, GITHUB_EVENT_PATH, ...baseEnv } = process.env;

test('ai-fund.mjs: a decision keeps each opening order\'s and passed-on idea\'s factors, the lab is pooled, and a lesson reaches the AI only while it applies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factor-lab-'));
  for (const d of ['data', 'state']) await mkdir(join(dir, d));
  const NOW = '2026-01-02T20:10:00Z'; // a Friday, the US session (the sample prices' last day)
  const sample = JSON.parse(readFileSync(join(root, 'data/sample-prices.json'), 'utf8'));
  for (const q of Object.values(sample.quotes)) {
    q.time = q.market === 'US' ? '2026-01-02T20:00:00Z' : q.time;
    q.daily = q.daily.map(([t, c], i) => [t, c, 1e6 + (i % 7) * 1e5]); // with volumes, as prices.json's are
  }
  sample.updatedAt = '2026-01-02T20:05:00Z';
  delete sample.sample;
  await writeFile(join(dir, 'data/prices.json'), JSON.stringify(sample));
  // the scripts' two years (here the sample's year, with volumes)
  const ohlcv = { symbols: Object.fromEntries(Object.entries(sample.quotes).map(([s, q]) => [s, { market: q.market, ...(q.etf ? { etf: true } : {}), bars: q.daily.map(([t, c, v]) => [t, null, null, null, c, v]) }])), macro: {} };
  await writeFile(join(dir, 'data/ohlcv.json'), JSON.stringify(ohlcv));
  const c = loadFunds(null);
  const f = addFund(c, { budget: 10000, currency: 'USD', decisionsPerDay: 1, now: new Date('2025-10-01T15:00:00Z') });
  f.settings.skipQuiet = false;
  // an idea logged before factors were kept, and last run's lab with two lessons: SPY is below its 200-day average in the sample
  const t0 = sample.quotes.MSFT.daily[200][0] + 3600;
  f.ideaLog = [ideaRow({ t: t0, symbol: 'MSFT', direction: 1, kind: 'entry', outcome: 'traded', ideaType: 'value', repeats: 1, price: sample.quotes.MSFT.daily[199][1], week: { move: 0.01, index: 0, peer: null }, month: { move: 0.02, index: 0, divs: 0 }, fee: 0.001, beta: 1, idio: 0.02 })];
  const lesson = (side) => ({ id: `cond:index:${side}`, source: 'conditions', measure: 'split', condition: { split: 'index', side }, text: `Ideas with SPY ${side} its 200-day average have done worse.`, evidence: 'e', edge: -0.02, lo: -0.03, hi: -0.01, bets: 25, p: 0.99, confidence: 'High' });
  c.factorLab = { US: { funds: 1, cases: 0, rows: [], splits: [], lessons: [lesson('below'), lesson('above')] } };
  await writeFile(join(dir, 'state/ai-fund.json'), JSON.stringify(c));
  await writeFile(join(dir, 'state/news.json'), JSON.stringify({ createdAt: '2026-01-02T19:00:00Z', market_summary: 'Quiet.', items: [] }));
  const decision = {
    outlook: 'x', source_urls: [], protections: [],
    orders: [{ symbol: 'AAPL', action: 'buy', shares: 2, reason: 'r', idea_type: 'momentum', conviction: 'medium', expected_move_pct: 3, horizon_days: 21, catalyst_type: 'none', catalyst_date: '', wrong_if: 'w', lessons_applied: [] }],
    considered: [{ symbol: 'NVDA', stance: 'long', idea_type: 'news', why_not: 'y', expected_move_pct: 2, horizon_days: 5, catalyst_type: 'none', catalyst_date: '', wrong_if: 'w', lessons_applied: [] }],
  };
  const log = join(dir, 'sdk.log');
  const out = spawnSync('node', ['--import', pinClock(NOW), '--import', withFakeSdk, join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8', env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', FUND_PRIVATE: '', AI_MONTHLY_CAP_USD: '', AI_MODEL: '', AI_NEWS_MODEL: '', NEWS_LEADS: 'off', FAKE_SDK_ANSWER: JSON.stringify(decision), FAKE_SDK_LOG: log },
  });
  assert.equal(out.status, 0, out.stderr);
  const after = JSON.parse(await readFile(join(dir, 'state/ai-fund.json'), 'utf8'));
  const fund = after.funds[0];
  const d = fund.decisions.at(-1);
  const inputs = factorInputs({ ohlcv, quotes: sample.quotes });
  const nowS = Date.parse(NOW) / 1000;
  assert.equal(d.orders[0].status, 'filled');
  assert.deepEqual(d.orders[0].factors, factorsAt(inputs, 'AAPL', nowS));
  assert.deepEqual(d.considered[0].factors, factorsAt(inputs, 'NVDA', nowS));
  assert.equal(factorsOf(d.orders[0].factors).index200 < 0, true);
  // the old logged idea got its factors from the prices; the lab was pooled for the next run
  assert.deepEqual(frozenIdeas(fund.ideaLog)[0].factors, factorsAt(inputs, 'MSFT', t0));
  assert.equal(after.factorLab.US.funds, 1);
  assert.equal(after.factorLab.US.cases, 1);
  assert.deepEqual(after.factorLab.US.lessons, []);
  assert.match(out.stdout, /Factor lab, US: 1 case\(s\), 0 lesson\(s\)\./);
  // the AI saw the lesson whose condition holds today, with applies_now, and not the other
  const req = JSON.parse((await readFile(log, 'utf8')).trim().split('\n').at(-1));
  const own = JSON.parse(req.messages[0].content[1].text.replace(/^[^{]*/, ''));
  assert.deepEqual(own.playbook.lessons.map((l) => [l.id, l.applies_now]), [['cond:index:below', 'yes: the index is below its 200-day average today']]);
  // the market data has each stock's volume ratio
  const shared = JSON.parse(req.messages[0].content[0].text.replace(/^[^{]*/, ''));
  assert.ok(shared.stocks.find((s) => s.symbol === 'AAPL').stats.rel_volume_20d > 0);
  // the public copy leaves the idea log's factor columns out
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'state/ai-fund.json'), join(dir, 'public.json')], { cwd: root });
  const pub = JSON.parse(await readFile(join(dir, 'public.json'), 'utf8'));
  assert.ok(pub.funds[0].ideaLog.every((row) => row.length <= 17));
  assert.ok(pub.factorLab.US);
  assert.equal(CLASS_CODES[fund.ideaLog[0][3]], 'entry:traded');
});
