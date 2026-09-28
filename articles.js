// Articles from free news feeds (feeds.json): Singapore and US business news, and Yahoo Finance's
// headline feed for each stock in symbols.json. Pure functions, no AI and no network: the job downloads
// the feeds with scripts/feed_fetch.py (curl_cffi, as for Yahoo's prices) and scripts/fetch-articles.mjs
// turns them into records here.
// Only an item that names a watchlist stock is kept, and only its headline, link, site, feed and time,
// never its text (state/articles/YYYY-MM.json, public). They're leads for the news digest (ai.js
// gatherNews) and tell which big moves had news (memory.js). Items are tagged by what their headline and
// the start of their description say, never by the feed they came from: Yahoo's feed for NVDA carries
// many stories about other stocks, and its feed for AAPL led with one about Tesla.

export const ARTICLES = {
  everyHours: 6, // the feeds are fetched at most this often
  deadAfter: 3, // a feed that failed this many tries in a row is dead...
  retryHours: 24, // ...and is tried once a day until it answers again
  maxAgeDays: 30, // an item older than this when first seen is left out
  perMonth: 3000, // a month's file keeps at most this many (the newest)
  keepMonths: 13, // months of files kept
  headline: 200, // characters kept of a headline
  tagChars: 300, // characters of the description read for tagging (never kept)
  sameStoryHours: 72, // the same headline within this many hours is the same story
  leads: 15, // headlines given to the news digest...
  leadDays: 4, // ...none older than this
  quality: 200, // digests kept in the quality record
};

const HOUR = 3600e3, DAY = 24 * HOUR;

// ---------- the feeds ----------

// The feeds to read: feeds.json's, with a per-stock feed (a `template`) expanded to one for each stock
// in symbols.json, in its region (index funds are left out: they have no company news).
export function expandFeeds(feeds, symbols) {
  const out = [];
  for (const f of feeds ?? []) {
    if (!f.template) {
      out.push({ id: f.id, name: f.name, url: f.url, market: f.market, kind: f.kind });
      continue;
    }
    for (const s of symbols ?? []) {
      if (s.etf) continue;
      const region = f.regions?.[s.market] ?? s.market;
      const url = f.template.replaceAll('{symbol}', encodeURIComponent(s.symbol)).replaceAll('{region}', region);
      out.push({ id: `${f.id}:${s.symbol}`, name: `${f.name} for ${s.symbol}`, url, market: s.market, kind: f.kind, symbol: s.symbol });
    }
  }
  return out;
}

// The file a feed's download goes in (on the runner only).
export const feedFile = (id) => `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.xml`;

// A fetch is due when the last try (state/feed-health.json `triedAt`) is ARTICLES.everyHours old (less
// 10 minutes, since scheduled runs start a little late).
export const feedsDue = (health, now = new Date()) => !health?.triedAt || now - Date.parse(health.triedAt) >= ARTICLES.everyHours * HOUR - 10 * 60e3;

const dead = (h) => (h?.fails ?? 0) >= ARTICLES.deadAfter;

// The feeds to try now: every one but the dead, which are tried once a day.
export function planFeeds(feeds, health, now = new Date()) {
  return feeds.filter((f) => {
    const h = health?.feeds?.[f.id];
    return !dead(h) || !h.tried || now - Date.parse(h.tried) >= ARTICLES.retryHours * HOUR - 10 * 60e3;
  });
}

// A download that is a feed: RSS or Atom, not an error page (Cloudflare answers blocked requests with a
// "Just a moment..." page, sometimes with HTTP 200).
export const isFeed = (body) => /<(?:rss|feed|rdf:RDF)[\s>]/i.test(String(body ?? '').slice(0, 5000)) && !/<title>\s*Just a moment/i.test(String(body ?? '').slice(0, 2000));

