import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeEvents, dedupeEvents, eventDay, marketEvents, movesAgainstIndex, newsNear, classifyMoves, movesToSearch, searchFailed, moveNewsStudy, buildMemory,
  MOVE_NEWS, BACKFILL_NONE,
} from '../memory.js';

// Weekday bars from June to the end of October 2026, stamped at the open (US 13:30 UTC, SGX 01:00 UTC).
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const weekdays = (hour) => {
  const out = [];
  for (let d = Date.parse(`2026-06-01T${hour}:00Z`); d <= Date.parse(`2026-10-30T${hour}:00Z`); d += 86400000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) out.push(d / 1000);
  }
  return out;
};
const US = weekdays('13:30'), SGX = weekdays('01:00');
const quote = (price, { market = 'US', etf = false } = {}) => {
  const daily = (market === 'US' ? US : SGX).map((t) => [t, price(day(t))]);
  return { market, currency: market === 'US' ? 'USD' : 'SGD', name: 'Test', daily, intraday: [], price: daily.at(-1)[1], ...(etf ? { etf: true } : {}) };
};
// The index is flat. NVDA jumps 6% on 30 Sep and keeps rising; AAPL drops 5% on 1 Oct and bounces back;
// TSLA gains 3% (not big enough); QQQ, an index fund, jumps too but isn't a company; DBS jumps 5% on 2 Oct.
const quotes = {
  SPY: quote(() => 400, { etf: true }),
  QQQ: quote((d) => (d >= '2026-09-30' ? 520 : 500), { etf: true }),
  NVDA: quote((d) => (d < '2026-09-30' ? 100 : d === '2026-09-30' ? 106 : 106 + 0.5 * Math.min(10, Math.round((Date.parse(d) - Date.parse('2026-09-30')) / 86400000)))),
  AAPL: quote((d) => (d < '2026-10-01' ? 200 : d === '2026-10-01' ? 190 : 196)),
  TSLA: quote((d) => (d < '2026-09-30' ? 300 : 309)),
  'ES3.SI': quote(() => 4, { market: 'SGX', etf: true }),
  'D05.SI': quote((d) => (d < '2026-10-02' ? 40 : 42), { market: 'SGX' }),
};
const utc = (iso) => new Date(iso);

// ---------- one event per stock, trading day and tone ----------

test('two digests wording one story differently are one event; a different tone is another', () => {
  const qs = { 'D05.SI': quote(() => 40, { market: 'SGX' }), NVDA: quotes.NVDA };
  const a = { symbol: 'D05.SI', date: '2026-08-07', headline: 'DBS posts record Q2 profit of S$3 billion', type: 'earnings', tone: 'positive' };
  const b = { symbol: 'D05.SI', date: '2026-08-07', headline: 'DBS second-quarter earnings beat forecasts on fee income', type: 'earnings', tone: 'positive' };
  const c = { symbol: 'D05.SI', date: '2026-08-07', headline: 'DBS warns on margins', type: 'guidance', tone: 'negative' };
  const merged = mergeEvents(mergeEvents([], [a], qs), [b, c], qs);
  assert.deepEqual(merged.map((e) => [e.headline, e.tone]), [[a.headline, 'positive'], [c.headline, 'negative']]); // the first wording stays
  // a Saturday story is measured from Monday, as is Monday's
  const sat = { symbol: 'NVDA', date: '2026-09-26', headline: 'Nvidia deal talk', type: 'deal', tone: 'positive' };
  const mon = { symbol: 'NVDA', date: '2026-09-28', headline: 'Nvidia confirms deal', type: 'deal', tone: 'positive' };
  assert.equal(eventDay(sat, qs.NVDA), '2026-09-28');
  assert.equal(mergeEvents([], [sat, mon], qs).length, 1);
  assert.equal(eventDay({ date: '2026-11-07' }, qs.NVDA), '2026-11-09'); // past the last bar: the next weekday
  // old duplicates already saved are merged too, but the backfill's notes are never events to merge
  const note = { symbol: 'D05.SI', date: '2026-08-07', headline: BACKFILL_NONE, type: 'other', tone: 'mixed', from: 'backfill' };
  const mixed = { ...a, headline: 'DBS results in line', tone: 'mixed' };
  assert.deepEqual(mergeEvents([a, b, note], [mixed], qs).map((e) => e.headline).sort(), [a.headline, BACKFILL_NONE, 'DBS results in line'].sort());
});

