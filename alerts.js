// Telegram alerts for the AI fund (sent by scripts/notify.mjs after every scheduled run). Pure
// functions: collectMessages() finds what happened since the last alert and remembers it in
// fund.notified (the collection's own alerts in c.notified), so nothing is sent twice; the first run
// only takes note of what's already there.
//
// Alerts: trades waiting for approval (with their deadline and a link to the fund's page, where they're
// approved or declined), fills (Tiger's or the simulator's), stop-losses / take-profits, Tiger refusing
// an order, a fund pausing or stopping, a failed AI decision, the AI's monthly cost cap, Tiger not
// connected, the funds and Tiger disagreeing, a request from the app that didn't work, splits and
// dividends, a short summary after each trading day's close, and a heads-up the evening before a stock
// the fund holds reports its results (only for dates the company has confirmed, not Yahoo's estimates,
// which for SGX stocks are often a guess from last year), and a line when the catalyst a held position
// was opened for has passed, with how the thesis is doing. They go out together, as one message.
//
// Each fund's weekly report ("What we learned", report.js) goes as a message of its own, with a link
// to that fund's page (APP_URL#fund/<id>).

import { summarize } from './portfolio.js';
import { MARKETS, marketForCurrency, isOpen, marketDate, localClock, tradingDaysBetween } from './markets.js';
import { nextResults } from './calendar.js';
import { reconcileAll, findFund } from './funds.js';
import { benchmarkFor } from './benchmark.js';
import { planFor } from './fees.js';
import { fundAiCost } from './spend.js';
import { positionThesis, thesisProgress, moveWords, CATALYST_LABELS, HORIZON_LABELS } from './thesis.js';
import { reportLines } from './report.js';

const MAX_KEYS = 1500;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const attr = (s) => esc(s).replace(/"/g, '&quot;'); // inside an attribute's quotes
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => `${n >= 0 ? '+' : '−'}${num(Math.abs(n), d)}`;
const pctText = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
const abs2 = (x) => `${Math.abs(x * 100).toFixed(2)}%`;
const sgTime = (iso) => new Date(iso).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
const dayMonth = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' }); // "3 Sep"
const localDate = (market, d) => new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS[market].tz }).format(d);

// A link to a fund's page in the app: APP_URL#fund/<id>, or #fund/<id>/approve for its trades waiting
// for approval (app.js follows both). Null without the app's address.
export const fundLink = (appUrl, fundId, part = '') => (appUrl ? `${appUrl}#fund/${encodeURIComponent(fundId ?? '')}${part ? `/${part}` : ''}` : null);

