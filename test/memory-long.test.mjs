import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seriesFrom, cleanSeries, asQuote, historyDue, horizonEstimate, holdoutCheck, holdoutNoiseCheck, noiseStudy, HOLDOUT_NOISE, HOLDOUT, LONG,
  buildLongMemory, fitSize, regimeNow, regimeWords, regimeForPrompt, matchesRegime, mergedMarketLessons, promptMarketLessons, episodesOf, resultsDates, studyNumbers, VIX, MAX_BYTES,
  lostSince, carryOver, PARTIAL,
} from '../memory-long.js';
import { events } from '../scripts/fetch-prices.mjs';
import { typicalResultsMove } from '../calendar.js';
import { seeded, gauss } from '../stats.js';

// ---------- made-up Yahoo answers ----------

// Weekdays from `from` (an ISO date), as bar times at the session's open (US 14:30 UTC, SGX 01:00).
function weekdays(n, from = '2016-09-26', market = 'US') {
  const out = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); out.length < n; d += 86400000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) out.push(d / 1000 + (market === 'US' ? 14.5 : 1) * 3600);
  }
  return out;
}
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// A Yahoo chart result from closes (and optional volumes, highs and lows), with dividends
// ([[barIndex, amount]]) and correct adjusted closes unless `adj` is given.
function chart(ts, closes, { volume = null, high = null, low = null, dividends = [], splits = [], adj = null } = {}) {
  const divAt = new Map(dividends.map(([i, a]) => [i, a]));
  const adjclose = adj ?? (() => {
    const out = new Array(closes.length);
    let f = 1;
    for (let i = closes.length - 1; i >= 0; i--) {
      out[i] = closes[i] == null ? null : closes[i] * f;
      if (divAt.has(i) && i > 0) f *= 1 - divAt.get(i) / closes[i - 1];
    }
    return out;
  })();
  return {
    meta: { currency: 'USD', regularMarketPrice: closes.at(-1) },
    timestamp: ts,
    events: {
      dividends: Object.fromEntries(dividends.map(([i, amount]) => [ts[i], { amount, date: ts[i] }])),
      splits: Object.fromEntries(splits.map(([i, n, d]) => [ts[i], { date: ts[i], numerator: n, denominator: d }])),
    },
    indicators: { quote: [{ close: closes, volume: volume ?? closes.map(() => 1000), high: high ?? closes, low: low ?? closes }], adjclose: [{ adjclose }] },
  };
}
const clean = (result, opts) => cleanSeries(seriesFrom(result, events(result) ?? null), opts);
const walk = (n, f) => { const out = [100]; for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + f(i))); return out; };

// ---------- the data ----------

test('Yahoo\'s bars are read one per date, oldest first, without empty closes', () => {
  const ts = weekdays(4);
  const r = chart([...ts, ts[3] + 3600], [10, null, 11, 12, 12.5]);
  const s = seriesFrom(r, events(r));
  assert.deepEqual(s.close, [10, 11, 12.5]); // the empty close gone, today's bar repeated later wins
  assert.deepEqual(s.t.map(day), [day(ts[0]), day(ts[2]), day(ts[3])]);
});

test('adjusted closes are used only when they agree with the dividends; otherwise total return is rebuilt', () => {
  const ts = weekdays(300);
  const closes = walk(300, (i) => (i % 2 ? 0.004 : -0.003));
  closes[100] -= 0.9; // the ex-date drop
  const good = clean(chart(ts, closes, { dividends: [[100, 1]] }));
  assert.equal(good.source, 'adjclose');
  // total return on the ex-date: the adjusted closes reinvest the dividend at that day's price, so they
  // differ from the close plus the dividend only in the second order
  const expect = (closes[100] + 1) / closes[99] - 1;
  assert.ok(Math.abs(good.r[100] - expect) < 1e-4);
  // Thai Beverage's case: the adjusted closes start at 0.0016 of the close
  const broken = chart(ts, closes, { dividends: [[100, 1]] });
  broken.indicators.adjclose[0].adjclose = broken.indicators.adjclose[0].adjclose.map((a, i) => (i < 40 ? a * 0.0017 : a));
  const y92 = clean(broken);
  assert.equal(y92.source, 'close+dividends');
  assert.match(y92.why, /disagreed with its dividends on 1 day/);
  assert.ok(Math.abs(y92.r[100] - expect) < 1e-12 && y92.ok[40]); // rebuilt from closes and dividends, no fake jump
  // no adjusted closes at all, and a "dividend" of 60% of the price (a data error)
  const none = chart(ts, closes, { dividends: [[100, 1], [200, closes[199] * 0.6]] });
  delete none.indicators.adjclose;
  const c = clean(none);
  assert.equal(c.why, 'no adjusted closes');
  assert.equal(c.notes.dividendsDropped, 1);
  assert.deepEqual(c.divBars, [[100, 1]]);
});

test('a split Yahoo didn\'t apply to older closes is applied; one it did apply is left alone', () => {
  const ts = weekdays(300);
  const adjusted = walk(300, (i) => (i % 3 ? 0.002 : -0.002));
  const raw = adjusted.map((c, i) => (i < 150 ? c * 4 : c)); // a 4-for-1 split on day 150, not applied before it
  const s = clean(chart(ts, raw, { splits: [[150, 4, 1]], adj: raw }));
  assert.equal(s.notes.splitsApplied, 1);
  assert.ok(s.ok.slice(1).every(Boolean) && Math.abs(s.close[149] - adjusted[149]) < 1e-9);
  const fine = clean(chart(ts, adjusted, { splits: [[150, 4, 1]] }));
  assert.equal(fine.notes.splitsApplied, undefined);
  assert.equal(fine.source, 'adjclose');
});

