import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultsFromSubmissions, mergeFilings, filingsDue, resultsCalendar, nextResults, upcomingResults, typicalResultsMove } from '../calendar.js';
import { ratingLevel, ratingChange, parseCompany, summaryDue, analystsForPrompt, recentRatingChanges, describeChange } from '../analysts.js';
import { eventsFromFilings, analystEvents, checkVolumeDate, marketEvents, measureEvents, plausibleDate } from '../memory.js';
import { resultsHeadsUp, collectAlerts } from '../alerts.js';
import { tradingDaysBetween, marketDate } from '../markets.js';
import { newFund } from '../fund.js';

const unix = (iso) => Date.parse(iso) / 1000;
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
// Weekday bars from April to late October 2026, stamped at the open (US 13:30 UTC, SGX 01:00 UTC).
const weekdays = (hour) => {
  const out = [];
  for (let d = Date.parse(`2026-04-01T${hour}:00Z`); d <= Date.parse(`2026-10-23T${hour}:00Z`); d += 86400000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) out.push(d / 1000);
  }
  return out;
};
const US_DAYS = weekdays('13:30'), SGX_DAYS = weekdays('01:00');
// A quote whose close on each date is price(date); `volume(date)` adds a third value to each bar.
const quote = (price, { market = 'US', currency = 'USD', volume = null } = {}) => {
  const daily = (market === 'US' ? US_DAYS : SGX_DAYS).map((t) => (volume ? [t, price(day(t)), volume(day(t))] : [t, price(day(t))]));
  return { market, currency, name: 'Test', daily, intraday: [], price: daily.at(-1)[1], time: new Date((daily.at(-1)[0] + 6.5 * 3600) * 1000).toISOString() };
};

// ---------- SEC filings ----------

// Shaped like EDGAR's submissions JSON (filings.recent): parallel arrays, acceptanceDateTime stamped
// 'Z' although it is New York time.
const recent = {
  accessionNumber: ['0000320193-26-000070', '0000320193-26-000068', '0000320193-26-000060', '0000320193-26-000050'],
  filingDate: ['2026-07-30', '2026-07-31', '2026-07-15', '2026-05-01'],
  acceptanceDateTime: ['2026-07-30T16:30:41.000Z', '2026-07-31T18:01:12.000Z', '2026-07-15T08:00:00.000Z', '2026-05-01T06:45:00.000Z'],
  form: ['8-K', '10-Q', '8-K', '8-K'],
  items: ['2.02,9.01', '', '5.07', '2.02'],
  primaryDocument: ['a8-k.htm', 'q3.htm', 'b8-k.htm', 'c8-k.htm'],
};

