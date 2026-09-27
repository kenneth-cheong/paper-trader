// The reading guide: what investing sites recommended for the watchlist's stocks, graded as the AI
// picks are; and your own reading, the articles you log in the app, graded the same way. Pure
// functions, no network and no AI:
//   - once a day, scripts/fetch-articles.mjs calls picks up to READING.perDay new headlines from the
//     news feeds' monthly files (articles.js), investing sites first, reads each with the start of its
//     summary (from this run's downloads, never stored) in one Claude Haiku call (ai.js readCalls), and
//     keeps each site's calls in state/reading-calls.json (public: sites' headlines and links), shaped
//     like the picks' history, so scorecard.js scorePicks grades them unchanged;
//   - an article you log ("Log an article" in the app) reaches scripts/ai-fund.mjs through the app's
//     command; its page is downloaded on the runner (scripts/page_fetch.py) and read here (pageFacts), and
//     the same call finds its calls, which are kept with the funds (c.reading; private when the funds
//     are, and left out of their public copy by scripts/public-fund.mjs).
// A call is graded a month (21 trading days) later, in its direction, against the same bet on the
// index, dividends included and before fees. Honest limits: with 17 stocks, a site calls a few of them
// a month and calls bunch after results, so a site's record is mostly luck for a year or more. The page
// shows each record with its count, separate weeks and a likely range, and no verdict below
// READING.verdict graded calls. Nothing here reaches the AI funds or the picks.

import { decodeEntities, textOf, parseDate, canonicalUrl, articleId, normTitle, parseFeed, isFeed } from './articles.js';
import { scorePicks } from './scorecard.js';
import { BENCHMARKS, priceAt, priceAtWithTime } from './benchmark.js';
import { dividendReturn } from './actions.js';
import { isoWeek, separateBets, weeklyMean, quantile, tCdf, LIKELY, seeded, gauss } from './stats.js';

export const READING = {
  perDay: 40, // headlines read a day, at most, in one call...
  everyHours: 20, // ...at most this often (the feeds are fetched every 6 hours)
  lookbackDays: 4, // a headline must be this new to be read (Monday's read covers the weekend)
  itemChars: 300, // characters of a headline and the start of its summary, used in that call only
  horizon: 21, // graded a month (trading days) later
  verdict: 20, // graded calls before a record gets a verdict...
  verdictP: 0.998, // ...and then only this clear of noise (see readingNoiseCheck)
  chartMin: 5, // graded calls before a site gets a row on the chart (its Table has every site)
  keepDays: 400, // calls kept this long (the year of prices grades them)...
  maxCalls: 3000, // ...at most this many, the newest
  listDays: 21, // headlines and links kept this long, for the list of the latest calls
  pageChars: 1500, // paragraph text read from the page of an article you log...
  minText: 300, // ...and with less than this (its summary and paragraphs), the app asks for its text
  pasteMax: 3000, // characters of an article's text you paste
  ownMax: 100, // articles you log kept (the newest)
};

export const CALLS = ['buy', 'sell', 'hold', 'none'];
const STANCE = { buy: 'long', sell: 'short', hold: 'hold' };
export const REASONS = ['valuation', 'dividends', 'growth', 'results', 'guidance', 'analysts', 'momentum', 'macro', 'deal', 'product', 'management', 'other'];
export const REASON_LABELS = {
  valuation: 'valuation', dividends: 'dividends', growth: 'growth', results: 'results', guidance: 'guidance', analysts: 'analysts\' views',
  momentum: 'the chart', macro: 'the economy', deal: 'a deal', product: 'a product', management: 'management', other: 'other',
};

