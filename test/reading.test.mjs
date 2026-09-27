import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  READING, READING_NOISE, readingNoiseCheck, readRank, readingDue, toRead, feedSummaries, readingItems, callsFrom, pickOf, recordCalls,
  trimCalls, gradable, monthResults, recordOf, siteRecords, latestCalls, soFar, gradeDay, pageFacts, readable, ownText, publicUrl, addOwn,
  loggedLately, ownId, siteName,
} from '../reading.js';
import { makeTagger, articlesFrom, parseFeed, canonicalUrl } from '../articles.js';
import { scorePicks } from '../scorecard.js';

const root = new URL('..', import.meta.url).pathname;
const feedFixture = (name) => readFileSync(new URL(`./fixtures/feeds/${name}`, import.meta.url), 'utf8');
const page = (name) => readFileSync(new URL(`./fixtures/pages/${name}`, import.meta.url), 'utf8');
const symbols = JSON.parse(readFileSync(new URL('../symbols.json', import.meta.url), 'utf8'));
const tag = makeTagger(symbols);
const NOW = new Date('2026-09-28T01:10:00Z'); // a Monday, the day's first fetch
const H = 3600e3;
const ago = (hours) => new Date(NOW - hours * H).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Weekday bars from `start`, stamped at the US open (13:30 UTC) as prices.json's are, with `closes`.
function usQuote(name, closes, start = '2026-06-01') {
  const daily = [];
  const d = new Date(`${start}T13:30:00Z`);
  for (const c of closes) {
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    daily.push([d.getTime() / 1000, c]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { name, market: 'US', currency: 'USD', price: closes.at(-1), daily };
}

// ---------- which headlines are read, and how ----------

test('the day\'s read: investing sites first, then headlines that read like analysis, then the news; new ones only, at most 40', () => {
  const a = (id, source, headline, hours, feed = 'yahoo:AAPL') => ({ id, symbols: ['AAPL'], source, feed, pubDate: ago(hours), headline, url: `https://${source}/${id}` });
  const list = [
    a('n1', 'cnbc.com', 'Apple faces $5.7 billion patent infringement verdict', 1, 'cnbc-top'),
    a('y1', 'finance.yahoo.com', 'How Investors May Respond To Apple (AAPL) Launching Its First Foldable iPhone', 5),
    a('y2', 'finance.yahoo.com', 'Is Apple Stock a Buy After the Verdict?', 30),
    a('f1', 'fool.com', 'Apple Eyes the Fitness Tracker Segment', 40),
    a('s1', 'thesmartinvestor.com.sg', 'Smart Reads of the Week', 50, 'smartinvestor'),
    a('old', 'fool.com', '3 Stocks to Buy', 5 * 24), // older than the 4 days looked back
    a('done', 'fool.com', 'Read yesterday', 2),
    a('future', 'fool.com', 'Dated tomorrow', -30),
    { ...a('untagged', 'fool.com', 'No stock', 3), symbols: [] },
    a('n1', 'cnbc.com', 'The same article twice', 1, 'cnbc-tech'),
  ];
  assert.deepEqual(toRead(list, { readAt: ago(24), read: { done: '2026-09-27' } }, NOW).map((x) => x.id), ['f1', 's1', 'y1', 'y2', 'n1']);
  assert.deepEqual(list.slice(0, 5).map((x) => readRank(x)), [2, 1, 1, 0, 0]);
  // a feed of kind 'opinion' (feeds.json) counts as an investing site wherever its links go
  assert.equal(readRank({ source: 'example.com', feed: 'smartinvestor', headline: 'x' }, { smartinvestor: 'opinion' }), 0);
  const many = Array.from({ length: 60 }, (_, i) => a(`m${i}`, 'barchart.com', `Stock ${i}`, i / 2));
  assert.equal(toRead(many, null, NOW).length, READING.perDay);
  assert.equal(toRead(many, null, NOW)[0].id, 'm0'); // the newest first
  // once a day: 20 hours after the last read (less 10 minutes: runs start late)
  assert.equal(readingDue(null, NOW), true);
  assert.equal(readingDue({ readAt: ago(6) }, NOW), false);
  assert.equal(readingDue({ readAt: ago(19.9) }, NOW), true);
  assert.equal(readingDue({ readAt: ago(19.5) }, NOW), false);
});

test('each headline is read with the start of its summary from this run\'s downloads, cut to 300 characters, never kept', () => {
  const body = feedFixture('yahoo-aapl.xml');
  const stored = articlesFrom(parseFeed(body), 'yahoo:AAPL', tag, new Date('2026-09-27T11:10:00Z'));
  const summaries = feedSummaries([body, feedFixture('cloudflare-403.html'), '', null]);
  assert.ok(stored.length === 3 && stored.every((x) => summaries[x.id])); // the links match without their tracking
  const items = readingItems(stored, summaries);
  assert.deepEqual(items.map((it) => [it.n, it.source, it.symbols]), [[1, 'finance.yahoo.com', ['AAPL']], [2, 'finance.yahoo.com', ['TSLA']], [3, 'barchart.com', ['AAPL']]]);
  assert.equal(items[0].text.length, READING.itemChars);
  assert.match(items[0].text, /^Foldables, AI Servers and India Expansion: What Lies Ahead for Apple \(AAPL\) Under the New CEO\? — Jim Cramer recently labelled/);
  assert.match(items[0].text, /…$/);
  assert.equal(items[2].text, 'Apple Eyes the Rapidly Growing Fitness Tracker Segment. What That Could Mean for AAPL Stock. — A push into fitness tracking could open a new stream of revenue.');
  // an item that has left its feed is read from its headline alone
  assert.equal(readingItems([{ ...stored[0], id: 'gone' }], summaries)[0].text, stored[0].headline);
  assert.deepEqual(feedSummaries([feedFixture('cloudflare-403.html')]), {});
});

test('the AI\'s answer counts only for stocks listed with an item: buy, sell or hold, once each', () => {
  const items = [{ n: 1, source: 'fool.com', symbols: ['NVDA', 'BRK-B'] }, { n: 2, source: 'barchart.com', symbols: ['AAPL'] }];
  const calls = callsFrom(items, { calls: [
    { item: 1, symbol: 'NVDA', call: 'buy', target_price: 250, reasons_cited: ['growth', 'valuation', 'made-up', 'growth', 'results', 'deal'] },
    { item: 1, symbol: 'NVDA', call: 'sell', target_price: 0, reasons_cited: [] }, // a second answer for the same item and stock
    { item: 1, symbol: 'BRK-B', call: 'none', target_price: 0, reasons_cited: [] }, // no call
    { item: 2, symbol: 'TSLA', call: 'buy', target_price: 0, reasons_cited: [] }, // not listed with the item
    { item: 3, symbol: 'AAPL', call: 'buy', target_price: 0, reasons_cited: [] }, // no such item
    { item: 2, symbol: 'AAPL', call: 'strong buy', target_price: 0, reasons_cited: [] }, // not a call it knows
    { item: 2, symbol: 'AAPL', call: 'hold', target_price: -5, reasons_cited: ['dividends'] },
  ] });
  assert.deepEqual(calls, [
    { item: 1, symbol: 'NVDA', call: 'buy', target: 250, reasons: ['growth', 'valuation', 'results'] },
    { item: 2, symbol: 'AAPL', call: 'hold', target: 0, reasons: ['dividends'] },
  ]);
  assert.deepEqual(callsFrom(items, null), []);
  assert.deepEqual(callsFrom(items, { calls: 'not a list' }), []);
});

test('calls are kept as the picks\' history is: priced when published, one per site, per stock, per week', () => {
  const closes = Array.from({ length: 90 }, (_, i) => 100 + i);
  const quotes = { NVDA: usQuote('Nvidia', closes), AAPL: usQuote('Apple', closes.map((c) => c * 2)), SPY: usQuote('SPY', closes.map((c) => c * 4)) };
  const item = (n, source, syms, pubDate) => ({ n, id: `id${n}`, source, symbols: syms, pubDate, headline: `Headline ${n}`, url: `https://${source}/${n}` });
  const items = [
    item(1, 'fool.com', ['NVDA'], '2026-09-24T12:00:00Z'), // Thursday, before the US open: priced at Wednesday's close
    item(2, 'fool.com', ['NVDA'], '2026-09-25T12:00:00Z'), // the same site, stock and week: dropped
    item(3, 'barchart.com', ['NVDA', 'AAPL'], '2026-09-25T12:00:00Z'),
    item(4, 'tikr.com', ['AAPL'], '2026-09-26T12:00:00Z'), // no call: read, nothing kept
    item(5, 'thestreet.com', ['MSFT'], '2026-09-26T12:00:00Z'), // no prices for it
  ];
  const calls = [
    { item: 1, symbol: 'NVDA', call: 'buy', target: 250, reasons: ['growth'] },
    { item: 2, symbol: 'NVDA', call: 'sell', target: 0, reasons: [] },
    { item: 3, symbol: 'NVDA', call: 'hold', target: 0, reasons: [] },
    { item: 3, symbol: 'AAPL', call: 'sell', target: 1e6, reasons: ['valuation'] }, // not a plausible target for it
    { item: 5, symbol: 'MSFT', call: 'buy', target: 0, reasons: [] },
  ];
  const before = { readAt: ago(24), read: { gone: '2026-09-01', recent: '2026-09-26' }, calls: [] };
  const { record, kept, dropped } = recordCalls(before, items, calls, quotes, NOW);
  assert.deepEqual([kept, dropped], [3, 1]);
  const wed = quotes.NVDA.daily.find(([t]) => new Date(t * 1000).toISOString().startsWith('2026-09-23'))[1];
  assert.deepEqual(record.calls, [
    { createdAt: '2026-09-24T12:00:00Z', source: 'fool.com', headline: 'Headline 1', url: 'https://fool.com/1', picks: [{ symbol: 'NVDA', stance: 'long', price: wed, target: 250, reasons: ['growth'] }] },
    { createdAt: '2026-09-25T12:00:00Z', source: 'barchart.com', headline: 'Headline 3', url: 'https://barchart.com/3', picks: [
      { symbol: 'NVDA', stance: 'hold', price: wed + 1 }, { symbol: 'AAPL', stance: 'short', price: (wed + 1) * 2, reasons: ['valuation'] },
    ] },
  ]);
  // every item read is remembered for the days looked back, so none is read twice
  assert.equal(record.readAt, '2026-09-28T01:10:00Z');
  assert.deepEqual(Object.keys(record.read).sort(), ['id1', 'id2', 'id3', 'id4', 'id5', 'recent']);
  // a later read that week keeps to one call per site and stock; the next week counts again
  const again = recordCalls(record, [item(6, 'fool.com', ['NVDA'], '2026-09-26T20:00:00Z'), item(7, 'fool.com', ['NVDA'], '2026-09-28T00:30:00Z')],
    [{ item: 6, symbol: 'NVDA', call: 'buy', target: 0, reasons: [] }, { item: 7, symbol: 'NVDA', call: 'sell', target: 0, reasons: [] }], quotes, NOW);
  assert.deepEqual([again.kept, again.dropped], [1, 1]);
  assert.equal(again.record.calls.at(-1).picks[0].stance, 'short');
  assert.equal(pickOf({ symbol: 'NVDA', call: 'buy', target: 0, reasons: [] }, quotes.NVDA, Date.parse('2026-01-01') / 1000), null); // before its prices
});

test('the record stays compact: calls from the last 400 days, at most 3,000, headlines only for 3 weeks', () => {
  const p = [{ symbol: 'NVDA', stance: 'long', price: 1 }];
  const out = trimCalls([
    { createdAt: '2026-09-20T00:00:00Z', source: 'fool.com', headline: 'recent', url: 'https://fool.com/r', picks: p },
    { createdAt: '2025-08-01T00:00:00Z', source: 'fool.com', headline: 'too old', url: 'https://fool.com/o', picks: p },
    { createdAt: '2026-08-01T00:00:00Z', source: 'fool.com', headline: 'over 3 weeks old', url: 'https://fool.com/w', picks: p },
  ], NOW);
  assert.deepEqual(out, [
    { createdAt: '2026-08-01T00:00:00Z', source: 'fool.com', picks: p },
    { createdAt: '2026-09-20T00:00:00Z', source: 'fool.com', picks: p, headline: 'recent', url: 'https://fool.com/r' },
  ]);
  const many = Array.from({ length: 3100 }, (_, i) => ({ createdAt: new Date(NOW - i * H).toISOString(), source: 's', picks: p }));
  const kept = trimCalls(many, NOW);
  assert.equal(kept.length, READING.maxCalls);
  assert.equal(kept.at(-1).createdAt, NOW.toISOString()); // the newest
  assert.deepEqual(latestCalls({ calls: out }).map((c) => [c.headline, c.pick.symbol]), [['recent', 'NVDA']]);
});

// ---------- grading ----------

test('calls are graded as the picks are: a month later, in their direction, against the same bet on the index; holds aren\'t', () => {
  const stock = usQuote('A stock', Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i));
  const quotes = { AAA: stock, SPY: usQuote('SPY', Array.from({ length: 60 }, (_, i) => 400 * 1.002 ** i)) };
  const close = (i) => new Date((stock.daily[i][0] + 6.5 * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const now = new Date(Date.parse(close(59)) + H);
  const pick = (i, stance) => ({ symbol: 'AAA', stance, price: stock.daily[i][1] });
  const record = { calls: [
    { createdAt: close(0), source: 'fool.com', picks: [pick(0, 'long'), pick(0, 'hold')] },
    { createdAt: close(0), source: 'barchart.com', picks: [pick(0, 'short')] },
    { createdAt: close(1), source: 'fool.com', picks: [pick(1, 'long')] },
    { createdAt: close(50), source: 'tikr.com', picks: [pick(50, 'long')] }, // not a month old yet
  ] };
  const x = 1.01 ** 21 - 1.002 ** 21; // a month of the stock against a month of the index
  const results = monthResults(record.calls, quotes, now);
  assert.deepEqual(results.map((r) => [r.source, r.direction]), [['fool.com', 1], ['barchart.com', -1], ['fool.com', 1]]);
  results.forEach((r) => assert.ok(Math.abs(r.x - r.direction * x) < 1e-9));
  // exactly scorecard.js's numbers; without leaving the hold out, it would be graded as a buy
  const scored = scorePicks(gradable(record.calls), quotes, now).filter((s) => s.horizon === 'month');
  assert.deepEqual(results.map((r) => r.x), scored.map((s) => s.ret - s.indexBet));
  assert.equal(scorePicks(record.calls, quotes, now).length, scorePicks(gradable(record.calls), quotes, now).length + 2);
  const rows = siteRecords(record, quotes, now);
  assert.deepEqual(rows.map((r) => [r.site, r.calls, r.holds, r.open, r.n, r.bets, r.weeks]), [
    [null, 5, 1, 1, 3, 2, 1], // every site: the long and the short on AAA in the same week are one week, which counts once
    ['fool.com', 3, 1, 0, 2, 1, 1], // two buys of AAA a day apart are one bet
    ['barchart.com', 1, 0, 0, 1, 1, 1],
    ['tikr.com', 1, 0, 1, 0, 0, 0],
  ]);
  assert.equal(rows[0].avg, 0);
  assert.ok(Math.abs(rows[1].avg - x) < 1e-4);
  assert.deepEqual([rows[1].beat, rows[2].beat], [2, 0]);
  assert.ok(rows.every((r) => r.verdict === 'too-few' && r.lo == null)); // one week: no range yet
  assert.deepEqual(siteRecords({ calls: [] }, quotes, now), []);
  // a call not graded yet shows how it's doing, against the same bet on the index
  const s = soFar(close(50), pick(50, 'long'), quotes);
  assert.ok(Math.abs(s.move - (1.01 ** 9 - 1)) < 1e-9 && Math.abs(s.vsIndex - (1.01 ** 9 - 1.002 ** 9)) < 1e-9);
  assert.equal(soFar(close(50), { symbol: 'AAA', stance: 'hold', price: 1 }, quotes), null);
  assert.equal(gradeDay('2026-09-28'), '2026-10-27'); // 21 weekdays on
});

test('a record: separate bets, each week once, a likely range, and no verdict below 20 calls or while it could be noise', () => {
  const T = Date.UTC(2026, 0, 5) / 1000; // a Monday
  const row = (w, s, x, direction = 1, day = 0) => ({ symbol: s, direction, t: T + (w * 7 + day) * 86400, x });
  assert.deepEqual(recordOf([]), { n: 0, beat: 0, bets: 0, weeks: 0, avg: null, lo: null, hi: null, p: null, verdict: 'too-few' });
  // the same stock and side within a month is one bet
  assert.deepEqual(recordOf([row(0, 'A', 0.02), row(1, 'A', 0.04), row(2, 'A', 0.06)]), { n: 3, beat: 3, bets: 1, weeks: 1, avg: 0.04, lo: null, hi: null, p: null, verdict: 'too-few' });
  // 19 calls that all beat the index by about 5%: still no verdict; the 20th brings one
  const strong = Array.from({ length: 19 }, (_, i) => row(i, `S${i % 8}`, 0.05 + 0.01 * ((i % 3) - 1), 1, i % 5));
  assert.deepEqual([recordOf(strong).verdict, recordOf(strong).weeks], ['too-few', 19]);
  const r20 = recordOf([...strong, row(19, 'S3', 0.05)]);
  assert.equal(r20.verdict, 'better');
  assert.ok(r20.lo > 0.04 && r20.hi < 0.06 && r20.p > 0.99);
  // sells that kept losing against the index
  assert.equal(recordOf(Array.from({ length: 24 }, (_, i) => row(i, `S${i % 8}`, -0.04 + 0.01 * ((i % 3) - 1), -1, i % 5))).verdict, 'worse');
  // a coin toss: no evidence either way
  const noise = recordOf(Array.from({ length: 30 }, (_, i) => row(i, `S${i % 8}`, (i % 2 ? 1 : -1) * 0.05 + 0.004 * ((i % 5) - 2), 1, i % 5)));
  assert.equal(noise.verdict, 'unclear');
  assert.ok(noise.lo < 0 && noise.hi > 0);
});

test('on made-up sites with no skill, few show a verdict at any point in a year (the page prints the rate)', () => {
  assert.deepEqual(readingNoiseCheck(), READING_NOISE);
  assert.ok(READING_NOISE.any < 0.05);
});

// ---------- your own reading ----------

test('a logged article\'s page: its title, summary, date and first paragraphs; a blocked or paywalled page asks for the text', () => {
  const bt = pageFacts(page('bt-article.html'));
  assert.equal(bt.title, 'Discussing the future of AI in Singapore and Asia: DBS conference');
  assert.equal(bt.description, 'Bank leaders and investors weigh how artificial intelligence will change lending, payments & jobs in the region.');
  assert.equal(bt.published, '2026-09-27T07:00:00Z'); // JSON-LD's datePublished, +08:00
  assert.match(bt.text, /^SINGAPORE – Bank executives, fund managers and start-up founders gathered at DBS Group's annual technology conference/);
  assert.doesNotMatch(bt.text, /Advertisement|Read more|Copyright|PHOTO|Subscribe|Companies & Markets|probe/); // not menus, captions, notes or scripts
  assert.equal(readable(bt), true);
  const cnbc = pageFacts(page('cnbc-article.html'));
  assert.equal(cnbc.title, 'Apple faces $5.7 billion patent infringement verdict over iPhone and Apple Watch haptics'); // og:title, written content-first
  assert.equal(cnbc.published, '2026-09-26T14:55:59Z');
  assert.match(cnbc.text, /^A federal jury on Friday ordered Apple/);
  const teaser = pageFacts(page('teaser.html'));
  assert.deepEqual([teaser.title, teaser.published, readable(teaser)], ['Why I\'m buying more Singtel shares', '2026-09-25T00:00:00Z', false]);
  const blocked = pageFacts(feedFixture('cloudflare-403.html'));
  assert.deepEqual([blocked.blocked, readable(blocked)], [true, false]);
  assert.equal(readable(pageFacts('')), false);
  assert.equal(pageFacts(`<title>T</title><p>${'word '.repeat(1000)}</p>`).text.length, READING.pageChars);
});

test('what\'s read of a logged article: the page, or the text you pasted (which wins), within 3,000 characters', () => {
  const facts = pageFacts(page('cnbc-article.html'));
  const fromPage = ownText({ facts });
  assert.equal(fromPage.published, '2026-09-26T14:55:59Z');
  assert.match(fromPage.text, /^Apple faces \$5\.7 billion patent infringement verdict over iPhone and Apple Watch haptics — A jury found .* — A federal jury on Friday/);
  const pasted = ownText({ pasted: 'Buy Singtel, target S$4.20\r\nThe telco\'s dividend looks safe.\n\nMore of the article.' });
  assert.deepEqual(pasted, { title: 'Buy Singtel, target S$4.20', published: null, text: 'Buy Singtel, target S$4.20 The telco\'s dividend looks safe. More of the article.' });
  // a paywalled page's title and date, with the text you pasted
  const both = ownText({ facts: pageFacts(page('teaser.html')), pasted: 'The full article.' });
  assert.deepEqual([both.title, both.published, both.text], ['Why I\'m buying more Singtel shares', '2026-09-25T00:00:00Z', 'Why I\'m buying more Singtel shares — The full article.']);
  assert.ok(ownText({ pasted: 'x '.repeat(4000) }).text.length <= READING.pasteMax);
  assert.equal(ownText({ pasted: 'y'.repeat(200) }).title, ''); // a first line too long for a title
  // only a public web page is fetched
  assert.equal(publicUrl('https://www.cnbc.com/2026/09/26/x.html?utm_source=twitter#top'), 'https://www.cnbc.com/2026/09/26/x.html');
  for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://localhost:8000/x', 'https://intranet/x', 'ftp://example.com/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'http://[::1]/x', 'not a link']) {
    assert.equal(publicUrl(bad), null, bad);
  }
});

test('your logged articles: kept with the funds, newest last, capped, and the same one isn\'t logged twice in a week', () => {
  const url = 'https://www.cnbc.com/2026/09/26/x.html';
  assert.equal(ownId(url, 'text'), ownId(url, 'other text')); // by its link
  assert.equal(ownId(null, 'Buy Singtel!'), ownId(null, 'buy singtel'));
  assert.notEqual(ownId(null, 'Buy Singtel'), ownId(null, 'Sell Singtel'));
  const entry = (id, days) => ({ id, createdAt: new Date(NOW - days * 24 * H).toISOString(), site: 'cnbc.com', title: 't', picks: [] });
  let list = [entry('old', 500), entry('a', 3)];
  let r = addOwn(list, entry('a', 0), NOW);
  assert.deepEqual([r.added, r.list.map((e) => e.id)], [false, ['a']]); // too old to grade: gone; logged 3 days ago: not again
  assert.equal(loggedLately(list, 'a', NOW), true);
  r = addOwn([entry('a', 8)], entry('a', 0), NOW);
  assert.deepEqual([r.added, r.list.length], [true, 2]); // a week on, it counts again
  list = Array.from({ length: READING.ownMax }, (_, i) => entry(`e${i}`, 100 - i / 2));
  r = addOwn(list, entry('new', 0), NOW);
  assert.deepEqual([r.list.length, r.list[0].id, r.list.at(-1).id], [READING.ownMax, 'e1', 'new']);
  assert.equal(siteName('fool.com'), 'The Motley Fool');
  assert.equal(siteName('example.com'), 'example.com');
});

// ---------- the scripts ----------

// A stand-in for the Anthropic SDK, loaded through Node's module hooks: it answers the reading call with
// FAKE_SDK_ANSWER (JSON, 'buy-all': a buy for the first stock of every item, or 'no-tool': words without
// calling the tool) and logs each request to FAKE_SDK_LOG.
const fakeSdk = `
import { appendFileSync } from 'node:fs';
export default class Anthropic {
  constructor() {
    this.beta = { messages: { stream: (req) => {
      if (process.env.FAKE_SDK_LOG) appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(req) + '\\n');
      const tool = req.tools.find((t) => t.input_schema);
      const answer = process.env.FAKE_SDK_ANSWER ?? '{}';
      if (answer === 'no-tool') return { finalMessage: async () => ({ stop_reason: 'end_turn', model: req.model, content: [{ type: 'text', text: 'hmm' }], usage: { input_tokens: 5000, output_tokens: 1000 } }) };
      const input = answer === 'buy-all' ? { calls: [...req.messages[0].content.matchAll(/^\\[(\\d+)\\] [^|]+\\| ([^ ,|]+)/gm)].map((m) => ({ item: Number(m[1]), symbol: m[2], call: 'buy', target_price: 0, reasons_cited: ['growth'] })) } : JSON.parse(answer);
      return { finalMessage: async () => ({ stop_reason: 'tool_use', model: req.model, content: [{ type: 'tool_use', id: 't1', name: tool.name, input }], usage: { input_tokens: 5000, output_tokens: 1000 } }) };
    } } };
  }
}`;
const hooks = `export async function resolve(s, c, n) { return s === '@anthropic-ai/sdk' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeSdk)}`)}, shortCircuit: true } : n(s, c); }`;
const withFakeSdk = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`)}`;
const pinClock = (iso) => `data:text/javascript,const F=Date.parse("${iso}");const R=Date;globalThis.Date=class extends R{constructor(...a){if(a.length)super(...a);else super(F)}static now(){return F}};`;
const { FUND_COMMAND, GITHUB_EVENT_PATH, ...baseEnv } = process.env;

test('fetch-articles.mjs calls: once a day, the new headlines with this run\'s summaries in one call; the calls kept, never the summaries or a headline in the log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reading-calls-'));
  for (const d of ['data', 'state/articles', 'raw-feeds']) await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  const probe = new Date('2026-09-27T11:10:00Z');
  const stored = [
    ...articlesFrom(parseFeed(feedFixture('yahoo-aapl.xml')), 'yahoo:AAPL', tag, probe),
    ...articlesFrom(parseFeed(feedFixture('smartinvestor.xml')), 'smartinvestor', tag, probe),
    ...articlesFrom(parseFeed(feedFixture('yahoo-d05.xml')), 'yahoo:D05.SI', tag, probe), // 10 days old by Monday: not read
  ];
  await writeFile(join(dir, 'state', 'articles', '2026-09.json'), JSON.stringify(stored));
  await writeFile(join(dir, 'raw-feeds', 'plan.json'), JSON.stringify([{ id: 'yahoo:AAPL', url: 'x', file: 'yahoo_AAPL.xml' }, { id: 'smartinvestor', url: 'y', file: 'smartinvestor.xml' }]));
  await writeFile(join(dir, 'raw-feeds', 'yahoo_AAPL.xml'), feedFixture('yahoo-aapl.xml'));
  await writeFile(join(dir, 'raw-feeds', 'smartinvestor.xml'), feedFixture('smartinvestor.xml'));
  const log = join(dir, 'sdk.log');
  const run = (env = {}) => spawnSync('node', ['--import', pinClock('2026-09-28T01:10:00Z'), '--import', withFakeSdk, join(root, 'scripts/fetch-articles.mjs'), 'calls', 'raw-feeds', 'state'], {
    cwd: dir, encoding: 'utf8', env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', AI_MONTHLY_CAP_USD: '', AI_NEWS_MODEL: '', FAKE_SDK_ANSWER: 'buy-all', FAKE_SDK_LOG: log, ...env },
  });
  assert.match(run({ ANTHROPIC_API_KEY: '' }).stdout, /ANTHROPIC_API_KEY is not set/);
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Reading guide: read 4 headlines \(2 from investing sites, 4 with the start of their summary\); 4 calls \(4 buy, 0 sell, 0 hold\), 4 kept; about US\$0\.01\. 4 calls on record\./);
  assert.doesNotMatch(out.stdout + out.stderr, /Foldables|Fitness|Smart Reads|Tesla|Musk|Cramer/);
  // one call on the news model, no web search, the investing sites first, with the start of each summary
  const req = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.deepEqual(req.tools.map((t) => t.name), ['submit_calls']);
  const lines = req.messages[0].content.split('\n').slice(1);
  assert.deepEqual(lines.map((l) => l.split(' | ').slice(0, 2).join(' | ')), [
    '[1] thesmartinvestor.com.sg | C38U.SI (CapitaLand Integrated Comm. Trust)', '[2] barchart.com | AAPL (Apple)', '[3] finance.yahoo.com | AAPL (Apple)', '[4] finance.yahoo.com | TSLA (Tesla)',
  ]);
  assert.match(lines[1], /A push into fitness tracking could open a new stream of revenue\.$/);
  const record = JSON.parse(await readFile(join(dir, 'state', 'reading-calls.json'), 'utf8'));
  assert.deepEqual(record.calls.map((s) => [s.source, s.picks.map((p) => `${p.stance} ${p.symbol}`).join()]), [
    ['barchart.com', 'long AAPL'], ['finance.yahoo.com', 'long TSLA'], ['thesmartinvestor.com.sg', 'long C38U.SI'], ['finance.yahoo.com', 'long AAPL'],
  ]);
  assert.doesNotMatch(JSON.stringify(record), /push into fitness|Jim Cramer/); // summaries are never kept
  assert.equal(Object.keys(record.read).length, 4);
  const spend = JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8'));
  assert.equal(spend.months['2026-09'].reading, 0.01); // 5k tokens in and 1k out on Haiku
  // once a day
  assert.match(run().stdout, /Reading guide: read within the last 20 hours\./);
});

test('fetch-articles.mjs calls: a read the API billed but that failed is counted, and not paid for again until tomorrow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reading-fail-'));
  for (const d of ['data', 'state/articles', 'raw-feeds']) await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'articles', '2026-09.json'), JSON.stringify(articlesFrom(parseFeed(feedFixture('yahoo-aapl.xml')), 'yahoo:AAPL', tag, new Date('2026-09-27T11:10:00Z'))));
  await writeFile(join(dir, 'raw-feeds', 'plan.json'), '[]');
  const log = join(dir, 'sdk.log');
  const run = (clock, env = {}) => spawnSync('node', ['--import', pinClock(clock), '--import', withFakeSdk, join(root, 'scripts/fetch-articles.mjs'), 'calls', 'raw-feeds', 'state'], {
    cwd: dir, encoding: 'utf8', env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', AI_MONTHLY_CAP_USD: '', AI_NEWS_MODEL: '', FAKE_SDK_ANSWER: 'no-tool', FAKE_SDK_LOG: log, ...env },
  });
  let out = run('2026-09-28T01:10:00Z');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /Reading guide: the read failed \(Claude did not return an answer\. Try again\.\); it's tried again tomorrow\./);
  const spend = JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8'));
  assert.equal(spend.months['2026-09'].reading, 0.02); // two rounds of 5k in and 1k out on Haiku
  const record = JSON.parse(await readFile(join(dir, 'state', 'reading-calls.json'), 'utf8'));
  assert.deepEqual([record.readAt, record.calls, record.read], ['2026-09-28T01:10:00.000Z', [], {}]); // nothing marked read: tomorrow reads them
  // the next fetch, 6 hours on: not tried again
  out = run('2026-09-28T07:10:00Z');
  assert.match(out.stdout, /Reading guide: read within the last 20 hours\./);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
  // a day on, the same headlines are read
  out = run('2026-09-29T01:10:00Z', { FAKE_SDK_ANSWER: 'buy-all' });
  assert.match(out.stdout, /Reading guide: read \d+ headlines/);
});

test('your reading: a logged article is read from its page or your text and kept with the funds; nothing about it is printed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'your-reading-'));
  for (const d of ['data', 'state', 'raw-page']) await mkdir(join(dir, d));
  await writeFile(join(dir, 'data', 'prices.json'), await readFile(new URL('../data/sample-prices.json', import.meta.url)));
  await writeFile(join(dir, 'state', 'ai-fund.json'), JSON.stringify({ version: 2, funds: [], archived: [] }));
  const setPage = async (status, html) => {
    await writeFile(join(dir, 'raw-page', 'page.json'), JSON.stringify({ status, bytes: html.length }));
    await writeFile(join(dir, 'raw-page', 'page.html'), html);
  };
  const log = join(dir, 'sdk.log');
  const run = (reading, env = {}) => spawnSync('node', ['--import', withFakeSdk, join(root, 'scripts/ai-fund.mjs'), 'state/ai-fund.json', 'state/picks.json'], {
    cwd: dir, encoding: 'utf8',
    env: { ...baseEnv, ANTHROPIC_API_KEY: 'test', FUND_PRIVATE: '', AI_MONTHLY_CAP_USD: '', AI_NEWS_MODEL: '', READING_PAGE_DIR: 'raw-page', FAKE_SDK_LOG: log, FUND_COMMAND: JSON.stringify({ fund: 'all', reading }), ...env },
  });
  const state = async () => JSON.parse(await readFile(join(dir, 'state', 'ai-fund.json'), 'utf8'));
  const secret = /cnbc|haptics|patent|Apple faces|Singtel|dividend|S\$4\.20|telco|AAPL|Z74/i;
  const url = 'https://www.cnbc.com/2026/09/26/apple-taction-technology-patent-infringement-verdict.html?utm_source=twitter';
  await setPage(200, page('cnbc-article.html'));
  let out = run({ url }, { FAKE_SDK_ANSWER: JSON.stringify({ calls: [{ item: 1, symbol: 'AAPL', call: 'sell', target_price: 250, reasons_cited: ['other'] }] }) });
  assert.equal(out.status, 0, out.stderr);
  let c = await state();
  const aapl = JSON.parse(await readFile(new URL('../data/sample-prices.json', import.meta.url), 'utf8')).quotes.AAPL;
  assert.deepEqual(c.reading.map(({ id, createdAt, ...e }) => e), [{
    site: 'cnbc.com', title: 'Apple faces $5.7 billion patent infringement verdict over iPhone and Apple Watch haptics',
    url: 'https://www.cnbc.com/2026/09/26/apple-taction-technology-patent-infringement-verdict.html', published: '2026-09-26T14:55:59Z',
    picks: [{ symbol: 'AAPL', stance: 'short', price: aapl.intraday.at(-1)[1], target: 250, reasons: ['other'] }],
  }]);
  assert.deepEqual([c.lastCommand.action, c.lastCommand.ok, c.lastCommand.message], ['reading', true, 'Logged your article: one call, graded a month from now under Your reading.']);
  assert.doesNotMatch(out.stdout + out.stderr + c.lastCommand.message, secret);
  const req = JSON.parse((await readFile(log, 'utf8')).trim().split('\n').at(-1));
  assert.match(req.messages[0].content, /^Items \(number, site, the stocks it names, its text\):\n\[1\] cnbc\.com \| AAPL \(Apple\) \| Apple faces \$5\.7 billion .* — A federal jury on Friday ordered Apple/);
  assert.equal(JSON.parse(await readFile(join(dir, 'state', 'ai-spend.json'), 'utf8')).months[new Date().toISOString().slice(0, 7)].reading, 0.01);
  // the same article again within a week: not read or added twice
  out = run({ url });
  c = await state();
  assert.deepEqual([c.reading.length, c.lastCommand.ok, c.lastCommand.message], [1, true, 'You logged that article in the last week, so it wasn\'t added again.']);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  // a page that couldn't be read asks for the text; with the text, it's logged from that
  await setPage(403, feedFixture('cloudflare-403.html'));
  const other = 'https://www.businesstimes.com.sg/companies-markets/singtel-dividend';
  out = run({ url: other });
  c = await state();
  assert.deepEqual([c.reading.length, c.lastCommand.ok], [1, false]);
  assert.match(c.lastCommand.message, /Couldn't read enough of that page.*Paste the article's text/);
  out = run({ url: other, text: 'Buy Singtel, target S$4.20\nThe telco\'s dividend looks safe for years.' }, { FAKE_SDK_ANSWER: JSON.stringify({ calls: [{ item: 1, symbol: 'Z74.SI', call: 'buy', target_price: 4.2, reasons_cited: ['dividends'] }] }) });
  c = await state();
  assert.deepEqual(c.reading.map((e) => [e.site, e.title, e.picks[0].stance, e.picks[0].symbol]), [['cnbc.com', c.reading[0].title, 'short', 'AAPL'], ['businesstimes.com.sg', 'Buy Singtel, target S$4.20', 'long', 'Z74.SI']]);
  assert.doesNotMatch(out.stdout + out.stderr + c.lastCommand.message, secret);
  // pasted text alone; one naming no watchlist stock; a link that isn't a public page; no key
  out = run({ text: 'Why I like Starbucks: its coffee is good and so is its dividend.' });
  assert.match((await state()).lastCommand.message, /doesn't name a stock on the watchlist/);
  out = run({ url: 'http://169.254.169.254/latest/meta-data' });
  assert.match((await state()).lastCommand.message, /isn't to a public web page/);
  out = run({ text: 'Sell DBS now.' }, { ANTHROPIC_API_KEY: '' });
  assert.deepEqual([(await state()).lastCommand.ok, (await state()).lastCommand.message], [false, 'ANTHROPIC_API_KEY isn\'t set, so the article couldn\'t be read.']);
  out = run({ text: 'Sell DBS now, it is overvalued.' }, { FAKE_SDK_ANSWER: JSON.stringify({ calls: [{ item: 1, symbol: 'D05.SI', call: 'none', target_price: 0, reasons_cited: [] }] }) });
  c = await state();
  assert.deepEqual([c.reading.length, c.lastCommand.message], [2, 'That article makes no buy, sell or hold call on a watchlist stock, so there\'s nothing to grade: it wasn\'t logged.']);
  assert.doesNotMatch(out.stdout + out.stderr, /DBS|overvalued/);
});

test('the public copy of the funds leaves your reading out, keeping only how many articles there are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-reading-'));
  const c = { version: 2, funds: [], archived: [], reading: [{ id: 'x', createdAt: NOW.toISOString(), site: 'cnbc.com', title: 'A private read', url: 'https://www.cnbc.com/private', picks: [{ symbol: 'AAPL', stance: 'short', price: 1 }] }] };
  await writeFile(join(dir, 'in.json'), JSON.stringify(c));
  execFileSync('node', ['scripts/public-fund.mjs', join(dir, 'in.json'), join(dir, 'out.json')], { cwd: root });
  const out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
  assert.equal(out.readingLogged, 1);
  assert.equal(out.reading, undefined);
  assert.doesNotMatch(JSON.stringify(out), /private|cnbc/);
});

test('the reading guide never reaches the AI funds or the picks', async () => {
  const scripts = ['ai-fund.mjs', 'fetch-picks.mjs', 'build-history.mjs', 'backfill-news.mjs', 'notify.mjs'];
  for (const s of scripts) assert.doesNotMatch(await readFile(join(root, 'scripts', s), 'utf8'), /reading-calls/, s);
  // the fund's decision is given no reading: c.reading only ever goes to its own command
  const job = await readFile(join(root, 'scripts', 'ai-fund.mjs'), 'utf8');
  const decide = job.slice(job.indexOf('await decideFund({'), job.indexOf('});', job.indexOf('await decideFund({')));
  assert.doesNotMatch(decide, /reading/);
  const code = job.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal([...code.matchAll(/c\.reading/g)].length, 3); // in its own command only: the duplicate check, and adding to it
  assert.equal(canonicalUrl('https://x.example/a?utm_source=y'), 'https://x.example/a');
});