test('SEC filings: results 8-Ks with the first session that could trade on them', () => {
  const out = resultsFromSubmissions(recent, 'AAPL', '0000320193');
  assert.deepEqual(out.map((f) => [f.date, f.time, f.effectiveDate, f.form]), [
    ['2026-07-30', '2026-07-30T16:30', '2026-07-31', '8-K'], // after the 4pm close (New York time, despite the Z): next day
    ['2026-05-01', '2026-05-01T06:45', '2026-05-01', '8-K'], // before the open: that day
  ]);
  assert.equal(out[0].url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000070/a8-k.htm');
  // Berkshire Hathaway publishes its results in the 10-Q itself, on a Saturday morning
  const brk = resultsFromSubmissions({
    form: ['10-Q', '8-K'], items: ['', '2.02'], acceptanceDateTime: ['2026-08-01T08:05:00.000Z', '2026-08-03T09:00:00.000Z'], accessionNumber: ['a', 'b'],
  }, 'BRK-B');
  assert.deepEqual(brk.map((f) => [f.form, f.effectiveDate]), [['10-Q', '2026-08-03']]); // the Monday after
  assert.deepEqual(resultsFromSubmissions(undefined, 'AAPL'), []);
});

test('filings merge one per results, and are checked every 2 hours and always after the US close', () => {
  const a = { date: '2026-07-30', time: '2026-07-30T16:30' }, amended = { date: '2026-07-31', time: '2026-07-31T09:00' }, b = { date: '2026-10-29', time: '2026-10-29T16:30' };
  assert.deepEqual(mergeFilings([a], [amended, b]), [a, b]);
  assert.equal(mergeFilings([], Array.from({ length: 20 }, (_, i) => ({ date: `20${10 + i}-01-15`, time: `20${10 + i}-01-15T16:30` }))).length, 16);
  assert.equal(filingsDue(null), true);
  assert.equal(filingsDue({ checkedAt: '2026-09-21T20:00:00Z' }, new Date('2026-09-21T21:30:00Z')), false);
  assert.equal(filingsDue({ checkedAt: '2026-09-21T20:00:00Z' }, new Date('2026-09-21T22:30:00Z')), true); // the evening run
  assert.equal(filingsDue({ checkedAt: '2026-09-21T22:31:00Z' }, new Date('2026-09-21T23:00:00Z')), false);
  assert.equal(filingsDue({ checkedAt: '2026-09-21T13:00:00Z' }, new Date('2026-09-21T15:00:00Z')), true);
});

// ---------- Yahoo's company data ----------

// Shaped like the probe's quoteSummary answers (NVDA, C38U.SI and Z74.SI in stage 1's probe).
const NOW = new Date('2026-09-27T12:00:00Z');
const nvdaSummary = {
  calendarEvents: { earnings: { earningsDate: [{ raw: 1794945600, fmt: '2026-11-17' }], earningsCallDate: [{ raw: 1787778000, fmt: '2026-08-26' }], isEarningsDateEstimate: false } },
  earningsHistory: { history: [
    { epsActual: { raw: 1.87 }, epsEstimate: { raw: 1.77191 }, surprisePercent: { raw: 0.0554 }, quarter: { raw: 1777507200, fmt: '2026-04-30' }, period: '-2q' },
    { epsActual: { raw: 2.22 }, epsEstimate: { raw: 2.09113 }, surprisePercent: { raw: 0.0616 }, quarter: { raw: 1785456000, fmt: '2026-07-31' }, period: '-1q' },
  ] },
  upgradeDowngradeHistory: { history: [
    { epochGradeDate: 1789048960, firm: 'Piper Sandler', toGrade: 'Overweight', fromGrade: '', action: 'init', priceTargetAction: 'Announces', currentPriceTarget: 300, priorPriceTarget: 0 },
    { epochGradeDate: 1788521889, firm: 'Rosenblatt', toGrade: 'Buy', fromGrade: 'Buy', action: 'main', priceTargetAction: 'Maintains', currentPriceTarget: 390, priorPriceTarget: 390 },
    { epochGradeDate: unix('2026-09-21T11:00:00Z'), firm: 'Jefferies', toGrade: 'Buy', fromGrade: 'Hold', action: 'up', priceTargetAction: 'Raises', currentPriceTarget: 245, priorPriceTarget: 210 },
    { epochGradeDate: unix('2026-09-18T11:00:00Z'), firm: 'Renamer', toGrade: 'Outperform', fromGrade: 'Buy', action: 'up', priceTargetAction: 'Raises', currentPriceTarget: 250, priorPriceTarget: 240 },
    { epochGradeDate: unix('2026-09-17T11:00:00Z'), firm: 'Cautious Co', toGrade: 'Neutral', fromGrade: 'Buy', action: 'down', priceTargetAction: 'Lowers', currentPriceTarget: 200, priorPriceTarget: 230 },
    { epochGradeDate: unix('2024-01-10T11:00:00Z'), firm: 'Old', toGrade: 'Buy', fromGrade: 'Hold', action: 'up', currentPriceTarget: 50, priorPriceTarget: 40 },
  ] },
  recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 48, hold: 2, sell: 1, strongSell: 0 }, { period: '-1m', strongBuy: 9, buy: 47, hold: 3, sell: 1, strongSell: 0 }] },
  financialData: { currentPrice: { raw: 225.07 }, targetMeanPrice: { raw: 327.7 }, targetMedianPrice: { raw: 315 }, targetHighPrice: { raw: 515 }, targetLowPrice: { raw: 180 }, numberOfAnalystOpinions: { raw: 59 } },
};