test('bad prints, suspensions and holidays are left out of every study, but never the VIX\'s swings', () => {
  const ts = weekdays(300);
  const closes = walk(300, (i) => (i % 2 ? 0.01 : -0.009));
  const volume = closes.map(() => 5000);
  closes[50] *= 1.45; // a bad print, straight back the next day
  closes[120] = closes[119] * 1.29; // a real 29% day (NVDA's results in 2016): kept
  for (let i = 121; i < 300; i++) closes[i] = closes[i - 1] * (i % 2 ? 1.01 : 0.991);
  for (let i = 200; i < 207; i++) { closes[i] = closes[199]; volume[i] = 0; } // a week's suspension
  closes[250] = closes[249]; volume[250] = 0; // a holiday bar
  const s = clean(chart(ts, closes, { volume }));
  assert.equal(s.notes.jumps, 2); // the print (+45%) and the fall straight back (−31%)
  assert.equal(s.notes.flatRuns, 1);
  assert.equal(s.notes.holidays, 1);
  assert.equal(s.t.length, 299);
  const at = (i) => s.date.indexOf(day(ts[i]));
  assert.deepEqual([s.ok[at(50)], s.ok[at(51)], s.ok[at(120)]], [false, false, true]);
  assert.ok([201, 205, 206, 207].every((i) => !s.ok[at(i)]) && s.ok[at(208)]);
  assert.equal(s.bad.at(-1), 10); // 2 around the print, 8 for the suspension (7 still days and the move after)
  assert.equal(s.leftOut, null);
  // a window is clean only when no unusable day falls inside it
  assert.ok(s.bad[at(49)] === s.bad[at(40)] && s.bad[at(52)] !== s.bad[at(49)]);
  // the VIX: a 60% day is just a day
  const vix = clean(chart(ts, walk(300, (i) => (i === 80 ? 0.6 : i % 2 ? 0.03 : -0.03))), { macro: true });
  assert.ok(vix.ok.slice(1).every(Boolean) && vix.bad.at(-1) === 0 && vix.tr[80] === vix.close[80]);
  // too little history
  assert.equal(clean(chart(weekdays(100), walk(100, () => 0.001))).leftOut, 'less than a year of prices');
});

test('a download with less than last week\'s: what it lost, and last week\'s figures carried over for it', () => {
  const prev = {
    updatedAt: '2026-09-20T03:00:00Z',
    stocks: { NVDA: { market: 'US', from: '2016-09-26', x: 1 }, AAPL: { market: 'US', from: '2016-09-26', x: 2 }, 'D05.SI': { market: 'SGX', from: '2016-09-26', x: 3 }, OLD: { market: 'US', from: '2016-09-26' } },
    markets: { US: { stocks: 3, lessons: ['us-old'] }, SGX: { stocks: 1, lessons: ['sgx-old'] } },
  };
  const symbols = [{ symbol: 'NVDA', market: 'US' }, { symbol: 'AAPL', market: 'US' }, { symbol: 'D05.SI', market: 'SGX' }];
  const mem = {
    updatedAt: '2026-09-27T03:00:00Z', stocks: { AAPL: { market: 'US', from: '2024-10-09', x: 20 }, 'D05.SI': { market: 'SGX', from: '2016-10-03', x: 30 } },
    markets: { US: { stocks: 1, lessons: ['us-new'] }, SGX: { stocks: 1, lessons: ['sgx-new'] } }, data: { stocks: 2, leftOut: [{ symbol: 'NVDA', why: 'no prices this week' }] },
  };
  // NVDA failed, AAPL came back eight years short; OLD is off the watchlist, so it isn't lost
  const lost = lostSince(prev, mem, symbols);
  assert.deepEqual(lost, { stocks: ['AAPL', 'NVDA'], markets: ['US'] });
  const out = carryOver(prev, mem, lost, new Date('2026-09-28T09:00:00Z'));
  assert.deepEqual(out.stocks.NVDA, { ...prev.stocks.NVDA, asOf: prev.updatedAt });
  assert.equal(out.stocks.AAPL.x, 2);
  assert.equal(out.stocks['D05.SI'].x, 30); // nothing lost there: this week's
  assert.deepEqual(out.markets.US, { ...prev.markets.US, asOf: prev.updatedAt });
  assert.deepEqual(out.markets.SGX.lessons, ['sgx-new']);
  assert.deepEqual(out.data.carried, [{ symbol: 'AAPL', asOf: prev.updatedAt }, { symbol: 'NVDA', asOf: prev.updatedAt }]);
  assert.deepEqual(out.data.leftOut, []);
  assert.equal(out.stocks.OLD, undefined);
  assert.deepEqual(lostSince(prev, prev, symbols), { stocks: [], markets: [] }); // nothing lost
  assert.deepEqual(lostSince(prev, { ...mem, markets: { SGX: mem.markets.SGX } }, symbols).markets, ['US']);
  // figures carried for longer than PARTIAL.carryDays go
  const old = '2026-08-20T03:00:00Z';
  const gone = carryOver({ ...prev, stocks: { ...prev.stocks, NVDA: { ...prev.stocks.NVDA, asOf: old } }, markets: { ...prev.markets, US: { ...prev.markets.US, asOf: old } } }, mem, lost, new Date('2026-09-28T09:00:00Z'));
  assert.equal(gone.stocks.NVDA, undefined);
  assert.deepEqual(gone.markets.US.lessons, ['us-new']);
});