test('events older than the year of prices keep their own days: they are not all snapped to the first bar', () => {
  // the bars start on 1 June 2026; the saved events go back further (news-events.json keeps up to 3,000)
  const qs = { AAPL: quotes.AAPL };
  const old = [
    { symbol: 'AAPL', date: '2026-03-02', headline: 'Apple faces EU fine', type: 'legal', tone: 'negative', from: 'backfill' },
    { symbol: 'AAPL', date: '2026-04-01', headline: 'Apple cuts iPhone orders', type: 'product', tone: 'negative', from: 'backfill' },
    { symbol: 'AAPL', date: '2026-05-01', headline: 'Apple Q2 results miss', type: 'earnings', tone: 'negative', from: 'digest' },
    { symbol: 'AAPL', date: '2026-05-30', headline: 'Apple weekend story', type: 'other', tone: 'negative', from: 'digest' }, // a Saturday
  ];
  assert.equal(eventDay(old[0], qs.AAPL), '2026-03-02');
  assert.equal(eventDay(old[3], qs.AAPL), '2026-06-01'); // the next weekday, which is also the first bar
  const merged = mergeEvents(old, [], qs);
  assert.equal(merged.length, 4);
  // and a second pass over the saved list loses nothing either
  assert.equal(mergeEvents(merged, [{ symbol: 'AAPL', date: '2026-09-22', headline: 'x', type: 'product', tone: 'negative' }], qs).length, 5);
  // two stories of one old day are still one event
  assert.equal(mergeEvents([old[0], { ...old[0], headline: 'EU fines Apple' }], [], qs).length, 1);
});

test('the best event of a day stays: a filing, then the AI\'s news (results first), then a rating change, then a feed', () => {
  const qs = { AAPL: quotes.AAPL };
  const e = (from, headline, extra = {}) => ({ symbol: 'AAPL', date: '2026-07-31', headline, type: 'deal', tone: 'positive', from, ...extra });
  assert.equal(dedupeEvents([e('digest', 'Apple buyback'), e('filing', 'Results: EPS 1.57 vs 1.43', { type: 'earnings' })], qs)[0].from, 'filing');
  assert.equal(dedupeEvents([e('rss', 'Apple up on buyback'), e('digest', 'Apple buyback')], qs)[0].from, 'digest');
  // an upgrade on results day follows the results: the results event stays (the calendar reads its date)
  assert.equal(dedupeEvents([e('yahoo', 'A Hold→Buy', { type: 'analyst' }), e('backfill', 'Apple results beat', { type: 'earnings' })], qs)[0].type, 'earnings');
  assert.equal(dedupeEvents([e('digest', 'Apple buyback'), e('digest', 'Apple results beat', { type: 'earnings' })], qs)[0].type, 'earnings');
  assert.equal(dedupeEvents([e('yahoo', 'A Hold→Buy', { type: 'analyst' }), e('rss', 'Apple upgraded')], qs)[0].from, 'yahoo');
  assert.equal(dedupeEvents([e('digest', 'first'), e('search', 'second')], qs)[0].headline, 'first'); // equal rank: the first
  // across sources in marketEvents: a digest's deal on the day of an after-the-close results filing
  // is the same price move; a digest item of the other tone is another
  const filings = { symbols: { AAPL: [{ date: '2026-07-30', effectiveDate: '2026-07-31', time: '2026-07-30T16:30:41-04:00', form: '8-K', url: 'https://sec.example/a' }] } };
  const co = { symbols: { AAPL: { eps: [{ quarter: '2026-06-27', actual: 1.57, estimate: 1.43, surprise: 0.098 }] } } };
  const news = [e('digest', 'Apple announces US$100 billion buyback'), e('digest', 'Apple faces EU fine', { tone: 'negative', type: 'legal' })];
  const out = marketEvents(news, qs, { filings, company: co });
  assert.deepEqual(out.map((x) => `${x.from} ${x.tone}`).sort(), ['digest negative', 'filing positive']);
});

