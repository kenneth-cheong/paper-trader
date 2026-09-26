// Runs the AI funds (in GitHub Actions, every price update). See funds.js for how several funds are
// kept together, and fund.js for one fund.
// Usage: node scripts/ai-fund.mjs <ai-fund.json path> [picks.json path]
// Environment:
//   FUND_START_AMOUNT       start a new fund with this budget, alongside any running ones
//   FUND_CURRENCY           USD (US stocks) or SGD (SGX stocks), with FUND_START_AMOUNT
//   FUND_DECISIONS_PER_DAY  1, 2 or 4, with FUND_START_AMOUNT
//   FUND_STOP=true          close every position of a fund and stop it (FUND_COMMAND's fund, or the only one running)
//   FUND_COMMAND            JSON from the app. `fund` names the fund (an id; "all" for pause/resume). With
//                           FUND_START_AMOUNT: { name, style, focus, settings } for the new fund. Otherwise one of
//                           { settings, name, style, focus }, { approve: [ids] }, { reject: [ids] }, { pause: true },
//                           { resume: true } or { remove: true } (a stopped fund).
//   ANTHROPIC_API_KEY, AI_MODEL (decisions, default Sonnet; a fund can choose its own), AI_NEWS_MODEL (news, default Haiku)
//   AI_MONTHLY_CAP_USD      skip AI decisions once the month's scheduled AI spend reaches this (ai-spend.json)
//   FUND_PRIVATE=true       print nothing about the funds' trades (the Actions log is public)
// Every run, for every fund: records Tiger fills (scripts/tiger_broker.py sync runs just before), applies
// splits and dividends, checks stop-loss / take-profit / forced-cover levels and the daily loss limit,
// and, when a decision is due, lets Claude decide. Decisions only happen while the fund's market is
// actually trading. With Tiger, orders are queued here and sent by scripts/tiger_broker.py send.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decideFund, TIERS } from '../ai.js';
import {
  decisionDue, executeDecision, setProtections, checkProtections, recordValue, stopFund,
  approveProposals, rejectProposals, expireProposals, applyBrokerFills, pauseFund, resumeFund, checkDailyLoss, syncGuards,
} from '../fund.js';
import { loadFunds, addFund, updateFund, removeFund, targetFund, otherTigerHoldings, activeFunds } from '../funds.js';
import { applyCorporateActions, describeAction } from '../actions.js';
import { addSpend, capReached, monthSpend } from '../spend.js';

const [file, picksFile] = process.argv.slice(2);
if (process.env.FUND_PRIVATE === 'true') console.log = () => {};
const newsFile = join(dirname(file), 'news.json');
const spendFile = join(dirname(file), 'ai-spend.json');
const NEWS_MAX_AGE_MS = 4 * 3600 * 1000; // reuse the picks job's digest when it's this fresh
const env = process.env;
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const now = new Date();

const c = loadFunds(await readJson(file));
const prices = await readJson('data/prices.json');
const quotes = prices?.quotes ?? {};
let command = {};
try { command = env.FUND_COMMAND ? JSON.parse(env.FUND_COMMAND) : {}; } catch { console.warn(`! Ignoring FUND_COMMAND that isn't JSON: ${env.FUND_COMMAND}`); }

// The result of the app's request, which the app watches for.
const note = (action, message, ok = true, fund = null) => {
  c.lastCommand = { time: now.toISOString(), action, message, ok, fund: fund?.id ?? command.fund ?? null };
  console.log(`${ok ? '' : '! '}${action}: ${message}`);
};
const where = (f) => (f.settings.broker === 'tiger' ? `through Tiger (${f.settings.approval === 'manual' ? 'you approve each trade' : 'automatic'})` : 'in the simulator');

// ---------- commands ----------

if (Number(env.FUND_START_AMOUNT) > 0) {
  try {
    const f = addFund(c, {
      name: command.name, style: command.style, focus: command.focus, settings: command.settings ?? {},
      budget: env.FUND_START_AMOUNT, currency: env.FUND_CURRENCY || 'USD', decisionsPerDay: env.FUND_DECISIONS_PER_DAY || 1, now,
    });
    note('start', `Started "${f.name}": ${f.budget} ${f.currency}, ${f.decisionsPerDay} decision(s) a day, trading ${where(f)}.`, true, f);
  } catch (err) {
    note('start', `Couldn't start the fund: ${err.message}`, false);
  }
  command = {};
}

try {
  if (env.FUND_STOP === 'true') {
    const f = targetFund(c, command.fund);
    if (!f.stoppedAt) {
      stopFund(f, quotes, now);
      note('stop', `"${f.name}" is stopped; its positions are being closed.`, true, f);
    }
  }
  // Approvals and rejections name proposals, which belong to exactly one fund.
  for (const verb of ['approve', 'reject']) {
    const ids = command[verb];
    if (!ids?.length) continue;
    for (const f of c.funds) {
      const mine = ids.filter((id) => (f.proposals ?? []).some((p) => p.id === id));
      if (!mine.length) continue;
      if (verb === 'reject') { rejectProposals(f, mine, now); note('reject', `Rejected ${mine.length} proposal(s).`, true, f); continue; }
      const out = approveProposals(f, mine, quotes, prices, now, { others: otherTigerHoldings(c, f.id) });
      const sent = out.filter((p) => p.status === 'approved').length;
      note('approve', `${sent} of ${mine.length} approved trade(s) sent to Tiger.${out.filter((p) => p.status !== 'approved').map((p) => ` ${p.symbol}: ${p.message}`).join('')}`, sent === mine.length, f);
    }
  }
  if (command.pause || command.resume) {
    const list = command.fund === 'all' || (!command.fund && activeFunds(c).length > 1) ? activeFunds(c) : [targetFund(c, command.fund)];
    for (const f of list) command.pause ? pauseFund(f, 'Paused by its owner.', now) : resumeFund(f);
    const who = list.length === 1 ? `"${list[0].name}" is` : `All ${list.length} funds are`;
    note(command.pause ? 'pause' : 'resume', command.pause ? `${who} paused; open orders are being cancelled.` : `${who} trading again.`, true, list.length === 1 ? list[0] : null);
  }
  if (command.settings || command.name !== undefined || command.style !== undefined || command.focus !== undefined) {
    const f = targetFund(c, command.fund);
    updateFund(f, { name: command.name, style: command.style, focus: command.focus, settings: command.settings });
    note('settings', `Saved "${f.name}".`, true, f);
  }
  if (command.remove) {
    const f = targetFund(c, command.fund);
    removeFund(c, f.id, now);
    note('remove', `Removed "${f.name}".`, true, f);
  }
} catch (err) {
  note(Object.keys(command).find((k) => k !== 'fund') ?? (env.FUND_STOP === 'true' ? 'stop' : 'command'), err.message, false);
}