test('the weekly build is due after 7 days, and a failed attempt waits 6 hours', () => {
  const now = new Date('2026-09-28T02:00:00Z');
  assert.equal(historyDue(null, now), true);
  assert.equal(historyDue({ updatedAt: '2026-09-22T02:00:00Z' }, now), false);
  assert.equal(historyDue({ updatedAt: '2026-09-21T02:00:00Z' }, now), true);
  assert.equal(historyDue({ updatedAt: '2026-09-01T02:00:00Z', triedAt: '2026-09-27T23:00:00Z' }, now), false);
  assert.equal(historyDue({ triedAt: '2026-09-27T19:00:00Z' }, now), true);
});

// ---------- the studies, on one small made-up market ----------

// A market with an index and stocks over `n` weekdays from 2016: each stock is beta 1 plus its own
// drift and noise; `shape(symbol, i, r)` may change a stock's return. SGX stocks may pay dividends.
function market({ n = 2560, stocks = ['A', 'B', 'C', 'D'], seed = 3, shape = null, divs = {}, marketName = 'US', idio = 0.012, lows = null } = {}) {
  const rand = seeded(seed);
  const ts = weekdays(n, '2016-09-26', marketName);
  const m = Array.from({ length: n }, () => 0.0003 + 0.008 * gauss(rand));
  const index = walk(n, (i) => m[i]);
  const out = { [marketName === 'US' ? 'SPY' : 'ES3.SI']: chart(ts, index) };
  for (const [k, sym] of stocks.entries()) {
    const closes = [100];
    const dividends = [];
    for (let i = 1; i < n; i++) {
      let r = m[i] + 0.0002 * k + idio * gauss(rand);
      if (shape) r = shape(sym, i, r, m[i]);
      let c = closes[i - 1] * (1 + r);
      const d = divs[sym]?.(i, closes[i - 1]);
      if (d) { dividends.push([i, d.amount]); c -= d.drop; }
      closes.push(c);
    }
    out[sym] = chart(ts, closes, { dividends, ...(lows ? { low: closes.map((c, i) => lows(sym, i, c)), high: closes } : {}) });
  }
  out[VIX] = chart(ts, m.map((x) => 12 + Math.abs(x) * 1200));
  return { ts, results: out };
}
const cleaned = (results) => Object.fromEntries(Object.entries(results).map(([s, r]) => [s, clean(r, { macro: s === VIX })]));
const rows = (syms, marketName = 'US') => syms.map((symbol) => ({ symbol, market: marketName }));

test('a big move is at least 4% and 2.5 times the stock\'s usual daily move; what follows is measured after beta and its usual drift', () => {
  // quiet stocks (about 1.3% a day) with a 7% drop on day 1000, then 0.3% a day back for a week; a
  // wild one (3% a day) whose 6% drop isn't big for it
  const shape = (sym, i, r, mi) => {
    if (sym === 'W') return mi + 0.03 * (i % 2 ? 1 : -1);
    if (i === 1000) return mi - 0.07;
    if (i > 1000 && i <= 1005) return mi + 0.0002 + 0.003;
    return mi + 0.0002 + 0.01 * (i % 2 ? 1 : -1);
  };
  const { results } = market({ stocks: ['A', 'B', 'W'], shape });
  results.W.indicators.quote[0].close[1000] = results.W.indicators.quote[0].close[999] * 0.94;
  const mem = buildLongMemory({ series: cleaned(results), symbols: rows(['A', 'B', 'W', 'SPY']).map((r) => (r.symbol === 'SPY' ? { ...r, etf: true } : r)), now: new Date('2026-09-26T00:00:00Z') });
  const st = mem.markets.US.studies['big-down'];
  assert.equal(st.cases, 2); // A and B on day 1000; W's 6% isn't 2.5 of its usual moves
  // one market-wide day: 2 separate bets on 1 day; the bounce (0.3% a day for 5 days, beyond beta 1
  // and the 0.02% daily drift) reads as the price's own move
  assert.equal(st.check.train.bets, 2);
  assert.equal(st.check.train.clusters, 1);
  assert.ok(Math.abs(st.check.train.mean + 0.015 / 1) < 0.0008, `bounce ${st.check.train.mean}`);
  assert.ok(Math.abs(studyNumbers('big-down', st).train.mean - 0.015) < 0.0008);
  assert.equal(st.check.status, 'too-few');
});

test('stop-loss base rates count how far ordinary swings reach in daily moves, and suggest the stop hit in 1 hold in 5', () => {
  // a stock that moves 1% up and down on alternate days, whose low is 1.55% under each close: a stop
  // 1.5 daily moves below any close is hit within two days; one 3 moves below never is (the worst
  // is a 1% fall to a low 1.55% under that: about 2.5 moves)
  const shape = (sym, i) => (i % 2 ? 0.01 : -0.01);
  const { results } = market({ stocks: ['A'], shape, lows: (sym, i, c) => c * (1 - 0.0155) });
  const mem = buildLongMemory({ series: cleaned(results), symbols: [...rows(['A']), { symbol: 'SPY', market: 'US', etf: true }], now: new Date('2026-09-26T00:00:00Z') });
  const a = mem.stocks.A;
  assert.equal(a.stops.long.hits[0], 1); // 1.5 moves: always
  assert.equal(a.stops.long.hits[3], 0); // 3 moves: never
  assert.ok(Math.abs(a.stops.long.k - 2.55) < 0.15, `k ${a.stops.long.k}`); // what ordinary swings reached in 1 hold in 5
  assert.ok(Math.abs(a.suggested_stop_pct.long - a.stops.long.k * a.typical_daily_move_pct) < 0.1); // at today's daily move
  assert.ok(a.stops.holds > 2400);
  const lesson = mem.markets.US.lessons.find((l) => l.id === 'US:10y:stops');
  assert.match(lesson.text, /^In US stocks, ordinary swings hit a stop-loss 2 typical daily moves below the price within 21 trading days in \d+% of holds/);
  assert.equal(lesson.kind, 'fact');
});

