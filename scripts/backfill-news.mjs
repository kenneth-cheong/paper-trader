// One-off: finds the past year's main news events for every watchlist stock (Claude Haiku with web
// search, about US$0.05 a stock) for the AI funds' market memory (memory.js). Stocks already done are
// skipped, so running it again only fills gaps. Price moves after each event are measured in code.
// Usage: node scripts/backfill-news.mjs <news-events.json>
// Environment: ANTHROPIC_API_KEY, AI_NEWS_MODEL (default Haiku), AI_MONTHLY_CAP_USD.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backfillNews, TIERS } from '../ai.js';
import { mergeEvents, BACKFILL_NONE } from '../memory.js';
import { addSpend, capReached, monthSpend } from '../spend.js';
import { BENCHMARKS } from '../benchmark.js';

const file = process.argv[2];
const spendFile = join(dirname(file), 'ai-spend.json');
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const env = process.env;

const prices = await readJson('data/prices.json');
const quotes = prices?.quotes ?? {};
if (!env.ANTHROPIC_API_KEY) { console.log('ANTHROPIC_API_KEY is not set; skipping the backfill.'); process.exit(0); }
if (!Object.keys(quotes).length) { console.log('No prices this run; skipping the backfill.'); process.exit(0); }

const indexes = new Set([...Object.values(BENCHMARKS).map((b) => b.symbol), 'QQQ']); // funds, not companies
let events = (await readJson(file)) ?? [];
const done = new Set(events.filter((e) => e.from === 'backfill').map((e) => e.symbol));
const to = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10); // needs a week of prices after
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic();
let found = 0, cost = 0;

for (const [symbol, q] of Object.entries(quotes)) {
  if (indexes.has(symbol) || done.has(symbol) || !q.daily?.length) continue;
  const spend = await readJson(spendFile);
  if (capReached(spend, env.AI_MONTHLY_CAP_USD)) { console.log(`Stopped: this month's AI spend (about US$${monthSpend(spend).toFixed(2)}) reached the cap.`); break; }
  const from = new Date(q.daily[0][0] * 1000).toISOString().slice(0, 10);
  try {
    const r = await backfillNews({ client, Anthropic, model: env.AI_NEWS_MODEL || TIERS.simple, symbol, name: q.name ?? symbol, from, to });
    events = mergeEvents(events, r.events, quotes);
    // Mark the stock done even when nothing new was kept (nothing found, or only news the digests
    // already had on those days), so it isn't searched again.
    if (!events.some((e) => e.symbol === symbol && e.from === 'backfill')) events.push({ symbol, date: from, headline: BACKFILL_NONE, type: 'other', tone: 'mixed', source_url: null, from: 'backfill' });
    found += r.events.length;
    cost += r.usage.costUsd;
    await writeFile(spendFile, JSON.stringify(addSpend(spend, 'backfill', r.usage.costUsd)));
    await writeFile(file, JSON.stringify(events));
    console.log(`${symbol}: ${r.events.length} events`);
  } catch (err) {
    console.warn(`! ${symbol}: ${err.message}`);
  }
}
console.log(`Backfill: ${found} news events added, about US$${cost.toFixed(2)}.`);