test('broker ratings map to levels, and only real upgrades and downgrades count as changes', () => {
  assert.equal(ratingLevel('Overweight'), 4);
  assert.equal(ratingLevel(' Equal-Weight '), 3);
  assert.equal(ratingLevel('Strong Sell'), 1);
  assert.equal(ratingLevel('Market Perform'), 3);
  assert.equal(ratingLevel('Something new'), null);
  const [, , up, renamed, down] = nvdaSummary.upgradeDowngradeHistory.history;
  assert.deepEqual(ratingChange(up), [up.epochGradeDate, 'Jefferies', 'Hold', 'Buy', 1, 210, 245]);
  assert.equal(ratingChange(renamed), null); // Buy -> Outperform is the same level
  assert.equal(ratingChange(down)[4], -1);
  assert.equal(ratingChange(nvdaSummary.upgradeDowngradeHistory.history[0]), null); // starting coverage
  assert.equal(ratingChange(nvdaSummary.upgradeDowngradeHistory.history[1]), null); // maintained
  assert.equal(ratingChange({ ...up, fromGrade: 'Hold', toGrade: 'Accumulate-ish', action: 'down' })[4], -1); // unknown words: Yahoo's action
});

test('company data: next results date, surprises, ratings, target and real changes from quoteSummary', () => {
  const nvda = parseCompany(nvdaSummary, NOW);
  assert.deepEqual(nvda.next, { date: '2026-11-17', estimate: false });
  assert.deepEqual(nvda.past, ['2026-08-26']); // the last results call has passed
  assert.deepEqual(nvda.eps.map((e) => [e.quarter, e.actual, e.surprise]), [['2026-04-30', 1.87, 0.0554], ['2026-07-31', 2.22, 0.0616]]);
  assert.deepEqual(nvda.ratings, { strongBuy: 10, buy: 48, hold: 2, sell: 1, strongSell: 0 });
  assert.deepEqual(nvda.target, { mean: 327.7, median: 315, high: 515, low: 180, n: 59 });
  assert.deepEqual(nvda.changes.map((c) => c[1]), ['Jefferies', 'Cautious Co']); // newest first; the 2024 one is too old
  assert.equal(nvda.ratingRows, 6);

  // C38U.SI: Yahoo still shows last quarter's date, so the next one is unknown; no earnings history
  const c38u = parseCompany({
    calendarEvents: { earnings: { earningsDate: [{ raw: 1786525200, fmt: '2026-08-12' }], earningsCallDate: [{ raw: 1786525200, fmt: '2026-08-12' }], isEarningsDateEstimate: false } },
    earningsHistory: { history: [] }, recommendationTrend: { trend: [{ period: '0m', strongBuy: 3, buy: 10, hold: 3, sell: 0, strongSell: 0 }] },
    financialData: { targetMeanPrice: { raw: 2.6825 }, numberOfAnalystOpinions: { raw: 16 } },
  }, NOW);
  assert.equal(c38u.next, null);
  assert.deepEqual(c38u.past, ['2026-08-12']);
  assert.equal(c38u.ratingRows, 0);

  // Z74.SI: an estimated date, and quarters without an actual EPS
  const z74 = parseCompany({
    calendarEvents: { earnings: { earningsDate: [{ raw: 1794387600, fmt: '2026-11-11' }], earningsCallDate: [], isEarningsDateEstimate: true } },
    earningsHistory: { history: [{ epsEstimate: { raw: 0.04497 }, quarter: { raw: 1759190400, fmt: '2025-09-30' } }] },
  }, NOW);
  assert.deepEqual(z74.next, { date: '2026-11-11', estimate: true });
  assert.equal(z74.eps[0].actual, null);
  assert.equal(z74.ratings, null);

  // A day later, what was learned before is kept and a passed confirmed date joins the past
  const later = parseCompany({ calendarEvents: { earnings: { earningsDate: [], isEarningsDateEstimate: false } } }, new Date('2026-11-18T12:00:00Z'), nvda);
  assert.deepEqual(later.past, ['2026-08-26', '2026-11-17']);
  assert.equal(later.next, null);
  assert.equal(later.eps.length, 2);
  assert.deepEqual(later.target, nvda.target);
});

