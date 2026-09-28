import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseFeed, parseDate, textOf, decodeEntities, canonicalUrl, urlKey, siteOf, normTitle, articleId, makeTagger, articlesFrom, newArticles,
  addToMonth, monthOf, recentMonths, expiredMonth, expandFeeds, feedFile, feedsDue, planFeeds, updateHealth, deadFeeds, isFeed,
  freshLeads, leadsText, digestQuality, addQuality, qualityByWeek, ARTICLES,
} from '../articles.js';
import { isoWeek } from '../stats.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/feeds/${name}`, import.meta.url), 'utf8');
const symbols = JSON.parse(readFileSync(new URL('../symbols.json', import.meta.url), 'utf8'));
const feeds = JSON.parse(readFileSync(new URL('../feeds.json', import.meta.url), 'utf8'));
const tag = makeTagger(symbols);
const NOW = new Date('2026-09-27T11:10:00Z'); // when the probe ran
const H = 3600e3;

// ---------- reading the real feeds (probe of 27 Sep 2026) ----------

test('the feeds parse as the probe saw them: dates in every zone, CDATA, escaped HTML and empty descriptions', () => {
  const bt = parseFeed(fixture('bt.xml'));
  assert.equal(bt.length, 7);
  assert.deepEqual(bt[0], {
    title: 'UBS leaving home would be more expensive, Swiss minister says',
    link: 'https://www.businesstimes.com.sg/companies-markets/banking-finance/ubs-leaving-home-would-be-more-expensive-swiss-minister-says',
    description: 'This is amid a plan that would force Switzerland’s largest lender to hold more equity capital',
    pubDate: '2026-09-27T09:32:17Z', guid: '/companies-markets/banking-finance/ubs-leaving-home-would-be-more-expensive-swiss-minister-says',
    categories: ['Banking & Finance', 'Companies & Markets', 'International'],
  });
  const st = parseFeed(fixture('st.xml'));
  assert.equal(st[0].pubDate, '2026-09-27T04:00:00Z'); // 12:00 +0800
  assert.equal(st[0].description, 'The STI closed higher on Sept 25 at 5,710.65 despite uncertainty over Trump-Xi talks and a jump in US Treasury yields.'); // &lt;p&gt; gone
  const cna = parseFeed(fixture('cna.xml'));
  assert.equal(cna[0].description, ''); // empty, as CNA often sends
  assert.deepEqual(cna[1].categories, ['Commentary ,Business']);
  assert.equal(cna[1].title, 'Commentary: Zuckerberg’s ‘Tamagotchi-like’ AI could be Meta’s iPod moment');
  const cnbc = parseFeed(fixture('cnbc.xml'));
  assert.equal(cnbc[1].pubDate, '2026-09-26T16:57:57Z'); // GMT
  assert.match(cnbc[1].description, /^A federal jury awarded Taction Technology/); // CDATA
  assert.equal(cnbc[2].title, '\'Funflation\' is on the rise as hobbies get pricier, but consumers keep spending anyway'); // &apos;
  assert.equal(cnbc[3].title, 'Costco makes progress on a key membership metric. Here\'s our new price target on the stock');
  const d05 = parseFeed(fixture('yahoo-d05.xml'));
  assert.equal(d05[1].title, 'STI or S&P 500: Where Should You Invest Your Next Dollar?');
  assert.equal(d05.length, 3); // the channel's own title and link are not items
  const tsi = parseFeed(fixture('smartinvestor.xml'));
  assert.match(tsi[0].description, /^This week’s reads cover CapitaLand Integrated Commercial Trust \(SGX: C38U\) and its payout, dividend stocks for the year ahead/); // CDATA HTML, &#8217; and &nbsp;
  assert.deepEqual(tsi[0].categories, ['Smart Reads', 'Yahoo']);
  assert.equal(parseFeed(fixture('yahoo-aapl.xml'))[0].pubDate, '2026-09-27T09:24:47Z');
});