// The feeds' health after a fetch: `results` is { id: { ok, items, error } } for the feeds tried. A
// success resets a feed's failures; a failure adds one, and ARTICLES.deadAfter in a row make it dead
// (tried once a day). When none of 3 or more feeds answered, the runner's connection is the likelier
// fault, so the errors are noted but not counted against the feeds. `since` is the day the feeds first
// answered, when the study of big moves with and without news starts; `answered`/`tried` say how the
// latest fetch went. Feeds no longer in `known` (feeds.json, expanded) are forgotten.
export function updateHealth(health, results, now = new Date(), known = null) {
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const feeds = { ...(health?.feeds ?? {}) };
  const tried = Object.keys(results ?? {}).length;
  const answered = Object.values(results ?? {}).filter((r) => r.ok).length;
  const count = answered > 0 || tried < 3;
  for (const [id, r] of Object.entries(results ?? {})) {
    const prev = feeds[id] ?? {};
    feeds[id] = r.ok ? { ok: at, fails: 0, tried: at, items: r.items ?? 0 }
      : { ...(prev.ok ? { ok: prev.ok } : {}), fails: (prev.fails ?? 0) + (count ? 1 : 0), tried: at, error: String(r.error ?? 'failed').slice(0, 80) };
  }
  if (known) for (const id of Object.keys(feeds)) if (!known.has(id)) delete feeds[id];
  return {
    ...(health ?? {}), ...(answered && !health?.since ? { since: at.slice(0, 10) } : {}),
    triedAt: health?.triedAt ?? at, fetchedAt: at, answered, tried, feeds,
  };
}

// The dead feeds, with their last error and when they last answered (null: never), for the log.
export const deadFeeds = (health) => Object.entries(health?.feeds ?? {}).filter(([, h]) => dead(h)).map(([id, h]) => ({ id, error: h.error ?? '', lastOk: h.ok ?? null }));

// ---------- reading a feed ----------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', hellip: '…', laquo: '«', raquo: '»', bull: '•', middot: '·', trade: '™', reg: '®', copy: '©',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à',
  oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß',
};

// XML and HTML character references: &amp; &#8217; &#x2019; and the common named ones.
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,7});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const k = Object.hasOwn(NAMED, e) ? e : e.toLowerCase();
    return Object.hasOwn(NAMED, k) ? NAMED[k] : m;
  });
}

// An element's content as text: CDATA sections are taken as they are and the rest XML-decoded, which
// leaves HTML (a description is often escaped HTML); then tags go and HTML's own references are decoded.
export function textOf(raw) {
  if (raw == null) return '';
  let out = '', last = 0;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  for (let m; (m = cdata.exec(raw));) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = cdata.lastIndex;
  }
  out += decodeEntities(raw.slice(last));
  // a news agency's ticker in angle brackets (<NVDA.O>, <D05.SI>) is text, not a tag
  const noTags = out.replace(/<(script|style)[\s>][\s\S]*?<\/\1>/gi, ' ').replace(/<(?![A-Z0-9]{1,8}\.[A-Z]{1,3}>)\/?[a-z][^>]*>/gi, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

// The raw content of an item's first <tag> (null without one; '' when empty or self-closing). A
// namespaced tag with the same local name (<media:title>) doesn't count.
function field(block, tag) {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(block);
  if (!open) return null;
  if (open[1]?.trim().endsWith('/')) return '';
  const start = open.index + open[0].length;
  const end = block.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, start);
  return end < 0 ? null : block.slice(start, end);
}