test('Yahoo is asked once a day, after the US close, and not again within 2 hours of a failure', () => {
  assert.equal(summaryDue(null), true);
  assert.equal(summaryDue({ fetchedAt: '2026-09-24T22:40:00Z' }, new Date('2026-09-25T15:00:00Z')), false); // today's comes this evening
  assert.equal(summaryDue({ fetchedAt: '2026-09-24T22:40:00Z' }, new Date('2026-09-25T22:31:00Z')), true);
  assert.equal(summaryDue({ fetchedAt: '2026-09-25T22:35:00Z' }, new Date('2026-09-25T23:00:00Z')), false);
  assert.equal(summaryDue({ fetchedAt: '2026-09-23T22:40:00Z' }, new Date('2026-09-25T09:00:00Z')), true); // missed an evening
  assert.equal(summaryDue({ fetchedAt: '2026-09-23T22:40:00Z', triedAt: '2026-09-25T08:00:00Z' }, new Date('2026-09-25T09:00:00Z')), false);
  // a catch-up fetch that morning doesn't take the place of that evening's
  assert.equal(summaryDue({ fetchedAt: '2026-09-28T01:00:00Z' }, new Date('2026-09-28T22:30:00Z')), true);
});

test('over two weeks of the scheduled job, Yahoo is asked on the 22:30 UTC run every weekday', () => {
  // prices.yml: every 15 minutes 01-09 and 13-21 UTC, plus 22:30, Monday to Friday; every fetch works
  let data = { fetchedAt: '2026-09-25T22:30:00Z' }; // Friday evening
  const fetched = [];
  for (let t = Date.parse('2026-09-26T00:00:00Z'); t < Date.parse('2026-10-10T00:00:00Z'); t += 15 * 60000) {
    const d = new Date(t), h = d.getUTCHours(), m = d.getUTCMinutes();
    if ([0, 6].includes(d.getUTCDay())) continue;
    if (!((h >= 1 && h <= 9) || (h >= 13 && h <= 21) || (h === 22 && m === 30))) continue;
    if (summaryDue(data, d)) { data = { fetchedAt: d.toISOString(), triedAt: d.toISOString() }; fetched.push(d.toISOString().slice(0, 16)); }
  }
  // Monday's first run catches up after the weekend (over 30 hours); every weekday evening fetches after the close
  assert.deepEqual(fetched, [
    '2026-09-28T01:00', '2026-09-28T22:30', '2026-09-29T22:30', '2026-09-30T22:30', '2026-10-01T22:30', '2026-10-02T22:30',
    '2026-10-05T01:00', '2026-10-05T22:30', '2026-10-06T22:30', '2026-10-07T22:30', '2026-10-08T22:30', '2026-10-09T22:30',
  ]);
});

// ---------- the calendar ----------

// AAPL jumps 4% on 1 May (results before the open) and 6% on 31 Jul (results after the close on 30 Jul).
const aapl = quote((d) => (d < '2026-05-01' ? 100 : d < '2026-07-31' ? 104 : 104 * 1.06));
const quotes = {
  SPY: quote(() => 400), AAPL: aapl, MSFT: quote(() => 300), GOOGL: quote(() => 150),
  'D05.SI': quote(() => 40, { market: 'SGX', currency: 'SGD' }), 'Z74.SI': quote(() => 4, { market: 'SGX', currency: 'SGD' }), 'ES3.SI': quote(() => 4, { market: 'SGX', currency: 'SGD' }),
};
const filings = { symbols: {
  AAPL: resultsFromSubmissions(recent, 'AAPL'),
  MSFT: [{ date: '2026-10-22', time: '2026-10-22T16:05', effectiveDate: '2026-10-23', form: '8-K' }],
  GOOGL: [{ date: '2026-10-21', time: '2026-10-21T16:10', effectiveDate: '2026-10-22', form: '8-K' }],
} };
const company = { symbols: {
  AAPL: { next: { date: '2026-10-29', estimate: false }, past: [] },
  MSFT: { next: { date: '2026-10-22', estimate: false }, past: [] },
  GOOGL: { next: { date: '2026-10-23', estimate: false }, past: [] }, // Yahoo hasn't moved on from the release yet
  'D05.SI': { next: { date: '2026-11-05', estimate: false }, past: ['2026-08-07'] },
  'Z74.SI': { next: { date: '2026-11-11', estimate: true }, past: [] },
} };
const FRI = new Date('2026-10-23T12:00:00Z'); // 8am in New York, 8pm in Singapore

