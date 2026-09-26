// Runs the AI fund (in GitHub Actions, every price update).
// Usage: node scripts/ai-fund.mjs <ai-fund.json path> [picks.json path]
// Environment:
//   FUND_START_AMOUNT       start a new fund with this budget (replaces the current one)
//   FUND_CURRENCY           USD (US stocks) or SGD (SGX stocks), with FUND_START_AMOUNT
//   FUND_DECISIONS_PER_DAY  1, 2 or 4, with FUND_START_AMOUNT
//   FUND_STOP=true          close every position and stop the fund
//   ANTHROPIC_API_KEY, AI_MODEL
// Every run checks stop-loss / take-profit / forced-cover levels against the new prices. When a
// decision is due (spread through the market's trading day), Claude reads the news and decides.

import { readFile, writeFile } from 'node:fs/promises';
import { decideFund, DEFAULT_MODEL } from '../ai.js';
import { newFund, decisionDue, applyOrders, setProtections, checkProtections, recordValue, stopFund } from '../fund.js';

const [file, picksFile] = process.argv.slice(2);
const env = process.env;
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const now = new Date();

let fund = await readJson(file);
const quotes = (await readJson('data/prices.json'))?.quotes ?? {};

if (Number(env.FUND_START_AMOUNT) > 0) {
  const old = fund;
  fund = newFund({ budget: env.FUND_START_AMOUNT, currency: env.FUND_CURRENCY || 'USD', decisionsPerDay: env.FUND_DECISIONS_PER_DAY || 2, now });
  if (old) fund.previousFunds = [...(old.previousFunds ?? []), { startedAt: old.startedAt, endedAt: now.toISOString(), currency: old.currency, budget: old.budget, finalValue: old.history.at(-1)?.[1] ?? old.budget }];
  console.log(`Started a new AI fund: ${fund.budget} ${fund.currency}, ${fund.decisionsPerDay} decisions a day.`);
}
if (!fund) {
  console.log('No AI fund. Start one from the Actions tab (Run workflow, with an amount).');
  process.exit(0);
}

if (env.FUND_STOP === 'true' && !fund.stoppedAt) {
  stopFund(fund, quotes, now);
  console.log('AI fund stopped; positions closed.');
}

if (!fund.stoppedAt) {
  for (const e of checkProtections(fund, quotes)) console.log(`Protection: ${e.action} ${e.shares} ${e.symbol} at ${e.price} (${e.why})`);

  if (decisionDue(fund, now)) {
    if (!env.ANTHROPIC_API_KEY) {
      console.log('A decision is due but ANTHROPIC_API_KEY is not set.');
    } else {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const d = await decideFund({ client: new Anthropic(), Anthropic, model: env.AI_MODEL || DEFAULT_MODEL, fund, quotes, picks: await readJson(picksFile), now });
        const orders = applyOrders(fund, d.orders ?? [], quotes, now);
        setProtections(fund, d.protections);
        fund.decisions.push({ time: now.toISOString(), outlook: d.outlook, orders, protections: d.protections, source_urls: d.source_urls, model: d.model, usage: d.usage });
        fund.decisions = fund.decisions.slice(-500);
        fund.lastDecisionAt = now.toISOString();
        fund.lastError = null;
        for (const o of orders) console.log(`Order: ${o.action} ${o.shares} ${o.symbol} -> ${o.status}${o.message ? ` (${o.message})` : ''}`);
      } catch (err) {
        fund.lastError = { time: now.toISOString(), message: err.message };
        console.warn(`! AI fund decision failed (will retry next run): ${err.message}`);
      }
    }
  }
}

console.log(`AI fund value: ${recordValue(fund, quotes, now)} ${fund.currency} (budget ${fund.budget}).`);
await writeFile(file, JSON.stringify(fund));