// Dates in feeds: RFC 822 with an offset (+0000, +0800) or GMT, ISO 8601 in dc:date and Atom, and
// Singapore's SGT, which JavaScript doesn't know. An ISO time in UTC, to the second, or null.
export function parseDate(s) {
  const text = String(s ?? '').trim().replace(/\b(SGT|HKT|MYT)$/i, '+0800');
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

// A feed's items: [{ title, link, description, pubDate (ISO or null), guid, categories }], all as text.
// RSS 2.0 <item>s, and Atom <entry>s (whose link is an attribute).
export function parseFeed(xml) {
  const body = String(xml ?? '');
  const out = [];
  for (const [, block] of body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const guid = textOf(field(block, 'guid'));
    const link = textOf(field(block, 'link')) || (/^https?:\/\//.test(guid) ? guid : '');
    out.push({
      title: textOf(field(block, 'title')), link, description: textOf(field(block, 'description')),
      pubDate: parseDate(textOf(field(block, 'pubDate')) || textOf(field(block, 'dc:date'))), guid,
      categories: [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((m) => textOf(m[1])).filter(Boolean),
    });
  }
  for (const [, block] of body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const href = (block.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i) ?? block.match(/<link\b[^>]*>/i))?.[0].match(/href=["']([^"']+)["']/i)?.[1];
    out.push({
      title: textOf(field(block, 'title')), link: href ? decodeEntities(href) : '', description: textOf(field(block, 'summary') ?? field(block, 'content')),
      pubDate: parseDate(textOf(field(block, 'published')) || textOf(field(block, 'updated'))), guid: textOf(field(block, 'id')), categories: [],
    });
  }
  return out;
}

// ---------- links ----------

// Query parameters that only track where a click came from: utm_*, Yahoo's .tsrc, and the like.
const TRACKING = /^(?:utm_[a-z0-9_]*|\.?tsrc|ncid|cmpid|fbclid|gclid|mc_cid|mc_eid|guccounter|guce_referrer(?:_sig)?|soc_src|soc_trk|sr_share|__source|yptr|taid|ref)$/i;

// A link without its tracking parameters and fragment (entities decoded: WordPress feeds write & as
// &#038;), or null when it isn't an http(s) link. The rest of the query keeps its order and encoding.
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(decodeEntities(String(raw ?? '').trim())); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  const keep = u.search.slice(1).split('&').filter((p) => {
    if (!p) return false;
    let k = p.split('=')[0];
    try { k = decodeURIComponent(k); } catch { /* keep it as it is */ }
    return !TRACKING.test(k);
  });
  u.search = keep.length ? `?${keep.join('&')}` : '';
  return u.toString();
}

// The same page for dedupe: any scheme, with or without www. and a trailing slash, any case.
export function urlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch { return String(url ?? '').toLowerCase(); }
}

// The site an article is on: its link's host without www. (finance.yahoo.com and sg.finance.yahoo.com
// stay apart: the second carries Singapore articles, The Smart Investor's among them).
export function siteOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// A headline for dedupe: lower case, accents and punctuation gone.
export const normTitle = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// A short stable id from a link: two 32-bit FNV-1a hashes with different seeds, in base 36.
const fnv = (s, h) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h.toString(36).padStart(7, '0'); };
export const articleId = (url) => { const k = urlKey(url); return `${fnv(k, 0x811c9dc5)}${fnv(k, 0x01000193)}`; };

// ---------- which stocks an item names ----------