test('the results calendar: a filing beats Yahoo, a confirmed date beats an estimate, and results days are measured', () => {
  const cal = resultsCalendar({ company, filings, quotes, now: FRI });
  assert.deepEqual(cal.AAPL.next, { date: '2026-10-29', source: 'yahoo' });
  assert.deepEqual(cal.MSFT.next, { date: '2026-10-22', effectiveDate: '2026-10-23', time: '2026-10-22T16:05', source: 'filing' }); // out last night
  assert.equal(cal.GOOGL.next, null); // Yahoo's date is the release already filed
  assert.equal(cal['Z74.SI'].next.source, 'estimated');
  assert.deepEqual(cal.AAPL.past.map((p) => [p.date, p.source]), [['2026-05-01', 'filing'], ['2026-07-30', 'filing']]);
  const t = cal.AAPL.typicalMove;
  assert.equal(t.n, 2);
  assert.ok(Math.abs(t.avg - 0.05) < 1e-9); // 4% and 6%, measured on the first session each could trade on
  assert.equal(typicalResultsMove(aapl, quotes.SPY, [{ date: '2026-07-30' }]), null); // one result isn't a typical move
  // without an exact time, the bigger of the day and the next counts
  const guessed = typicalResultsMove(aapl, quotes.SPY, [{ date: '2026-07-30' }, { date: '2026-04-30' }]);
  assert.ok(Math.abs(guessed.avg - 0.05) < 1e-9);

  assert.equal(nextResults(cal, 'MSFT', quotes, FRI).daysAway, 0);
  assert.equal(nextResults(cal, 'AAPL', quotes, FRI).daysAway, 4);
  const up = upcomingResults(cal, quotes, Object.keys(quotes), FRI);
  assert.deepEqual(up.map((u) => [u.symbol, u.days_away, u.source]), [['MSFT', 0, 'filing'], ['AAPL', 4, 'yahoo'], ['D05.SI', 9, 'yahoo']]); // Z74's estimate is 13 trading days away
  assert.equal(up[1].typical_results_day_move_pct, 5);
  assert.match(up[0].released, /16:05 New York time; first traded 2026-10-23/);
  assert.deepEqual(resultsCalendar({ quotes, now: FRI }), {}); // no files, no dates
});

test('trading days and market dates', () => {
  assert.equal(tradingDaysBetween('2026-10-23', '2026-10-26'), 1); // Friday to Monday
  assert.equal(tradingDaysBetween('2026-10-23', '2026-10-23'), 0);
  assert.equal(tradingDaysBetween('2026-10-26', '2026-10-23'), -1);
  assert.equal(marketDate('SGX', new Date('2026-10-23T17:00:00Z')), '2026-10-24');
  assert.equal(marketDate('US', new Date('2026-10-23T17:00:00Z')), '2026-10-23');
});

