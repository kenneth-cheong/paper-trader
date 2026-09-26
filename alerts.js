// Telegram alerts for the AI fund (sent by scripts/notify.mjs after every scheduled run). Pure
// functions: collectAlerts() finds what happened since the last alert and remembers it in
// fund.notified, so nothing is sent twice; the first run only takes note of what's already there.
//
// Alerts: trades waiting for approval (with their deadline), fills (Tiger's or the simulator's),
// stop-losses / take-profits, Tiger refusing an order, a fund pausing or stopping, a failed AI
// decision, the AI's monthly cost cap, Tiger not connected, the funds and Tiger disagreeing, splits
// and dividends, and a short summary after each trading day's close.

import { summarize } from './portfolio.js';
import { MARKETS, marketForCurrency, isOpen } from './markets.js';
import { reconcileAll } from './funds.js';
import { benchmarkFor } from './benchmark.js';
import { planFor } from './fees.js';
import { fundAiCost } from './spend.js';

const MAX_KEYS = 1500;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => `${n >= 0 ? '+' : '−'}${num(Math.abs(n), d)}`;
const pctText = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
const sgTime = (iso) => new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
const localDate = (market, d) => new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS[market].tz }).format(d);

// Every alert key for the fund as it is now: { key: text }.
function candidates(fund, { prices = null, now = new Date() } = {}) {
  const out = {};
  const ccy = fund.currency;
  for (const p of fund.proposals ?? []) {
    if (p.status === 'awaiting') out[`p:${p.id}`] = `🟡 <b>Waiting for your approval</b> until ${sgTime(p.expiresAt)} SGT: ${esc(p.action.toUpperCase())} ${p.shares} ${esc(p.symbol)} (limit ${num(p.limitPrice)}). ${esc(p.reason)}`;
  }
  for (const o of fund.brokerOrders ?? []) {
    if (['rejected', 'failed'].includes(o.status)) out[`o:${o.id}:${o.status}`] = `⚠️ <b>Tiger didn't take</b> ${esc(o.action)} ${o.qty} ${esc(o.symbol)}: ${esc(o.error ?? o.status)}`;
    if (o.source === 'guard' && o.status === 'sent') out[`o:${o.id}:sent`] = `🛡️ Stop-loss placed at Tiger: ${o.side === 'sell' ? 'sell' : 'buy back'} ${o.qty} ${esc(o.symbol)} if it ${o.side === 'sell' ? 'falls' : 'rises'} to ${num(o.stopPrice)}.`;
  }
  for (const e of fund.events ?? []) {
    const key = `e:${e.time}:${e.symbol}:${e.action}:${e.shares}`;
    out[key] = ['split', 'dividend'].includes(e.action)
      ? `💵 ${esc(e.why)}`
      : `${/stop-loss|forced/.test(e.why) ? '🔻' : /take-profit/.test(e.why) ? '🎯' : '✅'} ${esc(e.action.toUpperCase())} ${e.shares} ${esc(e.symbol)} at ${num(e.price)} ${ccy} (${esc(e.why)})`;
  }
  for (const d of fund.decisions ?? []) {
    const filled = (d.orders ?? []).filter((o) => o.status === 'filled');
    if (filled.length) out[`d:${d.time}`] = `🤖 <b>AI traded</b>: ${filled.map((o) => `${esc(o.action.toUpperCase())} ${o.shares} ${esc(o.symbol)} at ${num(o.price)}`).join(', ')}. ${esc(d.outlook)}`;
  }
  if (fund.paused) out[`pause:${fund.paused.at}`] = `⛔ <b>Trading paused</b>: ${esc(fund.paused.reason)} Stop-losses still work.`;
  if (fund.stoppedAt) out[`stop:${fund.stoppedAt}`] = '⏹️ <b>The AI fund was stopped</b> and its positions are being closed.';
  if (fund.lastError) out[`err:${fund.lastError.time}`] = `⚠️ An AI decision failed (it retries next run): ${esc(fund.lastError.message)}`;
  if (fund.aiCapped) out[`cap:${fund.aiCapped.time}`] = `💸 ${esc(fund.aiCapped.message)}`;
  if (fund.lastCommand && !fund.lastCommand.ok) out[`cmd:${fund.lastCommand.time}`] = `⚠️ Your "${esc(fund.lastCommand.action)}" request didn't work: ${esc(fund.lastCommand.message)}`;
  if (fund.settings?.broker === 'tiger' && fund.broker?.error) out[`berr:${fund.broker.error}`] = `⚠️ <b>Tiger</b>: ${esc(fund.broker.error)}`;
  const summary = dailySummary(fund, prices, now);
  if (summary) out[summary.key] = summary.text;
  return out;
}