// The names that tag a stock, beyond its name in symbols.json and its ticker: regular expressions
// matched as whole words, case-sensitive in `names` (DBS, SIA, Apple, Meta are words or letters that
// mean other things in lower case) and in any case in `anyCase`. `not` (any case) lists phrases naming
// something else, which don't count: a REIT or trust carrying the group's name, an affiliate listed on
// its own, a bank's economists and analysts quoted on other news, SGX as the market rather than the
// company, and namesakes.
const POSS = "(?:['’]s)?";
const PLATFORM_USE = '(?:posts?|pages?|videos?|groups?|messages?|chats?|accounts?|scams?|channels?|clips?|live)';
const DESK = `${POSS} (?:group${POSS} |bank${POSS} |investment |global |private bank${POSS} )?(?:chief |senior |lead )?(?:research|economics|economists?|analysts?|strategists?|securities|vickers|asset management|chief investment office(?:r)?|cio|head of (?:research|equities|economics|investments?|strategy|fixed income|wealth))`;
export const ALIASES = {
  'D05.SI': { names: ['DBS'], not: [`DBS${DESK}`] },
  'O39.SI': { names: ['OCBC', 'Oversea-Chinese Banking'], not: [`OCBC${DESK}`, 'iOCBC'] },
  'U11.SI': { names: ['UOB', 'United Overseas Bank'], not: [`UOB${DESK}`, `United Overseas Bank${DESK}`, 'UOB[-‑– ]?Kay[-‑– ]?Hian'] },
  'Z74.SI': { anyCase: ['Singtel', 'Singapore Telecommunications', 'Optus'] },
  'C6L.SI': { names: ['SIA'], not: ['SIA Engineering', 'SIA Engg', 'SIAEC'] },
  'S68.SI': {
    names: ['SGX'],
    not: [
      'SGX ?: ?[A-Z0-9]{2,5}', // a stock's ticker on the exchange, e.g. (SGX:U11)
      '(?:Nasdaq|NYSE|HKEX|ASX|LSE)[-‑–/ ]SGX', 'SGX[-‑–/ ](?:Nasdaq|NYSE|HKEX|ASX|LSE)', // one of two listing venues
      'SGX[-‑– ](?:listed|traded|quoted|ST)', 'Singapore Exchange[-‑– ](?:listed|traded|quoted)',
      // listing on it (an analyst's view "on SGX" is about the company)
      "(?:list|lists|listed|listing|listings|IPOs?|debut(?:s|ed|ing)?|floats?|floated|floating|quoted|trades?|traded|trading) (?:on|onto) (?:the )?(?:SGX|Singapore Exchange)(?:['’]s)?(?: Mainboard| Catalist)?",
      'SGX (?:Mainboard|Catalist|RegCo|stocks|IPOs?|filings?|announcements?|firms|companies|counters)',
      'Singapore Exchange Regulation',
    ],
  },
  'BN4.SI': {
    anyCase: ['Keppel'],
    not: ['Keppel (?:DC )?REIT', 'Keppel Infrastructure Trust', 'Keppel Pacific Oak(?: US REIT)?', 'Keppel DC', 'KepPacOak', 'Keppel (?:Bay|Road|Harbour|Club|Island|Distripark|Hill)'], // the last: places in Singapore
  },
  'C38U.SI': { names: ['CICT'], anyCase: ['CapitaLand Integrated Commercial Trust', 'CapitaLand Integrated'] },
  'Y92.SI': { anyCase: ['Thai Beverage', 'ThaiBev'] },
  AAPL: { names: ['Apple'], not: ['Apple Hospitality(?: REIT)?', 'Apple Bank', 'Big Apple', 'Apple Daily'] },
  MSFT: { anyCase: ['Microsoft'] },
  NVDA: { anyCase: ['Nvidia'] },
  AMZN: { names: ['Amazon', 'AWS'], anyCase: ['Amazon Web Services'], not: ['Amazon(?:ian)? (?:rainforest|rain forest|river|basin|jungle|deforestation|region)'] },
  // a platform someone posted on, or a scam ran through, isn't news about its owner
  GOOGL: { names: ['Alphabet', 'Google', 'GOOG'], anyCase: ['YouTube', 'Waymo', 'DeepMind'], not: [`YouTube ${PLATFORM_USE}`, '(?:on|via|over|through) YouTube', 'Google Trends', '(?:a|in a) Google search'] },
  META: {
    names: ['Meta'], anyCase: ['Facebook', 'Instagram', 'WhatsApp'],
    not: ['Meta Materials', 'Meta Financial', 'Meta[-‑ ]analys[ie]s', `(?:Facebook|Instagram|WhatsApp) ${PLATFORM_USE}`, '(?:on|via|over|through) (?:Facebook|Instagram|WhatsApp)'],
  },
  TSLA: { anyCase: ['Tesla'], not: ['Nikola Tesla'] },
  'BRK-B': { anyCase: ['Berkshire Hathaway', 'Berkshire'], not: ['Berkshire (?:Hills|Grey|Partners|Realty|Income)', '(?:West|Royal) Berkshire', 'Berkshire,? (?:England|UK|county|police)'] },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = (list, flags) => new RegExp(`(?<![A-Za-z0-9])(?:${list.join('|')})(?![A-Za-z0-9])`, flags);

// A stock's ticker as headlines write it: (SGX:U11) or U11.SI for SGX, AAPL or BRK.B for US stocks.
function tickerPatterns(symbol) {
  const sgx = symbol.match(/^([A-Z0-9]+)\.SI$/);
  if (sgx) return [`SGX ?: ?${sgx[1]}`, `${sgx[1]}\\.SI`];
  return [escapeRe(symbol).replace(/\\?-/g, '[-./]?')];
}

// A tagger for the watchlist (symbols.json; index funds left out): text → the symbols it names. A name
// inside one of the stock's `not` phrases doesn't count, but another mention of it in the same text does.
export function makeTagger(symbols, aliases = ALIASES) {
  const entries = (symbols ?? []).filter((s) => !s.etf).map((s) => {
    const a = aliases[s.symbol] ?? {};
    const own = [escapeRe(s.name ?? s.symbol), ...(a.names ?? [])];
    // a name in capitals (an all-caps headline) is the name too
    const exact = [...own, ...own.filter((n) => /^[A-Za-z .&-]+$/.test(n) && n !== n.toUpperCase()).map((n) => n.toUpperCase()), ...tickerPatterns(s.symbol)];
    return {
      symbol: s.symbol,
      names: [WORD(exact, 'g'), ...(a.anyCase?.length ? [WORD(a.anyCase, 'gi')] : [])],
      not: a.not?.length ? WORD(a.not, 'gi') : null,
    };
  });
  return (text) => {
    const t = String(text ?? '');
    return entries.filter((e) => {
      const spans = e.not ? [...t.matchAll(e.not)].map((m) => [m.index, m.index + m[0].length]) : [];
      return e.names.some((re) => [...t.matchAll(re)].some((m) => !spans.some(([a, b]) => m.index >= a && m.index + m[0].length <= b)));
    }).map((e) => e.symbol);
  };
}

// ---------- articles ----------

// A feed's items as articles, keeping those that name a watchlist stock (tagged on the headline and the
// description's first ARTICLES.tagChars characters): { id, symbols, source (the link's site), feed,
// pubDate, headline, url }, plus `text`, what was tagged, for this run only (it's never saved). Items
// without a link or older than ARTICLES.maxAgeDays are left out; an undated or future-dated item is
// dated when it was fetched.
export function articlesFrom(items, feedId, tag, now = new Date()) {
  const out = [];
  for (const it of items ?? []) {
    const url = canonicalUrl(it.link);
    const title = String(it.title ?? '').trim();
    if (!url || !title) continue;
    let at = it.pubDate ? Date.parse(it.pubDate) : NaN;
    if (!Number.isFinite(at) || at > now.getTime()) at = now.getTime();
    if (now - at > ARTICLES.maxAgeDays * DAY) continue;
    const text = `${title} ${String(it.description ?? '').slice(0, ARTICLES.tagChars)}`.trim();
    const symbols = tag(text);
    if (!symbols.length) continue;
    const headline = title.length > ARTICLES.headline ? `${title.slice(0, ARTICLES.headline - 1).trimEnd()}…` : title;
    out.push({
      id: articleId(url), symbols, source: siteOf(url), feed: feedId,
      pubDate: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'), headline, url, text,
    });
  }
  return out;
}

// The articles in `fresh` not already stored: the same link, or the same headline within
// ARTICLES.sameStoryHours (the same story on another site, or in another feed), is left out. `stored`:
// the items of the months they could fall in. The first of two copies in `fresh` wins.
export function newArticles(stored, fresh) {
  const urls = new Set((stored ?? []).map((a) => urlKey(a.url)));
  const titles = new Map();
  const note = (a) => { const k = normTitle(a.headline); if (k) titles.set(k, [...(titles.get(k) ?? []), Date.parse(a.pubDate)]); };
  (stored ?? []).forEach(note);
  const out = [];
  for (const a of fresh ?? []) {
    const k = normTitle(a.headline), at = Date.parse(a.pubDate);
    if (urls.has(urlKey(a.url)) || (k && (titles.get(k) ?? []).some((t) => Math.abs(t - at) <= ARTICLES.sameStoryHours * HOUR))) continue;
    urls.add(urlKey(a.url));
    note(a);
    out.push(a);
  }
  return out;
}

// The month an article is filed under (state/articles/YYYY-MM.json): its publication month, in UTC.
export const monthOf = (iso) => String(iso).slice(0, 7);

// The last `n` months' keys, this one first.
export function recentMonths(now = new Date(), n = 2) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}