test('analysts for the AI: counts, target, upside and rating changes in the last 10 trading days with the move since', () => {
  const nvdaQuote = quote((d) => (d < '2026-09-21' ? 200 : 210));
  const qs = { NVDA: nvdaQuote, SPY: quote(() => 400) };
  const now = new Date('2026-09-25T20:30:00Z');
  const co = { symbols: { NVDA: parseCompany(nvdaSummary, now) } };
  const a = analystsForPrompt('NVDA', co, qs, now);
  assert.equal(a.n, 59);
  assert.deepEqual(a.buy_hold_sell, [58, 2, 1]);
  assert.equal(a.consensus_target, 327.7);
  assert.equal(a.implied_upside_pct, 56); // 327.7 / 210 - 1
  assert.deepEqual(a.rating_changes_10d, ['2026-09-21 Jefferies Hold→Buy, target 210→245, move since +5.0%', '2026-09-17 Cautious Co Buy→Neutral, target 230→200, move since +5.0%']);
  assert.equal(analystsForPrompt('SPY', co, qs, now), null); // nothing from Yahoo: nothing sent
  const list = recentRatingChanges(co, qs, 'US', now);
  assert.equal(list.length, 2);
  assert.equal(list[0].index, 0);
  assert.equal(describeChange({ firm: 'X', from: '', to: 'Buy', targetFrom: null, targetTo: 10 }), 'X new→Buy, target 10');
});

// ---------- the market memory's events ----------

test('filings become results events, toned by the EPS surprise or else the first day against the index', () => {
  const co = { symbols: { AAPL: { eps: [{ quarter: '2026-06-27', actual: 1.57, estimate: 1.43, surprise: 0.098 }] } } };
  const ev = eventsFromFilings(filings, co, quotes);
  const may = ev.find((e) => e.date === '2026-05-01'), jul = ev.find((e) => e.date === '2026-07-30');
  assert.deepEqual([jul.date, jul.effectiveDate, jul.tone, jul.from, jul.type], ['2026-07-30', '2026-07-31', 'positive', 'filing', 'earnings']);
  assert.match(jul.headline, /EPS 1.57 vs 1.43 expected \(\+9.8%\)/);
  assert.equal(may.tone, 'positive'); // no surprise known for May: its +4% day against a flat index
  assert.match(may.headline, /Results released 06:45 New York time/);
  assert.equal(ev.find((e) => e.symbol === 'MSFT').tone, 'mixed'); // flat: in line, left out of the lessons
  const measured = measureEvents(ev, quotes, 'US');
  assert.ok(Math.abs(measured.find((e) => e.date === '2026-07-30').day.move - 0.06) < 1e-9); // measured on the reaction day
});

test('rating changes become analyst events, one per burst of changes within 3 trading days', () => {
  const co = { symbols: { AAPL: { ratingRows: 3, changes: [
    [unix('2026-09-21T11:00:00Z'), 'A', 'Hold', 'Buy', 1, 100, 120], [unix('2026-09-22T11:00:00Z'), 'B', 'Hold', 'Buy', 1, null, 130],
    [unix('2026-09-17T11:00:00Z'), 'C', 'Buy', 'Hold', -1, 120, 100], [unix('2026-06-01T11:00:00Z'), 'D', 'Sell', 'Hold', 1, null, null],
  ] } } };
  const ev = analystEvents(co, quotes);
  assert.deepEqual(ev.map((e) => [e.date, e.tone, e.effectiveDate]), [['2026-06-01', 'positive', '2026-06-01'], ['2026-09-17', 'positive', '2026-09-17']]);
  assert.equal(ev[1].headline, 'C Buy→Hold, target 120→100; A Hold→Buy, target 100→120; B Hold→Buy, target 130');
  assert.equal(ev[1].from, 'yahoo');
});

test('SGX news dates must show up in trading volume: kept, moved to the real day, or dropped', () => {
  // D05 trades 1m shares a day, with 3m on 13 Aug; the index has no volume
  const d05 = quote(() => 40, { market: 'SGX', currency: 'SGD', volume: (d) => (d === '2026-08-13' ? 3e6 : 1e6) });
  const e = (date) => ({ symbol: 'D05.SI', date, headline: 'Results', type: 'earnings', tone: 'positive', from: 'backfill' });
  assert.deepEqual(checkVolumeDate(e('2026-08-13'), d05), e('2026-08-13'));
  // only the next day traded heavily: out after the close, so measured from the next day
  assert.deepEqual(checkVolumeDate(e('2026-08-12'), d05), { ...e('2026-08-12'), effectiveDate: '2026-08-13' });
  assert.equal(checkVolumeDate(e('2026-08-10'), d05).effectiveDate, '2026-08-13'); // misdated by 3 sessions: moved
  assert.equal(checkVolumeDate(e('2026-07-07'), d05), null); // nothing unusual traded near it: dropped
  assert.deepEqual(checkVolumeDate(e('2026-07-07'), quotes['D05.SI']), e('2026-07-07')); // no volume data: unchecked
  assert.deepEqual(checkVolumeDate(e('2026-10-23'), d05), e('2026-10-23')); // today: the next session hasn't traded yet
});