test('dates, entities and odd markup', () => {
  assert.equal(parseDate('Sun, 27 Sep 2026 12:00:00 +0800'), '2026-09-27T04:00:00Z');
  assert.equal(parseDate('Sat, 26 Sep 2026 17:10:32 GMT'), '2026-09-26T17:10:32Z');
  assert.equal(parseDate('Mon, 28 Sep 2026 08:00:00 SGT'), '2026-09-28T00:00:00Z'); // not a zone JavaScript knows
  assert.equal(parseDate('2026-09-27T07:00:00+08:00'), '2026-09-26T23:00:00Z'); // dc:date and Atom
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
  assert.equal(decodeEntities('S&amp;P &#8217; &#x2019; &nbsp;&unknown; &constructor; &AMP;'), 'S&P ’ ’  &unknown; &constructor; &');
  assert.equal(textOf('<![CDATA[<p>A &amp; B</p>]]> and &lt;b&gt;C&lt;/b&gt;'), 'A & B and C'); // CDATA as it is, the rest decoded
  assert.equal(textOf('Stocks &lt; 5% and &gt; 3%'), 'Stocks < 5% and > 3%'); // not mistaken for a tag
  assert.equal(textOf('Stocks to watch: &lt;AAPL.O&gt;, &lt;D05.SI&gt; &lt;p&gt;x&lt;/p&gt;'), 'Stocks to watch: <AAPL.O>, <D05.SI> x'); // a ticker in angle brackets stays
  assert.equal(textOf('&lt;P&gt;Up&lt;/P&gt; &lt;BR&gt;&lt;B&gt;now&lt;/B&gt;'), 'Up now'); // capital tags are still tags
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Nvidia beats</title><link rel="alternate" href="https://x.example/a?utm_source=f&amp;id=2"/><published>2026-09-26T10:00:00Z</published><summary>s</summary></entry></feed>');
  assert.deepEqual([atom[0].title, atom[0].link, atom[0].pubDate], ['Nvidia beats', 'https://x.example/a?utm_source=f&id=2', '2026-09-26T10:00:00Z']);
  const odd = parseFeed('<rss><channel><item><title>T</title><description /><guid>https://y.example/p</guid></item></channel></rss>');
  assert.deepEqual([odd[0].description, odd[0].link, odd[0].pubDate], ['', 'https://y.example/p', null]); // self-closing, link from the guid, undated
  assert.equal(isFeed(fixture('cloudflare-403.html')), false); // Cloudflare's "Just a moment..." page
  for (const f of ['bt.xml', 'st.xml', 'cna.xml', 'cnbc.xml', 'yahoo-aapl.xml', 'smartinvestor.xml']) assert.equal(isFeed(fixture(f)), true, f);
});

test('links lose their tracking and keep everything else', () => {
  assert.equal(canonicalUrl('https://sg.finance.yahoo.com/news/dbs-ocbc-uob-bank-pays-060000874.html?.tsrc=rss'), 'https://sg.finance.yahoo.com/news/dbs-ocbc-uob-bank-pays-060000874.html');
  assert.equal(canonicalUrl('https://thesmartinvestor.com.sg/smart-look-at-the-week-ahead-micron-nike-and-accenture/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=smart-look'),
    'https://thesmartinvestor.com.sg/smart-look-at-the-week-ahead-micron-nike-and-accenture/'); // WordPress's &#038;
  assert.equal(canonicalUrl('https://finance.yahoo.com/m/6d48c29e-1367-39b5-99b4-a628243d31c9/what-musk%E2%80%99s-tesla-and-spacex.html?.tsrc=rss'),
    'https://finance.yahoo.com/m/6d48c29e-1367-39b5-99b4-a628243d31c9/what-musk%E2%80%99s-tesla-and-spacex.html'); // its encoding kept
  assert.equal(canonicalUrl('https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&amp;category=6936&amp;utm_medium=x#top'), 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936');
  assert.equal(canonicalUrl('HTTPS://WWW.CNBC.com/2026/09/26/a.html?ncid=1&fbclid=2&ref=rss'), 'https://www.cnbc.com/2026/09/26/a.html');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('/companies-markets/a-path'), null); // BT's guid is a path, not a link
  assert.equal(urlKey('http://www.fool.com/investing/a/'), urlKey('https://fool.com/investing/a'));
  assert.equal(siteOf('https://www.businesstimes.com.sg/x'), 'businesstimes.com.sg');
  assert.equal(siteOf('https://sg.finance.yahoo.com/news/x.html'), 'sg.finance.yahoo.com'); // kept apart from finance.yahoo.com
  assert.equal(normTitle('Keppel, StarHub discuss M1 deal; Grab execs buy shares'), normTitle('Keppel, Starhub discuss M1 deal; Grab execs buy shares'));
  assert.equal(articleId('https://www.cnbc.com/a.html'), articleId('http://cnbc.com/a.html/'));
  assert.notEqual(articleId('https://www.cnbc.com/a.html'), articleId('https://www.cnbc.com/b.html'));
  assert.match(articleId('https://www.cnbc.com/a.html'), /^[0-9a-z]{14}$/);
});