// A month's file with new articles added: oldest first, the newest ARTICLES.perMonth kept, and only the
// fields that are saved.
export function addToMonth(items, fresh) {
  return [...(items ?? []), ...(fresh ?? [])].map(({ id, symbols, source, feed, pubDate, headline, url }) => ({ id, symbols, source, feed, pubDate, headline, url }))
    .sort((a, b) => a.pubDate.localeCompare(b.pubDate)).slice(-ARTICLES.perMonth);
}

// Whether a month's file is past keeping (older than ARTICLES.keepMonths).
export const expiredMonth = (month, now = new Date()) => month < recentMonths(now, ARTICLES.keepMonths).at(-1);

// ---------- leads for the news digest ----------

// The freshest tagged headlines about `symbols` for the news digest (ai.js gatherNews): at most
// ARTICLES.leads, none older than ARTICLES.leadDays, newest first, taking the markets in turn (the US
// feeds carry more, and SGX gains most from leads). Each is { symbols, source, pubDate, headline, url }.
export function freshLeads(articles, symbols, now = new Date(), { marketOf = () => '', n = ARTICLES.leads } = {}) {
  const want = new Set(symbols ?? []);
  const from = now.getTime() - ARTICLES.leadDays * DAY;
  const byMarket = new Map();
  const seen = new Set();
  const sorted = (articles ?? []).filter((a) => {
    const t = Date.parse(a.pubDate);
    return t >= from && t <= now.getTime() + HOUR && a.symbols?.some((s) => want.has(s));
  }).sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  for (const a of sorted) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    const mine = a.symbols.filter((s) => want.has(s));
    const m = marketOf(mine[0]);
    if (!byMarket.has(m)) byMarket.set(m, []);
    byMarket.get(m).push({ symbols: mine, source: a.source, pubDate: a.pubDate, headline: a.headline, url: a.url });
  }
  const lists = [...byMarket.values()];
  const out = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  return out.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
}