test('SGX ex-dates: the drop against the dividend, and the recovery after, checked on held-out years', () => {
  // DBS pays 2% twice a year; its price drops 90% of that on the day and recovers 40% of it over 21 days
  const divs = { 'D05.SI': (i, prev) => (i % 126 === 60 ? { amount: prev * 0.02, drop: prev * 0.018 } : null) };
  const shape = (sym, i, r, mi) => (sym === 'D05.SI' && [...Array(21).keys()].some((k) => (i - 61 - k) % 126 === 0) ? mi + 0.4 * 0.02 / 21 : sym === 'D05.SI' ? mi : r);
  const { results } = market({ stocks: ['D05.SI', 'O39.SI', 'Z74.SI', 'S68.SI'], marketName: 'SGX', divs, shape });
  const mem = buildLongMemory({ series: cleaned(results), symbols: [...rows(['D05.SI', 'O39.SI', 'Z74.SI', 'S68.SI'], 'SGX'), { symbol: 'ES3.SI', market: 'SGX', etf: true }], now: new Date('2026-09-26T00:00:00Z') });
  const st = mem.markets.SGX.studies['ex-dividend'];
  assert.ok(Math.abs(st.drop - 0.9) < 0.005, `drop ${st.drop}`);
  // the recovery comes back twice a year, so the stock's usual drift (its average excess over the year
  // before) already holds a sixth of it: what's left is 5/6 of 40%, a third of the dividend
  assert.ok(Math.abs(st.recovered - 1 / 3) < 0.03, `recovered ${st.recovered}`);
  assert.equal(st.check.status, 'held');
  const lesson = mem.markets.SGX.lessons.find((l) => l.id === 'SGX:10y:ex-dividend');
  assert.match(lesson.text, /fell by about 90% of the dividend, and over the next 21 trading days recovered about 3\d% of it/);
  assert.equal(lesson.kind, 'pattern');
  assert.equal(mem.stocks['D05.SI'].dividends.n, st.cases);
  const months = mem.stocks['D05.SI'].dividends.months; // the months it went ex in the last three years
  assert.ok(months.length >= 2 && months.every((m, i) => m >= 1 && m <= 12 && (!i || m > months[i - 1])));
});

test('results days: reactions measured on the first session that could react, typical moves as calendar.js has them', () => {
  const { ts, results } = market({ stocks: ['A'], shape: (s, i, r, mi) => (i === 2400 ? mi + 0.06 : i === 2460 ? mi - 0.05 : r) });
  const series = cleaned(results);
  const d = (i) => day(ts[i]);
  const filings = { symbols: { A: [{ date: d(2399), effectiveDate: d(2400), time: `${d(2399)}T16:05`, form: '8-K' }] } };
  const company = { symbols: { A: { past: [d(2399), d(2459)], eps: [{ quarter: '2026-03-31', surprise: 0.05 }] } } };
  const dates = resultsDates('A', { filings, company });
  assert.deepEqual(dates.map((x) => [x.date, x.from]), [[d(2399), 'filing'], [d(2459), 'yahoo']]); // Yahoo's copy of the filing's date is the same results
  const mem = buildLongMemory({ series, symbols: [...rows(['A']), { symbol: 'SPY', market: 'US', etf: true }], filings, company, now: new Date('2026-09-26T00:00:00Z') });
  const r = mem.stocks.A.results;
  // the filing's day (after the close: the next session) and Yahoo's date without a time (the bigger of that day and the next)
  assert.deepEqual(r.recent.map(([date]) => date), [d(2400), d(2460)]);
  assert.ok(r.recent[0][1] > 5 && r.recent[1][1] < -4);
  const typical = typicalResultsMove(asQuote(series.A, 'US'), asQuote(series.SPY, 'US'), dates);
  assert.equal(r.typical_results_day_move_pct, Math.round(typical.avg * 1000) / 10);
});

test('last week\'s best stock against its worst: one case a week, the spread the week after', () => {
  const { results } = market({ stocks: ['A', 'B', 'C', 'D'], idio: 0.012, seed: 5 });
  const mem = buildLongMemory({ series: cleaned(results), symbols: [...rows(['A', 'B', 'C', 'D']), { symbol: 'SPY', market: 'US', etf: true }], now: new Date('2026-09-26T00:00:00Z') });
  const st = mem.markets.US.studies['best-worst'];
  assert.ok(st.cases > 480 && st.cases < 530); // about one a week for ten years
  assert.equal(st.check.train.bets, st.check.train.clusters); // each week its own bet
  assert.notEqual(st.check.status, 'held'); // pure noise
});

// ---------- the held-out check ----------