// ---------- big moves with and without news ----------

test('moves against the index: the day\'s total return beyond the index\'s, companies only', () => {
  const us = movesAgainstIndex(quotes, 'US');
  assert.deepEqual(us.map((m) => [m.symbol, m.date, Math.round(m.excess * 1000) / 1000]), [['NVDA', '2026-09-30', 0.06], ['AAPL', '2026-10-01', -0.05]]); // not TSLA's 3%, not QQQ
  assert.deepEqual(movesAgainstIndex(quotes, 'SGX').map((m) => [m.symbol, m.date]), [['D05.SI', '2026-10-02']]);
  // against a falling index, a flat stock moved up against it
  const qs = { SPY: quote((d) => (d === '2026-09-30' ? 380 : 400), { etf: true }), MSFT: quote(() => 300) };
  assert.deepEqual(movesAgainstIndex(qs, 'US').map((m) => [m.date, Math.round(m.excess * 1000) / 1000]), [['2026-09-30', 0.05], ['2026-10-01', -0.053]]);
});

test('news within a trading day counts: events of every source but a search, and tagged headlines', () => {
  const ev = (date, extra = {}) => ({ symbol: 'NVDA', date, headline: 'h', type: 'deal', tone: 'positive', from: 'digest', ...extra });
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-09-29')] }), true);
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-10-01')] }), true);
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-10-02')] }), false); // two sessions after
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-09-28', { effectiveDate: '2026-09-29' })] }), true); // measured from the 29th
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-09-30', { symbol: 'AAPL' })] }), false);
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-09-30', { from: 'search' })] }), false); // found because of the move
  assert.equal(newsNear('NVDA', '2026-09-30', 'US', { events: [ev('2026-09-30', { headline: BACKFILL_NONE, from: 'backfill' })] }), false);
  assert.equal(newsNear('D05.SI', '2026-10-05', 'SGX', { events: [{ ...ev('2026-10-03'), symbol: 'D05.SI' }] }), true); // a Saturday story, before Monday's move
  // a headline counts by the market's own date: 23:30 UTC on the 29th is the 30th in Singapore
  const art = (pubDate, symbols = ['D05.SI']) => ({ symbols, pubDate, headline: 'h', url: 'https://x.example' });
  assert.equal(newsNear('D05.SI', '2026-10-02', 'SGX', { articles: [art('2026-09-30T23:30:00Z')] }), true);
  assert.equal(newsNear('D05.SI', '2026-10-02', 'SGX', { articles: [art('2026-09-30T12:00:00Z')] }), false);
  assert.equal(newsNear('D05.SI', '2026-10-02', 'SGX', { articles: [art('2026-10-01T12:00:00Z', ['O39.SI'])] }), false);
});

