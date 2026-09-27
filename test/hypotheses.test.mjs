import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateSpec, describeSpec, answerLong, answerIdeas, ideaCases, questionFrom, addQuestion, answerDue, answerWaiting, answerWaitingIdeas,
  waitingLong, statusLabel, APPLIES, FILTERS, POPULATIONS, ASK,
} from '../hypotheses.js';
import { seriesFrom, cleanSeries, longCases, holdoutCheck, VIX, HOLDOUT } from '../memory-long.js';
import { events } from '../scripts/fetch-prices.mjs';
import { seeded, gauss } from '../stats.js';
import { FACTOR_KEYS } from '../factors.js';

const root = new URL('..', import.meta.url).pathname;
const symbols = JSON.parse(await readFile(new URL('../symbols.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-09-28T02:00:00Z');

// ---------- made-up Yahoo answers (as test/memory-long.test.mjs makes them) ----------

function weekdays(n, from = '2016-09-26', market = 'US') {
  const out = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); out.length < n; d += 86400000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) out.push(d / 1000 + (market === 'US' ? 14.5 : 1) * 3600);
  }
  return out;
}
function chart(ts, closes, { volume = null, dividends = [] } = {}) {
  const divAt = new Map(dividends.map(([i, a]) => [i, a]));
  const adjclose = new Array(closes.length);
  let f = 1;
  for (let i = closes.length - 1; i >= 0; i--) {
    adjclose[i] = closes[i] * f;
    if (divAt.has(i) && i > 0) f *= 1 - divAt.get(i) / closes[i - 1];
  }
  return {
    meta: { currency: 'USD', regularMarketPrice: closes.at(-1) }, timestamp: ts,
    events: { dividends: Object.fromEntries(dividends.map(([i, amount]) => [ts[i], { amount, date: ts[i] }])) },
    indicators: { quote: [{ close: closes, volume: volume ?? closes.map(() => 1000), high: closes, low: closes }], adjclose: [{ adjclose }] },
  };
}
// A market of stocks that are beta 1 plus their own noise over ten years from 2016; `shape(symbol, i,
// r, m)` may change a stock's return, `divs[symbol](i, prev)` pay a dividend (and drop the price).
function market({ n = 2560, stocks, seed = 3, shape = null, divs = {}, marketName = 'US', volume = null }) {
  const rand = seeded(seed);
  const ts = weekdays(n, '2016-09-26', marketName);
  const m = Array.from({ length: n }, () => 0.0003 + 0.008 * gauss(rand));
  const walk = (f) => { const out = [100]; for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + f(i))); return out; };
  const out = { [marketName === 'US' ? 'SPY' : 'ES3.SI']: chart(ts, walk((i) => m[i])) };
  for (const sym of stocks) {
    const closes = [100], dividends = [];
    for (let i = 1; i < n; i++) {
      let r = m[i] + 0.012 * gauss(rand);
      if (shape) r = shape(sym, i, r, m[i]);
      let c = closes[i - 1] * (1 + r);
      const d = divs[sym]?.(i, closes[i - 1]);
      if (d) { dividends.push([i, d.amount]); c -= d.drop; }
      closes.push(c);
    }
    out[sym] = chart(ts, closes, { dividends, volume: volume ? closes.map((_, i) => volume(sym, i)) : null });
  }
  out[VIX] = chart(ts, m.map((x) => 12 + Math.abs(x) * 1200));
  return { ts, results: out };
}
const cleaned = (results) => Object.fromEntries(Object.entries(results).map(([s, r]) => [s, cleanSeries(seriesFrom(r, events(r) ?? null), { macro: s === VIX })]));
const spec = (over = {}) => ({ population: 'big_moves', market: 'US', symbols: [], direction: 'any', size: 'any', volume: 'any', vix: 'any', index_trend: 'any', results: 'any', horizon: 5, expect: 'any', ...over });
const raw = (over = {}) => ({ answerable: true, reason: '', population: 'big_moves', market: 'US', symbols: [], direction: 'any', size: 'any', volume: 'any', vix: 'any', index_trend: 'any', results: 'any', horizon: '1_week', expect: 'any', ...over });

// ---------- the spec ----------

