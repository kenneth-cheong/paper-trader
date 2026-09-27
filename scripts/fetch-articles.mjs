// The news feeds (feeds.json, articles.js): leads for the news digest, and which big moves had news.
// Usage: node scripts/fetch-articles.mjs due <state dir> <raw folder>    exit code 0 if a fetch is due (writes the plan)
//        node scripts/fetch-articles.mjs build <raw folder> <state dir>  reads the downloads into the state
//        node scripts/fetch-articles.mjs moves <state dir>               judges the big moves; searches the unexplained ones
// `due`: at most every 6 hours (state/feed-health.json's triedAt, set here, so a failing fetch waits too),
// it writes the list of feeds to fetch, leaving out the dead ones (a feed that failed 3 tries in a row is
// tried once a day until it answers). scripts/feed_fetch.py then downloads them into the raw folder on
// the runner, which is never saved.
// `build`: parses each feed, keeps the items that name a watchlist stock (articles.js makeTagger, on the
// headline and the start of the description) and adds the new ones to state/articles/YYYY-MM.json (by
// publication month, at most 3,000 a month, 13 months kept): only { id, symbols, source, feed, pubDate,
// headline, url }, never an article's text. It updates each feed's health counters.
//        node scripts/fetch-articles.mjs calls <raw folder> <state dir>  the reading guide's daily read
// `moves` (memory.js): each day a stock moved 4% or more against its index, from the day the feeds first
// answered, is judged once, after the next session, on whether news came out within a trading day of it
// (an event, a filing, a rating change or a tagged headline), before any search, and kept in
// state/move-news.json for the market memory's study. Each move without news then gets one web search
// on the news model (ANTHROPIC_API_KEY, AI_NEWS_MODEL), at most 10 a month and within the monthly cap
// (AI_MONTHLY_CAP_USD), counted in the spend ledger as 'articles'; news it finds with a source joins
// state/news-events.json as an event (from: 'search'). It only judges after a fetch in which most feeds
// answered, so a day the feeds were down doesn't count as a day without news.
// `calls` (reading.js, the reading guide): once a day (20 hours after the last), right after a fetch,
// up to 40 headlines stored in the last 4 days and not read yet, investing sites first, are read with
// the start of each one's summary, taken from this run's downloads and cut to 300 characters (never
// stored), in one call on the news model (ai.js readCalls) that says each one's own call on the stocks
// it names: buy, sell, hold or none, with its target and the reasons it cites. The calls go in
// state/reading-calls.json, one per site, per stock, per week, priced when they were published, for the
// page's reading guide, which grades them like the AI picks. Within the monthly cap; counted in the
// spend ledger as 'reading'. Nothing from it reaches the AI funds or the picks.
// The log gives counts and feed names only, never a headline.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expandFeeds, feedsDue, planFeeds, feedFile, isFeed, parseFeed, makeTagger, articlesFrom, newArticles, addToMonth,
  monthOf, recentMonths, expiredMonth, updateHealth, deadFeeds, ARTICLES,
} from '../articles.js';
import { marketEvents, mergeEvents, classifyMoves, movesToSearch, searchFailed, MOVE_NEWS } from '../memory.js';
import { explainMove, readCalls, TIERS } from '../ai.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import { readingDue, toRead, readingItems, feedSummaries, recordCalls, readRank, READING } from '../reading.js';

const ROOT = new URL('..', import.meta.url);
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const [mode, ...args] = process.argv.slice(2);
const now = new Date();
const env = process.env;
const watchlist = async () => JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
const allFeeds = async () => expandFeeds(JSON.parse(await readFile(new URL('feeds.json', ROOT), 'utf8')), await watchlist());