test('each move is judged once, after the next session, before any search, and stays as judged', () => {
  const since = '2026-09-28';
  const article = { symbols: ['NVDA'], pubDate: '2026-10-01T15:00:00Z', headline: 'Why Nvidia jumped', url: 'https://x.example/n' };
  assert.equal(classifyMoves(null, { quotes, since: null, now: utc('2026-10-05T22:00:00Z') }), null); // the feeds haven't answered yet
  // on the evening of 1 Oct in New York, NVDA's move of the 30th waits for the session after it
  let r = classifyMoves(null, { quotes, articles: [article], since, now: utc('2026-10-01T22:00:00Z') });
  assert.deepEqual(r, { since, moves: [] });
  r = classifyMoves(r, { quotes, articles: [article], since, now: utc('2026-10-02T22:00:00Z') });
  assert.deepEqual(r.moves.map((m) => [m.symbol, m.date, m.news]), [['NVDA', '2026-09-30', true]]);
  // Monday: AAPL's drop of the 1st (no news) and DBS's jump of the 2nd (on SGX, Tuesday morning there)
  r = classifyMoves(r, { quotes, articles: [article], since, now: utc('2026-10-06T02:00:00Z') });
  assert.deepEqual(r.moves.map((m) => [m.symbol, m.date, m.news, m.excess]), [['NVDA', '2026-09-30', true, 0.06], ['AAPL', '2026-10-01', false, -0.05], ['D05.SI', '2026-10-02', false, 0.05]]);
  // news that turns up later doesn't change a move already judged, and nothing is judged twice
  const later = { symbols: ['AAPL'], pubDate: '2026-10-02T15:00:00Z', headline: 'Apple slides', url: 'https://x.example/a' };
  const again = classifyMoves(r, { quotes, articles: [article, later], since, now: utc('2026-10-07T02:00:00Z') });
  assert.deepEqual(again.moves, r.moves);
  // a move more than 10 trading days back when first seen is left out (the feeds may have been down)
  const late = classifyMoves({ since, moves: [] }, { quotes, since, now: utc('2026-10-16T22:00:00Z') });
  assert.deepEqual(late.moves.map((m) => m.symbol), ['D05.SI']);
  // and nothing from before the feeds started
  assert.deepEqual(classifyMoves(null, { quotes, since: '2026-10-02', now: utc('2026-10-06T02:00:00Z') }).moves.map((m) => m.symbol), ['D05.SI']);
  // moves over MOVE_NEWS.keepDays old go
  const old = { since: '2025-01-01', moves: [{ symbol: 'NVDA', date: '2025-06-02', excess: 0.05, news: false }] };
  assert.equal(classifyMoves(old, { quotes, now: utc('2026-10-06T02:00:00Z') }).moves.some((m) => m.date === '2025-06-02'), false);
});

test('at most 10 searches a month, for moves without news, the newest first', () => {
  const move = (i, extra = {}) => ({ symbol: 'NVDA', date: `2026-10-${String(i + 1).padStart(2, '0')}`, excess: 0.05, news: false, ...extra });
  const record = { since: '2026-09-28', moves: [
    ...Array.from({ length: 12 }, (_, i) => move(i)),
    move(20, { news: true }),
    move(21, { searched: { at: '2026-10-22T02:00:00Z', found: false } }),
    move(22, { searched: { at: '2026-10-23T02:00:00Z', found: true, headline: 'h', url: 'u' } }),
    move(23, { searched: { at: '2026-09-30T02:00:00Z', found: false } }), // last month's
  ] };
  const todo = movesToSearch(record, utc('2026-10-25T02:00:00Z'));
  assert.equal(todo.length, MOVE_NEWS.perMonth - 2);
  assert.deepEqual(todo.slice(0, 2).map((m) => m.date), ['2026-10-12', '2026-10-11']);
  assert.ok(todo.every((m) => !m.news && !m.searched));
  assert.equal(movesToSearch(record, utc('2026-11-01T02:00:00Z')).length, 10); // a new month
  todo[0].searched = { at: 'x' }; // the job marks the record's own moves
  assert.ok(record.moves.find((m) => m.date === '2026-10-12').searched);
});