test('a pattern needs 90% on 2016-2023 and the same sign at half the size on 2024 on; otherwise the null is the lesson', () => {
  const rand = seeded(4);
  const base = noiseStudy(rand);
  const withEffect = (fTrain, fTest) => base.map((x) => ({ ...x, x5: x.x5 + (x.date >= HOLDOUT.testFrom ? fTest : fTrain) }));
  assert.equal(holdoutCheck(withEffect(0.01, 0.008), 5).status, 'held');
  assert.equal(holdoutCheck(withEffect(0.01, -0.006), 5).status, 'didnt-hold');
  assert.equal(holdoutCheck(withEffect(0.01, 0.001), 5).status, 'didnt-hold'); // same sign, but too small
  assert.equal(holdoutCheck(withEffect(0, 0.01), 5).status, 'no-pattern');
  assert.equal(holdoutCheck(base.filter((x) => x.date < '2017-02-01'), 5).status, 'too-few');
  // an effect under GATE.edge isn't a lesson however sure (a huge sample of a 0.1% drift)
  const tiny = Array.from({ length: 12 }, () => noiseStudy(rand, 400)).flat().map((x) => ({ ...x, x5: x.x5 * 0.2 + 0.001 }));
  const c = holdoutCheck(tiny, 5);
  assert.ok(c.train.p >= 0.9 && c.status === 'no-pattern');
  // 21-day outcomes are judged per week: +2.1% a month is +0.5% a week
  const monthly = base.map((x) => ({ ...x, x21: 0.021, end21: x.end5 }));
  assert.ok(Math.abs(horizonEstimate(monthly, 21).mean - 0.005) < 1e-9);
});

test('pure noise rarely passes the held-out check: the Monte Carlo figure the page prints', () => {
  const r = holdoutNoiseCheck();
  assert.deepEqual(r, HOLDOUT_NOISE);
  assert.ok(r.held <= 0.05, `pure noise passed ${r.held * 100}% of the time`);
  // and a real one is found: +0.6% a week in both periods
  const rand = seeded(5);
  let found = 0;
  for (let i = 0; i < 40; i++) if (holdoutCheck(noiseStudy(rand).map((x) => ({ ...x, x5: x.x5 + 0.006 })), 5).status === 'held') found++;
  assert.ok(found >= 28, `found ${found} of 40`);
});

// ---------- the whole memory ----------

test('ten years of a made-up market: every study, lessons with a verdict, under 50 KB', () => {
  const us = market({ stocks: ['AAPL', 'MSFT', 'NVDA', 'TSLA'], seed: 7, idio: 0.018 });
  const sg = market({ stocks: ['D05.SI', 'O39.SI', 'U11.SI', 'C38U.SI', 'Z74.SI'], marketName: 'SGX', seed: 8, divs: Object.fromEntries(['D05.SI', 'O39.SI', 'U11.SI', 'C38U.SI', 'Z74.SI'].map((s) => [s, (i, prev) => (i % 126 === 40 ? { amount: prev * 0.02, drop: prev * 0.018 } : null)])) });
  delete sg.results[VIX];
  const series = cleaned({ ...us.results, ...sg.results });
  const symbols = [...rows(['AAPL', 'MSFT', 'NVDA', 'TSLA']), { symbol: 'SPY', market: 'US', etf: true }, ...rows(['D05.SI', 'O39.SI', 'U11.SI', 'C38U.SI', 'Z74.SI'], 'SGX'), { symbol: 'ES3.SI', market: 'SGX', etf: true }, { symbol: 'Y92.SI', market: 'SGX' }];
  const mem = buildLongMemory({ series, symbols, now: new Date('2026-09-26T00:00:00Z') });
  assert.equal(mem.data.stocks, 9);
  assert.deepEqual(mem.data.leftOut, [{ symbol: 'Y92.SI', why: 'no prices this week' }]);
  assert.deepEqual(Object.keys(mem.markets.US.studies).sort(), ['best-worst', 'big-down', 'big-up', 'results', 'stops']);
  assert.deepEqual(Object.keys(mem.markets.SGX.studies).sort(), ['best-worst', 'big-down', 'big-up', 'ex-dividend', 'stops']);
  for (const m of Object.values(mem.markets)) {
    for (const l of m.lessons) {
      assert.ok(['pattern', 'no-pattern', 'fact'].includes(l.kind), l.id);
      assert.ok(l.text && l.evidence && l.source === 'market memory');
      assert.equal(Boolean(l.confidence), l.kind === 'pattern'); // only a pattern that held carries numbers for the AI
    }
    assert.deepEqual(m.years, { train: '2016–23', test: `2024–${mem.to.slice(2, 4)}` });
  }
  assert.equal(mem.markets.US.studies.results.check.status, 'too-few'); // no results dates given
  assert.ok(!mem.markets.US.lessons.some((l) => l.id === 'US:10y:results'));
  assert.ok(mem.markets.US.regime.episodes.stressed && mem.markets.SGX.regime.episodes.below && !mem.markets.SGX.regime.episodes.stressed);
  const size = JSON.stringify(fitSize(mem)).length;
  assert.ok(size < MAX_BYTES, `${size} bytes`);
  // over the limit, the least needed detail goes first
  const small = fitSize(mem, 5000);
  assert.deepEqual(small.markets.US.regime.rows, []);
  assert.equal(small.markets.US.studies['big-up'].volume, undefined);
  assert.equal(small.markets.US.lessons.length, mem.markets.US.lessons.length); // the lessons always stay
});

// ---------- today's regime and the merged lessons ----------