// Every alert key for the fund as it is now: { key: text }.
function candidates(fund, { prices = null, calendar = null, appUrl = '', now = new Date() } = {}) {
  const out = {};
  const ccy = fund.currency;
  const approve = fundLink(appUrl, fund.id, 'approve');
  for (const p of fund.proposals ?? []) {
    if (p.status === 'awaiting') out[`p:${p.id}`] = `🟡 <b>Waiting for your approval</b> until ${sgTime(p.expiresAt)} SGT: ${esc(p.action.toUpperCase())} ${p.shares} ${esc(p.symbol)} (limit ${num(p.limitPrice)}). ${esc(p.reason)}${approve ? ` <a href="${attr(approve)}">Approve or decline</a>` : ''}`;
  }
  for (const o of fund.brokerOrders ?? []) {
    if (['rejected', 'failed'].includes(o.status)) out[`o:${o.id}:${o.status}`] = `⚠️ <b>Tiger didn't take</b> ${esc(o.action)} ${o.qty} ${esc(o.symbol)}: ${esc(o.error ?? o.status)}`;
    if (o.source === 'guard' && o.status === 'sent') out[`o:${o.id}:sent`] = `🛡️ Stop-loss placed at Tiger: ${o.side === 'sell' ? 'sell' : 'buy back'} ${o.qty} ${esc(o.symbol)} if it ${o.side === 'sell' ? 'falls' : 'rises'} to ${num(o.stopPrice)}.`;
  }
  // an exit carries how far the position went against and for the fund while it was held (fund.js
  // tracks); one opened before tracking began (`late`) was only followed from then
  const held = (tr) => (tr?.worst == null ? '' : `. ${tr.late ? `Since tracking began${tr.openedAt ? ` (${dayMonth(tr.openedAt)})` : ''}` : 'While held'}: at worst ${pctText(tr.worst)}, at best ${pctText(tr.best)}.`);
  for (const e of fund.events ?? []) {
    const key = `e:${e.time}:${e.symbol}:${e.action}:${e.shares}`;
    out[key] = ['split', 'dividend'].includes(e.action)
      ? `💵 ${esc(e.why)}`
      : `${/stop-loss|forced/.test(e.why) ? '🔻' : /take-profit/.test(e.why) ? '🎯' : '✅'} ${esc(e.action.toUpperCase())} ${e.shares} ${esc(e.symbol)} at ${num(e.price)} ${ccy} (${esc(e.why)})${held(e.track)}`;
  }
  for (const d of fund.decisions ?? []) {
    const filled = (d.orders ?? []).filter((o) => o.status === 'filled');
    if (filled.length) out[`d:${d.time}`] = `🤖 <b>AI traded</b>: ${filled.map((o) => `${esc(o.action.toUpperCase())} ${o.shares} ${esc(o.symbol)} at ${num(o.price)}`).join(', ')}. ${esc(d.outlook)}`;
  }
  // (what the weekly review wrote is in the weekly report, reportMessage, which replaced its own alert)
  if (fund.paused) out[`pause:${fund.paused.at}`] = `⛔ <b>Trading paused</b>: ${esc(fund.paused.reason)} Stop-losses still work.`;
  if (fund.stoppedAt) out[`stop:${fund.stoppedAt}`] = '⏹️ <b>The AI fund was stopped</b> and its positions are being closed.';
  if (fund.lastError) out[`err:${fund.lastError.time}`] = `⚠️ An AI decision failed (it retries next run): ${esc(fund.lastError.message)}`;
  if (fund.aiCapped) out[`cap:${fund.aiCapped.time}`] = `💸 ${esc(fund.aiCapped.message)}`;
  if (fund.settings?.broker === 'tiger' && fund.broker?.error) out[`berr:${fund.broker.error}`] = `⚠️ <b>Tiger</b>: ${esc(fund.broker.error)}`;
  const summary = dailySummary(fund, prices, now);
  if (summary) out[summary.key] = summary.text;
  for (const h of resultsHeadsUp(fund, calendar, prices, now)) out[h.key] = h.text;
  for (const h of catalystsPassed(fund, prices, now)) out[h.key] = h.text;
  return out;
}

const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
// "tomorrow" only for the next calendar day; a Monday seen from a Friday evening is "on Mon 5 Oct".
const nextDay = (today, date) => Date.parse(date) - Date.parse(today) === 86400000;