// After the fund's market has closed on a day it traded: the day's result, the index and the AI cost.
export function dailySummary(fund, prices, now = new Date()) {
  const market = marketForCurrency(fund.currency);
  const quotes = prices?.quotes ?? {};
  if (!prices || fund.stoppedAt || isOpen(market, now)) return null;
  const times = Object.values(quotes).filter((q) => q.market === market && !q.stale && q.time).map((q) => Date.parse(q.time));
  if (!times.length) return null;
  const latest = Math.max(...times);
  const today = localDate(market, now);
  if (localDate(market, new Date(latest)) !== today || now - latest > 16 * 3600000) return null; // no session today
  const a = summarize(fund.portfolio, quotes).accounts[fund.currency];
  const dayStart = fund.day?.date ? fund.day.startValue : null;
  const bench = benchmarkFor({ currency: fund.currency, amount: fund.budget, since: fund.startedAt, quotes, plan: planFor(fund.settings?.feePlan ?? 'tiger') });
  const lines = [
    `📊 <b>${MARKETS[market].label} close, ${today}</b>${fund.name ? ` · ${esc(fund.name)}` : ''}`,
    `Value ${num(a.equity)} ${fund.currency}${dayStart ? ` (today ${signed(a.equity - dayStart)})` : ''}; since start ${signed(a.net)} (${pctText(a.netPct)}).`,
    bench ? `Same money in ${bench.symbol}: ${pctText(bench.pct)}. The fund is ${a.net >= bench.net ? 'ahead' : 'behind'} by ${num(Math.abs(a.net - bench.net))} ${fund.currency}.` : '',
    `Holding ${Object.keys(fund.portfolio.positions).length} stock(s). AI cost so far about US$${fundAiCost(fund).toFixed(2)}.`,
  ];
  return { key: `sum:${today}`, text: lines.filter(Boolean).join('\n') };
}

// Returns the texts to send now (oldest first) and updates fund.notified. On the very first call
// nothing is sent: everything already there is only remembered.
export function collectAlerts(fund, options = {}) {
  const all = candidates(fund, options);
  const first = !fund.notified;
  const seen = new Set(fund.notified?.keys ?? []);
  const fresh = Object.entries(all).filter(([k]) => !seen.has(k));
  fund.notified = { keys: [...seen, ...fresh.map(([k]) => k)].slice(-MAX_KEYS) };
  return first ? [] : fresh.map(([, text]) => text);
}

// Every fund's alerts (each labelled with its name when there are several) and a check of Tiger
// against all the Tiger funds together. `c` is a collection (funds.js).
export function collectAllAlerts(c, options = {}) {
  const many = c.funds.length > 1;
  const texts = [];
  for (const f of c.funds) {
    for (const t of collectAlerts(f, options)) texts.push(many ? `<b>${esc(f.name)}</b> · ${t}` : t);
  }
  const check = reconcileAll(c);
  const key = check && !check.ok ? `mismatch:${JSON.stringify(check.mismatches)}` : null;
  if (key && c.notifiedMismatch !== key) {
    texts.push(`⚠️ <b>Your Tiger account doesn't hold what the funds think</b>: ${check.mismatches.map((m) => `${esc(m.symbol)} funds ${m.fund}, Tiger ${m.tiger}`).join('; ')}. Check the Tiger app.`);
  }
  c.notifiedMismatch = key;
  return texts;
}

// One Telegram message (under its 4096-character limit) for a list of alerts.
export function formatMessage(texts, appUrl) {
  let body = texts.join('\n\n');
  if (body.length > 3800) body = `${body.slice(0, 3800)}…`;
  return `${body}${appUrl ? `\n\n<a href="${esc(appUrl)}#fund">Open the AI fund</a>` : ''}`;
}