// ---------- which stocks an item names ----------

test('headlines from the probe are tagged by what they say, not by the feed', () => {
  const cases = [
    // The Business Times, The Straits Times, CNA, CNBC
    ['Discussing the future of AI in Singapore and Asia: DBS conference', ['D05.SI']],
    ['US stocks: Wall Street ends higher as investors buy AI stocks; Microsoft rallies', ['MSFT']],
    ['Google takes the AI data centre race to outer space', ['GOOGL']],
    ['Meta debuts US$349 camera-free Ray-Bans and brings Muse to glasses', ['META']],
    ['StarHub, Keppel confirm talks over potential M1 deal', ['BN4.SI']],
    ['Keppel, StarHub discuss M1 deal; Grab execs buy shares after stock falls: Markets this week', ['BN4.SI']],
    ['Singapore stocks dip 0.2% as OCBC, Seatrium weigh on STI', ['O39.SI']],
    ['SGX enhances disclosure rules to build a ‘value creation culture’ among issuers', ['S68.SI']],
    ['Commentary: Zuckerberg’s ‘Tamagotchi-like’ AI could be Meta’s iPod moment', ['META']],
    ['US jury says Apple owes record $5.7 billion in haptic technology patent case', ['AAPL']],
    ['EU vote on Tesla\'s supervised self-driving system pushed back', ['TSLA']],
    ['Berkshire adds to nearly doubled stake in slumping homebuilder', ['BRK-B']],
    ['Nvidia adds more than $400 billion in value after blowout earnings boost AI confidence', ['NVDA']],
    // Yahoo's per-stock feeds
    ['S$10,000 in DBS, OCBC or UOB: Which Bank Pays the Most Dividends?', ['D05.SI', 'O39.SI', 'U11.SI']],
    ['What Does United Overseas Bank (SGX:U11) 2031 Covered Bond Deal Change?', ['U11.SI']], // SGX: a ticker, not the company
    ['Singtel (SGX:Z74) Stock Still Looks Undervalued After Its 126% Run', ['Z74.SI']],
    ['CICT, FCT or Mapletree Industrial Trust: Which REIT Is the Best Buy Today?', ['C38U.SI']],
    ['ThaiBev said to consider selling KFC franchise business - Bloomberg', ['Y92.SI']],
    ['Thai Beverage\'s 1HFY2026 earnings lower on impairment', ['Y92.SI']],
    ['Is Sembcorp or Keppel a Better Long-Term Investment for Infrastructure?', ['BN4.SI']],
    ['Foldables, AI Servers and India Expansion: What Lies Ahead for Apple (AAPL) Under the New CEO?', ['AAPL']],
    ['What Musk’s Tesla and SpaceX Stocks Are Doing After That White House State Dinner', ['TSLA']], // first in AAPL's feed
    ['Amazon Opened Seller Central to Walmart and eBay but Blocked Meta’s Muse. Here’s What Connects the Two Moves', ['AMZN', 'META']],
    ['3 Reasons Why Nvidia Fits Warren Buffett\'s Investment Style', ['NVDA']], // Buffett alone isn't Berkshire
    ['Could AI Commerce Reshape Meta (META)’s Business Model?', ['META']],
    ['Singapore Airlines to add flights to Europe', ['C6L.SI']],
    ['SIA posts record first-half profit', ['C6L.SI']],
    ['Singapore Exchange posts record annual profit', ['S68.SI']],
    ['BRK.B slips after the annual letter', ['BRK-B']],
    // not the watchlist company
    ['SIA Engineering, Rolls-Royce JV SAESL to offer 30 work-study places from 2027', []],
    ['Keppel Reit to divest freehold Grade A office building in Seoul for US$255.8 million', []],
    ['Stocks to watch: Keppel Reit, Thai Beverage, Nio, Olam, Multi-Chem', ['Y92.SI']],
    ['Keppel DC Reit acquires two data centres in Japan', []],
    ['Keppel Infrastructure Trust to buy stake in German solar portfolio', []],
    ['Keppel Pacific Oak US REIT cuts distribution', []],
    ['Carro is said to mull first dual Nasdaq-SGX IPO', []],
    ['Carro could list on the Singapore Exchange and in New York', []],
    ['SGX-listed firms must report sustainability data', []],
    ['CapitaLand Investment to launch private credit fund', []],
    ['CapitaLand Ascendas REIT buys UK logistics portfolio', []],
    ['Apple Hospitality REIT declares monthly distribution', []],
    ['OCBC chief economist Selena Ling says Singapore growth will slow', []],
    ['UOB Kay Hian starts coverage of Seatrium with a buy', []],
    ['DBS analysts see the STI at 6,000 by year-end', []],
    ['Deforestation in the Amazon rainforest hits record', []],
    ['We\'re Witnessing the Stock Market Do Something for Only the 3rd Time in 156 Years', []],
    ['STI or S&P 500: Where Should You Invest Your Next Dollar?', []],
    ['an apple a day: fruit prices rise', []],
    ['Growth will slow next year, PM Wong says in Facebook post', []], // a platform someone posted on
    ['Police warn of job scams run via WhatsApp and Telegram', []],
    ['Tesla crash caught on YouTube video draws regulators\' attention', ['TSLA']],
    ['Google Trends data show record interest in gold', []],
    ['Condo at Keppel Bay sells for S$12 million', []], // a place
    ['WhatsApp to charge businesses for marketing messages', ['META']], // the business itself
    ['Meta\'s WhatsApp adds ads to its Updates tab', ['META']],
    ['YouTube ad revenue jumps 20%', ['GOOGL']],
    // SGX the company in an analyst's view, not a venue
    ['Maybank ups target on SGX, citing derivatives volumes', ['S68.SI']],
    ['3 reasons to be bullish on Singapore Exchange', ['S68.SI']],
    ['Grab weighs secondary listing on SGX', []],
    ['Chip designer to debut on the Singapore Exchange next week', []],
    ['Firm plans IPO on SGX Catalist', []],
    // a bank's economists, researchers and brokerage quoted on other news
    ['DBS Bank\'s chief economist Taimur Baig says growth will hold up', []],
    ['OCBC Bank\'s head of research sees two more rate cuts', []],
    ['DBS Group\'s research team raises its STI target', []],
    ['UOB-Kay Hian upgrades Sembcorp', []],
    ['UOB Kay Hian starts coverage of Seatrium with a buy', []],
    ['DBS Bank posts record profit', ['D05.SI']], // the bank itself
    // a platform someone posted on; all-caps headlines
    ['Video posted on YouTube goes viral', []],
    ['APPLE SHARES FALL AFTER EU RULING', ['AAPL']],
    ['AMAZON TO CUT 10,000 JOBS', ['AMZN']],
    ['BIG APPLE HOME PRICES CLIMB', []],
    ['Stocks to watch: <NVDA.O>, <TSLA.O>, <D05.SI>', ['D05.SI', 'NVDA', 'TSLA']],
  ];
  for (const [headline, want] of cases) assert.deepEqual(tag(headline), want, headline);
  // another mention of the company still counts
  assert.deepEqual(tag('Keppel Reit falls; Keppel itself rises on M1 sale'), ['BN4.SI']);
  assert.deepEqual(tag('DBS analysts upgrade OCBC; DBS shares rise'), ['D05.SI', 'O39.SI']);
  // index funds have no company news and are never tagged
  assert.deepEqual(tag('SPDR STI ETF sees record inflows as SPY and QQQ swing'), []);
});