// Investing sites whose pieces argue for or against a stock: read first. The names the page shows.
export const OPINION_SITES = ['fool.com', 'barchart.com', 'tikr.com', 'thestreet.com', '247wallst.com', 'sg.finance.yahoo.com', 'thesmartinvestor.com.sg'];
export const SITE_NAMES = {
  'fool.com': 'The Motley Fool', 'barchart.com': 'Barchart', 'tikr.com': 'TIKR', 'thestreet.com': 'TheStreet', '247wallst.com': '24/7 Wall St',
  'sg.finance.yahoo.com': 'Yahoo Finance Singapore', 'finance.yahoo.com': 'Yahoo Finance', 'thesmartinvestor.com.sg': 'The Smart Investor',
  'businesstimes.com.sg': 'The Business Times', 'straitstimes.com': 'The Straits Times', 'channelnewsasia.com': 'CNA', 'cnbc.com': 'CNBC',
  'stocktwits.com': 'Stocktwits', 'firstformoney.com': 'First for Money',
};
export const siteName = (site) => SITE_NAMES[site] ?? site;

const HOUR = 3600e3, DAY = 24 * HOUR, DAY_S = 86400;
const isoS = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const round4 = (x) => Math.round(x * 1e4) / 1e4 || 0; // (never −0)
const sig = (x) => Number(x.toPrecision(6)); // a price, to 6 significant figures
const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---------- which headlines are read ----------

// A headline that reads like analysis, on any other site: a call, a question, a target or valuation,
// or a ticker in brackets, as Yahoo Finance's own analysis pieces write it ("Apple (AAPL)").
const ANALYSIS = /\b(?:buy|sell|hold|should you|is it time|time to|undervalued|overvalued|cheap|bargain|price target|target price|upside|downside|stocks? to|reasons? (?:to|why)|worth|top pick|valuation|dividend (?:stock|play)s?)\b|\?\s*$/i;
const TICKER = /\((?:(?:NASDAQ|NYSE|SGX)\s?:\s?)?[A-Z0-9]{1,5}(?:[.-][A-Z]{1,2})?\)/;

// 0: an investing site (or a feed of kind 'opinion' in feeds.json); 1: a headline that reads like
// analysis; 2: the news.
export function readRank(a, kinds = {}) {
  if (OPINION_SITES.includes(a.source) || kinds[a.feed] === 'opinion') return 0;
  return ANALYSIS.test(a.headline ?? '') || TICKER.test(a.headline ?? '') ? 1 : 2;
}

// The day's read is due when the last (`record.readAt`) is READING.everyHours old (less 10 minutes).
export const readingDue = (record, now = new Date()) => !record?.readAt || now - Date.parse(record.readAt) >= READING.everyHours * HOUR - 10 * 60e3;

