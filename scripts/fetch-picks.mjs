// Refreshes the home page's AI long/short picks (runs in GitHub Actions).
// Usage: node scripts/fetch-picks.mjs <picks.json path>
// Keeps the existing picks when they are younger than PICKS_MAX_AGE_HOURS (default 10, so about
// two refreshes per weekday), when ANTHROPIC_API_KEY isn't set, or when the call fails.
// FORCE_PICKS=true refreshes regardless of age.

import { readFile, writeFile } from 'node:fs/promises';
import { recommend, DEFAULT_MODEL } from '../ai.js';

const file = process.argv[2];
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

const previous = await readJson(file);
const maxAgeH = Number(process.env.PICKS_MAX_AGE_HOURS || 10);
const ageH = previous ? (Date.now() - Date.parse(previous.createdAt)) / 3600000 : Infinity;

// An empty set of picks (e.g. from a run with no prices) is refreshed straight away.
if (process.env.FORCE_PICKS !== 'true' && ageH < maxAgeH && previous?.picks?.length) {
  console.log(`Picks are ${ageH.toFixed(1)} h old; keeping them.`);
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY is not set; skipping AI picks.');
} else if (!Object.keys((await readJson('data/prices.json'))?.quotes ?? {}).length) {
  console.log('No prices this run; skipping AI picks.');
} else {
  const prices = await readJson('data/prices.json');
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const picks = await recommend({ client: new Anthropic(), Anthropic, model: process.env.AI_MODEL || DEFAULT_MODEL, prices });
    await writeFile(file, JSON.stringify(picks, null, 1));
    console.log(`Wrote ${picks.picks.length} picks from ${picks.sources.length} sources (~US$${picks.usage.costUsd}).`);
  } catch (err) {
    console.warn(`! AI picks failed, keeping the previous ones: ${err.message}`);
  }
}