// The leads as the digest reads them: one line each, newest first.
export function leadsText(leads, now = new Date()) {
  const ago = (iso) => { const h = Math.max(0, Math.round((now - Date.parse(iso)) / HOUR)); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
  return leads.map((l) => `- [${l.symbols.join(', ')}] ${l.headline} (${l.source}, ${ago(l.pubDate)}) ${l.url}`).join('\n');
}

// ---------- the digest's quality, with and without leads ----------

// One digest's record, for comparing weeks with the leads on and off (the NEWS_LEADS variable): how
// many items it had, how many kept a checked link (a page from its searches or a lead's: "verified"),
// how many came from a lead, and its searches and cost. Counts only.
export function digestQuality(news, { by = 'picks', on = true } = {}) {
  const items = news?.items ?? [];
  const leadUrls = new Set((news?.leads ?? []).map((l) => l.url));
  return {
    at: news?.createdAt ?? null, by, via: news?.via ?? 'search', leadsOn: Boolean(on), leads: leadUrls.size, items: items.length,
    verified: items.filter((i) => i.source_url).length, fromLeads: items.filter((i) => leadUrls.has(i.source_url)).length,
    searches: news?.usage?.searches ?? 0, costUsd: news?.usage?.costUsd ?? 0,
  };
}

// The record with one more digest, the latest ARTICLES.quality kept.
export const addQuality = (list, rec) => [...(Array.isArray(list) ? list : []), rec].slice(-ARTICLES.quality);

// The record week by week (ISO weeks, from `isoWeek`), split by whether the leads were on: digests,
// average items, share of items with a verified link, items from leads, searches and cost a digest.
export function qualityByWeek(list, isoWeek) {
  const groups = new Map();
  for (const r of list ?? []) {
    if (!r?.at) continue;
    const k = `${isoWeek(Date.parse(r.at) / 1000)}|${r.leadsOn ? 'on' : 'off'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const avg = (rs, f) => rs.reduce((s, r) => s + (f(r) ?? 0), 0) / rs.length;
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => {
    const [week, leads] = k.split('|');
    const items = rs.reduce((s, r) => s + r.items, 0);
    return {
      week, leads, digests: rs.length, items: avg(rs, (r) => r.items), verified: items ? rs.reduce((s, r) => s + r.verified, 0) / items : null,
      fromLeads: avg(rs, (r) => r.fromLeads), searches: avg(rs, (r) => r.searches), cost: avg(rs, (r) => r.costUsd),
    };
  });
}