// The headlines to read now (stored articles, articles.js): tagged to a stock, published in the last
// READING.lookbackDays, not read before (`record.read`), investing sites first and then the newest, at
// most READING.perDay. `kinds`: each feed's kind, by feed id (feeds.json).
export function toRead(articles, record, now = new Date(), { kinds = {} } = {}) {
  const read = record?.read ?? {};
  const from = now.getTime() - READING.lookbackDays * DAY;
  const seen = new Set();
  return (articles ?? []).filter((a) => {
    const t = Date.parse(a?.pubDate);
    if (!(t >= from && t <= now.getTime() + HOUR) || !a.symbols?.length || !a.id || read[a.id] || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).map((a) => ({ a, rank: readRank(a, kinds) }))
    .sort((x, y) => x.rank - y.rank || y.a.pubDate.localeCompare(x.a.pubDate))
    .slice(0, READING.perDay).map(({ a }) => a);
}

// The summaries in this run's downloads of the feeds (raw RSS or Atom; not a feed, nothing), by article
// id (articles.js articleId of the link without tracking parameters): { title, description }. They stay
// in memory for the day's read and are never stored.
export function feedSummaries(bodies) {
  const out = {};
  for (const body of bodies ?? []) {
    if (!isFeed(body)) continue;
    for (const it of parseFeed(body)) {
      const url = canonicalUrl(it.link);
      if (url && it.title) out[articleId(url)] ??= { title: it.title, description: it.description ?? '' };
    }
  }
  return out;
}

// Each headline as the call reads it: its site, the stocks it names and its text (the headline and the
// start of its summary, cut to READING.itemChars), numbered from 1. `summaries`: this run's downloads,
// { article id: { title, description } } (never stored); an item that has left its feed is read from its
// headline alone.
export function readingItems(articles, summaries = {}) {
  return (articles ?? []).map((a, i) => {
    const s = summaries[a.id];
    const title = s?.title || a.headline;
    return {
      n: i + 1, id: a.id, source: a.source, symbols: a.symbols, pubDate: a.pubDate, headline: a.headline, url: a.url,
      text: cut(s?.description ? `${title} — ${s.description}` : title, READING.itemChars),
    };
  });
}

// ---------- the calls ----------

// The calls in the AI's answer (ai.js READING_TOOL: { calls: [{ item, symbol, call, target_price,
// reasons_cited }] }) that hold up: an item it was given, a stock listed with that item, buy, sell or
// hold (none is no call), the first for each item and stock. [{ item, symbol, call, target, reasons }].
export function callsFrom(items, input) {
  const out = [], seen = new Set();
  for (const c of Array.isArray(input?.calls) ? input.calls : []) {
    const n = Number(c?.item);
    const it = Number.isInteger(n) ? (items ?? [])[n - 1] : null;
    if (!it || !it.symbols?.includes(c.symbol) || !STANCE[c.call]) continue;
    const key = `${n}|${c.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = Number(c.target_price);
    out.push({
      item: n, symbol: c.symbol, call: c.call, target: Number.isFinite(target) && target > 0 ? target : 0,
      reasons: [...new Set((Array.isArray(c.reasons_cited) ? c.reasons_cited : []).filter((r) => REASONS.includes(r)))].slice(0, 3),
    });
  }
  return out;
}

// A call as a pick (picks-history's shape, scorecard.js): its stance (long for buy, short for sell, hold)
// and the price when it was made (benchmark.js priceAt: the last price by then), with its target when
// that's a plausible price for the stock (a fifth to five times the price) and the reasons it cited.
// Null without a price.
export function pickOf(c, quote, t) {
  const price = priceAt(quote, t);
  if (!(price > 0)) return null;
  const target = c.target > 0 && c.target >= price / 5 && c.target <= price * 5 ? sig(c.target) : 0;
  return { symbol: c.symbol, stance: STANCE[c.call], price: sig(price), ...(target ? { target } : {}), ...(c.reasons?.length ? { reasons: c.reasons } : {}) };
}

// One call per site, per stock, per week (the ISO week it was published): the first counts.
const slot = (source, symbol, iso) => `${source}|${symbol}|${isoWeek(Date.parse(iso) / 1000)}`;

// The record (state/reading-calls.json: { readAt, read: { article id: day }, calls: [{ createdAt, source,
// headline?, url?, picks: [{ symbol, stance, price, target?, reasons? }] }] }) after a read of `items`
// found `calls`: each item's calls as one set, dated when it was published and priced then; a site's
// second call on a stock in a week is dropped. Every item read is remembered for READING.lookbackDays,
// so none is read twice. Returns { record, kept, dropped }.
export function recordCalls(record, items, calls, quotes, now = new Date()) {
  const sets = [...(record?.calls ?? [])];
  const taken = new Set(sets.flatMap((s) => s.picks.map((p) => slot(s.source, p.symbol, s.createdAt))));
  let kept = 0, dropped = 0;
  for (const it of items ?? []) {
    const picks = [];
    for (const c of (calls ?? []).filter((x) => x.item === it.n)) {
      const key = slot(it.source, c.symbol, it.pubDate);
      if (taken.has(key)) { dropped++; continue; }
      const p = pickOf(c, quotes?.[c.symbol], Date.parse(it.pubDate) / 1000);
      if (!p) continue;
      taken.add(key);
      picks.push(p);
    }
    if (!picks.length) continue;
    kept += picks.length;
    sets.push({ createdAt: it.pubDate, source: it.source, headline: it.headline, url: it.url, picks });
  }
  const since = new Date(now - (READING.lookbackDays + 1) * DAY).toISOString().slice(0, 10);
  const read = Object.fromEntries(Object.entries(record?.read ?? {}).filter(([, day]) => day >= since));
  for (const it of items ?? []) read[it.id] = String(it.pubDate).slice(0, 10);
  return { record: { readAt: isoS(now), read, calls: trimCalls(sets, now) }, kept, dropped };
}

// Oldest first; calls older than READING.keepDays go, at most READING.maxCalls stay, and headlines and
// links are kept only for READING.listDays (the list of the latest calls).
export function trimCalls(sets, now = new Date()) {
  const from = isoS(now - READING.keepDays * DAY), list = isoS(now - READING.listDays * DAY);
  return sets.filter((s) => s.createdAt >= from).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-READING.maxCalls)
    .map(({ headline, url, ...s }) => (s.createdAt >= list && headline ? { ...s, headline, url } : s));
}

// ---------- grading ----------

// The calls that can be graded (holds have no direction), as the picks' history is.
export const gradable = (sets) => (sets ?? []).map((s) => ({ ...s, picks: (s.picks ?? []).filter((p) => p.stance === 'long' || p.stance === 'short') })).filter((s) => s.picks.length);

// Each call graded a month later (scorecard.js scorePicks): { symbol, direction, t, x }, x being what
// it made in its direction against the same bet on the index. `source` is kept for grouping.
export function monthResults(sets, quotes, now = new Date()) {
  const out = [];
  for (const s of gradable(sets)) {
    for (const x of scorePicks([s], quotes, now)) {
      if (x.horizon !== 'month' || x.indexBet == null) continue;
      out.push({ source: s.source, symbol: x.symbol, direction: x.stance === 'short' ? -1 : 1, t: Date.parse(x.createdAt) / 1000, x: x.ret - x.indexBet });
    }
  }
  return out;
}

// A record from graded calls ({ symbol, direction, t, x }): calls on the same stock and side within a
// month are one bet (stats.js separateBets), and each calendar week's bets count once (weeklyMean), so
// a week when every site called the same move counts once. { n (calls), beat (how many beat the index),
// bets, weeks, avg (a month later against the index, each week once), lo, hi (the likely range, an
// 8-in-10 chance, from 2 weeks on), p (the chance its sign is right), verdict }. The verdict: 'too-few'
// below READING.verdict calls; then 'better' or 'worse' only when the average is clear of noise (a
// READING.verdictP chance of its sign on a t-distribution over the weeks), else 'unclear'.
export function recordOf(rows) {
  const n = rows?.length ?? 0;
  if (!n) return { n: 0, beat: 0, bets: 0, weeks: 0, avg: null, lo: null, hi: null, p: null, verdict: 'too-few' };
  const bets = separateBets(rows, READING.horizon);
  const w = weeklyMean(bets.map((b) => ({ x: mean(b.items.map((i) => i.x)), key: isoWeek(b.t) })));
  const spread = w.n >= 2 && w.se > 0;
  const half = spread ? quantile(0.5 + LIKELY / 2, w.n - 1) * w.se : null;
  const p = spread ? Math.round(tCdf(Math.abs(w.mean) / w.se, w.n - 1) * 1000) / 1000 : null;
  const verdict = n < READING.verdict ? 'too-few' : spread && Math.abs(w.mean) >= quantile(READING.verdictP, w.n - 1) * w.se ? (w.mean > 0 ? 'better' : 'worse') : 'unclear';
  return {
    n, beat: rows.filter((r) => r.x > 1e-9).length, bets: bets.length, weeks: w.n, avg: round4(w.mean),
    lo: spread ? round4(w.mean - half) : null, hi: spread ? round4(w.mean + half) : null, p, verdict,
  };
}

// Each site's record, with every site pooled first (`site: null`): { site, calls (buy, sell and hold),
// holds, open (not a month old yet), ...recordOf }, the sites with the most graded calls first.
export function siteRecords(record, quotes, now = new Date()) {
  const sets = record?.calls ?? [];
  if (!sets.length) return [];
  const results = monthResults(sets, quotes, now);
  const sites = [...new Set(sets.map((s) => s.source))];
  const one = (site) => {
    const mine = site == null ? sets : sets.filter((s) => s.source === site);
    const picks = mine.flatMap((s) => s.picks);
    const graded = results.filter((r) => site == null || r.source === site);
    const holds = picks.filter((p) => p.stance === 'hold').length;
    return { site, calls: picks.length, holds, open: picks.length - holds - graded.length, ...recordOf(graded) };
  };
  return [one(null), ...sites.map(one).sort((a, b) => b.n - a.n || b.calls - a.calls || a.site.localeCompare(b.site))];
}

// The latest calls with their headlines (kept READING.listDays), newest first: [{ createdAt, source,
// headline, url, pick }].
export function latestCalls(record, n = 30) {
  return (record?.calls ?? []).filter((s) => s.headline).flatMap((s) => s.picks.map((p) => ({ createdAt: s.createdAt, source: s.source, headline: s.headline, url: s.url, pick: p })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, n);
}

// A call not graded yet: what it has made so far in its direction, and against the same bet on the
// index (dividends included, as scorePicks counts them). { move, vsIndex } or null.
export function soFar(createdAt, pick, quotes) {
  const q = quotes?.[pick.symbol];
  const iq = quotes?.[BENCHMARKS[q?.currency]?.symbol];
  if (!q?.price || !(pick.price > 0) || !['long', 'short'].includes(pick.stance)) return null;
  const t0 = Date.parse(createdAt) / 1000, t1 = Date.now() / 1000;
  const dir = pick.stance === 'short' ? -1 : 1;
  const move = dir * (q.price / pick.price - 1) + dividendReturn(q, t0, t1, dir, pick.price);
  const [i0, it0] = priceAtWithTime(iq, t0);
  const bet = i0 && iq?.price ? dir * (iq.price / i0 - 1) + dividendReturn(iq, it0, t1, dir, i0) : null;
  return { move, vsIndex: bet == null ? null : move - bet };
}

// About when a call's month grade comes in: READING.horizon weekdays after its day (holidays aside).
export function gradeDay(iso, days = READING.horizon) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  for (let k = 0; k < days;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (![0, 6].includes(d.getUTCDay())) k++;
  }
  return d.toISOString().slice(0, 10);
}

// ---------- your own reading ----------

// A meta tag's content, the first of `names` (property, name or itemprop) that a tag has.
function metaContent(html, names) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  for (const name of names) {
    for (const tag of tags) {
      const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1];
      if (key?.toLowerCase() !== name) continue;
      const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
      if (content?.trim()) return decodeEntities(content).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

// What an article's page says: { title (og:title, else <title>), description (og:description), published
// (ISO: article:published_time, JSON-LD datePublished or a <time datetime>; null without), text (its
// paragraphs, the first READING.pageChars characters), blocked (Cloudflare's "Just a moment" page) }.
// Only what the page shows in paragraphs is read: never a paywalled body hidden in its data.
export function pageFacts(html) {
  const page = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
  const tagTitle = textOf(page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const title = metaContent(page, ['og:title', 'twitter:title']) || tagTitle;
  const description = metaContent(page, ['og:description', 'twitter:description', 'description']);
  const jsonLd = page.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1];
  const time = page.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1];
  const published = parseDate(metaContent(page, ['article:published_time', 'og:article:published_time', 'datepublished', 'pubdate']) || jsonLd || time || '');
  const body = page.replace(/<(script|style|noscript|template|svg|header|footer|nav|aside|figure|form|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => textOf(m[1])).filter((p) => p.length >= 40);
  return {
    title: cut(title, 200), description: cut(description, 600), published,
    text: cut(paras.join(' '), READING.pageChars), blocked: /^just a moment/i.test(tagTitle || title),
  };
}

// Whether a page gave enough to read: a title and READING.minText characters of summary and paragraphs.
export const readable = (f) => Boolean(f && !f.blocked && f.title && `${f.description} ${f.text}`.trim().length >= READING.minText);

// What the call reads for an article you log: from its page (`facts`), or the text you pasted (which
// wins over the page's paragraphs: you may have pasted what a paywall hid), cut to READING.pasteMax.
// { title, published, text }: the title is the page's, else your text's first line.
export function ownText({ facts = null, pasted = '' } = {}) {
  const paste = cut(String(pasted ?? '').replace(/\r/g, ''), READING.pasteMax);
  const firstLine = paste.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = facts?.title || (firstLine.length <= 150 ? firstLine : '');
  const text = paste ? paste.replace(/\s+/g, ' ') : [facts?.description, facts?.text].filter(Boolean).join(' — ');
  return { title: cut(title, 120), published: facts?.published ?? null, text: title && !text.startsWith(title) ? `${title} — ${text}` : text };
}

// A link you gave, if it's a public web page: http(s), a host name with a dot, not an IP address or the
// runner itself. The same check as scripts/page_fetch.py makes before downloading it.
export function publicUrl(raw) {
  const url = canonicalUrl(raw);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /(^|\.)localhost$/.test(host) || (u.port && !['80', '443'].includes(u.port))) return null;
  return url;
}

// Your logged articles (c.reading) with one more: { id, createdAt (when you logged it: its grade starts
// then, so an old article isn't graded on moves you'd already seen), site, title, url?, published?,
// picks }, newest last, the latest READING.ownMax within READING.keepDays. The same article (link, or
// pasted text) logged again within a week isn't added twice: returns { list, added }.
export function addOwn(list, entry, now = new Date()) {
  const old = (Array.isArray(list) ? list : []).filter((e) => e.createdAt >= isoS(now - READING.keepDays * DAY));
  if (loggedLately(old, entry.id, now)) return { list: old, added: false };
  return { list: [...old, entry].slice(-READING.ownMax), added: true };
}

// Whether the article with this id was logged in the last week.
export const loggedLately = (list, id, now = new Date()) => (Array.isArray(list) ? list : []).some((e) => e.id === id && now - Date.parse(e.createdAt) < 7 * DAY);

// An id for an article you log: from its link, else from the start of its text.
export const ownId = (url, text) => articleId(url || `pasted:${normTitle(String(text ?? '').slice(0, 300))}`);

// ---------- how often noise gives a verdict ----------

// Made-up sites with no skill at all, over a year: every week each makes about one call on one of 8
// stocks (most on the same few, mostly buys), graded a month later on the stocks' made-up moves against
// the index (a theme shared by 6 of them plus their own; overlapping months share their weeks). Each
// site's record is checked every week, as the page would show it: { sims, any } is the share of sites
// that showed a verdict ('better' or 'worse') at some point in the year. READING.verdictP was set on it:
// at a 97.5% chance, 17% of such sites showed one; at 99.8%, about 4%. The same test is slow to credit
// real skill: in the same simulation, a site making 3 calls a week whose calls really beat the index by
// 1% a month showed a verdict within the year only 1 time in 10, and one beating it by 2% about half the
// time.
export function readingNoiseCheck({ sims = 1000, seed = 1, weeks = 52 } = {}) {
  const T0 = Date.UTC(2025, 0, 6) / 1000; // a Monday
  let any = 0;
  for (let k = 0; k < sims; k++) {
    const rand = seeded(seed + k * 7919);
    const moves = Array.from({ length: weeks + 6 }, () => { const theme = 0.02 * gauss(rand); return Array.from({ length: 8 }, (_, s) => (s < 6 ? theme : 0) + 0.025 * gauss(rand)); });
    const calls = [];
    for (let w = 0; w < weeks; w++) {
      for (let c = 0; c < 3; c++) {
        if (rand() > 0.4) continue; // about 1.2 calls a week
        const s = Math.min(7, Math.floor(8 * rand() ** 2)); // the first few stocks most
        const direction = rand() < 0.85 ? 1 : -1;
        const x = direction * (moves[w + 1][s] + moves[w + 2][s] + moves[w + 3][s] + moves[w + 4][s]);
        calls.push({ symbol: `S${s}`, direction, t: T0 + (w * 7 + Math.floor(5 * rand())) * DAY_S, week: w, x });
      }
    }
    for (let w = 5; w <= weeks + 5; w++) {
      const v = recordOf(calls.filter((c) => c.week + 5 <= w)).verdict;
      if (v === 'better' || v === 'worse') { any++; break; }
    }
  }
  return { sims, any: Math.round((any / sims) * 1000) / 1000 };
}

// The result of readingNoiseCheck() with its defaults, which test/reading.test.mjs re-runs and checks:
// the page prints it in its honesty note.
export const READING_NOISE = { sims: 1000, any: 0.037 };