test('an item is kept only if it names a watchlist stock, with only the saved fields', () => {
  const now = NOW;
  const aapl = articlesFrom(parseFeed(fixture('yahoo-aapl.xml')), 'yahoo:AAPL', tag, now);
  assert.deepEqual(aapl.map((a) => [a.symbols, a.source]), [[['AAPL'], 'finance.yahoo.com'], [['TSLA'], 'finance.yahoo.com'], [['AAPL'], 'barchart.com']]); // the market-history piece names none
  assert.equal(aapl[0].url, 'https://finance.yahoo.com/technology/articles/foldables-ai-servers-india-expansion-092447891.html');
  assert.equal(aapl[0].feed, 'yahoo:AAPL');
  assert.match(aapl[0].text, /Jim Cramer recently labelled Apple Inc\./); // what was tagged, for this run only...
  assert.ok(aapl[0].text.length <= aapl[0].headline.length + 1 + ARTICLES.tagChars);
  const month = addToMonth([], aapl);
  assert.deepEqual(Object.keys(month[0]).sort(), ['feed', 'headline', 'id', 'pubDate', 'source', 'symbols', 'url']); // ...never saved
  // a description that names the stock is enough; the start of it only
  const d05 = articlesFrom(parseFeed(fixture('smartinvestor.xml')), 'smartinvestor', tag, now);
  assert.deepEqual(d05.map((a) => [a.symbols, a.source, a.url]), [[['C38U.SI'], 'thesmartinvestor.com.sg', 'https://thesmartinvestor.com.sg/smart-reads-of-the-week-singapore-dividend-stocks-reit-payouts-and-small-cap-opportunities/']]);
  const late = { title: 'Nvidia beats', link: 'https://x.example/n', description: `${'x'.repeat(ARTICLES.tagChars)} Apple`, pubDate: '2026-09-27T12:00:00Z' };
  const [n] = articlesFrom([late], 'f', tag, now);
  assert.deepEqual(n.symbols, ['NVDA']); // Apple is past the characters read
  assert.equal(n.pubDate, '2026-09-27T11:10:00Z'); // a future date is the time it was fetched
  const old = { title: 'Nvidia beats', link: 'https://x.example/o', description: '', pubDate: '2026-08-20T00:00:00Z' };
  assert.equal(articlesFrom([old], 'f', tag, now).length, 0); // more than 30 days old when first seen
  const long = { title: `Apple ${'y'.repeat(300)}`, link: 'https://x.example/l', description: '', pubDate: '2026-09-27T01:00:00Z' };
  assert.equal(articlesFrom([long], 'f', tag, now)[0].headline.length, ARTICLES.headline);
  assert.equal(articlesFrom([{ title: 'Apple', link: '', description: '' }], 'f', tag, now).length, 0); // no link
});

