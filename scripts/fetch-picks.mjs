// Refreshes the home page's AI long/short picks (runs in GitHub Actions).
// Usage: node scripts/fetch-picks.mjs <picks.json path>
// Keeps the existing picks when they are younger than PICKS_MAX_AGE_HOURS (default 10, so about
// two refreshes per weekday), when ANTHROPIC_API_KEY isn't set, or when the call fails.
// FORCE_PICKS=true refreshes regardless of age. News is gathered with AI_NEWS_MODEL (default Haiku) and
// the picks are made with AI_MODEL (default Sonnet); the digest is also saved as news.json for the AI fund.
// Costs are added to ai-spend.json next to the picks; AI_MONTHLY_CAP_USD (US$) skips the AI once reached.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { recommend, TIERS } from '../ai.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import { recordPicks } from '../scorecard.js';
import { mergeEvents, eventsFromDigest } from '../memory.js';

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
  console.log(`This month's AI spend (about US$${monthSpend(spend)}) has reached the US$${cap} cap; skipping AI picks.`);
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; skipping AI picks.');
} else if (!Object.keys((await readJson('data/prices.json'))?.quotes ?? {}).length) {
  console.log('No prices this run; skipping AI picks.');
} else {
  const prices = await readJson('data/prices.json');
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { news, ...picks } = await recommend({
      client: new Anthropic(), Anthropic, prices,
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
    console.log(`Wrote ${picks.picks.length} picks (${picks.model}, news by ${picks.newsModel} from ${picks.sources.length} sources, ~US$${picks.usage.costUsd}).`);
  } catch (err) {
    console.warn(`! AI picks failed, keeping the previous ones: ${err.message}`);
  }
}