if (mode === 'due') {
  const [state, raw] = args;
  const healthFile = join(state, 'feed-health.json');
  const health = await readJson(healthFile);
  if (!feedsDue(health, now)) {
    console.log(`Articles: the feeds were fetched within the last ${ARTICLES.everyHours} hours.`);
    process.exit(1);
  }
  const feeds = await allFeeds();
  const plan = planFeeds(feeds, health, now);
  await mkdir(raw, { recursive: true });
  await writeFile(join(raw, 'plan.json'), JSON.stringify(plan.map((f) => ({ id: f.id, url: f.url, file: feedFile(f.id) }))));
  await mkdir(state, { recursive: true });
  await writeFile(healthFile, JSON.stringify({ ...(health ?? {}), triedAt: now.toISOString() }));
  const resting = feeds.length - plan.length;
  console.log(`Articles: fetching ${plan.length} feeds${resting ? ` (${resting} dead, tried once a day)` : ''}.`);
  process.exit(0);
}

if (mode === 'build') {
  const [raw, state] = args;
  const plan = (await readJson(join(raw, 'plan.json'))) ?? [];
  const status = (await readJson(join(raw, 'status.json'))) ?? {};
  const feeds = await allFeeds();
  const tag = makeTagger(await watchlist());
  const results = {}, fresh = [], counts = [];
  for (const p of plan) {
    const s = status[p.id];
    let body = '';
    try { body = await readFile(join(raw, p.file), 'utf8'); } catch { /* not downloaded */ }
    const ok = s?.status === 200 && isFeed(body);
    const items = ok ? parseFeed(body) : [];
    const found = ok ? articlesFrom(items, p.id, tag, now) : [];
    results[p.id] = ok ? { ok: true, items: items.length }
      : { ok: false, error: s?.error || (s?.status ? `HTTP ${s.status}${s.status === 200 ? ', not a feed' : ''}` : 'not downloaded') };
    fresh.push(...found);
    counts.push({ id: p.id, ok, items: items.length, tagged: found.length });
  }
  const healthFile = join(state, 'feed-health.json');
  const health = updateHealth(await readJson(healthFile), results, now, new Set(feeds.map((f) => f.id)));
  await writeFile(healthFile, JSON.stringify(health));

  // add the new ones to their months' files, and let the oldest months go
  const dir = join(state, 'articles');
  await mkdir(dir, { recursive: true });
  const months = [...new Set([...recentMonths(now, 2), ...fresh.map((a) => monthOf(a.pubDate))])];
  const stored = {};
  for (const m of months) stored[m] = (await readJson(join(dir, `${m}.json`))) ?? [];
  const added = newArticles(Object.values(stored).flat(), fresh);
  for (const m of new Set(added.map((a) => monthOf(a.pubDate)))) {
    await writeFile(join(dir, `${m}.json`), JSON.stringify(addToMonth(stored[m], added.filter((a) => monthOf(a.pubDate) === m))));
  }
  for (const f of await readdir(dir)) {
    const m = f.replace(/\.json$/, '');
    if (/^\d{4}-\d{2}$/.test(m) && expiredMonth(m, now)) await rm(join(dir, f));
  }

  const answered = counts.filter((c) => c.ok);
  const yahoo = counts.filter((c) => c.id.includes(':'));
  const own = counts.filter((c) => !c.id.includes(':')).map((c) => `${c.id} ${c.ok ? `${c.tagged}/${c.items}` : `failed (${results[c.id].error})`}`);
  console.log(`Articles: ${answered.length} of ${plan.length} feeds answered; ${fresh.length} items name a watchlist stock, ${added.length} new.`);
  console.log(`  Feeds (items naming a stock / items): ${own.join(', ')}${yahoo.length ? `; Yahoo per stock ${yahoo.filter((c) => c.ok).length} of ${yahoo.length} answered, ${yahoo.reduce((s, c) => s + c.tagged, 0)}/${yahoo.reduce((s, c) => s + c.items, 0)}` : ''}.`);
  const dead = deadFeeds(health);
  if (dead.length) console.log(`  Dead (tried once a day until they answer): ${dead.map((d) => `${d.id} (${d.error})`).join(', ')}.`);
}