// ---------- every fund ----------

const spent = async () => readJson(spendFile);
const newsFor = {}; // a digest gathered this run for one market, reused by that market's other funds

for (const fund of c.funds) {
  const log = (text) => console.log(`[${fund.name}] ${text}`);

  // Splits and dividends on what the fund holds (with Tiger, Tiger adjusts the real account itself)
  const actions = applyCorporateActions(fund.portfolio, quotes, now);
  fund.portfolio = actions.portfolio;
  for (const a of actions.applied) {
    fund.events.push({ time: a.time, symbol: a.symbol, action: a.kind, shares: a.qty, price: a.perShare ?? null, why: describeAction(a) });
    log(`Corporate action: ${describeAction(a)}`);
  }

  // Tiger fills that scripts/tiger_broker.py sync just brought back
  for (const e of applyBrokerFills(fund, now)) log(`Tiger fill: ${e.action} ${e.shares} ${e.symbol} at ${e.price}`);
  expireProposals(fund, now);

  if (!fund.stoppedAt) {
    for (const e of checkProtections(fund, quotes, now)) log(`Protection: ${e.action} ${e.shares} ${e.symbol} at ${e.price} (${e.why})`);
    if (Object.keys(quotes).length && checkDailyLoss(fund, quotes, now)) log(`! Daily loss limit hit: ${fund.paused.reason}`);

    if (decisionDue(fund, now, prices)) {
      if (!Object.keys(quotes).length) {
        log('A decision is due but there are no prices this run; waiting for the next one.');
      } else if (!env.ANTHROPIC_API_KEY) {
        log('A decision is due but ANTHROPIC_API_KEY is not set.');
      } else if (capReached(await spent(), env.AI_MONTHLY_CAP_USD, now)) {
        const message = `This month's AI spend (about US$${monthSpend(await spent(), now)}) reached the US$${env.AI_MONTHLY_CAP_USD} cap, so the AI isn't deciding until next month. Stop-losses still work. Raise the cap with the AI_MONTHLY_CAP_USD repository variable.`;
        if (fund.aiCapped?.message !== message) fund.aiCapped = { time: now.toISOString(), message };
        log(message);
      } else {
        fund.aiCapped = null;
        try {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const cached = await readJson(newsFile);
          const news = newsFor[fund.currency] ?? (cached && now - Date.parse(cached.createdAt) < NEWS_MAX_AGE_MS ? cached : undefined);
          const d = await decideFund({
            client: new Anthropic(), Anthropic, fund, quotes, picks: await readJson(picksFile), news, now,
            model: fund.settings.model || env.AI_MODEL || TIERS.advanced, newsModel: env.AI_NEWS_MODEL || TIERS.simple,
          });
          if (d.news) newsFor[fund.currency] = d.news;
          await writeFile(spendFile, JSON.stringify(addSpend(await spent(), 'fund', d.usage?.costUsd, now)));
          const orders = executeDecision(fund, d.orders ?? [], quotes, now, { others: otherTigerHoldings(c, fund.id) });
          setProtections(fund, d.protections);
          fund.decisions.push({ time: now.toISOString(), outlook: d.outlook, orders, protections: d.protections, source_urls: d.source_urls, model: d.model, newsModel: d.newsModel, usage: d.usage });
          fund.decisions = fund.decisions.slice(-500);
          fund.lastDecisionAt = now.toISOString();
          fund.lastError = null;
          for (const o of orders) log(`Order: ${o.action} ${o.shares} ${o.symbol} -> ${o.status}${o.message ? ` (${o.message})` : ''}`);
        } catch (err) {
          fund.lastError = { time: now.toISOString(), message: err.message };
          console.warn(`! [${fund.name}] AI decision failed (will retry next run): ${err.message}`);
        }
      }
    }
  }

  // Stop orders held by Tiger, matched to what the fund now holds (Tiger funds only)
  for (const x of syncGuards(fund, quotes, now)) {
    log(x.change === 'place' ? `Tiger stop order: ${x.symbol} ${x.qty} shares at ${x.stopPrice}` : `Tiger stop order for ${x.symbol}: cancelling the old one`);
  }

  fund.proposals = (fund.proposals ?? []).slice(-200);
  // Keep the last 500 Tiger orders, and always every open one (a stop order can stand for months).
  const orders = fund.brokerOrders ?? [];
  fund.brokerOrders = orders.filter((o, i) => i >= orders.length - 500 || ['queued', 'sent', 'partial'].includes(o.status));
  log(`Value: ${recordValue(fund, quotes, now)} ${fund.currency} (budget ${fund.budget}).`);
}

if (!c.funds.length) console.log('No AI fund. Start one from the app or the Actions tab.');
await writeFile(file, JSON.stringify(c));