test('the same article from two feeds, or the same story on two sites, is kept once', () => {
  const a = (url, headline, pubDate, feed = 'f') => ({ id: articleId(url), symbols: ['AAPL'], source: siteOf(url), feed, pubDate, headline, url });
  const stored = [a('https://www.cnbc.com/2026/09/26/apple-verdict.html', 'Apple faces verdict', '2026-09-26T16:57:57Z', 'cnbc-top')];
  const fresh = [
    a('https://cnbc.com/2026/09/26/apple-verdict.html/', 'Apple faces verdict', '2026-09-26T16:57:57Z', 'cnbc-tech'), // the same link in another CNBC feed
    a('https://sg.finance.yahoo.com/news/apple-verdict.html', 'Apple Faces Verdict!', '2026-09-27T01:00:00Z'), // the same headline on another site
    a('https://x.example/1', 'Apple faces verdict', '2026-10-05T00:00:00Z'), // the same words 8 days on: a new story
    a('https://x.example/2', 'Apple appeals', '2026-09-27T02:00:00Z'),
    a('https://x.example/2?utm_source=y', 'Apple appeals again', '2026-09-27T03:00:00Z'), // not canonical here, but the same page
  ];
  fresh[4].url = canonicalUrl(fresh[4].url);
  assert.deepEqual(newArticles(stored, fresh).map((x) => x.url), ['https://x.example/1', 'https://x.example/2']);
  // a month keeps the newest, oldest first
  const many = Array.from({ length: ARTICLES.perMonth + 5 }, (_, i) => a(`https://x.example/m${i}`, `h${i}`, new Date(Date.UTC(2026, 8, 1) + i * 60e3).toISOString().replace('.000Z', 'Z')));
  const kept = addToMonth(many.slice(0, 10), many.slice(10).reverse());
  assert.equal(kept.length, ARTICLES.perMonth);
  assert.equal(kept[0].headline, 'h5');
  assert.equal(kept.at(-1).headline, `h${ARTICLES.perMonth + 4}`);
  assert.equal(monthOf('2026-09-30T23:59:00Z'), '2026-09');
  assert.deepEqual(recentMonths(new Date('2026-01-15T00:00:00Z'), 3), ['2026-01', '2025-12', '2025-11']);
  assert.equal(expiredMonth('2025-09', NOW), false); // 13 months are kept: Sep 2025 to Sep 2026
  assert.equal(expiredMonth('2025-08', NOW), true);
});