test('an SGX release after the close is measured from the next session, where the reaction is', () => {
  // OCBC flat on 12 Aug and up 5% on 13 Aug, which trades 3x the usual volume
  const ocbc = quote((d) => (d < '2026-08-13' ? 20 : 21), { market: 'SGX', currency: 'SGD', volume: (d) => (d === '2026-08-13' ? 3e6 : 1e6) });
  const qs = { 'O39.SI': ocbc, 'ES3.SI': quotes['ES3.SI'] };
  const ev = { symbol: 'O39.SI', date: '2026-08-12', headline: 'OCBC results', type: 'earnings', tone: 'positive', from: 'digest' };
  const [m] = measureEvents(marketEvents([ev], qs), qs, 'SGX');
  assert.equal(m.effectiveDate, '2026-08-13');
  assert.ok(Math.abs(m.day.move - 0.05) < 1e-9); // the reaction is the day's move, not the week's drift
});

test('a quarter-end results date stays out even when the volume check moves it to a nearby spike', () => {
  // C38U trades heavily on 26 Jun (a rebalance), and the AI dated its results 30 Jun, the quarter end
  const c38u = quote(() => 2.2, { market: 'SGX', currency: 'SGD', volume: (d) => (d === '2026-06-26' ? 5e6 : 1e6) });
  const qs = { 'C38U.SI': c38u, 'ES3.SI': quotes['ES3.SI'] };
  const ev = { symbol: 'C38U.SI', date: '2026-06-30', headline: 'CICT results', type: 'earnings', tone: 'positive', from: 'digest' };
  const events = marketEvents([ev], qs);
  assert.equal(events[0].effectiveDate, '2026-06-26'); // moved by the volume check...
  assert.equal(plausibleDate(events[0]), false); // ...but still a quarter-end date
  assert.equal(measureEvents(events, qs, 'SGX').length, 0);
  const cal = resultsCalendar({ company: { symbols: { 'C38U.SI': { next: null, past: [] } } }, quotes: qs, events, now: FRI });
  assert.equal(cal['C38U.SI'], undefined); // not a past results date either
  // an exactly timed release is trusted, whatever its date
  assert.equal(plausibleDate({ ...ev, from: 'filing' }), true);
  assert.equal(plausibleDate({ ...ev, time: '2026-06-30T17:45:00+08:00' }), true);
});

test('primary sources replace what the AI recalled: SEC filings for US results, Yahoo for rating changes', () => {
  const news = [
    { symbol: 'AAPL', date: '2026-06-27', headline: 'Apple Q3 results (misdated at the quarter end)', type: 'earnings', tone: 'positive', from: 'backfill' },
    { symbol: 'AAPL', date: '2026-07-31', headline: 'Apple beats', type: 'earnings', tone: 'positive', from: 'digest' },
    { symbol: 'AAPL', date: '2026-02-01', headline: 'Apple Q1 results', type: 'earnings', tone: 'negative', from: 'backfill' }, // before the filings: kept
    { symbol: 'AAPL', date: '2026-08-05', headline: 'Broker upgrades Apple', type: 'analyst', tone: 'positive', from: 'digest' },
    { symbol: 'AAPL', date: '2026-08-06', headline: 'Apple deal', type: 'deal', tone: 'positive', from: 'digest' },
    { symbol: 'D05.SI', date: '2026-08-07', headline: 'DBS results', type: 'earnings', tone: 'positive', from: 'digest' },
    { symbol: 'NOPE', date: '2026-08-07', headline: 'x', type: 'deal', tone: 'positive' },
  ];
  const qs = { ...quotes, 'D05.SI': quote(() => 40, { market: 'SGX', currency: 'SGD', volume: (d) => (d === '2026-08-07' ? 5e6 : 1e6) }) };
  const co = { symbols: { AAPL: { ratingRows: 900, changes: [] } } };
  const out = marketEvents(news, qs, { filings: { symbols: { AAPL: filings.symbols.AAPL } }, company: co });
  assert.deepEqual(out.map((e) => `${e.symbol} ${e.date} ${e.from}`), [
    'AAPL 2026-02-01 backfill', 'AAPL 2026-05-01 filing', 'AAPL 2026-07-30 filing', 'AAPL 2026-08-06 digest', 'D05.SI 2026-08-07 digest',
  ]);
  assert.deepEqual(marketEvents(news.slice(0, 2), qs).length, 2); // without the files, nothing changes
});