test('a failed search is paid for once: a billed failure counts as a search, one that never reached the API is tried again, twice at most', () => {
  const now = utc('2026-10-25T02:00:00Z');
  const move = (i) => ({ symbol: 'NVDA', date: `2026-10-${String(i + 1).padStart(2, '0')}`, excess: 0.05, news: false });
  const record = { since: '2026-09-28', moves: Array.from({ length: 12 }, (_, i) => move(i)) };
  let todo = movesToSearch(record, now);
  // the API answered (and billed) but gave no answer: searched, found nothing, one of the month's 10
  searchFailed(todo[0], Object.assign(new Error('Claude did not return an answer.'), { usage: { costUsd: 0.02 } }), now);
  assert.deepEqual(todo[0].searched, { at: now.toISOString(), found: false, failed: true });
  // the API out of reach: tried again next time, and after a second failure no more
  searchFailed(todo[1], new Error('Could not reach Anthropic.'), now);
  assert.equal(todo[1].searched, undefined);
  todo = movesToSearch(record, now);
  assert.equal(todo.length, MOVE_NEWS.perMonth - 1);
  assert.equal(todo[0].date, '2026-10-11'); // the same move again
  searchFailed(todo[0], new Error('Could not reach Anthropic.'), now);
  assert.equal(todo[0].searched.failed, true);
  assert.equal(movesToSearch(record, now).length, MOVE_NEWS.perMonth - 2);
  // the page: a failed search isn't counted as searched, and says it failed
  const s = moveNewsStudy(record, quotes, 'US');
  assert.equal(s.searched, 0);
  assert.deepEqual(s.recent.find((m) => m.date === '2026-10-12').searched, { found: false, failed: true });
});

test('the study compares what followed each group, in the move\'s direction, and the page gets the counts', () => {
  const record = { since: '2026-09-28', moves: [
    { symbol: 'NVDA', date: '2026-09-30', excess: 0.06, news: true },
    { symbol: 'AAPL', date: '2026-10-01', excess: -0.05, news: false, searched: { at: '2026-10-05T22:00:00Z', found: true, headline: 'Apple faces EU fine', url: 'https://x.example/e' } },
    { symbol: 'D05.SI', date: '2026-10-02', excess: 0.05, news: false },
    { symbol: 'AAPL', date: '2026-10-29', excess: 0.05, news: false }, // no week after it yet
  ] };
  const s = moveNewsStudy(record, quotes, 'US');
  assert.deepEqual([s.since, s.moves, s.withoutNews, s.measured, s.searched, s.found], ['2026-09-28', 3, 2, 2, 1, 1]);
  assert.equal(s.withNews.week.n, 1);
  assert.equal(s.withNews.week.continued, 1); // NVDA kept rising
  assert.ok(s.withNews.week.vsIndex > 0);
  assert.equal(s.noNews.week.n, 1);
  assert.equal(s.noNews.week.continued, 0); // AAPL bounced back: against its drop
  assert.ok(Math.abs(s.noNews.week.vsIndex - (-(196 / 190 - 1))) < 1e-9);
  assert.ok(s.withNews.month); // a month after 30 Sep is in the bars
  assert.deepEqual(s.recent.map((m) => [m.symbol, m.date, m.searched?.found ?? null]), [['AAPL', '2026-10-29', null], ['AAPL', '2026-10-01', true]]);
  assert.equal(s.recent[1].searched.headline, 'Apple faces EU fine');
  // in the market memory, per market, only with a record
  const now = utc('2026-10-30T22:00:00Z');
  assert.equal(buildMemory([], quotes, 'SGX', now, null, { moveNews: record }).moveNews.moves, 1);
  assert.equal(buildMemory([], quotes, 'US', now).moveNews, undefined);
  assert.equal(moveNewsStudy(null, quotes, 'US'), null);
  // a year on, the study covers the year of prices: older moves can't be measured
  const older = { since: '2026-01-05', moves: [{ symbol: 'NVDA', date: '2026-03-02', excess: 0.05, news: false }, ...record.moves] };
  const y = moveNewsStudy(older, quotes, 'US');
  assert.deepEqual([y.since, y.from, y.moves], ['2026-01-05', '2026-06-01', 3]);
  assert.equal(s.from, '2026-09-28'); // until then, from the day the feeds started
});