if (mode === 'moves') {
  const [state] = args;
  const quotes = (await readJson('data/prices.json'))?.quotes ?? {};
  const health = await readJson(join(state, 'feed-health.json'));
  if (!Object.keys(quotes).length) {
    console.log('Big moves: no prices this run.');
    process.exit(0);
  }
  if (!health?.since) {
    console.log('Big moves: waiting for the news feeds to answer for the first time.');
    process.exit(0);
  }
  const eventsFile = join(state, 'news-events.json');
  const newsEvents = (await readJson(eventsFile)) ?? [];
  // any news on record counts: the saved items as they are, and the memory's events (SEC filings,
  // Yahoo's rating changes, and SGX dates moved to the day that traded on them)
  const events = [...newsEvents, ...marketEvents(newsEvents, quotes, { filings: await readJson(join(state, 'results-dates.json')), company: await readJson(join(state, 'company-data.json')) })];
  const articles = (await Promise.all(recentMonths(now, 2).map((m) => readJson(join(state, 'articles', `${m}.json`))))).flat().filter(Boolean);
  const recordFile = join(state, 'move-news.json');
  let record = await readJson(recordFile);
  const key = (m) => `${m.symbol}|${m.date}`;
  const before = new Set((record?.moves ?? []).map(key));
  // judged only right after a fetch in which most feeds answered
  const fresh = health.fetchedAt && now - Date.parse(health.fetchedAt) < 7 * 3600e3 && health.tried > 0 && health.answered >= health.tried / 2;
  if (fresh) record = classifyMoves(record, { quotes, events, articles, since: health.since, now });
  else console.log('Big moves: most feeds failed in their latest fetch, so new moves are judged after the next one.');
  if (!record) process.exit(0);

  // one web search for each move without news, newest first, within the month's allowance and the cap
  const spendFile = join(state, 'ai-spend.json');
  const todo = movesToSearch(record, now);
  const found = [];
  let searched = 0, failed = 0, cost = 0;
  if (todo.length && !env.ANTHROPIC_API_KEY) console.log('Big moves: ANTHROPIC_API_KEY is not set, so moves without news aren\'t searched.');
  else if (todo.length && capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) console.log(`Big moves: this month's AI spend (about US$${monthSpend(await readJson(spendFile), now).toFixed(2)}) reached the cap; no searches.`);
  else if (todo.length) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    for (const m of todo) {
      if (capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) break;
      const q = quotes[m.symbol];
      try {
        const r = await explainMove({ client, Anthropic, model: env.AI_NEWS_MODEL || TIERS.simple, symbol: m.symbol, name: q?.name ?? m.symbol, market: q?.market, date: m.date, excess: m.excess });
        m.searched = { at: now.toISOString(), found: r.found, ...(r.event ? { headline: r.event.headline, url: r.event.source_url, date: r.event.date } : {}) };
        if (r.event) found.push(r.event);
        searched++;
        cost += r.usage?.costUsd ?? 0;
        await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'articles', r.usage?.costUsd, now)));
      } catch (err) {
        // what the API billed before the failure counts; a billed failure uses up one of the month's searches
        if (err.usage?.costUsd) {
          cost += err.usage.costUsd;
          await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'articles', err.usage.costUsd, now)));
        }
        searchFailed(m, err, now);
        failed++;
        console.warn(`! Big moves: a search failed (${err.message}); ${m.searched ? 'it counts as one of the month\'s searches and isn\'t tried again' : 'it\'s tried again next time'}.`);
      }
    }
    if (found.length) await writeFile(eventsFile, JSON.stringify(mergeEvents(newsEvents, found, quotes)));
  }
  await writeFile(recordFile, JSON.stringify(record));
  const month = now.toISOString().slice(0, 7);
  const used = record.moves.filter((m) => String(m.searched?.at ?? '').startsWith(month)).length;
  console.log(`Big moves of ${MOVE_NEWS.move * 100}%+ against the index since ${record.since}: ${record.moves.length} judged (${record.moves.filter((m) => !before.has(key(m))).length} new), ${record.moves.filter((m) => !m.news).length} without news.${searched || failed ? ` Searched ${searched} (${found.length} found news${failed ? `, ${failed} failed` : ''}, about US$${cost.toFixed(2)}).` : ''} Searches this month: ${used} of ${MOVE_NEWS.perMonth}.`);
}