// ---------- Telegram ----------

test('a heads-up the evening before a held stock reports, only for confirmed dates', () => {
  const f = newFund({ budget: 10000, currency: 'USD', now: new Date('2026-10-01T14:00:00Z') });
  f.portfolio.positions.AAPL = { qty: 10, avgCost: 100, currency: 'USD' };
  f.portfolio.positions.MSFT = { qty: 5, avgCost: 280, currency: 'USD' };
  const prices = { quotes };
  const wed = new Date('2026-10-28T21:30:00Z'); // 5:30pm in New York, the day before AAPL reports
  const cal = resultsCalendar({ company, filings, quotes, now: wed });
  assert.deepEqual(resultsHeadsUp(f, cal, prices, new Date('2026-10-28T19:00:00Z')), []); // still trading
  const [h] = resultsHeadsUp(f, cal, prices, wed);
  assert.equal(h.key, 'results:AAPL:2026-10-29');
  assert.match(h.text, /AAPL reports results tomorrow<\/b> \(Thu 29 Oct\)\. The fund is long 10 shares, \d+% of its value\. Its results days have moved it ±5\.0% against the index on average \(2 results\)/);
  assert.deepEqual(resultsHeadsUp(f, cal, prices, new Date('2026-10-27T21:30:00Z')), []); // two days before
  // an estimated date gets no heads-up
  const est = resultsCalendar({ company: { symbols: { AAPL: { next: { date: '2026-10-29', estimate: true } } } }, quotes, now: wed });
  assert.deepEqual(resultsHeadsUp(f, est, prices, wed), []);
  // a filing after today's close
  const thu = new Date('2026-10-22T21:00:00Z');
  const [m] = resultsHeadsUp(f, resultsCalendar({ filings, quotes, now: thu }), prices, thu);
  assert.match(m.text, /MSFT reported results after today's close<\/b> \(16:05 New York time\); it first trades on them tomorrow/);
  // on a Friday evening, a Monday date is the next trading day, not "tomorrow"
  const fri = new Date('2026-10-02T22:30:00Z');
  const monCal = resultsCalendar({ company: { symbols: { AAPL: { next: { date: '2026-10-05', estimate: false } } } }, quotes, now: fri });
  const [mon] = resultsHeadsUp(f, monCal, prices, fri);
  assert.match(mon.text, /AAPL reports results on Mon 5 Oct<\/b>, the next trading day\./);
  assert.doesNotMatch(mon.text, /tomorrow/);
  // a filing late on a Friday is first traded on Monday
  const friFiled = { symbols: { MSFT: [{ date: '2026-10-02', time: '2026-10-02T16:30', effectiveDate: '2026-10-05', form: '8-K' }] } };
  const [fm] = resultsHeadsUp(f, resultsCalendar({ filings: friFiled, quotes, now: fri }), prices, fri);
  assert.match(fm.text, /it first trades on them on Mon 5 Oct\./);
  // sent once, through the usual alerts
  collectAlerts(f, { prices, calendar: cal, now: new Date('2026-10-28T19:00:00Z') });
  assert.equal(collectAlerts(f, { prices, calendar: cal, now: wed }).filter((t) => /reports results/.test(t)).length, 1);
  assert.equal(collectAlerts(f, { prices, calendar: cal, now: wed }).length, 0);
});