test('today\'s regime: the index against its 200-day average and, for US stocks, the VIX', () => {
  const ts = weekdays(252);
  const quotes = {
    SPY: { market: 'US', price: 130, daily: ts.map((t, i) => [t, 100 + i * 0.1]) },
    'ES3.SI': { market: 'SGX', price: 3.1, daily: ts.map((t, i) => [t, 4 - i * 0.002]) },
  };
  const macro = { [VIX]: { price: 14.8, daily: [] } };
  const us = regimeNow(quotes, macro, 'US');
  assert.deepEqual([us.trend, us.level, us.vix], ['above', 'calm', 14.8]);
  assert.equal(regimeWords(us), 'SPY above its 200-day average, calm (VIX 14.8)');
  const sg = regimeNow(quotes, macro, 'SGX');
  assert.equal(regimeWords(sg), 'ES3 below its 200-day average'); // no VIX for SGX
  assert.deepEqual(regimeForPrompt(us), { index: 'SPY', vs_200_day_average_pct: Math.round((130 / (100 + 0.1 * (52 + 251) / 2) - 1) * 1000) / 10, trend: 'above its 200-day average', vix: 14.8, volatility: 'calm' });
  assert.equal(regimeNow({ SPY: { daily: ts.slice(0, 150).map((t) => [t, 1]) } }, macro, 'US'), null); // under 200 days
  assert.equal(regimeNow(quotes, null, 'US').level, undefined); // no VIX today: the trend alone
  assert.equal(regimeNow(quotes, { [VIX]: { price: 31 } }, 'US').level, 'stressed');
  // a VIX that stopped updating (carried over from earlier prices, marked stale) isn't today's regime
  const spyAt = { ...quotes, SPY: { ...quotes.SPY, time: '2026-09-24T20:00:00Z' } };
  const old = regimeNow(spyAt, { [VIX]: { price: 13.1, time: '2026-07-01T20:15:00Z', stale: true } }, 'US');
  assert.deepEqual([old.trend, old.vix, old.level], ['above', undefined, undefined]);
  assert.equal(regimeWords(old), 'SPY above its 200-day average');
  assert.equal(regimeForPrompt(old).vix, undefined);
  // one failed update leaves a recent value, which still counts; a stale one without a time doesn't
  assert.equal(regimeNow(spyAt, { [VIX]: { price: 13.1, time: '2026-09-24T19:45:00Z', stale: true } }, 'US').vix, 13.1);
  assert.equal(regimeNow(spyAt, { [VIX]: { price: 13.1, time: '2026-09-22T20:00:00Z' } }, 'US').vix, 13.1); // 2 days
  assert.equal(regimeNow(spyAt, { [VIX]: { price: 13.1, stale: true } }, 'US').vix, undefined);
  // a lesson matches today when its evidence covers 10+ days like today
  assert.equal(matchesRegime({ regimes: { above: 40, calm: 12 } }, us), true);
  assert.equal(matchesRegime({ regimes: { above: 40, calm: 3 } }, us), false);
  assert.equal(matchesRegime({ regimes: { below: 11 } }, sg), true);
  assert.equal(matchesRegime({ id: 'US:news-positive' }, us), false);
});

test('the ten-year lessons join the past year\'s news lessons, replacing its big-move ones when they could be checked', () => {
  const year = { lessons: [{ id: 'US:big-up', text: 'y1' }, { id: 'US:news-positive', text: 'y2' }] };
  const long = { markets: { US: { studies: { 'big-up': { check: { status: 'no-pattern' } }, 'big-down': { check: { status: 'too-few' } } }, lessons: [{ id: 'US:10y:big-up', text: 't1' }] } } };
  assert.deepEqual(mergedMarketLessons(year, long, 'US').map((l) => l.id), ['US:10y:big-up', 'US:news-positive']);
  assert.deepEqual(mergedMarketLessons(year, null, 'US').map((l) => l.id), ['US:big-up', 'US:news-positive']);
  assert.deepEqual(mergedMarketLessons(null, long, 'SGX'), []);
});

test('separate episodes: runs of days merged across short gaps, counted when they last', () => {
  const dates = Array.from({ length: 100 }, (_, i) => `d${String(i).padStart(3, '0')}`);
  const flags = dates.map((_, i) => (i >= 10 && i < 18) || (i >= 25 && i < 27) || (i >= 60 && i < 62));
  assert.deepEqual(episodesOf(dates, flags), [['d010', 'd026']]); // 60-61 lasted only 2 days
  assert.equal(LONG.stopKs.length, 4);
});

// ---------- where the memory goes ----------

test('the AI sees at most 6 market lessons, those whose evidence covers days like today first', async () => {
  const { playbookForPrompt } = await import('../learning.js');
  const l = (id, regimes) => ({ id, text: id, evidence: 'e', ...(regimes ? { regimes } : {}) });
  const market = [l('US:10y:big-down', { above: 50, calm: 40 }), l('US:10y:stops', { below: 900, stressed: 400 }), l('US:10y:big-up', { below: 30, stressed: 25 }),
    l('US:news-positive'), l('US:10y:best-worst', { below: 200, stressed: 70 }), l('US:10y:results', { below: 12, stressed: 1 }), l('US:news-negative')];
  const stressed = { market: 'US', trend: 'below', level: 'stressed' };
  const p = playbookForPrompt({ hidden: ['US:10y:big-up'] }, { marketLessons: market, regime: stressed });
  assert.deepEqual(p.market_memory.map((x) => x.id), ['US:10y:stops', 'US:10y:best-worst', 'US:10y:big-down', 'US:news-positive', 'US:10y:results', 'US:news-negative']);
  const calm = playbookForPrompt({}, { marketLessons: market, regime: { market: 'US', trend: 'above', level: 'calm' } });
  assert.equal(calm.market_memory[0].id, 'US:10y:big-down');
  assert.equal(calm.market_memory.length, 6); // the cap
  assert.deepEqual(playbookForPrompt({}, { marketLessons: market }).market_memory.map((x) => x.id), market.slice(0, 6).map((x) => x.id)); // no regime: as given
  // a pattern that held reaches the AI with its numbers, a "no reliable pattern" with its evidence only
  const held = { id: 'SGX:10y:big-down', text: 't', evidence: 'e', confidence: 'High', edge: 0.011, lo: 0.008, hi: 0.015, bets: 78 };
  const none = { id: 'SGX:10y:big-up', text: 'n', evidence: 'e2', kind: 'no-pattern' };
  assert.deepEqual(playbookForPrompt({}, { marketLessons: [held, none] }).market_memory, [
    { id: 'SGX:10y:big-down', lesson: 't', confidence: 'High', edge_pct_per_week: 1.1, likely_range: [0.8, 1.5], separate_bets: 78, evidence: 'e' },
    { id: 'SGX:10y:big-up', lesson: 'n', evidence: 'e2' },
  ]);
});