// After the market's close, for each stock the fund holds whose results come before the next
// session: confirmed dates only (a filing already out, or a date the company confirmed on Yahoo).
// `calendar` is calendar.js resultsCalendar.
export function resultsHeadsUp(fund, calendar, prices, now = new Date()) {
  const market = marketForCurrency(fund.currency);
  const quotes = prices?.quotes ?? {};
  if (!calendar || fund.stoppedAt || isOpen(market, now)) return [];
  const today = marketDate(market, now);
  const { weekend, mins } = localClock(market, now);
  if (weekend || mins < MARKETS[market].sessions.at(-1)[1]) return [];
  const { positions, accounts } = summarize(fund.portfolio, quotes);
  const equity = accounts[fund.currency]?.equity ?? 0;
  const out = [];
  for (const p of positions) {
    const n = nextResults(calendar, p.symbol, quotes, now);
    if (!n || n.source === 'estimated' || n.daysAway !== 1) continue;
    // A confirmed date is the day of the release; a filing is already out (today, after the close).
    if (n.source === 'filing' && n.date !== today) continue;
    const typical = calendar[p.symbol]?.typicalMove;
    const share = equity > 0 ? Math.abs(p.marketValue) / equity : null;
    out.push({
      key: `results:${p.symbol}:${n.date}`,
      text: `📅 <b>${esc(p.symbol)} ${n.source === 'filing'
        ? `reported results after today's close</b> (${esc(n.time.slice(11))} New York time); it first trades on them ${nextDay(today, n.effectiveDate) ? 'tomorrow' : `on ${weekday(n.effectiveDate)}`}`
        : nextDay(today, n.date) ? `reports results tomorrow</b> (${weekday(n.date)})` : `reports results on ${weekday(n.date)}</b>, the next trading day`}. The fund is ${p.short ? 'short' : 'long'} ${Math.abs(p.qty).toLocaleString('en-US')} shares${share == null ? '' : `, ${Math.round(share * 100)}% of its value`}.${typical ? ` Its results days have moved it ±${(typical.avg * 100).toFixed(1)}% against the index on average (${typical.n} results).` : ''}`,
    });
  }
  return out;
}

// For each position the fund holds whose thesis had a catalyst still to come when it was opened, once
// that date has passed (within the last 3 trading days, so an old one isn't announced late): what it
// expected, how it's doing so far and what would prove it wrong.
export const CATALYST_ALERT_DAYS = 3;
export function catalystsPassed(fund, prices, now = new Date()) {
  const market = marketForCurrency(fund.currency);
  const quotes = prices?.quotes ?? {};
  if (!prices || fund.stoppedAt) return [];
  const today = marketDate(market, now);
  const out = [];
  for (const p of summarize(fund.portfolio, quotes).positions) {
    const th = positionThesis(fund, p.symbol, p.short ? 'short' : 'long');
    const date = th?.catalystDate;
    if (!date || date < marketDate(market, new Date(th.time))) continue; // no date, or already past when opened
    const since = tradingDaysBetween(date, today);
    if (since < 1 || since > CATALYST_ALERT_DAYS) continue;
    const { soFar } = thesisProgress(th, { price: p.price, short: p.short, quote: quotes[p.symbol], now });
    out.push({
      key: `catalyst:${p.symbol}:${date}`,
      text: `📌 <b>${esc(p.symbol)}</b>: the catalyst the fund ${p.short ? 'shorted' : 'bought'} it for (${esc(CATALYST_LABELS[th.catalyst] ?? th.catalyst)}, ${weekday(date)}) has passed. It expected ${th.expected == null ? '?' : moveWords(th.expected / 100, p.short, abs2)} in ${HORIZON_LABELS[th.horizon] ?? '?'}${soFar == null ? '' : `; so far ${moveWords(soFar, p.short, abs2)}`}.${th.wrongIf ? ` Wrong if: ${esc(th.wrongIf)}` : ''}`,
    });
  }
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

// Of `all` ({ key: text }), the texts not sent before, remembering their keys in holder.notified (here
// the collection, for its own alerts). On the very first call nothing is sent: everything already there
// is only remembered.
function unsent(holder, all) {
  const first = !holder.notified;
  const seen = new Set(holder.notified?.keys ?? []);
  const fresh = Object.entries(all).filter(([k]) => !seen.has(k));
  holder.notified = { keys: [...seen, ...fresh.map(([k]) => k)].slice(-MAX_KEYS) };
  return first ? [] : fresh.map(([, text]) => text);
}

// The owner's last request from the app, if it didn't work. scripts/ai-fund.mjs keeps it on the
// collection (c.lastCommand), with the id of the fund it was for, if any.
function failedCommand(c) {
  const cmd = c.lastCommand;
  if (!cmd || cmd.ok) return {};
  const f = c.funds.length > 1 ? findFund(c, cmd.fund) : null;
  return { [`cmd:${cmd.time}`]: `${f ? `<b>${esc(f.name)}</b> · ` : ''}⚠️ Your "${esc(cmd.action)}" request didn't work: ${esc(cmd.message)}` };
}

// A weekly report (report.js) as the text of a Telegram message: the fund's name, the week's result,
// then a line for each part.
export function reportMessage(fund, report) {
  const [head, ...rest] = reportLines(report);
  return [`📘 <b>What we learned · ${esc(fund.name ?? 'AI fund')}</b>`, esc(head.text), ...rest.map((l) => `• ${esc(l.text)}`)].join('\n');
}

// What's new for one fund, marked as sent in fund.notified: { alerts: texts (oldest first), reports:
// [[key, report]] (its latest weekly report, once) }. On the very first call nothing is sent:
// everything already there is only remembered.
function collect(fund, options) {
  const all = candidates(fund, options);
  const latest = fund.reports?.at(-1);
  const first = !fund.notified;
  const seen = new Set(fund.notified?.keys ?? []);
  const fresh = Object.entries(all).filter(([k]) => !seen.has(k));
  const reports = latest && !seen.has(`report:${latest.week}`) ? [[`report:${latest.week}`, latest]] : [];
  fund.notified = { keys: [...seen, ...fresh.map(([k]) => k), ...reports.map(([k]) => k)].slice(-MAX_KEYS) };
  return first ? { alerts: [], reports: [] } : { alerts: fresh.map(([, text]) => text), reports };
}

// Returns the alert texts to send now for one fund (oldest first) and updates fund.notified (its
// weekly report, if a new one is due, counts as sent too: collectMessages sends it).
export const collectAlerts = (fund, options = {}) => collect(fund, options).alerts;

// Every fund's new alerts and weekly reports, marked as sent: { alerts: texts, one message together (a
// request from the app that didn't work first, as it answers what the owner just did; then each fund's,
// labelled with its name when there are several, and a check of Tiger against all the Tiger funds),
// reports: [{ fundId, key, text }], each a whole message with a link to its fund's page }.
// `c` is a collection (funds.js); `options.appUrl` the app's address, for the links.
export function collectMessages(c, options = {}) {
  const many = c.funds.length > 1;
  const alerts = unsent(c, failedCommand(c)), reports = [];
  for (const f of c.funds) {
    const got = collect(f, options);
    for (const t of got.alerts) alerts.push(many ? `<b>${esc(f.name)}</b> · ${t}` : t);
    for (const [key, r] of got.reports) {
      reports.push({ fundId: f.id, key, text: formatMessage([reportMessage(f, r)], options.appUrl, { hash: `fund/${encodeURIComponent(f.id ?? '')}`, label: 'Open it on the page' }) });
    }
  }
  const check = reconcileAll(c);
  const key = check && !check.ok ? `mismatch:${JSON.stringify(check.mismatches)}` : null;
  if (key && c.notifiedMismatch !== key) {
    alerts.push(`⚠️ <b>Your Tiger account doesn't hold what the funds think</b>: ${check.mismatches.map((m) => `${esc(m.symbol)} funds ${m.fund}, Tiger ${m.tiger}`).join('; ')}. Check the Tiger app.`);
  }
  c.notifiedMismatch = key;
  return { alerts, reports };
}

// Every fund's alerts alone (see collectMessages; the weekly reports it marks as sent go unsent).
export const collectAllAlerts = (c, options = {}) => collectMessages(c, options).alerts;

// Forgets that a report was sent (its message failed), so it goes out on the next run.
export function unmarkSent(c, { fundId, key }) {
  const f = c.funds.find((x) => x.id === fundId);
  if (f?.notified?.keys) f.notified.keys = f.notified.keys.filter((k) => k !== key);
}

// One Telegram message (under its 4096-character limit) for a list of alerts, with a link to the app
// (`hash`: the page's address after '#', and its `label`). A message cut short never splits an HTML
// tag or entity, and closes the tags left open.
export const MESSAGE_MAX = 3800;
export function formatMessage(texts, appUrl, { hash = 'fund', label = 'Open the AI fund' } = {}) {
  let body = texts.join('\n\n');
  if (body.length > MESSAGE_MAX) {
    body = body.slice(0, MESSAGE_MAX).replace(/<[^>]*$|&[#a-z0-9]*$/i, '').trimEnd();
    const open = [];
    for (const m of body.matchAll(/<(\/?)(b|i|a|code)\b[^>]*>/g)) { if (m[1]) open.pop(); else open.push(m[2]); }
    body = `${body}…${open.reverse().map((t) => `</${t}>`).join('')}`;
  }
  return `${body}${appUrl ? `\n\n<a href="${attr(`${appUrl}#${hash}`)}">${esc(label)}</a>` : ''}`;
}