// ---------- the feeds and their health ----------

test('feeds.json: every feed is complete, and Yahoo\'s per-stock feed covers every stock in its region', () => {
  const ids = new Set();
  for (const f of feeds) {
    for (const k of ['id', 'name', 'market', 'kind']) assert.ok(f[k], `${f.id} ${k}`);
    assert.ok(f.url || f.template, f.id);
    assert.ok(!ids.has(f.id), f.id);
    ids.add(f.id);
  }
  const all = expandFeeds(feeds, symbols);
  const yahoo = all.filter((f) => f.kind === 'per-stock');
  assert.equal(yahoo.length, symbols.filter((s) => !s.etf).length); // index funds left out
  assert.equal(all.find((f) => f.id === 'yahoo:D05.SI').url, 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=D05.SI&region=SG&lang=en-SG');
  assert.equal(all.find((f) => f.id === 'yahoo:BRK-B').url, 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=BRK-B&region=US&lang=en-US');
  assert.ok(all.some((f) => f.id === 'smartinvestor' && f.kind === 'opinion'));
  assert.ok(!all.some((f) => /fool\.sg|theedgesingapore|news\.google/.test(f.url))); // gone, blocked, or not to be used
  assert.equal(feedFile('yahoo:D05.SI'), 'yahoo_D05.SI.xml');
});

test('health counters: at most every 6 hours, a dead feed once a day until it answers', () => {
  const list = [{ id: 'bt' }, { id: 'smartinvestor' }, { id: 'yahoo:AAPL' }];
  assert.equal(feedsDue(null, NOW), true);
  assert.equal(feedsDue({ triedAt: new Date(NOW - 5 * H).toISOString() }, NOW), false);
  assert.equal(feedsDue({ triedAt: new Date(NOW - 6 * H + 5 * 60e3).toISOString() }, NOW), true); // scheduled runs start late
  let h = updateHealth(null, { bt: { ok: true, items: 100 }, smartinvestor: { ok: false, error: 'HTTP 403' }, 'yahoo:AAPL': { ok: true, items: 14 } }, NOW);
  assert.equal(h.since, '2026-09-27');
  assert.deepEqual([h.answered, h.tried, h.feeds.bt.fails, h.feeds.smartinvestor.fails, h.feeds.smartinvestor.error], [2, 3, 0, 1, 'HTTP 403']);
  let t = NOW;
  for (let i = 0; i < 2; i++) { t = new Date(t.getTime() + 6 * H); h = updateHealth(h, { smartinvestor: { ok: false, error: 'HTTP 403' } }, t); }
  assert.equal(h.feeds.smartinvestor.fails, ARTICLES.deadAfter);
  assert.deepEqual(deadFeeds(h), [{ id: 'smartinvestor', error: 'HTTP 403', lastOk: null }]);
  assert.deepEqual(planFeeds(list, h, new Date(t.getTime() + 6 * H)).map((f) => f.id), ['bt', 'yahoo:AAPL']); // resting
  assert.deepEqual(planFeeds(list, h, new Date(t.getTime() + 24 * H)).map((f) => f.id), ['bt', 'smartinvestor', 'yahoo:AAPL']); // its daily try
  h = updateHealth(h, { smartinvestor: { ok: true, items: 20 } }, new Date(t.getTime() + 24 * H));
  assert.equal(h.feeds.smartinvestor.fails, 0); // Cloudflare let it through: back on
  assert.equal(h.since, '2026-09-27'); // the first day stays
  h = updateHealth(h, {}, t, new Set(['bt'])); // feeds no longer in feeds.json are forgotten
  assert.deepEqual(Object.keys(h.feeds), ['bt']);
  assert.equal(updateHealth(null, { bt: { ok: false, error: 'x' } }, NOW).since, undefined); // no feed answered yet
  // every feed failing at once is the runner's connection, not the feeds: not counted against them
  const down = { bt: { ok: false, error: 'Could not resolve host' }, st: { ok: false, error: 'Could not resolve host' }, cna: { ok: false, error: 'Could not resolve host' } };
  const d = updateHealth({ feeds: { bt: { ok: 'x', fails: 2 } } }, down, NOW);
  assert.deepEqual([d.feeds.bt.fails, d.feeds.st.fails, d.feeds.bt.error, d.answered, d.tried], [2, 0, 'Could not resolve host', 0, 3]);
});

// ---------- leads for the digest ----------

test('the digest\'s leads: the 15 freshest about its stocks, the markets taken in turn', () => {
  const market = (s) => (s.endsWith('.SI') ? 'SGX' : 'US');
  const art = (i, symbols, hoursAgo) => ({ id: `a${i}`, symbols, source: 'x.example', feed: 'f', pubDate: new Date(NOW - hoursAgo * H).toISOString(), headline: `h${i}`, url: `https://x.example/${i}` });
  const us = Array.from({ length: 20 }, (_, i) => art(i, ['NVDA'], i + 1));
  const sgx = Array.from({ length: 5 }, (_, i) => art(100 + i, ['D05.SI', 'AAPL'], 10 * i + 2));
  const old = art(200, ['D05.SI'], ARTICLES.leadDays * 24 + 1);
  const leads = freshLeads([...us, ...sgx, old], ['NVDA', 'D05.SI'], NOW, { marketOf: market });
  assert.equal(leads.length, ARTICLES.leads);
  assert.equal(leads.filter((l) => l.symbols.includes('D05.SI')).length, 5); // SGX isn't crowded out
  assert.ok(leads.every((l, i) => i === 0 || l.pubDate <= leads[i - 1].pubDate)); // newest first
  assert.deepEqual(leads.find((l) => l.headline === 'h100').symbols, ['D05.SI']); // only the digest's own stocks
  assert.ok(!leads.some((l) => l.headline === 'h200')); // too old
  assert.deepEqual(freshLeads(us, ['D05.SI'], NOW, { marketOf: market }), []);
  assert.match(leadsText(leads.slice(0, 1), NOW), /^- \[NVDA\] h0 \(x\.example, 1h ago\) https:\/\/x\.example\/0$/);
});

test('each digest\'s quality is recorded, and compared week by week with the leads on and off', () => {
  const news = {
    createdAt: '2026-09-28T02:00:00Z', usage: { searches: 5, costUsd: 0.12 },
    leads: [{ url: 'https://x.example/1' }, { url: 'https://x.example/2' }],
    items: [{ source_url: 'https://x.example/1' }, { source_url: 'https://search.example/a' }, { source_url: null }],
  };
  const r = digestQuality(news, { by: 'picks', on: true });
  assert.deepEqual(r, { at: '2026-09-28T02:00:00Z', by: 'picks', via: 'search', leadsOn: true, leads: 2, items: 3, verified: 2, fromLeads: 1, searches: 5, costUsd: 0.12 });
  const off = digestQuality({ ...news, createdAt: '2026-10-06T02:00:00Z', leads: undefined }, { on: false });
  assert.equal(off.leads, 0);
  let list = addQuality(null, r);
  list = addQuality(list, { ...r, at: '2026-09-29T02:00:00Z', items: 5, verified: 5, fromLeads: 3, costUsd: 0.1 });
  list = addQuality(list, off);
  const weeks = qualityByWeek(list, isoWeek);
  assert.deepEqual(weeks.map((w) => [w.week, w.leads, w.digests, w.items, w.verified, w.fromLeads]), [['2026-W40', 'on', 2, 4, 7 / 8, 2], ['2026-W41', 'off', 1, 3, 2 / 3, 0]]);
  assert.equal(addQuality(Array.from({ length: ARTICLES.quality }, () => r), off).length, ARTICLES.quality);
});