test('the VIX goes to prices.json under macro, never among the watchlist quotes', async () => {
  const { toMacro } = await import('../scripts/fetch-prices.mjs');
  const ts = weekdays(5);
  const m = toMacro({ meta: { regularMarketPrice: 17.25, regularMarketTime: ts[4] + 3600 }, timestamp: ts, indicators: { quote: [{ close: [15, null, 16, 18.5, 17.25], volume: [0, 0, 0, 0, 0] }] } });
  assert.deepEqual(m, { price: 17.25, time: new Date((ts[4] + 3600) * 1000).toISOString(), daily: [[ts[0], 15], [ts[2], 16], [ts[3], 18.5], [ts[4], 17.25]] });
  assert.throws(() => toMacro({ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }), /no value/);
});

test('today\'s regime reaches the AI in the shared market data, identical for every fund in the market', async () => {
  const { marketContext, fundContext } = await import('../ai.js');
  const { newFund } = await import('../fund.js');
  const ts = weekdays(252);
  const quotes = {
    SPY: { market: 'US', currency: 'USD', name: 'SPDR S&P 500', price: 130, prevClose: 129, daily: ts.map((t, i) => [t, 100 + i * 0.1]), intraday: [] },
    AAPL: { market: 'US', currency: 'USD', name: 'Apple', price: 200, prevClose: 199, daily: ts.map((t, i) => [t, 150 + i * 0.2]), intraday: [] },
  };
  const macro = { [VIX]: { price: 27.3, daily: [] } };
  const ctx = marketContext({ currency: 'USD', quotes, picks: null, news: null, macro }); // 130 against the last 200 closes' average of 115.15
  assert.deepEqual(ctx.market_regime_now, { index: 'SPY', vs_200_day_average_pct: 12.9, trend: 'above its 200-day average', vix: 27.3, volatility: 'stressed' });
  assert.deepEqual(ctx.stocks.map((s) => s.symbol), ['SPY', 'AAPL']); // the VIX isn't a stock
  const a = newFund({ budget: 1000, currency: 'USD' }), b = newFund({ budget: 5000, currency: 'USD', style: 'aggressive' });
  const shared = (f) => { const c = fundContext({ fund: f, quotes, picks: null, news: null, macro }); return JSON.stringify(c.market_regime_now); };
  assert.equal(shared(a), shared(b));
  assert.equal(marketContext({ currency: 'USD', quotes: { AAPL: quotes.AAPL }, picks: null, news: null }).market_regime_now, undefined); // no index: nothing
});

test('the weekly script: due when stale, keeps last week\'s results when Yahoo fails, and writes a compact file', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'long-'));
  const root = new URL('..', import.meta.url).pathname;
  const run = (...args) => { try { return { out: execFileSync('node', ['scripts/build-history.mjs', ...args], { encoding: 'utf8', cwd: root }), code: 0 }; } catch (e) { return { out: e.stdout, code: e.status }; } };
  const file = join(dir, 'memory-long.json');
  assert.equal(run('due', file).code, 0); // nothing yet
  writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), markets: { US: { lessons: [] } } }));
  assert.equal(run('due', file).code, 1);
  // Yahoo failed: the raw folder holds only errors
  const raw = join(dir, 'raw');
  (await import('node:fs')).mkdirSync(raw);
  const symbols = JSON.parse(readFileSync(join(root, 'symbols.json'), 'utf8'));
  for (const s of symbols) writeFileSync(join(raw, `${encodeURIComponent(s.symbol)}_10y_1d.json`), JSON.stringify({ error: 'HTTP 429' }));
  assert.match(run('build', raw, file).out, /too little came back.*kept the build from/);
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(kept.markets && kept.triedAt);
  assert.equal(run('due', file).code, 1); // tried just now: not again for 6 hours
  // a year of prices for every symbol: a build, well under 50 KB, and nothing raw kept beside it
  const ts = weekdays(300, '2025-08-01');
  const rand = seeded(2);
  for (const s of [...symbols.map((x) => x.symbol), VIX]) writeFileSync(join(raw, `${encodeURIComponent(s)}_10y_1d.json`), JSON.stringify({ chart: { result: [chart(ts, walk(300, () => 0.012 * gauss(rand)))] } }));
  const out = run('build', raw, file).out;
  assert.match(out, /Ten-year prices: 17 stocks from 2025-08-01/);
  const mem = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(JSON.stringify(mem).length < MAX_BYTES && mem.stocks['D05.SI'].stops && mem.triedAt);
  assert.equal(mem.stocks.NVDA.from, '2025-08-01');
  // (the stock cards are written beside it too when there are prices this run: dossier.js)
  assert.deepEqual(readdirSync(dir).filter((f) => f !== 'dossiers.json').sort(), ['memory-long.json', 'raw']);
  // a week later one stock fails: last week's build is kept and tried again 6 hours later, up to
  // PARTIAL.tries times; then this week's is taken with last week's figures for it
  const weekAgo = new Date(Date.now() - 8 * 86400000).toISOString();
  writeFileSync(file, JSON.stringify({ ...mem, updatedAt: weekAgo }));
  writeFileSync(join(raw, 'NVDA_10y_1d.json'), JSON.stringify({ error: 'HTTP 500' }));
  for (let i = 1; i < PARTIAL.tries; i++) {
    assert.match(run('build', raw, file).out, new RegExp(`less came back than last week \\(missing or years shorter: NVDA\\); kept the build from ${weekAgo.slice(0, 10)}, trying again in 6 hours \\(try ${i} of ${PARTIAL.tries}\\)`));
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual([kept.updatedAt, kept.tries, kept.stocks.NVDA.from], [weekAgo, i, '2025-08-01']);
    assert.equal(historyDue(kept), false);
    assert.equal(historyDue(kept, new Date(Date.now() + 7 * 3600000)), true);
  }
  assert.match(run('build', raw, file).out, new RegExp(`after ${PARTIAL.tries} tries still missing NVDA; taking this week's build[\\s\\S]*Carried over from the build of ${weekAgo.slice(0, 10)}: NVDA`));
  const taken = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([taken.stocks.NVDA.asOf, taken.markets.US.asOf, taken.tries], [weekAgo, weekAgo, undefined]);
  assert.deepEqual(taken.data.carried, [{ symbol: 'NVDA', asOf: weekAgo }]);
  assert.equal(taken.markets.SGX.asOf, undefined);
  assert.equal(historyDue(taken), false); // next week
});

