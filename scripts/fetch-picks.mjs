// Refreshes the home page's AI long/short picks (runs in GitHub Actions).
// Usage: node scripts/fetch-picks.mjs <picks.json path>
// Keeps the existing picks when they are younger than PICKS_MAX_AGE_HOURS (default 10, so about
// two refreshes per weekday), when ANTHROPIC_API_KEY isn't set, or when the call fails.
// FORCE_PICKS=true refreshes regardless of age. News is gathered with AI_NEWS_MODEL (default Haiku) and
// the picks are made with AI_MODEL (default Sonnet); the digest is also saved as news.json for the AI fund.
// Costs are added to ai-spend.json next to the picks; AI_MONTHLY_CAP_USD (US$) skips the AI once reached.
// The digest gets the news feeds' freshest tagged headlines as leads (state/articles, articles.js)
// unless the repository variable NEWS_LEADS is 'off'; each digest's quality (items, verified links,
// leads cited, searches and cost; counts only) goes in news-quality.json, which
// scripts/memory-report.mjs prints week by week, so weeks with and without the leads can be compared.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { recommend, TIERS } from '../ai.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import { recordPicks } from '../scorecard.js';
import { mergeEvents, eventsFromDigest, marketEvents } from '../memory.js';
import { resultsCalendar } from '../calendar.js';
import { recentMonths, digestQuality, addQuality } from '../articles.js';

const file = process.argv[2];
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

const previous = await readJson(file);
const spendFile = join(dirname(file), 'ai-spend.json');
const spend = await readJson(spendFile);
const cap = process.env.AI_MONTHLY_CAP_USD;
const maxAgeH = Number(process.env.PICKS_MAX_AGE_HOURS || 10);
const ageH = previous ? (Date.now() - Date.parse(previous.createdAt)) / 3600000 : Infinity;

// An empty set of picks (e.g. from a run with no prices) is refreshed straight away.
if (process.env.FORCE_PICKS !== 'true' && ageH < maxAgeH && previous?.picks?.length) {
  console.log(`Picks are ${ageH.toFixed(1)} h old; keeping them.`);
} else if (capReached(spend, cap)) {
  console.log(`This month's AI spend (about US$${monthSpend(spend).toFixed(2)}) has reached the US$${cap} cap; skipping AI picks.`);
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; skipping AI picks.');
} else if (!Object.keys((await readJson('data/prices.json'))?.quotes ?? {}).length) {
  console.log('No prices this run; skipping AI picks.');
} else {
  const prices = await readJson('data/prices.json');
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Analysts' views and the results due soon, when the job fetched them (see calendar.js, analysts.js)
    const company = await readJson(join(dirname(file), 'company-data.json'));
    const filings = await readJson(join(dirname(file), 'results-dates.json'));
    const events = marketEvents((await readJson(join(dirname(file), 'news-events.json'))) ?? [], prices.quotes, { filings, company });
    const leadsOn = process.env.NEWS_LEADS !== 'off';
    const articles = leadsOn ? (await Promise.all(recentMonths(new Date(), 2).map((m) => readJson(join(dirname(file), 'articles', `${m}.json`))))).flat().filter(Boolean) : null;
    const { news, ...picks } = await recommend({
      client: new Anthropic(), Anthropic, prices, company, calendar: resultsCalendar({ company, filings, quotes: prices.quotes, events }), articles,
      model: process.env.AI_MODEL || TIERS.advanced, newsModel: process.env.AI_NEWS_MODEL || TIERS.simple,
    });
    await writeFile(file, JSON.stringify(picks, null, 1));
    await writeFile(spendFile, JSON.stringify(addSpend(spend, 'picks', picks.usage?.costUsd)));
    // Every set of picks is kept, with the prices when picked, for the home page's track record.
    const historyFile = join(dirname(file), 'picks-history.json');
    await writeFile(historyFile, JSON.stringify(recordPicks(await readJson(historyFile), picks)));
    // Company news from the digest, for the AI funds' market memory (price moves after it are measured later).
    const eventsFile = join(dirname(file), 'news-events.json');
    await writeFile(eventsFile, JSON.stringify(mergeEvents(await readJson(eventsFile), eventsFromDigest(news), prices.quotes)));
    // The AI fund reuses this digest instead of searching again.
    await writeFile(join(dirname(file), 'news.json'), JSON.stringify(news, null, 1));
    // How the digest did, with or without the leads (counts only)
    const qualityFile = join(dirname(file), 'news-quality.json');
    await writeFile(qualityFile, JSON.stringify(addQuality(await readJson(qualityFile), digestQuality(news, { by: 'picks', on: leadsOn }))));
    console.log(`Wrote ${picks.picks.length} picks (${picks.model}, news by ${picks.newsModel} from ${picks.sources.length} sources${leadsOn ? ` and ${news.leads?.length ?? 0} feed headlines as leads` : ', leads off'}, ~US$${picks.usage.costUsd}).`);
  } catch (err) {
    console.warn(`! AI picks failed, keeping the previous ones: ${err.message}`);
  }
}