if (mode === 'calls') {
  const [raw, state] = args;
  const recordFile = join(state, 'reading-calls.json');
  const spendFile = join(state, 'ai-spend.json');
  const record = await readJson(recordFile);
  const articles = (await Promise.all(recentMonths(now, 2).map((m) => readJson(join(state, 'articles', `${m}.json`))))).flat().filter(Boolean);
  const kinds = Object.fromEntries((await allFeeds()).map((f) => [f.id, f.kind]));
  const chosen = readingDue(record, now) ? toRead(articles, record, now, { kinds }) : [];
  const quotes = (await readJson('data/prices.json'))?.quotes ?? {};
  if (!readingDue(record, now)) console.log(`Reading guide: read within the last ${READING.everyHours} hours.`);
  else if (!chosen.length) console.log('Reading guide: no new headlines naming a watchlist stock to read.');
  else if (!Object.keys(quotes).length) console.log('Reading guide: no prices this run to date the calls by; it reads after the next fetch.');
  else if (!env.ANTHROPIC_API_KEY) console.log('Reading guide: ANTHROPIC_API_KEY is not set, so the headlines aren\'t read.');
  else if (capReached(await readJson(spendFile), env.AI_MONTHLY_CAP_USD, now)) console.log(`Reading guide: this month's AI spend (about US$${monthSpend(await readJson(spendFile), now).toFixed(2)}) reached the cap; nothing read.`);
  else {
    // the start of each summary, from this run's downloads only (never stored)
    const plan = (await readJson(join(raw, 'plan.json'))) ?? [];
    const bodies = await Promise.all(plan.map((p) => readFile(join(raw, p.file), 'utf8').catch(() => '')));
    const summaries = feedSummaries(bodies);
    const items = readingItems(chosen, summaries);
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const names = Object.fromEntries((await watchlist()).map((s) => [s.symbol, s.name]));
      const r = await readCalls({ client: new Anthropic(), Anthropic, model: env.AI_NEWS_MODEL || TIERS.simple, items, names });
      await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'reading', r.usage?.costUsd, now)));
      const { record: next, kept, dropped } = recordCalls(record, items, r.calls, quotes, now);
      await writeFile(recordFile, JSON.stringify(next));
      const n = (c) => r.calls.filter((x) => x.call === c).length;
      console.log(`Reading guide: read ${items.length} headlines (${chosen.filter((a) => readRank(a, kinds) === 0).length} from investing sites, ${chosen.filter((a) => summaries[a.id]?.description).length} with the start of their summary); `
        + `${r.calls.length} calls (${n('buy')} buy, ${n('sell')} sell, ${n('hold')} hold), ${kept} kept${dropped ? `, ${dropped} dropped (a site's second call on a stock that week)` : ''}; about US$${r.usage?.costUsd ?? 0}. ${next.calls.length} calls on record.`);
    } catch (err) {
      // a read the API answered but that failed (cut off, no answer) is billed: it counts, and the day's
      // read is over (the same headlines are read tomorrow); one that never reached the API is tried again
      // after the next fetch
      if (err.usage?.costUsd) {
        await writeFile(spendFile, JSON.stringify(addSpend(await readJson(spendFile), 'reading', err.usage.costUsd, now)));
        await writeFile(recordFile, JSON.stringify({ read: {}, calls: [], ...(record ?? {}), readAt: now.toISOString() }));
      }
      console.warn(`! Reading guide: the read failed (${err.message}); ${err.usage?.costUsd ? 'it\'s tried again tomorrow' : 'it\'s tried again after the next fetch'}.`);
    }
  }
}