test('a spec is checked against the whitelist: populations, enum filters, watchlist symbols, horizons and expectations', () => {
  let v = validateSpec(raw({ symbols: ['nvda'], direction: 'down', expect: 'reverse', market: 'any' }), symbols);
  assert.deepEqual(v, { ok: true, spec: spec({ symbols: ['NVDA'], direction: 'down', expect: 'reverse' }) }); // the market follows the stock
  v = validateSpec(raw({ population: 'ex_dividend', market: 'SGX', symbols: ['D05.SI', 'O39.SI', 'U11.SI'], horizon: '1_month', expect: 'up' }), symbols);
  assert.equal(v.ok, true);
  assert.equal(v.spec.horizon, 21);
  // the AI's own reason when it said the data can't answer, clipped
  assert.deepEqual(validateSpec(raw({ answerable: false, population: 'none', reason: `It needs P/E ratios. ${'x'.repeat(400)}` }), symbols).reason.length, ASK.reasonMax);
  const why = (over) => validateSpec(raw(over), symbols).reason;
  assert.match(why({ population: 'eval(process.exit())' }), /doesn't fit any of the kinds of days/);
  assert.match(why({ symbols: ['NFLX'] }), /^NFLX isn't a stock on the watchlist/);
  assert.match(why({ symbols: ['SPY'] }), /^SPY isn't a stock on the watchlist/); // an index fund isn't a stock here
  assert.match(why({ symbols: ['D05.SI'], market: 'US' }), /outside the US market/);
  assert.match(why({ market: 'HK' }), /other than US or SGX/);
  assert.match(why({ vix: 'panic' }), /VIX level this data doesn't have/);
  assert.match(why({ population: 'ex_dividend', direction: 'down' }), /A direction doesn't apply to ex-dividend dates/);
  assert.match(why({ population: 'results_days', size: 'over_10' }), /A size of move doesn't apply to results days/);
  assert.match(why({ results: 'beat' }), /A results outcome doesn't apply to big one-day moves/);
  assert.match(why({ horizon: '1_year' }), /other than the next day, week or month/);
  // an inherited key of the whitelist object isn't in the whitelist
  for (const h of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) assert.match(why({ horizon: h }), /other than the next day, week or month/, h);
  for (const k of ['direction', 'vix', 'expect', 'population', 'market']) assert.equal(validateSpec(raw({ [k]: 'constructor' }), symbols).ok, false, k);
  // a lone symbol as a string is that symbol, not every stock; a symbols value of another kind is refused
  assert.deepEqual(validateSpec(raw({ symbols: 'aapl' }), symbols).spec.symbols, ['AAPL']);
  assert.match(why({ symbols: { 0: 'AAPL' } }), /couldn't be read/);
  assert.deepEqual(validateSpec(raw({ symbols: null }), symbols).spec.symbols, []);
  assert.match(why({ expect: 'moon' }), /expects something other than/);
  assert.match(why({ population: 'ex_dividend', expect: 'continue' }), /no move of its own to continue/);
  // the funds' ideas are graded a week and a month on
  v = validateSpec(raw({ population: 'fund_ideas', horizon: '1_day', direction: 'up', expect: 'continue' }), symbols);
  assert.deepEqual([v.ok, v.spec.horizon], [true, 5]);
  assert.match(v.note, /answered over a week/);
  // every population's filters are enums the schema lists
  for (const p of POPULATIONS) for (const k of APPLIES[p]) assert.ok(FILTERS[k].length > 1, `${p} ${k}`);
});

test('a spec reads back in plain words', () => {
  assert.equal(describeSpec(spec({ symbols: ['NVDA'], direction: 'down', vix: 'stressed', expect: 'reverse' })),
    'Big one-day drops (at least 4% and 2.5 times the usual daily move) in NVDA, with the VIX stressed (over 25): the next week, expecting the move to reverse.');
  assert.equal(describeSpec(spec({ population: 'ex_dividend', market: 'SGX', symbols: ['D05.SI', 'O39.SI', 'U11.SI'], horizon: 21, expect: 'up' })),
    'Ex-dividend dates of D05.SI, O39.SI and U11.SI: the next month (21 trading days), expecting the price to rise, beyond the market.');
  assert.equal(describeSpec(spec({ population: 'weekly_stock_sample', market: 'any', direction: 'up', index_trend: 'below', expect: 'continue' })),
    'Weeks that beat the index, for the watchlist\'s stocks, with the index below its 200-day average: the next week, expecting the move to continue.');
  assert.equal(describeSpec(spec({ population: 'fund_ideas', direction: 'up', expect: 'continue' })), 'The AI funds\' buys in US stocks: the next week, expecting the ideas to work.');
});

// ---------- the answers on ten years ----------

// Four US stocks: every 40 sessions A drops 7% and then bounces 0.6% a day for 5 days (both periods);
// B jumps 7% every 40 sessions and then drifts at random.
const bounce = (sym, i, r, m) => {
  if (sym === 'A' && i % 40 === 0) return m - 0.07;
  if (sym === 'A' && i % 40 >= 1 && i % 40 <= 5) return m + 0.006 + 0.004 * ((i % 2) ? 1 : -1);
  if (sym === 'B' && i % 40 === 20) return m + 0.07;
  return r;
};
const usSymbols = [...['A', 'B', 'C', 'D'].map((symbol) => ({ symbol, market: 'US' })), { symbol: 'SPY', market: 'US', etf: true }];
const us = market({ stocks: ['A', 'B', 'C', 'D'], shape: bounce });
const usData = longCases({ series: cleaned(us.results), symbols: usSymbols });

test('the cases behind questions: every big move, ex-date, results day and stock-week, with a day, a week and a month after', () => {
  const m = usData.markets.US;
  assert.deepEqual(m.stocks, ['A', 'B', 'C', 'D']);
  const a = m.cases.big_moves.filter((x) => x.symbol === 'A' && x.direction < 0);
  assert.ok(a.length >= 55, `A's drops ${a.length}`);
  const first = a.find((x) => x.x1 != null);
  assert.ok(first.x1 != null && first.x5 != null && first.x21 != null && first.end1 < first.end5 && first.end5 < first.end21);
  assert.ok(['calm', 'normal', 'stressed'].includes(first.vix) && ['above', 'below', null].includes(first.trend ?? null));
  // one case per stock per week, in the direction it went against the index that week
  const weeks = m.cases.weekly_stock_sample.filter((x) => x.symbol === 'C');
  assert.ok(weeks.length > 500 && weeks.length < 530, `weeks ${weeks.length}`);
  assert.ok(weeks.every((x) => [1, -1].includes(x.direction) && Number.isFinite(x.move)));
  assert.equal(new Set(weeks.map((x) => x.date)).size, weeks.length);
  assert.deepEqual(usData.leftOut, []);
});

test('a question on big moves: confirmed when it held the way expected, rejected when the opposite held, no reliable pattern as a normal answer', () => {
  let a = answerLong(spec({ symbols: ['A'], direction: 'down', expect: 'up' }), usData);
  assert.equal(a.status, 'confirmed', a.text);
  assert.equal(a.agreed, true);
  assert.match(a.text, /^Yes\. 201\d–23: the next week, the price moved \+\d\.\d%, beyond the market and the stock's usual drift \(likely \+\d\.\d% to \+\d\.\d%; \d+ separate bets on \d+ separate dates, from \d+ cases in all\), (a \d\d%|over a 99%) chance of that sign\. 2024–26, held out: \+\d\.\d% \(\d+ separate bets\), which agreed\.$/);
  assert.ok(a.numbers.train.edge > 0.015 && a.numbers.train.bets >= 45 && a.numbers.test.bets >= 10, JSON.stringify(a.numbers));
  // the same cases expecting the fall to go on: the opposite held
  a = answerLong(spec({ symbols: ['A'], direction: 'down', expect: 'continue' }), usData);
  assert.deepEqual([a.status, a.verdict], ['rejected', 'opposite']);
  assert.match(a.text, /^No: the opposite held\. 201\d–23: the next week, the price moved \d\.\d% against the big move's direction \(it reversed\), beyond/);
  // B's jumps are followed by nothing in particular
  a = answerLong(spec({ symbols: ['B'], direction: 'up', expect: 'continue' }), usData);
  assert.deepEqual([a.status, a.verdict], ['rejected', 'no-pattern'], a.text);
  assert.match(a.text, /^No reliable pattern\. .*Don't assume it either way\.$/);
  assert.equal(statusLabel({ status: 'rejected', verdict: 'no-pattern' })[0], 'no reliable pattern');
  // a day after, from the same cases
  a = answerLong(spec({ symbols: ['A'], direction: 'down', expect: 'up', horizon: 1 }), usData);
  assert.equal(a.status, 'confirmed', a.text);
  assert.match(a.text, /: the next trading day, the price moved/);
  // too few: big moves of over 10% hardly happen here
  a = answerLong(spec({ size: 'over_10', expect: 'up' }), usData);
  assert.deepEqual([a.status, a.verdict], ['not-enough', 'too-few']);
  assert.match(a.text, /^Not enough data(: no case matched the question in the data\.| to check: \d+ separate bets? in .* a check needs 8 and 5\.)$/);
  // the numbers are the held-out check's, unchanged (per week, times the horizon)
  const items = usData.markets.US.cases.big_moves.filter((x) => x.symbol === 'A' && x.direction < 0).map((x) => ({ ...x, x5: x.x5 == null ? null : -x.x5 }));
  const check = holdoutCheck(items, 5);
  assert.equal(answerLong(spec({ symbols: ['A'], direction: 'down', expect: 'up' }), usData).numbers.train.edge, Math.round(check.train.edge * 1e5) / 1e5);
});

test('a stock the ten-year build left out is named, and a market with no prices this time waits', () => {
  const series = cleaned(us.results);
  series.D = cleanSeries(seriesFrom(chart(us.ts.slice(0, 100), Array(100).fill(0).map((_, i) => 50 + i))));
  const data = longCases({ series, symbols: usSymbols });
  assert.deepEqual(data.leftOut, [{ symbol: 'D', why: 'less than a year of prices' }]);
  let a = answerLong(spec({ symbols: ['D'], expect: 'up' }), data);
  assert.deepEqual([a.status, a.text], ['cant-answer', 'D isn\'t in the ten-year data: less than a year of prices. So there\'s nothing to answer this from.']);
  a = answerLong(spec({ symbols: ['A', 'D'], direction: 'down', expect: 'up' }), data);
  assert.equal(a.status, 'confirmed');
  assert.match(a.text, / D isn't in the ten-year data: less than a year of prices\.$/);
  // the whole market: said once for each stock left out
  assert.match(answerLong(spec({ direction: 'down', expect: 'up' }), data).text, /D isn't in the ten-year data/);
  // SGX had no prices: nothing to answer from yet
  assert.equal(answerLong(spec({ market: 'SGX', expect: 'up' }), data), null);
  assert.equal(answerLong(spec({ market: 'any', expect: 'up' }), data), null);
});

test('a market whose index came back unusable is answered "can\'t answer" with why, and isn\'t downloaded again and again', () => {
  const series = cleaned(us.results);
  series.SPY = { ...series.SPY, leftOut: '139 days where Yahoo\'s adjusted prices broke' };
  const data = longCases({ series, symbols: usSymbols });
  assert.equal(data.markets.US, undefined);
  assert.match(data.unusable.US, /^SPY, the US index the answers are measured against, isn't usable in the ten-year data: 139 days/);
  assert.match(data.leftOut[0].why, /^its index SPY isn't usable \(139 days/);
  let a = answerLong(spec({ symbols: ['A'], expect: 'up' }), data);
  assert.deepEqual([a.status, a.verdict], ['cant-answer', 'left-out']);
  assert.match(a.text, /^SPY, the US index .*: 139 days where Yahoo's adjusted prices broke\. So there's nothing to answer this from\.$/);
  // the whole market too; with SGX's prices simply missing this time, an "any market" question still waits for them
  assert.equal(answerLong(spec({ expect: 'up' }), data).status, 'cant-answer');
  assert.equal(answerLong(spec({ market: 'any', expect: 'up' }), data), null);
  // answered once: no fresh ten-year download for it every 20 hours
  const NOW = new Date('2026-09-27T00:00:00Z');
  const qs = [{ id: 'q1', status: 'waiting', spec: spec({ symbols: ['A'], expect: 'up' }) }];
  assert.deepEqual(answerWaiting(qs, data, NOW), { answered: 1, waiting: 0 });
  assert.equal(qs[0].status, 'cant-answer');
  assert.equal(answerDue(qs, { now: new Date(NOW.getTime() + 30 * 3600000) }), false);
  // an index that didn't arrive at all is a retry, not an answer
  const missing = cleaned(us.results);
  delete missing.SPY;
  const d2 = longCases({ series: missing, symbols: usSymbols });
  assert.deepEqual(d2.unusable, {});
  assert.match(d2.leftOut[0].why, /had no prices this time/);
  assert.equal(answerLong(spec({ symbols: ['A'], expect: 'up' }), d2), null);
  // every stock unusable is the same as an unusable index
  const bad = cleaned(us.results);
  for (const k of ['A', 'B', 'C', 'D']) bad[k] = { ...bad[k], leftOut: 'less than a year of prices' };
  const d3 = longCases({ series: bad, symbols: usSymbols });
  assert.match(answerLong(spec({ expect: 'up' }), d3).text, /^None of the US stocks has usable prices in the ten-year data\./);
});

test('ex-dividend dates, weeks, the VIX and the index trend as filters', () => {
  // D05.SI pays 2% twice a year, drops 90% of it on the day and recovers 40% of it over the next month
  const divs = { 'D05.SI': (i, prev) => (i % 126 === 60 ? { amount: prev * 0.02, drop: prev * 0.018 } : null) };
  const shape = (sym, i, r, m) => (sym === 'D05.SI' && [...Array(21).keys()].some((k) => (i - 61 - k) % 126 === 0) ? m + 0.4 * 0.02 / 21 : sym === 'D05.SI' ? m : r);
  const sgx = market({ stocks: ['D05.SI', 'O39.SI', 'Z74.SI', 'S68.SI'], marketName: 'SGX', divs, shape });
  const sgxSymbols = [...['D05.SI', 'O39.SI', 'Z74.SI', 'S68.SI'].map((symbol) => ({ symbol, market: 'SGX' })), { symbol: 'ES3.SI', market: 'SGX', etf: true }];
  const data = longCases({ series: cleaned(sgx.results), symbols: sgxSymbols });
  const a = answerLong(spec({ population: 'ex_dividend', market: 'SGX', symbols: ['D05.SI'], horizon: 21, expect: 'up' }), data);
  assert.equal(a.status, 'confirmed', a.text);
  assert.match(a.text, /: the next 21 trading days, the price moved .* separate weeks.*On the ex-date itself the price fell by about 90% of the dividend, after the market's move \(the middle of \d+ ex-dates\)\.$/);
  // the SGX cases carry the VIX too; filters narrow the cases
  const all = data.markets.SGX.cases.weekly_stock_sample;
  assert.ok(all.every((x) => x.vix));
  const calm = answerLong(spec({ population: 'weekly_stock_sample', market: 'SGX', vix: 'calm', expect: 'continue' }), data);
  const any = answerLong(spec({ population: 'weekly_stock_sample', market: 'SGX', expect: 'continue' }), data);
  assert.ok(calm.numbers.cases > 0 && calm.numbers.cases < any.numbers.cases);
  assert.equal(any.numbers.cases, all.filter((x) => x.x5 != null).length);
  const below = answerLong(spec({ population: 'weekly_stock_sample', market: 'SGX', index_trend: 'below', expect: 'up' }), data);
  assert.equal(below.numbers.cases, all.filter((x) => x.trend === 'below' && x.x5 != null).length);
  assert.equal(below.numbers.measure, 'price');
  assert.equal(any.numbers.measure, 'direction');
});

test('an SGX case\'s VIX is the last close before the SGX session ended, never the same date\'s US close', () => {
  // the VIX is 14 at every US close except 30 on 15 March 2023 (20:00 UTC); D05.SI drops 10% on SGX that
  // day (closing 09:00 UTC, before the US opens): its case is calm, and the next day's case is stressed
  const days = [];
  for (let t = Date.parse('2021-01-04T00:00:00Z'); t <= Date.parse('2024-06-28T00:00:00Z'); t += 86400e3) if (![0, 6].includes(new Date(t).getUTCDay())) days.push(t / 1000);
  const D = Date.parse('2023-03-15T00:00:00Z') / 1000;
  const mk = (hour, f) => { const t = [], close = []; let p = 100; days.forEach((d, i) => { p = f(d, p, i); t.push(d + hour * 3600); close.push(p); }); return { t, close, volume: close.map(() => 1e6), adj: close.slice() }; };
  const wiggle = (i, a) => 1 + a * Math.sin(i * 1.7);
  const series = {
    'ES3.SI': cleanSeries(mk(1, (d, p, i) => p * wiggle(i, 0.002))),
    'D05.SI': cleanSeries(mk(1, (d, p, i) => (d === D ? p * 0.9 : p * wiggle(i, 0.004)))),
    'SPY': cleanSeries(mk(14.5, (d, p, i) => p * wiggle(i, 0.002))),
    'AAPL': cleanSeries(mk(14.5, (d, p, i) => (d === D ? p * 0.9 : p * wiggle(i, 0.004)))),
    [VIX]: cleanSeries(mk(14.5, (d) => (d === D ? 30 : 14)), { macro: true }),
  };
  const data = longCases({ series, symbols: [{ symbol: 'ES3.SI', market: 'SGX', etf: true }, { symbol: 'D05.SI', market: 'SGX' }, { symbol: 'SPY', market: 'US', etf: true }, { symbol: 'AAPL', market: 'US' }] });
  const sgx = data.markets.SGX.cases.weekly_stock_sample.concat(data.markets.SGX.cases.big_moves);
  assert.equal(data.markets.SGX.cases.big_moves.find((x) => x.date === '2023-03-15').vix, 'calm');
  const weekOf = (d) => sgx.find((x) => x.date === d);
  assert.equal(weekOf('2023-03-17')?.vix, 'calm'); // Friday's case: the VIX's Thursday close, 14
  // a US case uses the VIX of its own session (both close at the same time)
  assert.equal(data.markets.US.cases.big_moves.find((x) => x.date === '2023-03-15').vix, 'stressed');
  // the first SGX day has no earlier VIX close: no level rather than a later one
  assert.ok(sgx.every((x) => x.date > '2021-01-04' || x.vix == null));
});

// ---------- the funds' own ideas ----------

// A fund's graded ideas over `months` months from `from`: a buy a trading day on 6 stocks, each beating
// the market by `edge` a week plus noise, with its factors (the VIX calm, the index above its average).
function fundIdeas({ id = 'f1', months = 9, from = '2026-01-05', edge = 0.01, seed = 5 } = {}) {
  const rand = seeded(seed);
  const graded = [];
  const start = Date.parse(`${from}T15:00:00Z`) / 1000;
  for (let d = 0; d < months * 21; d++) {
    const t = start + (Math.floor(d / 5) * 7 + (d % 5)) * 86400;
    const x = edge + 0.02 * gauss(rand);
    const factors = FACTOR_KEYS.map((k) => ({ volume20: 1, vix: 14, index200: 0.03 })[k] ?? null);
    graded.push({ kind: 'entry', outcome: 'traded', t, symbol: `S${d % 6}`, direction: 1, idio: 0.03, beta: 1, fee: 0.001,
      week: { move: x + 0.004, index: 0.003 }, month: { move: x * 2 + 0.01, index: 0.009 }, factors });
  }
  return { fund: { id, currency: 'USD', ideaLog: [[graded[0].t, 'S0', 1, 0]] }, graded };
}

test('questions on the funds\' own ideas open after 6 months, found on the first two thirds and checked on the rest', () => {
  const { fund, graded } = fundIdeas();
  const q = spec({ population: 'fund_ideas', direction: 'up', expect: 'continue' });
  // too early: under 6 months of frozen ideas
  let a = answerIdeas(q, { funds: [fund], gradedBy: { f1: graded }, now: new Date('2026-05-01T00:00:00Z') });
  assert.deepEqual([a.status, a.verdict], ['not-enough', 'too-early']);
  assert.match(a.text, /open once their graded ideas go back 6 months, around 2026-07-0\d\. Ask again then\.$/);
  assert.match(answerIdeas(q, { funds: [], now: NOW }).text, /none are graded a month on yet/);
  a = answerIdeas(q, { funds: [fund], gradedBy: { f1: graded }, now: NOW });
  assert.equal(a.status, 'confirmed', a.text);
  assert.match(a.text, /^Yes\. 2026-01-05 to 2026-0\d-\d\d: the next week, the ideas made \+\d\.\d% in their direction, against the market, after beta and fees/);
  assert.match(a.text, /months of ideas, not years, so a first look\.$/);
  // a month on, from the month's grades: the same stock within a month is one bet, so 6 stocks bought
  // every week make 6 long bets, too few; the conditions come from their factors
  const month = answerIdeas({ ...q, horizon: 21 }, { funds: [fund], gradedBy: { f1: graded }, now: NOW });
  assert.deepEqual([month.status, month.numbers.train.bets], ['not-enough', 6]);
  assert.equal(answerIdeas({ ...q, vix: 'stressed' }, { funds: [fund], gradedBy: { f1: graded }, now: NOW }).status, 'not-enough');
  const cases = ideaCases([fund], ['US'], { gradedBy: { f1: graded } });
  assert.ok(cases.every((c) => c.vix === 'calm' && c.trend === 'above' && c.heavy === false));
  // an SGD fund's ideas aren't a US question's; the frozen log counts when there's no run's grading
  assert.equal(ideaCases([{ ...fund, currency: 'SGD' }], ['US'], { gradedBy: { f1: graded } }).length, 0);
  assert.equal(ideaCases([fund], ['US'], { frozen: () => graded }).length, cases.length);
});

// ---------- the questions ----------

test('questions: kept with their spec or the reason, the newest 30, and answered once the data is on the runner', () => {
  const q1 = questionFrom('  Does   NVDA bounce after a big drop?  ', raw({ symbols: ['NVDA'], direction: 'down', expect: 'up' }), symbols, NOW);
  assert.deepEqual([q1.status, q1.text, q1.spec.symbols], ['waiting', 'Does NVDA bounce after a big drop?', ['NVDA']]);
  const q2 = questionFrom('What is Apple\'s P/E?', raw({ answerable: false, population: 'none', reason: 'It needs valuations, which this data doesn\'t hold.' }), symbols, NOW);
  assert.deepEqual([q2.status, q2.reason, q2.answeredAt], ['cant-answer', 'It needs valuations, which this data doesn\'t hold.', NOW.toISOString()]);
  assert.equal(questionFrom('x'.repeat(500), null, symbols, NOW).text.length, ASK.maxChars);
  let list = [];
  for (let i = 0; i < ASK.keep + 5; i++) list = addQuestion(list, { id: `q${i}` });
  assert.deepEqual([list.length, list[0].id, list.at(-1).id], [ASK.keep, 'q5', `q${ASK.keep + 4}`]);
  // due when one waits: at once with the ten years on the runner, else unless one was tried in the last 20 hours
  const fundQ = questionFrom('Do its buys work?', raw({ population: 'fund_ideas', direction: 'up', expect: 'continue' }), symbols, NOW);
  assert.equal(answerDue([q2, fundQ], { now: NOW }), false); // nothing waits for the ten years
  assert.equal(answerDue([q1], { now: NOW }), true);
  const tried = { ...q1, triedAt: new Date(NOW - 3 * 3600000).toISOString() };
  assert.equal(answerDue([tried], { now: NOW }), false);
  assert.equal(answerDue([tried], { now: NOW, rawReady: true }), true);
  assert.equal(answerDue([tried], { now: new Date(NOW.getTime() + 18 * 3600000) }), true);
  // answered in place, the question's words kept; one whose market had no prices waits, marked tried
  const onA = { ...questionFrom('Does A bounce?', raw(), usSymbols.concat(symbols), NOW), spec: spec({ symbols: ['A'], direction: 'down', expect: 'up' }) };
  const onSgx = { ...q1, id: 'sgx', spec: spec({ market: 'SGX', expect: 'up' }) };
  const qs = [onA, onSgx, q2, fundQ];
  assert.deepEqual(answerWaiting(qs, usData, NOW), { answered: 1, waiting: 1 });
  assert.deepEqual([onA.status, onA.text, onA.answeredAt], ['confirmed', 'Does A bounce?', NOW.toISOString()]);
  assert.match(onA.answer, /^Yes\./);
  assert.deepEqual([onSgx.status, onSgx.triedAt], ['waiting', NOW.toISOString()]);
  assert.deepEqual(waitingLong(qs).map((q) => q.id), ['sgx']);
  assert.equal(fundQ.status, 'waiting'); // the funds' ideas are answered by the fund step
  assert.equal(answerWaitingIdeas(qs, { funds: [], now: NOW }), 1);
  assert.deepEqual([fundQ.status, fundQ.verdict], ['not-enough', 'too-early']);
  assert.deepEqual(statusLabel(onA), ['confirmed', 'up']);
  assert.deepEqual(statusLabel({ status: 'confirmed', spec: { expect: 'any' } }), ['a pattern that held', 'up']);
  // a question and its answer stay small (the fund collection is one row, loaded every run)
  assert.ok(JSON.stringify(onA).length < 1500, JSON.stringify(onA).length);
});

test('pure noise: the held-out check the answers use lets through few made-up patterns', () => {
  // questions on made-up stocks with no pattern: at most a few in 40 come out confirmed
  let confirmed = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const m = market({ stocks: ['A', 'B', 'C', 'D'], seed, n: 2560 });
    const data = longCases({ series: cleaned(m.results), symbols: usSymbols });
    for (const s of [spec({ direction: 'down', expect: 'up' }), spec({ direction: 'up', expect: 'continue' }), spec({ population: 'weekly_stock_sample', direction: 'up', expect: 'continue' })]) {
      if (answerLong(s, data)?.status === 'confirmed') confirmed++;
    }
  }
  assert.ok(confirmed <= 2, `confirmed ${confirmed} of 36`);
  assert.equal(HOLDOUT.trainTo, '2023-12-31');
});

// ---------- the scripts ----------

// A stand-in for the Anthropic SDK (as test/reading.test.mjs's): answers with FAKE_SDK_ANSWER and logs
// each request to FAKE_SDK_LOG.
const fakeSdk = `
import { appendFileSync } from 'node:fs';
export default class Anthropic {
  constructor() {
    this.beta = { messages: { stream: (req) => {
      if (process.env.FAKE_SDK_LOG) appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(req) + '\\n');
      const tool = req.tools.find((t) => t.input_schema);
      return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't1', name: tool.name, input: JSON.parse(process.env.FAKE_SDK_ANSWER ?? '{}') }], usage: { input_tokens: 2000, output_tokens: 150 } }) };
    } } };
  }
}`;
const hooks = `export async function resolve(s, c, n) { return s === '@anthropic-ai/sdk' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeSdk)}`)}, shortCircuit: true } : n(s, c); }`;
const withFakeSdk = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`)}`;
const { FUND_COMMAND, GITHUB_EVENT_PATH, ...baseEnv } = process.env;

test('ai-fund.mjs: the owner\'s question becomes a query kept with the funds; its words are never printed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-'));
  for (const d of ['data', 'state']) await mkdir(join(dir, d));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [], archived: [] }));
  const log = join(dir, 'sdk.log');
  const run = (ask, answer, env = {}) => spawnSync('node', ['--import', withFakeSdk, join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8',
    env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', FUND_PRIVATE: '', AI_MONTHLY_CAP_USD: '', AI_NEWS_MODEL: '', FAKE_SDK_LOG: log, FAKE_SDK_ANSWER: JSON.stringify(answer), FUND_COMMAND: JSON.stringify({ fund: 'all', ask }), ...env },
  });
  const state = async () => JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  const secret = /Nvidia|NVDA|bounce|valuation|P\/E|buys work/i;
  let out = run('Does Nvidia bounce the week after a big drop?', raw({ symbols: ['NVDA'], direction: 'down', expect: 'up' }));
  assert.equal(out.status, 0, out.stderr);
  let c = await state();
  assert.deepEqual(c.questions.map((q) => [q.text, q.status, q.spec.population, q.spec.symbols]), [['Does Nvidia bounce the week after a big drop?', 'waiting', 'big_moves', ['NVDA']]]);
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok, c.lastCommand.message], ['ask', true, 'Read your question: it\'s answered from the ten years of prices within a day, usually in this run.']);
  assert.doesNotMatch(out.stdout + out.stderr + c.lastCommand.message, secret);
  // one call on the news model, no web search, with the watchlist's stocks (not index funds) and the question
  const req = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools.map((t) => t.name), ['submit_query']);
  assert.match(req.messages[0].content, /^The watchlist's stocks: D05\.SI \(DBS Group, SGX\); .*BRK-B \(Berkshire Hathaway B, US\)\.\n\nThe owner's question:\nDoes Nvidia bounce the week after a big drop\?$/);
  assert.doesNotMatch(req.messages[0].content, /SPY|ES3/);
  assert.equal(JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8')).months[new Date().toISOString().slice(0, 7)].ask, 0.0028); // a fraction of a cent, counted
  // one this data can't answer: kept with the reason, which the message doesn't repeat
  out = run('What is Apple\'s P/E?', raw({ answerable: false, population: 'none', reason: 'It needs valuations.' }));
  c = await state();
  assert.deepEqual(c.questions.map((q) => q.status), ['waiting', 'cant-answer']);
  assert.equal(c.lastCommand.message, 'Read your question: this data can\'t answer it. The reason is under Ask the data.');
  assert.doesNotMatch(out.stdout + out.stderr, secret);
  // one on the funds' own ideas: answered in this run (not enough yet, with no fund)
  out = run('Do its buys work?', raw({ population: 'fund_ideas', direction: 'up', expect: 'continue' }));
  c = await state();
  assert.deepEqual([c.questions[2].status, c.questions[2].verdict], ['not-enough', 'too-early']);
  assert.match(out.stdout, /Ask the data: answered 1 question\(s\) from the funds' own ideas\./);
  assert.doesNotMatch(out.stdout + out.stderr, secret);
  // no key, an empty question
  run('Does DBS rise after results?', raw(), { ANTHROPIC_API_KEY: '' });
  assert.deepEqual([(await state()).lastCommand.ok, (await state()).lastCommand.message], [false, 'ANTHROPIC_API_KEY isn\'t set, so the question couldn\'t be read.']);
  run('   ', raw());
  assert.equal((await state()).lastCommand.message, 'Type a question first.');
  assert.equal((await state()).questions.length, 3);
});

test('build-history.mjs asked and answer: the waiting questions answered from the ten years on the runner, counts only in the log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ask-long-'));
  const rawDir = join(dir, 'raw');
  await mkdir(rawDir);
  const file = join(dir, 'ai-fund.json');
  const run = (...args) => spawnSync('node', [join(root, 'scripts/build-history.mjs'), ...args], { cwd: root, encoding: 'utf8', env: baseEnv });
  const qs = [
    { ...questionFrom('Do Apple\'s big drops bounce back?', raw({ symbols: ['AAPL'], direction: 'down', expect: 'up' }), symbols), id: 'a' },
    { ...questionFrom('Do DBS weeks carry on?', raw({ population: 'weekly_stock_sample', market: 'SGX', symbols: ['D05.SI'], expect: 'continue' }), symbols), id: 'b' },
    questionFrom('Apple P/E?', raw({ answerable: false, population: 'none', reason: 'Valuations.' }), symbols),
  ];
  await writeFile(file, JSON.stringify({ version: 2, funds: [], archived: [], questions: qs }));
  // nothing on the runner, none tried: due (the job downloads the ten years); tried within the hours: not
  let out = run('asked', file, rawDir);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Ask the data: 2 question\(s\) waiting; answering now\./);
  // the download failed: both wait, marked tried, and aren't due again for hours
  for (const s of [...symbols.map((x) => x.symbol), VIX]) await writeFile(join(rawDir, `${encodeURIComponent(s)}_10y_1d.json`), JSON.stringify({ error: 'HTTP 429' }));
  out = run('answer', rawDir, file);
  assert.match(out.stdout, /Ask the data: answered 0 question\(s\) from ten years of prices; 2 wait for prices that didn't come back this time\./);
  let c = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(c.questions.slice(0, 2).every((q) => q.status === 'waiting' && q.triedAt));
  assert.equal(run('asked', file, join(dir, 'none')).status, 1);
  // with this run's ten years on the runner: answered at once
  const usm = market({ stocks: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B'], seed: 7 });
  const sgm = market({ stocks: ['D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'C6L.SI', 'S68.SI', 'BN4.SI', 'C38U.SI', 'Y92.SI'], seed: 8, marketName: 'SGX' });
  const all = { ...usm.results, ...sgm.results, QQQ: usm.results.SPY };
  for (const [s, r] of Object.entries(all)) await writeFile(join(rawDir, `${encodeURIComponent(s)}_10y_1d.json`), JSON.stringify({ chart: { result: [r] } }));
  assert.equal(run('asked', file, rawDir).status, 0);
  out = run('answer', rawDir, file);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Ask the data: answered 2 question\(s\) from ten years of prices\.\n$/);
  assert.doesNotMatch(out.stdout + out.stderr, /Apple|DBS|AAPL|D05|bounce|carry/);
  c = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(c.questions.map((q) => [q.text, q.status === 'waiting', Boolean(q.answer), q.triedAt]), [
    ['Do Apple\'s big drops bounce back?', false, true, undefined], ['Do DBS weeks carry on?', false, true, undefined], ['Apple P/E?', false, false, undefined],
  ]);
  assert.ok(['confirmed', 'rejected', 'not-enough'].includes(c.questions[0].status));
  assert.match(c.questions[1].answer, /2016–23: the next week, the stock moved (\+?\d\.\d% the way its week against the index had gone|\d\.\d% against the way its week against the index had gone \(it reversed\)), beyond the market/);
  // nothing waits now
  assert.match(run('asked', file, rawDir).stdout, /no question waiting/);
});

test('the public copy of the funds leaves the questions out, keeping how many; the funds\' prompts never see them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-ask-'));
  const c = { version: 2, funds: [], archived: [], questions: [questionFrom('A private question about DBS?', raw({ market: 'SGX', symbols: ['D05.SI'] }), symbols)] };
  await writeFile(join(dir, 'in.json'), JSON.stringify(c));
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'in.json'), join(dir, 'out.json')], { cwd: root });
  const out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
  assert.equal(out.questionsAsked, 1);
  assert.equal(out.questions, undefined);
  assert.doesNotMatch(JSON.stringify(out), /private question|D05/);
  // the fund's decision is given no questions: c.questions only goes to its own command and answers
  const job = await readFile(join(root, 'scripts', 'ai-fund.mjs'), 'utf8');
  const decide = job.slice(job.indexOf('await decideFund({'), job.indexOf('});', job.indexOf('await decideFund({')));
  assert.doesNotMatch(decide, /question/);
  const code = job.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal([...code.matchAll(/c\.questions/g)].length, 3); // adding one, and answering those on the funds' ideas
  for (const s of ['fetch-picks.mjs', 'notify.mjs', 'backfill-news.mjs']) assert.doesNotMatch(await readFile(join(root, 'scripts', s), 'utf8'), /questions/, s);
});
