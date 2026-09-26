// Runs the AI fund (in GitHub Actions, every price update).
// Usage: node scripts/ai-fund.mjs <ai-fund.json path> [picks.json path]
// Environment:
//   FUND_START_AMOUNT       start a new fund with this budget (replaces the current one)
//   FUND_CURRENCY           USD (US stocks) or SGD (SGX stocks), with FUND_START_AMOUNT
//   FUND_DECISIONS_PER_DAY  1, 2 or 4, with FUND_START_AMOUNT
//   FUND_STOP=true          close every position and stop the fund
//   FUND_COMMAND            JSON from the app: { settings }, { approve: [ids] }, { reject: [ids] },
//                           { pause: true } or { resume: true }. With FUND_START_AMOUNT, its settings
//                           (broker, approval, limits) apply to the new fund.
//   ANTHROPIC_API_KEY, AI_MODEL (decisions, default Sonnet), AI_NEWS_MODEL (news, default Haiku)
// Every run records Tiger fills (scripts/tiger_broker.py sync runs just before), checks stop-loss /
// take-profit / forced-cover levels and the daily loss limit, and, when a decision is due, lets
// Claude decide. Decisions only happen while the fund's market is actually trading. With Tiger,
// orders are queued here and sent by scripts/tiger_broker.py send, which runs just after.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decideFund, TIERS } from '../ai.js';
import {
  newFund, decisionDue, executeDecision, setProtections, checkProtections, recordValue, stopFund, applySettings,
  approveProposals, rejectProposals, expireProposals, applyBrokerFills, pauseFund, resumeFund, checkDailyLoss,
} from '../fund.js';

const [file, picksFile] = process.argv.slice(2);
const newsFile = join(dirname(file), 'news.json');
const NEWS_MAX_AGE_MS = 4 * 3600 * 1000; // reuse the picks job's digest when it's this fresh
const env = process.env;
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const now = new Date();

let fund = await readJson(file);
const prices = await readJson('data/prices.json');
const quotes = prices?.quotes ?? {};
let command = {};
try { command = env.FUND_COMMAND ? JSON.parse(env.FUND_COMMAND) : {}; } catch { console.warn(`! Ignoring FUND_COMMAND that isn't JSON: ${env.FUND_COMMAND}`); }

const note = (action, message, ok = true) => {
  if (fund) fund.lastCommand = { time: now.toISOString(), action, message, ok };
  console.log(`${ok ? '' : '! '}${action}: ${message}`);
};

if (Number(env.FUND_START_AMOUNT) > 0) {
  const old = fund;
  try {
    fund = newFund({
      budget: env.FUND_START_AMOUNT, currency: env.FUND_CURRENCY || 'USD', decisionsPerDay: env.FUND_DECISIONS_PER_DAY || 2,
      settings: command.settings ?? {}, now,
    });
    if (old) fund.previousFunds = [...(old.previousFunds ?? []), { startedAt: old.startedAt, endedAt: now.toISOString(), currency: old.currency, budget: old.budget, finalValue: old.history.at(-1)?.[1] ?? old.budget }];
    note('start', `Started a new AI fund: ${fund.budget} ${fund.currency}, ${fund.decisionsPerDay} decisions a day, trading ${fund.settings.broker === 'tiger' ? `through Tiger (${fund.settings.approval === 'manual' ? 'you approve each trade' : 'automatic'})` : 'in the simulator'}.`);
  } catch (err) {
    fund = old;
    note('start', `Couldn't start the fund: ${err.message}`, false);
  }
  command = {};
}
if (!fund) {
  console.log('No AI fund. Start one from the app or the Actions tab.');
  process.exit(0);
}

// Tiger fills that scripts/tiger_broker.py sync just brought back
for (const e of applyBrokerFills(fund, now)) console.log(`Tiger fill: ${e.action} ${e.shares} ${e.symbol} at ${e.price}`);
expireProposals(fund, now);

// Commands from the app
try {
  if (command.settings) { applySettings(fund, command.settings); note('settings', 'Settings saved.'); }
  if (command.pause) { pauseFund(fund, 'Paused by its owner.', now); note('pause', 'The fund is paused; open orders are being cancelled.'); }
  if (command.resume) { resumeFund(fund); note('resume', 'The fund is running again.'); }
  if (command.reject?.length) { rejectProposals(fund, command.reject, now); note('reject', `Rejected ${command.reject.length} proposal(s).`); }
  if (command.approve?.length) {
    const out = approveProposals(fund, command.approve, quotes, prices, now);
    const sent = out.filter((p) => p.status === 'approved').length;
    note('approve', `${sent} of ${command.approve.length} approved trade(s) sent to Tiger.${out.filter((p) => p.status !== 'approved').map((p) => ` ${p.symbol}: ${p.message}`).join('')}`, sent === command.approve.length);
  }
} catch (err) {
  note(Object.keys(command)[0] ?? 'command', err.message, false);
}

if (env.FUND_STOP === 'true' && !fund.stoppedAt) {
  stopFund(fund, quotes, now);
  note('stop', 'The fund is stopped; its positions are being closed.');
}

if (!fund.stoppedAt) {
  for (const e of checkProtections(fund, quotes, now)) console.log(`Protection: ${e.action} ${e.shares} ${e.symbol} at ${e.price} (${e.why})`);
  if (Object.keys(quotes).length && checkDailyLoss(fund, quotes, now)) console.log(`! Daily loss limit hit: ${fund.paused.reason}`);

  if (decisionDue(fund, now, prices)) {
    if (!Object.keys(quotes).length) {
      console.log('A decision is due but there are no prices this run; waiting for the next one.');
    } else if (!env.ANTHROPIC_API_KEY) {
      console.log('A decision is due but ANTHROPIC_API_KEY is not set.');
    } else {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const cached = await readJson(newsFile);
        const news = cached && now - Date.parse(cached.createdAt) < NEWS_MAX_AGE_MS ? cached : undefined;
        const d = await decideFund({
          client: new Anthropic(), Anthropic, fund, quotes, picks: await readJson(picksFile), news, now,
          model: env.AI_MODEL || TIERS.advanced, newsModel: env.AI_NEWS_MODEL || TIERS.simple,
        });
        if (d.news) await writeFile(newsFile, JSON.stringify(d.news, null, 1));
        const orders = executeDecision(fund, d.orders ?? [], quotes, now);
        setProtections(fund, d.protections);
        fund.decisions.push({ time: now.toISOString(), outlook: d.outlook, orders, protections: d.protections, source_urls: d.source_urls, model: d.model, newsModel: d.newsModel, usage: d.usage });
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

fund.proposals = (fund.proposals ?? []).slice(-200);
fund.brokerOrders = (fund.brokerOrders ?? []).slice(-500);
console.log(`AI fund value: ${recordValue(fund, quotes, now)} ${fund.currency} (budget ${fund.budget}).`);
await writeFile(file, JSON.stringify(fund));