test('the AI gets the ten-year lessons compact: patterns with a check line, the stop base rate short, every "no pattern" as one', () => {
  const mk = (id, kind, extra = {}) => ({ id: `US:10y:${id}`, kind, status: kind === 'pattern' ? 'held' : kind, text: `full ${id}`, evidence: `long evidence ${id}`, source: 'market memory', ...extra });
  const long = { markets: { US: {
    years: { train: '2016–23', test: '2024–26' },
    studies: { 'big-up': { check: { status: 'no-pattern' } }, 'big-down': { check: { status: 'held' } } },
    lessons: [
      mk('big-down', 'pattern', { confidence: 'High', edge: 0.011, lo: 0.008, hi: 0.015, bets: 78, topic: 'after a big one-day drop', brief: 'Checked on 2024–26: +0.8% (36 bets).', regimes: { above: 40 } }),
      mk('stops', 'fact', { short: 'short stops', brief: '2024–26: 53% and 36%.', regimes: { above: 900 } }),
      mk('big-up', 'no-pattern', { topic: 'after a big one-day jump', brief: 'big jump −0.1% (2016–23) then −0.3%', regimes: { above: 30, below: 20 } }),
      mk('best-worst', 'no-pattern', { topic: 'last week\'s best stock against its worst', brief: 'best vs worst +0.3% (2016–23) then −0.3%', regimes: { above: 300, below: 5 } }),
    ],
  } } };
  const year = { lessons: [{ id: 'US:big-up', text: 'y' }, { id: 'US:news-positive', text: 'n' }] };
  const out = promptMarketLessons(year, long, 'US');
  assert.deepEqual(out.map((l) => l.id), ['US:10y:big-down', 'US:10y:stops', 'US:10y:no-pattern', 'US:news-positive']);
  assert.deepEqual([out[0].text, out[0].evidence, out[0].confidence], ['full big-down', 'Checked on 2024–26: +0.8% (36 bets).', 'High']);
  assert.deepEqual([out[1].text, out[1].evidence], ['short stops', '2024–26: 53% and 36%.']);
  assert.equal(out[2].text, 'No reliable pattern in US stocks over 2016–23, checked on 2024–26: after a big one-day jump; last week\'s best stock against its worst. Don\'t assume momentum, a rebound or a continuation.');
  assert.equal(out[2].evidence, 'Beyond the market and each stock\'s usual drift: big jump −0.1% (2016–23) then −0.3%; best vs worst +0.3% (2016–23) then −0.3%.');
  assert.deepEqual(out[2].regimes, { above: 30, below: 5 }); // only as broad as its narrowest part
  assert.ok(!('topic' in out[0]) && !('brief' in out[1]));
  // a lesson the owner removed stays out, also from the one line
  const hid = promptMarketLessons(year, long, 'US', { hidden: ['US:10y:best-worst', 'US:10y:stops'] });
  assert.deepEqual(hid.map((l) => l.id), ['US:10y:big-down', 'US:10y:no-pattern', 'US:news-positive']);
  assert.doesNotMatch(hid[1].text, /best stock/);
  assert.equal(promptMarketLessons(year, long, 'US', { hidden: ['US:10y:big-up', 'US:10y:best-worst'] }).some((l) => l.id === 'US:10y:no-pattern'), false);
  // without the ten-year memory: the past year's lessons, as before
  assert.deepEqual(promptMarketLessons(year, null, 'US').map((l) => l.id), ['US:big-up', 'US:news-positive']);
  // a study measured on fewer years than the market (results dates only go back a few years) says so
  const results = { ...long.markets.US, studies: { ...long.markets.US.studies, results: { check: { status: 'no-pattern' }, years: { train: '2022–23', test: '2024–26' } }, 'big-up': { check: { status: 'no-pattern' }, years: { train: '2016–23', test: '2024–26' } } },
    lessons: [...long.markets.US.lessons, mk('results', 'no-pattern', { topic: 'the month after results', brief: 'results −0.6% (2022–23) then −3.4%' })] };
  const text = promptMarketLessons(null, { markets: { US: results } }, 'US').find((l) => l.id === 'US:10y:no-pattern').text;
  assert.equal(text, 'No reliable pattern in US stocks over 2016–23, checked on 2024–26: after a big one-day jump; last week\'s best stock against its worst; the month after results (only 2022–23). Don\'t assume momentum, a rebound or a continuation.');
});
