import { newPortfolio, applyTrade, placeOrder, cancelOrder, convertCash, summarize, validatePortfolio, buyingPower, DEFAULT_START, SHORT_MARGIN } from './portfolio.js';
import { applyCorporateActions, describeAction } from './actions.js';
import { BENCHMARKS, benchmarkFor, benchmarkSeries } from './benchmark.js';
import { scorePicks, summarizeScores } from './scorecard.js';
import { addSpend, monthSpend, fundAiCost } from './spend.js';
import { hbars, stackBar, columns, lineChart, tableToggle, focusQuietly, tipOpenFor, SERIES, OTHER, CASH, TRACK } from './charts.js';
import { valueHistory, indexHistory, realizedHistory } from './history.js';
import { MIN_CASES as MEMORY_MIN_CASES } from './memory.js';
import { CONDITIONS, UNITS, REPEATS, newRule, freshState, checkRule, describeRule, runRules, backtest, fillPendingOrders } from './rules.js';
import { MODELS, TIERS, loadClient, analyze, recommend, buildContext } from './ai.js';
import { MARKETS, marketForCurrency, tradingStatus, STATUS_LABELS } from './markets.js';
import { loadFunds, reconcileAll, STYLES, DEFAULT_STYLE, MAX_ACTIVE_FUNDS } from './funds.js';
import { activeLessons, OUTCOME_LABELS, IDEA_LABELS, MIN_CASES, REVIEW_MIN_NEW } from './learning.js';
import { calcFee, planFor, fxSpreadFor, FEE_PLANS } from './fees.js';
import { authEnabled, onAuthChange, signOut, myInvite, loadCloudPortfolio, saveCloudPortfolio, sendFundCommand, fundCommandStatus, loadPrivateFund } from './auth.js';
import { showAuth, hideAuth, wireAuthScreen, openInvites, wireInvites } from './login.js';

const KEYS = { portfolio: 'paper-trader:portfolio', ai: 'paper-trader:ai', picks: 'paper-trader:picks', strategist: 'paper-trader:strategist', spend: 'paper-trader:ai-spend', fundId: 'paper-trader:fund' };
const PRICE_REFRESH_MS = 5 * 60 * 1000;
const $ = (id) => document.getElementById(id);

const state = {
  prices: { quotes: {}, fx: {} },
  sample: false,
  portfolio: newPortfolio(),
  user: null, // { id, email, isAdmin } when signed in (accounts on)
  cloud: { updatedAt: null, timer: null, saving: false, failed: false },
  ai: readStore(KEYS.ai) ?? { key: '', model: TIERS.advanced }, // model = the one that makes decisions
  sitePicks: null,
  picksHistory: null, // every scheduled set of picks, for the track record
  spend: null, // the scheduled AI jobs' spend ledger, with its monthly cap
  browserSpend: readStore(KEYS.spend), // what this browser spent with your own key
  localPicks: readStore(KEYS.picks),
  strategist: readStore(KEYS.strategist),
  funds: undefined, // the AI funds (funds.js): undefined = not loaded yet, null = none
  fundId: readStore(KEYS.fundId), // the fund shown on the AI fund page
  fundCmd: null, // the admin's latest start/stop request: { id, action, createdAt, phase, message }
  marketFilter: 'all',
  trade: null, // { symbol, side }
  editingRule: null, // rule id, or null for a new rule
  backtests: {}, // rule id / "s<index>" / "editor" -> result
};

// ---------- storage ----------

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Each signed-in user gets their own local copy; without accounts there's one per browser.
const portfolioKey = () => (state.user ? `${KEYS.portfolio}:${state.user.id}` : KEYS.portfolio);

function loadPortfolio() {
  try {
    const saved = readStore(portfolioKey());
    if (saved) return validatePortfolio(saved);
  } catch (err) {
    console.warn('Could not read saved portfolio', err);
  }
  return newPortfolio();
}

function savePortfolio() {
  if (!writeStore(portfolioKey(), state.portfolio) && !state.user) {
    showBanner('This browser is not letting the page save, so trades will be lost when you close it. Export your portfolio to keep it.');
  }
  if (state.user) scheduleCloudSave();
}

// ---------- account sync ----------

// Saves to the user's account a moment after the last change, retrying if it fails.
function scheduleCloudSave(delay = 1000) {
  clearTimeout(state.cloud.timer);
  state.cloud.timer = setTimeout(async () => {
    state.cloud.timer = null;
    if (!state.user) return;
    state.cloud.saving = true;
    renderSync();
    try {
      state.cloud.updatedAt = await saveCloudPortfolio(state.user.id, state.portfolio);
      state.cloud.failed = false;
    } catch (err) {
      console.warn('Saving to account failed', err);
      state.cloud.failed = true;
      scheduleCloudSave(30000);
    } finally {
      state.cloud.saving = false;
      renderSync();
    }
  }, delay);
}

function renderSync() {
  $('sync-status').textContent = state.cloud.saving ? 'Saving…' : state.cloud.failed ? 'Not saved, retrying' : 'Saved';
  $('sync-status').className = `small ${state.cloud.failed ? 'down' : 'muted'}`;
}

// Loads the user's saved portfolio. On their first sign-in, this browser's existing portfolio
// (from before accounts) is carried over, so nothing is lost.
async function loadAccountPortfolio() {
  const row = await loadCloudPortfolio(state.user.id);
  if (row) {
    state.portfolio = validatePortfolio(row.data);
    state.cloud.updatedAt = row.updated_at;
  } else {
    let local = null;
    try { local = validatePortfolio(readStore(KEYS.portfolio)); } catch { /* nothing usable */ }
    state.portfolio = local ?? newPortfolio();
    state.cloud.updatedAt = await saveCloudPortfolio(state.user.id, state.portfolio);
  }
  writeStore(portfolioKey(), state.portfolio);
}

// Picks up changes made on another device when this tab comes back into view.
async function refreshFromAccount() {
  if (!state.user || state.cloud.timer || state.cloud.saving) return;
  try {
    const row = await loadCloudPortfolio(state.user.id);
    if (row && row.updated_at !== state.cloud.updatedAt && Date.parse(row.updated_at) > Date.parse(state.cloud.updatedAt ?? 0)) {
      state.portfolio = validatePortfolio(row.data);
      state.cloud.updatedAt = row.updated_at;
      writeStore(portfolioKey(), state.portfolio);
      render();
    }
  } catch (err) {
    console.warn('Could not check account for changes', err);
  }
}

async function handleAuth(event, session) {
  if (event === 'PASSWORD_RECOVERY') { showAuth('newpass'); return; }
  if (!session) {
    state.user = null;
    state.portfolio = newPortfolio();
    $('user-chip').hidden = true;
    showAuth('signin');
    return;
  }
  if (state.user?.id === session.user.id) return; // token refresh or a repeat event
  const email = session.user.email ?? '';
  try {
    const invite = await myInvite(email);
    if (!invite) { showAuth('notinvited', email); return; }
    state.user = { id: session.user.id, email, isAdmin: invite.is_admin };
    await loadAccountPortfolio();
  } catch (err) {
    state.user = null;
    showAuth('error', err.message);
    return;
  }
  $('user-email').textContent = email;
  $('open-invites').hidden = !state.user.isAdmin;
  $('user-chip').hidden = false;
  renderSync();
  hideAuth();
  startApp();
}

async function doSignOut() {
  clearTimeout(state.cloud.timer);
  if (state.cloud.timer || state.cloud.failed) {
    try { await saveCloudPortfolio(state.user.id, state.portfolio); } catch { /* best effort */ }
  }
  state.cloud.timer = null;
  try { localStorage.removeItem(portfolioKey()); } catch { /* ignore */ }
  await signOut(); // the sign-out event shows the sign-in screen
}

// ---------- data loading ----------

async function fetchJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function loadPrices() {
  try {
    state.prices = await fetchJson('data/prices.json');
    state.sample = false;
  } catch {
    state.prices = await fetchJson('data/sample-prices.json');
    state.sample = true;
  }
  runAutomation();
  render();
}

async function loadSideData() {
  // A private fund (admins, from Supabase) wins over the public copy.
  const fundSource = async () => (authEnabled && state.user?.isAdmin && (await loadPrivateFund().catch(() => null))) || fetchJson('data/ai-fund.json');
  const [picks, fund, history, spend] = await Promise.allSettled([
    fetchJson('data/picks.json'), fundSource(), fetchJson('data/picks-history.json'), fetchJson('data/ai-spend.json'),
  ]);
  state.sitePicks = picks.status === 'fulfilled' ? picks.value : null;
  state.picksHistory = history.status === 'fulfilled' ? history.value : null;
  state.spend = spend.status === 'fulfilled' ? spend.value : null;
  state.funds = fund.status === 'fulfilled' && fund.value ? loadFunds(fund.value) : null;
  render();
}

const quote = (symbol) => state.prices.quotes?.[symbol];
const myPlan = () => planFor(state.portfolio.feePlan, state.portfolio.customFees);
const feeOf = (q, side, qty) => (q && qty > 0 ? calcFee(myPlan(), q.market, side, qty, q.price) : { total: 0, parts: [] });
// Backtests use the same fees as your own trades.
const btOptions = () => ({ feePlan: state.portfolio.feePlan ?? 'tiger', customFees: state.portfolio.customFees });
// Open only when today's prices are arriving (so holidays and early closes count as closed).
const marketStatus = (market) => (state.sample ? 'open' : tradingStatus(market, state.prices));

// ---------- automation ----------

// Runs auto-trading rules over any prices they haven't seen. Re-reads storage first so two open tabs don't double-trade.
function runAutomation() {
  if (authEnabled && !state.user) return; // signed out: nothing to trade for
  try {
    const saved = readStore(portfolioKey());
    if (saved) state.portfolio = validatePortfolio(saved);
  } catch { /* keep the in-memory copy */ }
  const quotes = state.prices.quotes ?? {};
  if (!state.sample) {
    const actions = applyCorporateActions(state.portfolio, quotes);
    if (actions.portfolio !== state.portfolio) {
      state.portfolio = actions.portfolio;
      savePortfolio();
      for (const a of actions.applied) notify(describeAction(a, (n) => money(n, a.currency)));
    }
  }
  if (state.portfolio.pendingOrders?.length) {
    const before = state.portfolio.pendingOrders.length;
    const filled = fillPendingOrders(state.portfolio, quotes);
    if (filled.portfolio.pendingOrders.length !== before) {
      state.portfolio = filled.portfolio;
      savePortfolio();
    }
    for (const { order, trade, error, time } of filled.log) {
      const verb = order.side === 'buy' ? 'Buy' : 'Sell';
      if (trade) notify(`${verb} order filled: ${shares(trade.qty)} of ${trade.symbol} at ${price(trade.price)} ${trade.currency}, the first price after the open (${fmtDateTime(trade.time)}).`);
      else notify(`${verb} order for ${shares(order.qty)} of ${order.symbol} couldn't fill at the open (${fmtDateTime(time)}): ${error}`, null, true);
    }
  }
  if (!state.portfolio.rules.some((r) => r.enabled)) return;
  const { portfolio, log } = runRules(state.portfolio, quotes);
  state.portfolio = portfolio;
  savePortfolio();
  for (const entry of log) {
    const rule = portfolio.rules.find((r) => r.id === entry.ruleId);
    const when = fmtDateTime(entry.time);
    if (entry.trade) {
      const t = entry.trade;
      notify(`Auto-trade: ${t.side === 'buy' ? 'bought' : 'sold'} ${t.qty.toLocaleString()} ${t.symbol} at ${price(t.price)} ${t.currency} (${when}).`, rule);
    } else {
      notify(`Auto-trade skipped for ${rule?.symbol}: ${entry.error} (${when}).`, rule, true);
    }
  }
}

function notify(text, rule, warn = false) {
  const div = document.createElement('div');
  div.className = `notice${warn ? ' warn' : ''}`;
  div.innerHTML = `<span>${esc(text)}${rule?.note ? ` <span class="muted">Rule from: ${esc(rule.note)}</span>` : ''}</span><button class="ghost small-btn" aria-label="Dismiss">✕</button>`;
  div.querySelector('button').onclick = () => div.remove();
  $('notices').append(div);
}

// ---------- formatting ----------

const fmtCache = {};
function money(n, ccy, { sign = false } = {}) {
  const key = ccy + sign;
  fmtCache[key] ??= new Intl.NumberFormat(undefined, {
    style: 'currency', currency: ccy, currencyDisplay: 'code',
    minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: sign ? 'exceptZero' : 'auto',
  });
  return fmtCache[key].format(n).replace('-', '−');
}
const price = (n) => n == null ? '–' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
const pct = (n) => { const v = Math.abs(n) < 0.00005 ? 0 : n; return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(2) + '%'; };
const tone = (n) => (n > 0.00001 ? 'up' : n < -0.00001 ? 'down' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDateTime = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
const domain = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const MODEL_NAMES = { 'claude-haiku-4-5': 'Haiku 4.5', 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-5': 'Opus 5' };
const modelName = (id) => { const base = String(id ?? '').replace(/-\d{8}$/, ''); return MODEL_NAMES[base] ?? base; };
// "Sonnet 5, news by Haiku 4.5"
const madeBy = (x) => x.newsModel && modelName(x.newsModel) !== modelName(x.model) ? `${modelName(x.model)}, news by ${modelName(x.newsModel)}` : modelName(x.model);
const safeUrl = (url) => /^https?:\/\//i.test(url) ? url : '#';
const shares = (n) => `${n.toLocaleString()} share${n === 1 ? '' : 's'}`;

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

function sparkline(values) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 88 + 1},${25 - ((v - min) / span) * 24}`).join(' ');
  const color = values.at(-1) >= values[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 90 26" aria-hidden="true"><polyline points="${pts}" stroke="${color}"/></svg>`;
}

const sources = (urls) => urls?.length
  ? `<p class="sources">Sources: ${urls.map((u) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(domain(u))}</a>`).join(' · ')}</p>`
  : '';

// ---------- rendering ----------

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
}

const VIEWS = ['home', 'markets', 'auto', 'strategist', 'fund', 'history'];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');

function render() {
  const view = currentView();
  const focused = focusKey();
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== view;
  for (const a of $('tabs').children) a.setAttribute('aria-selected', a.getAttribute('href') === `#${view}`);
  // On a phone the tab strip scrolls sideways: keep the current tab in sight.
  const tabs = $('tabs'), sel = tabs.querySelector('[aria-selected="true"]');
  if (sel && tabs.scrollWidth > tabs.clientWidth) {
    const a = sel.getBoundingClientRect(), b = tabs.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) tabs.scrollLeft += a.left - b.left - 12;
  }
  $('cards').hidden = view === 'fund';

  const { accounts, positions } = summarize(state.portfolio, state.prices.quotes);
  renderCards(accounts);
  if (view === 'home') { renderOverview(); renderPicks(); renderScorecard(); renderHoldings(positions, accounts); }
  if (view === 'markets') renderMarkets();
  if (view === 'auto') renderRules();
  if (view === 'strategist') renderStrategist();
  if (view === 'fund') { renderFundControls(); renderFund(); }
  if (view === 'history') renderTrades();
  if ($('trade-dialog').open) updateTradeDialog();
  restoreFocus(focused);

  $('updated').textContent = state.sample ? 'Sample prices'
    : state.prices.updatedAt ? `Prices updated ${ago(state.prices.updatedAt)}` : '';
  showBanner(state.sample
    ? 'Showing made-up sample prices so you can try the app. Real prices appear once the price job has run on GitHub (see README).'
    : '');
}

// ---------- charts ----------

// A chart is drawn after its HTML is on the page (it sizes itself to its box): chartSlot returns the
// box's HTML and remembers how to draw it; flushCharts draws every waiting chart. Drawn charts are
// kept (by box id, with the width they were drawn at) so a resize redraws just the ones whose box
// changed width, and an open "Table" stays open when the page re-renders (keyed by the chart's
// `key`, else its title).
let chartJobs = [];
let chartSeq = 0;
const chartDraws = new Map();
const openTables = new Set();
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.classList?.contains('chart-table') && d.dataset.key) d.open ? openTables.add(d.dataset.key) : openTables.delete(d.dataset.key);
}, true);
function chartSlot(draw, { title = '', caption = '', table = '', key = '' } = {}) {
  const id = `chart-${++chartSeq}`;
  const k = key || title || caption;
  chartJobs.push([id, draw]);
  const tableHtml = table && k ? table.replace('<details class="chart-table">', `<details class="chart-table" data-key="${esc(k)}"${openTables.has(k) ? ' open' : ''}>`) : table;
  return `<figure class="chart-card" data-key="${esc(k)}">${title ? `<h3>${esc(title)}</h3>` : ''}${caption ? `<p class="caption muted small">${caption}</p>` : ''}<div id="${id}" class="chart-box"></div>${tableHtml}</figure>`;
}
function flushCharts() {
  const jobs = chartJobs;
  chartJobs = [];
  for (const [id, draw] of jobs) { const el = $(id); if (el) drawChart(id, el, draw); }
  for (const id of chartDraws.keys()) if (!$(id)) chartDraws.delete(id);
}
function drawChart(id, el, draw) {
  draw(el);
  chartDraws.set(id, { draw, w: el.clientWidth });
}
function redrawCharts() {
  const focused = focusKey();
  for (const [id, c] of chartDraws) {
    const el = $(id);
    if (!el) chartDraws.delete(id);
    else if (el.clientWidth && el.clientWidth !== c.w) drawChart(id, el, c.draw);
  }
  restoreFocus(focused);
}
// Keyboard focus on a chart, its table or a fund row survives the page re-rendering around it, with
// its tooltip open again only if it was open. A line chart keeps the point being read.
function focusKey() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  if (a.dataset?.fundSelect) return { sel: `[data-fund-select="${CSS.escape(a.dataset.fundSelect)}"]` };
  const box = a.closest?.('.chart-card[data-key], [data-bt]');
  if (!box) return null;
  const scope = box.matches('[data-bt]') ? `[data-bt="${CSS.escape(box.dataset.bt)}"]` : `.chart-card[data-key="${CSS.escape(box.dataset.key)}"]`;
  const tip = a.getAttribute('data-tip'), open = tipOpenFor(a);
  if (tip != null) return { sel: `${scope} [data-tip="${CSS.escape(tip)}"]`, open };
  for (const s of ['svg.line-chart', 'details.chart-table > summary', '.chart-table .table-wrap']) if (a.matches(s)) return { sel: `${scope} ${s}`, at: a.dataset.at, open };
  return null;
}
function restoreFocus(f) {
  const el = f && document.querySelector(f.sel);
  if (!el || el === document.activeElement) return;
  if (f.at) el.dataset.at = f.at;
  if (f.open) el.focus({ preventScroll: true });
  else focusQuietly(el);
}
const pctTick = (v, d = 0) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Value over time for one account, against the money put in and against the same money in the index.
function valueChart(portfolio, currency, quotes, plan) {
  const a = portfolio.accounts[currency];
  const hist = valueHistory(portfolio, quotes, currency);
  const moved = hist.some(([, , inv]) => inv !== a.start);
  // An account that started empty gets its index line from the money converted into it.
  const b0 = a.start > 0 || moved ? benchmarkFor({ currency, amount: a.start || 1, since: portfolio.createdAt, quotes, plan }) : null;
  const b = b0 && (a.start > 0 ? b0 : { ...b0, shares: 0 });
  const idx = b ? indexHistory(portfolio, quotes, currency, b, hist) : null;
  const flat = hist.every(([, v, inv]) => Math.abs(v - inv) < 0.005);
  const refLabel = moved ? 'Money put in' : 'Started with';
  const compareLabel = idx ? `${b.label}, same money${idx.rebased ? ` from ${fmtDate(idx.since)}` : ''}` : '';
  const pts = hist.map(([t, v, inv], i) => ({ label: fmtDate(t), axis: fmtDate(t), value: v, ref: inv, compare: idx?.values[i] ?? null }));
  const table = tableToggle(['Date', 'Value', ...(moved ? ['Money put in'] : []), ...(idx ? [compareLabel] : [])],
    pts.slice().reverse().map((p) => [p.label, money(p.value, currency), ...(moved ? [money(p.ref, currency)] : []), ...(idx ? [p.compare == null ? '–' : money(p.compare, currency)] : [])]));
  const caption = flat && !moved ? `No trades in this account yet, so it's still worth the ${money(a.start, currency)} it started with.`
    : flat ? (new Set(hist.map(([, , inv]) => inv)).size > 1 ? 'No trades in this account yet, so it\'s worth exactly the money put in; the steps are money converted into or out of it.'
      : `No trades in this account yet, so it's worth exactly the money put in: ${money(hist.at(-1)[2], currency)}, counting money converted into or out of it.`)
    : idx?.rebased ? `The index line starts on ${fmtDate(idx.since)}, the first day with its prices, at the account's value then.` : '';
  return chartSlot((el) => lineChart(el, pts, { refLabel, fmt: (v) => money(v, currency), compareLabel, title: `${currency} account value` }),
    { title: `${currency} account`, caption, table, key: `value-${currency}` });
}

// Where an account's (or a fund's) money is: the biggest holdings, the rest, and cash. Each stock
// keeps its colour while it's held, whatever its size: it takes the first free colour when it's
// bought and gives it back when it's sold out.
function allocationChart(positions, cash, currency, title, portfolio) {
  const longs = positions.filter((p) => p.currency === currency && p.qty > 0);
  const slot = new Map(), held = {};
  const take = (symbol) => { let i = 0; const used = new Set(slot.values()); while (used.has(i)) i++; slot.set(symbol, i); };
  const splits = (portfolio.actions ?? []).filter((a) => a.kind === 'split' && a.ratio);
  const laterSplits = (t) => splits.filter((a) => a.symbol === t.symbol && a.time > t.time).reduce((m, a) => m * a.ratio, 1);
  for (const t of [...portfolio.trades].filter((t) => t.currency === currency).sort((x, y) => x.time.localeCompare(y.time))) {
    const q = Math.round(((held[t.symbol] ?? 0) + (t.side === 'buy' ? t.qty : -t.qty) * laterSplits(t)) * 1e6) / 1e6;
    if (q <= 0) slot.delete(t.symbol);
    else if (!slot.has(t.symbol)) take(t.symbol);
    held[t.symbol] = q;
  }
  for (const p of [...longs].sort((x, y) => x.symbol.localeCompare(y.symbol))) if (!slot.has(p.symbol)) take(p.symbol);
  const top = [...longs].sort((x, y) => y.marketValue - x.marketValue).filter((p) => slot.get(p.symbol) < SERIES.length).slice(0, 5)
    .sort((x, y) => slot.get(x.symbol) - slot.get(y.symbol));
  const topSet = new Set(top.map((p) => p.symbol));
  const rest = longs.filter((p) => !topSet.has(p.symbol)).reduce((s, p) => s + p.marketValue, 0);
  const shorts = positions.some((p) => p.currency === currency && p.qty < 0);
  const segs = top.map((p) => ({ label: p.symbol, value: p.marketValue, color: SERIES[slot.get(p.symbol)], display: money(p.marketValue, currency) }));
  if (rest > 0) segs.push({ label: 'Other holdings', value: rest, color: OTHER, display: money(rest, currency) });
  if (cash > 0) segs.push({ label: shorts ? 'Buying power' : 'Cash', value: cash, color: CASH, display: money(cash, currency) });
  if (segs.length < 2) return '';
  return chartSlot((el) => stackBar(el, segs, { ariaLabel: title }), { title, caption: shorts ? 'Short positions and the cash set aside for them aren\'t shown.' : '' });
}

// Profit or loss of each holding, in %, gains to the right and losses to the left.
function pnlChart(positions, title) {
  const list = [...positions].sort((x, y) => y.unrealizedPct - x.unrealizedPct);
  const shown = list.length > 12 ? [...list.slice(0, 6), ...list.slice(-6)] : list;
  if (!shown.length) return '';
  const rows = shown.map((p) => ({
    label: p.symbol, sub: money(p.unrealized, p.currency, { sign: true }), value: p.unrealizedPct * 100, display: pct(p.unrealizedPct),
    tip: [{ value: pct(p.unrealizedPct), label: p.symbol }, { value: money(p.unrealized, p.currency, { sign: true }), label: p.short ? 'on the short' : 'profit / loss' }],
  }));
  return chartSlot((el) => hbars(el, rows, { signColors: true, tickFmt: pctTick, ariaLabel: title }),
    { title, caption: list.length > shown.length ? `The 6 best and 6 worst of ${list.length} holdings.` : '',
      table: tableToggle(['Stock', 'Profit / loss', '%'], list.map((p) => [p.symbol, money(p.unrealized, p.currency, { sign: true }), pct(p.unrealizedPct)])) });
}

// "Index, same period": what the account's starting money would have made in the index fund.
function indexLine(a) {
  if (state.sample) return '';
  const b = benchmarkFor({ currency: a.currency, amount: a.start, since: state.portfolio.createdAt, quotes: state.prices.quotes, plan: planFor(state.portfolio.feePlan, state.portfolio.customFees) });
  return b ? `<span title="${esc(`${b.label} bought with ${money(a.start, a.currency)} on ${fmtDate(b.since)}, after fees`)}">Index, same period</span><span class="${tone(b.pct)}">${pct(b.pct)}</span>` : '';
}

function renderCards(accounts) {
  const cards = Object.values(accounts).map((a) => `
    <div class="card">
      <div class="label">${a.currency} account · net profit / loss</div>
      <div class="big ${tone(a.net)}">${money(a.net, a.currency, { sign: true })}</div>
      <div class="${tone(a.net)}">${pct(a.netPct)} on ${money(a.invested, a.currency)}${a.transfers ? ` <span class="muted small">(incl. ${money(a.transfers, a.currency, { sign: true })} converted)</span>` : ''}</div>
      <div class="sub">
        <span>Cash</span><span>${money(a.cash, a.currency)}</span>
        ${a.hasShorts ? `<span>Buying power</span><span>${money(a.buyingPower, a.currency)}</span>` : ''}
        <span>Holdings</span><span>${money(a.marketValue, a.currency)}</span>
        <span>Realized</span><span class="${tone(a.realized)}">${money(a.realized, a.currency, { sign: true })}</span>
        <span>Unrealized</span><span class="${tone(a.unrealized)}">${money(a.unrealized, a.currency, { sign: true })}</span>
        ${indexLine(a)}
        ${a.dividends ? `<span>Dividends</span><span class="${tone(a.dividends)}">${money(a.dividends, a.currency, { sign: true })}</span>` : ''}
        <span>Fees paid</span><span>${money(a.fees ?? 0, a.currency)}</span>
      </div>
    </div>`);

  const fx = state.prices.fx?.USDSGD;
  if (fx && accounts.SGD && accounts.USD) {
    const net = accounts.SGD.net + accounts.USD.net * fx;
    const start = accounts.SGD.invested + accounts.USD.invested * fx;
    cards.push(`
      <div class="card">
        <div class="label">Combined, in SGD</div>
        <div class="big ${tone(net)}">${money(net, 'SGD', { sign: true })}</div>
        <div class="${tone(net)}">${pct(start ? net / start : 0)}</div>
        <p class="muted small">USD converted at today's rate of ${fx.toFixed(4)}. Each account's own figure ignores exchange rates.</p>
        ${authEnabled && !state.user ? '' : '<button class="ghost small-btn" id="open-convert">Convert SGD ↔ USD</button>'}
      </div>`);
  }
  $('cards').innerHTML = cards.join('');
}

// ----- home: AI picks -----

function currentPicks() {
  const a = state.sitePicks, b = state.localPicks;
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a;
}

function renderPicks() {
  const picks = currentPicks();
  if (!picks) {
    $('picks-meta').textContent = '';
    $('picks').innerHTML = `<p class="muted">No AI picks yet. They refresh automatically twice each weekday once an Anthropic API key is added to the
      GitHub repo (see README), or press <strong>Refresh now</strong> to get them with your own key.</p>`;
    return;
  }
  const n = picks.sources?.length ?? 0;
  $('picks-meta').textContent = `${ago(picks.createdAt)} · ${n} source${n === 1 ? '' : 's'} · ${madeBy(picks)}${picks.usage ? ` · about US$${picks.usage.costUsd.toFixed(2)}` : ''}`;
  const card = (p) => {
    const q = quote(p.symbol);
    const since = q && p.priceAtPick ? q.price / p.priceAtPick - 1 : null;
    const right = since == null ? null : p.stance === 'long' ? since : -since;
    return `<article class="pick ${p.stance}">
      <header>
        <strong>${esc(p.symbol)}</strong> <span class="muted small">${esc(q?.name ?? '')}</span>
        <span class="chips"><span class="chip ${p.stance === 'long' ? 'buy' : 'sell'}">${p.stance}</span><span class="chip">${esc(p.conviction)} conviction</span><span class="chip">${esc(p.horizon)}</span></span>
      </header>
      <p>${esc(p.thesis)}</p>
      <p class="small"><strong>News:</strong> ${esc(p.news)}</p>
      <details class="small"><summary>What would make this wrong</summary><p>${esc(p.risks)}</p></details>
      ${sources(p.source_urls)}
      <footer>
        <span class="small muted">Now ${price(q?.price)} ${esc(q?.currency ?? '')}${right == null ? '' : ` · <span class="${tone(right)}">${pct(since)} since the pick</span>`}</span>
        <button class="small-btn" data-trade="${esc(p.symbol)}" data-side="${p.stance === 'long' ? 'buy' : 'sell'}">${p.stance === 'long' ? 'Buy' : 'Short'}</button>
      </footer>
    </article>`;
  };
  const longs = picks.picks.filter((p) => p.stance === 'long');
  const shorts = picks.picks.filter((p) => p.stance === 'short');
  $('picks').innerHTML = `
    <p>${esc(picks.market_summary)}</p>
    <div class="pick-cols">
      <div><h3 class="col-head up">Long ideas</h3>${longs.map(card).join('') || '<p class="muted small">None right now.</p>'}</div>
      <div><h3 class="col-head down">Short ideas</h3>${shorts.map(card).join('') || '<p class="muted small">None right now.</p>'}</div>
    </div>
    <p class="muted small">AI-generated from web news and price data; it can be wrong or out of date. Not financial advice.</p>`;
}

async function refreshPicks() {
  if (!state.ai.key) { openSettings(); $('api-key').focus(); return; }
  const btn = $('picks-refresh');
  btn.disabled = true;
  btn.textContent = 'Reading the news…';
  $('picks-error').textContent = '';
  try {
    const { client, Anthropic } = await loadClient(state.ai.key);
    state.localPicks = await recommend({ client, Anthropic, model: state.ai.model, prices: state.prices });
    writeStore(KEYS.picks, state.localPicks);
    trackBrowserSpend('picks', state.localPicks.usage?.costUsd);
    render();
  } catch (err) {
    $('picks-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
}

function trackBrowserSpend(task, cost) {
  state.browserSpend = addSpend(state.browserSpend, task, cost);
  writeStore(KEYS.spend, state.browserSpend);
}

// ----- home: the AI picks' track record -----

function renderScorecard() {
  const el = $('scorecard');
  const history = state.picksHistory;
  if (!history?.length || state.sample) { el.innerHTML = ''; return; }
  const scores = scorePicks(history, state.prices.quotes ?? {});
  const sum = summarizeScores(scores);
  const since = fmtDate(history[0].createdAt);
  if (!scores.length) {
    el.innerHTML = `<p class="muted small"><strong>Track record:</strong> ${history.reduce((n, h) => n + h.picks.length, 0)} picks recorded since ${since}. Each is scored once a week of trading has passed.</p>`;
    return;
  }
  const rate = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const row = (h) => h.n ? `<tr><td>After ${esc(h.label)}</td><td class="num hide-sm">${h.n}</td><td class="num">${rate(h.right)}</td><td class="num">${rate(h.beat)}</td>
    <td class="num ${tone(h.avgRet)}">${pct(h.avgRet)}</td><td class="num hide-sm ${tone(h.avgIndex ?? 0)}">${h.avgIndex == null ? '–' : pct(h.avgIndex)}</td></tr>` : '';
  const recent = scores.filter((x) => x.horizon === 'week').slice(-8).reverse();
  const bars = [];
  const of = (k, n) => `${k} of ${n} (${Math.round((k / n) * 100)}%)`;
  for (const h of [sum.week, sum.month]) {
    if (!h.n) continue;
    bars.push({ label: 'Right', sub: `after ${h.label}`, value: h.right * 100, display: of(h.rightN, h.n), tip: [{ value: of(h.rightN, h.n), label: `picks made money in their direction after ${h.label}` }] });
    if (h.beat != null) bars.push({ label: 'Beat the index', sub: `after ${h.label}`, value: h.beat * 100, display: of(h.beatN, h.nIndex), tip: [{ value: of(h.beatN, h.nIndex), label: `picks did better than the index after ${h.label}` }] });
  }
  el.innerHTML = `
    <h3 class="col-head">Track record since ${since}</h3>
    ${chartSlot((box) => hbars(box, bars, { ref: 50, refLabel: 'coin flip', domain: [0, 100], tickFmt: pctTick, ariaLabel: 'AI picks track record' }), { caption: 'Better than a coin flip means right more than 50% of the time.', key: 'scorecard' })}
    <div class="table-wrap"><table>
      <thead><tr><th>Scored</th><th class="num hide-sm">Picks</th><th class="num">Right</th><th class="num">Beat index</th><th class="num">Avg return</th><th class="num hide-sm">Same bet on index</th></tr></thead>
      <tbody>${row(sum.week)}${row(sum.month)}</tbody>
    </table></div>
    <p class="muted small">"Right" means the pick made money in its direction (a short gains when the price falls). "Beat index" compares it with the S&P 500 (US) or STI (SGX) over the same days. Before fees.
      ${recent.length ? `Latest after a week: ${recent.map((x) => `<span class="${tone(x.ret)}">${esc(x.symbol)} ${x.stance} ${pct(x.ret)}</span>`).join(', ')}.` : ''}</p>`;
  flushCharts();
}

function renderPendingOrders() {
  const orders = state.portfolio.pendingOrders ?? [];
  $('pending').hidden = !orders.length;
  $('pending').innerHTML = orders.length ? `
    <h3 class="col-head">Waiting for the market to open</h3>
    <ul class="orders">${orders.map((o) => {
      const q = quote(o.symbol);
      return `<li><span class="chip ${o.side}">${o.side}</span> ${shares(o.qty)} of <strong>${esc(o.symbol)}</strong>
        <span class="muted small">placed ${fmtDateTime(o.placedAt)} · fills at the first ${esc(MARKETS[q?.market]?.label ?? '')} price after the open${q ? ` (last ${price(q.price)} ${esc(q.currency)})` : ''}</span>
        <button class="small-btn ghost" data-cancel-order="${esc(o.id)}">Cancel</button></li>`;
    }).join('')}</ul>` : '';
}

function renderOverview() {
  const p = state.portfolio;
  if (state.sample) { $('overview').innerHTML = '<p class="muted small">Charts appear once real prices are loaded.</p>'; return; }
  $('overview').innerHTML = Object.keys(p.accounts).map((ccy) => valueChart(p, ccy, state.prices.quotes ?? {}, myPlan())).join('');
  flushCharts();
}

function renderHoldings(positions, accounts = {}) {
  renderPendingOrders();
  const allocs = positions.length ? Object.keys(accounts).map((ccy) => allocationChart(positions, accounts[ccy].buyingPower, ccy, `Where your ${ccy} is`, state.portfolio)).join('') : '';
  $('holding-charts').innerHTML = positions.length ? `${allocs ? `<div class="chart-grid">${allocs}</div>` : ''}${pnlChart(positions, 'Profit or loss by holding')}` : '';
  flushCharts();
  if (!positions.length) {
    $('holdings').innerHTML = '<tr><td class="empty">No holdings yet. Pick a stock under Markets or from the AI picks above.</td></tr>';
    return;
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  $('holdings').innerHTML = `
    <thead><tr>
      <th>Stock</th><th class="num">Shares</th><th class="num hide-sm">Avg price</th><th class="num">Price</th>
      <th class="num hide-sm">Value</th><th class="num">Profit / loss</th><th></th>
    </tr></thead>
    <tbody>${positions.map((p) => {
      const q = quote(p.symbol);
      return `<tr>
        <td><strong>${esc(p.symbol)}</strong>${p.short ? '<span class="chip sell">short</span>' : ''}<span class="name">${esc(q?.name ?? '')}</span></td>
        <td class="num">${p.qty.toLocaleString()}</td>
        <td class="num hide-sm">${price(p.avgCost)}</td>
        <td class="num">${p.unpriced ? '<span title="No current price; valued at cost">–</span>' : price(p.price)}</td>
        <td class="num hide-sm">${money(p.marketValue, p.currency)}</td>
        <td class="num ${tone(p.unrealized)}">${money(p.unrealized, p.currency, { sign: true })}<br><span class="small">${pct(p.unrealizedPct)}</span></td>
        <td class="num">${p.short
          ? `<button class="small-btn" data-trade="${esc(p.symbol)}" data-side="buy">Cover</button>`
          : `<button class="small-btn" data-trade="${esc(p.symbol)}" data-side="sell">Sell</button>`}</td>
      </tr>`;
    }).join('')}</tbody>`;
}

// ----- markets -----

function renderMarkets() {
  const status = Object.keys(MARKETS).map((m) => `${MARKETS[m].label} ${STATUS_LABELS[marketStatus(m)]}`).join(' · ');
  $('market-status').textContent = `${status}. Prices may be delayed. Orders placed while a market is closed wait and fill at the first price after it opens.`;

  const rows = Object.entries(state.prices.quotes ?? {})
    .filter(([, q]) => state.marketFilter === 'all' || q.market === state.marketFilter);
  if (!rows.length) {
    $('markets').innerHTML = '<tr><td class="empty">No prices loaded.</td></tr>';
    return;
  }
  $('markets').innerHTML = `
    <thead><tr>
      <th>Stock</th><th class="num">Price</th><th class="num">Day</th><th class="hide-sm">1 month</th><th class="num hide-sm">Held</th><th></th>
    </tr></thead>
    <tbody>${rows.map(([symbol, q]) => {
      const chg = q.prevClose ? (q.price - q.prevClose) / q.prevClose : null;
      const held = state.portfolio.positions[symbol]?.qty;
      return `<tr>
        <td><strong>${esc(symbol)}</strong><span class="chip">${esc(q.market)}</span><span class="name">${esc(q.name)}</span></td>
        <td class="num">${price(q.price)} <span class="muted small hide-sm">${esc(q.currency)}</span>${q.stale ? '<br><span class="small muted" title="Last fetch failed">stale</span>' : ''}</td>
        <td class="num ${tone(chg)}">${chg == null ? '–' : pct(chg)}</td>
        <td class="hide-sm">${sparkline((q.daily ?? []).slice(-22).map(([, c]) => c))}</td>
        <td class="num hide-sm">${held ? held.toLocaleString() : ''}</td>
        <td class="num"><button class="small-btn" data-trade="${esc(symbol)}" data-side="buy">Trade</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

// ----- history -----

function renderCashMoves() {
  const p = state.portfolio;
  const items = [
    ...(p.actions ?? []).filter((a) => a.qty).map((a) => ({ time: a.time, html: esc(describeAction(a, (n) => money(n, a.currency))) })),
    ...(p.conversions ?? []).map((c) => ({ time: c.time, html: `Converted ${money(c.amount, c.from)} to ${money(c.received, c.to)} at ${c.rate.toFixed(4)} <span class="muted small">(spread ${c.spreadPct}%: ${money(c.cost, c.to)})</span>` })),
  ].sort((a, b) => b.time.localeCompare(a.time));
  $('cash-moves-panel').hidden = !items.length;
  $('cash-moves').innerHTML = items.map((i) => `<li>${fmtDate(i.time)}: ${i.html}</li>`).join('');
}

// ----- converting cash between currencies -----

const convertRate = (from) => {
  const fx = state.prices.fx?.USDSGD;
  return fx > 0 ? (from === 'USD' ? fx : 1 / fx) : null;
};

function openConvert() {
  $('convert-amount').value = '';
  $('convert-error').textContent = '';
  updateConvert();
  $('convert-dialog').showModal();
  $('convert-amount').focus();
}

function updateConvert() {
  const from = $('convert-from').value, to = from === 'USD' ? 'SGD' : 'USD';
  const rate = convertRate(from), spread = fxSpreadFor(state.portfolio), amount = Number($('convert-amount').value) || 0;
  const received = amount * (rate ?? 0) * (1 - spread / 100);
  $('convert-facts').innerHTML = `
    <dt>Available</dt><dd>${money(Math.max(0, buyingPower(state.portfolio, from)), from)}</dd>
    <dt>Rate</dt><dd>${rate ? `1 ${from} = ${rate.toFixed(4)} ${to}` : 'No rate yet'}</dd>
    <dt>Spread</dt><dd>${spread}%${amount && rate ? ` (${money(amount * rate - received, to)})` : ''}</dd>
    <dt>You receive</dt><dd><strong>${money(received, to)}</strong></dd>`;
}

function submitConvert(e) {
  e.preventDefault();
  const from = $('convert-from').value;
  try {
    state.portfolio = convertCash(state.portfolio, { from, to: from === 'USD' ? 'SGD' : 'USD', amount: $('convert-amount').value, rate: convertRate(from), spreadPct: fxSpreadFor(state.portfolio) });
    savePortfolio();
    $('convert-dialog').close();
    render();
  } catch (err) {
    $('convert-error').textContent = err.message;
  }
}

function renderRealized() {
  const p = state.portfolio;
  const all = Object.keys(p.accounts).map((ccy) => [ccy, realizedHistory(p, ccy)]);
  if (all.every(([, h]) => !h.length)) { $('realized-charts').innerHTML = '<p class="muted small">No sales or dividends yet.</p>'; return; }
  $('realized-charts').innerHTML = all.map(([ccy, h]) => {
    if (!h.length) return `<figure class="chart-card"><h3>${esc(ccy)} account</h3><p class="muted small">No sales or dividends yet.</p></figure>`;
    const fmt = (v) => money(v, ccy, { sign: true });
    const start = Math.min(Date.parse(p.createdAt), Date.parse(h[0][0]));
    const pts = [
      { t: start, label: fmtDateTime(start), axis: fmtDate(start), value: 0 },
      ...h.map(([t, v]) => ({ t: Date.parse(t), label: fmtDateTime(t), axis: fmtDate(t), value: v })),
    ];
    pts.push({ t: Math.max(Date.now(), pts.at(-1).t), label: 'Today', axis: 'Today', value: h.at(-1)[1] });
    return chartSlot((el) => lineChart(el, pts, { time: true, step: true, endLabel: true, fmt, height: 160, title: `Realized profit, ${ccy} account` }),
      { title: `${ccy} account`, key: `realized-${ccy}`, table: tableToggle(['When', 'Realized so far'], pts.slice(1, -1).reverse().map((x) => [x.label, fmt(x.value)])) });
  }).join('');
  flushCharts();
}

function renderTrades() {
  renderRealized();
  renderCashMoves();
  const trades = state.portfolio.trades.slice().sort((a, b) => b.time.localeCompare(a.time));
  if (!trades.length) {
    $('trades').innerHTML = '<tr><td class="empty">No trades yet.</td></tr>';
    return;
  }
  const ruleNote = (id) => state.portfolio.rules.find((r) => r.id === id)?.note;
  $('trades').innerHTML = `
    <thead><tr>
      <th>When</th><th>Stock</th><th class="num">Shares</th><th class="num hide-md">Price</th><th class="num hide-md">Amount</th><th class="num hide-md">Fees</th><th class="num hide-md">Realized</th>
    </tr></thead>
    <tbody>${trades.map((t) => `<tr>
      <td class="when">${fmtDate(t.time)}<br><span class="small muted">${new Date(t.time).toLocaleTimeString(undefined, { timeStyle: 'short' })}</span></td>
      <td><strong>${esc(t.symbol)}</strong><span class="chip ${t.side}">${t.side}</span>${t.rule ? `<span class="chip" title="${esc(ruleNote(t.rule) || 'Auto-trading rule')}">auto</span>` : ''}</td>
      <td class="num">${t.qty.toLocaleString()}<span class="show-md small muted"><br>@ ${price(t.price)}</span>${t.realized ? `<span class="show-md small ${tone(t.realized)}"><br>${t.realized > 0 ? '+' : '\u2212'}${price(Math.abs(t.realized))}</span>` : ''}</td>
      <td class="num hide-md">${price(t.price)}</td>
      <td class="num hide-md">${money(t.value, t.currency)}</td>
      <td class="num hide-md">${t.fee ? money(t.fee, t.currency) : '–'}</td>
      <td class="num hide-md ${tone(t.realized)}">${t.realized ? money(t.realized, t.currency, { sign: true }) : ''}</td>
    </tr>`).join('')}</tbody>`;
}

// ---------- trade dialog ----------

function openTrade(symbol, side) {
  const q = quote(symbol);
  if (!q) return;
  state.trade = { symbol, side };
  const held = state.portfolio.positions[symbol]?.qty ?? 0;
  $('trade-title').textContent = `${symbol} · ${q.name ?? ''}`;
  $('qty').value = (side === 'sell' && held > 0) || (side === 'buy' && held < 0) ? Math.abs(held) : q.market === 'SGX' ? 100 : 1;
  $('trade-error').textContent = '';
  updateTradeDialog();
  $('trade-dialog').showModal();
  $('qty').select();
}

function maxQty() {
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  const held = state.portfolio.positions[symbol]?.qty ?? 0;
  const bp = Math.max(0, buyingPower(state.portfolio, q.currency));
  if (side === 'buy') {
    if (held < 0) return -held;
    let n = Math.floor(bp / q.price);
    while (n > 0 && n * q.price + feeOf(q, 'buy', n).total > bp) n--; // leave room for the fees
    return n;
  }
  if (held > 0) return held;
  let n = Math.floor(bp / (q.price * (SHORT_MARGIN - 1)));
  while (n > 0 && n * q.price * (SHORT_MARGIN - 1) + feeOf(q, 'sell', n).total > bp) n--;
  return n;
}

function updateTradeDialog() {
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  const qty = Number($('qty').value) || 0;
  const ccy = q.currency;
  const held = state.portfolio.positions[symbol]?.qty ?? 0;
  const avg = state.portfolio.positions[symbol]?.avgCost ?? 0;
  const closing = held !== 0 && Math.sign(held) !== (side === 'buy' ? 1 : -1) ? Math.min(qty, Math.abs(held)) : 0;
  const opening = qty - closing;

  for (const b of $('side').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.side === side);
  const label = side === 'buy' ? (held < 0 ? 'Cover' : 'Buy') : (held > 0 && opening === 0 ? 'Sell' : 'Short');
  const status = marketStatus(q.market);
  const trading = status === 'open';
  $('trade-submit').textContent = trading ? label : `Place ${label.toLowerCase()} order`;
  $('trade-submit').className = side === 'buy' ? 'primary' : 'danger';

  const facts = [
    [trading ? 'Price' : 'Last price', `${price(q.price)} ${ccy}`],
    ['You hold', held < 0 ? `${shares(-held)} short` : shares(held)],
    ['Buying power', money(buyingPower(state.portfolio, ccy), ccy)],
  ];
  if (closing) {
    const pl = (q.price - avg) * closing * Math.sign(held);
    facts.push(['Profit / loss on what you close', `<span class="${tone(pl)}">${money(pl, ccy, { sign: true })}</span>`]);
  }
  const fee = feeOf(q, side, qty);
  const breakdown = fee.parts.map((p) => `${p.label} ${p.amount.toFixed(2)}`).join(', ');
  facts.push([`Fees (${esc(myPlan().label)})`, `<span title="${esc(breakdown)}">${money(fee.total, ccy)}</span>`]);
  facts.push([`${side === 'buy' ? 'Total cost with fees' : 'You receive after fees'}${trading ? '' : ' (estimate)'}`,
    `<strong>${money(side === 'buy' ? qty * q.price + fee.total : qty * q.price - fee.total, ccy)}</strong>`]);
  $('trade-facts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const notes = [];
  if (side === 'sell' && opening > 0) {
    notes.push(`${closing ? `This sells your ${shares(closing)} and shorts` : 'This shorts'} ${shares(opening)}: you profit if the price falls and lose if it rises. A short sets aside ${SHORT_MARGIN * 100}% of its value from your buying power until you cover it.`);
  }
  if (trading) {
    if (q.time) notes.push(`Fills now at the latest price, from ${fmtDateTime(q.time)}.`);
  } else {
    notes.push(`${MARKETS[q.market].label} is ${STATUS_LABELS[status]}. Your order waits and fills at the first price after it opens, like a real broker; the actual price may differ from the last one shown. If you can't afford it by then, it's cancelled.`);
  }
  $('trade-note').textContent = notes.join(' ');
}

function submitTrade(e) {
  e.preventDefault();
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  try {
    if (marketStatus(q.market) === 'open') {
      state.portfolio = applyTrade(state.portfolio, { symbol, side, qty: $('qty').value, price: q.price, currency: q.currency, market: q.market });
    } else {
      state.portfolio = placeOrder(state.portfolio, { symbol, side, qty: $('qty').value, currency: q.currency });
      notify(`Order placed: ${side} ${shares(Number($('qty').value))} of ${symbol}. It fills at the first price after ${MARKETS[q.market].label} opens.`);
    }
    savePortfolio();
    $('trade-dialog').close();
    render();
  } catch (err) {
    $('trade-error').textContent = err.message;
  }
}

// ---------- auto-trading rules ----------

function ruleStatus(r) {
  const s = r.state;
  if (s.lastError) return `<span class="down">Last attempt skipped: ${esc(s.lastError)}</span>`;
  const fired = s.fires ? `Fired ${s.fires} time${s.fires > 1 ? 's' : ''}, last ${fmtDateTime(s.lastFiredAt * 1000)}. ` : '';
  if (!r.enabled) return `${fired}Off.`;
  if (r.when.type === 'every') return `${fired}Next due ${s.lastFiredAt ? fmtDate((s.lastFiredAt + r.when.value * 86400) * 1000) : 'at the next price'}.`;
  return `${fired}${s.armed ? 'Watching.' : 'Waiting for the condition to reset before it can fire again.'}`;
}

function renderBacktest(bt) {
  if (!bt) return '';
  if (bt.error) return `<p class="muted small">${esc(bt.error)}</p>`;
  return `<div class="backtest">
    <p class="small"><strong>Past-year test</strong> <span class="muted">(${fmtDate(bt.from)} to ${fmtDate(bt.to)})</span></p>
    <dl class="facts">
      <dt>Strategy result, after fees</dt><dd class="${tone(bt.returnPct)}"><strong>${pct(bt.returnPct)}</strong></dd>
      <dt>Buying and holding instead</dt><dd class="${tone(bt.buyHoldPct)}">${pct(bt.buyHoldPct)}</dd>
      <dt>Trades · worst drop</dt><dd>${bt.trades} · ${pct(-bt.maxDrawdown)}</dd>
    </dl>
    <div class="bt-chart"></div>
    <p class="muted small">Starts with ${money(bt.startCash, bt.currency)}${bt.startInvested ? ' fully invested (these rules only sell)' : ' in cash'}. After ${money(bt.fees ?? 0, bt.currency)} in trading fees. Uses daily closing prices, so it's an approximation. Past results don't predict future ones.</p>
  </div>`;
}

function drawBacktestCharts(root) {
  for (const el of root.querySelectorAll('[data-bt]')) {
    const bt = state.backtests[el.dataset.bt];
    const chart = el.querySelector('.bt-chart');
    if (!bt?.curve || !chart) continue;
    const from = Date.parse(bt.from), span = Date.parse(bt.to) - from;
    const step = Math.max(1, Math.floor(bt.curve.length / 120));
    const pts = [];
    bt.curve.forEach((v, i) => {
      if (i % step === 0 || i === bt.curve.length - 1) pts.push({ value: v, label: fmtDate(from + ((i + 1) / bt.curve.length) * span) });
    });
    chart.id ||= `bt-chart-${++chartSeq}`;
    drawChart(chart.id, chart, (c) => lineChart(c, pts, { ref: bt.startCash, refLabel: 'Start', fmt: (v) => money(v, bt.currency), height: 120, title: `Past-year test, ${el.dataset.btName ?? 'rule'}` }));
  }
}

function renderRules() {
  const rules = state.portfolio.rules;
  if (!rules.length) {
    $('rules').innerHTML = '<p class="empty">No rules yet. Add one with <strong>New rule</strong>, or let the AI strategist propose some.</p>';
    return;
  }
  $('rules').innerHTML = rules.map((r) => {
    const q = quote(r.symbol);
    return `<div class="rule" data-bt="${esc(r.id)}" data-bt-name="${esc(`${r.symbol} rule: ${describeRule(r, { currency: q?.currency, name: q?.name })}`)}">
      <label class="switch" title="Switch on or off"><input type="checkbox" data-toggle-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}><span></span></label>
      <div class="rule-body">
        <p class="sentence">${esc(describeRule(r, { currency: q?.currency, name: q?.name }))}</p>
        ${r.note ? `<p class="small muted">From: ${esc(r.note)}</p>` : ''}
        <p class="small muted">${ruleStatus(r)}</p>
        ${renderBacktest(state.backtests[r.id])}
      </div>
      <div class="rule-actions">
        <button class="small-btn ghost" data-edit-rule="${esc(r.id)}">Edit</button>
        <button class="small-btn ghost" data-test-rule="${esc(r.id)}">Test</button>
        <button class="small-btn ghost" data-delete-rule="${esc(r.id)}">Delete</button>
      </div>
    </div>`;
  }).join('');
  drawBacktestCharts($('rules'));
}

function saveRules(mutator) {
  state.portfolio = structuredClone(state.portfolio);
  mutator(state.portfolio.rules);
  savePortfolio();
  runAutomation();
  render();
}

const symbolOptions = (selected) => Object.entries(state.prices.quotes ?? {})
  .map(([s, q]) => `<option value="${esc(s)}" ${s === selected ? 'selected' : ''}>${esc(s)} · ${esc(q.name)}</option>`).join('');

function openRuleEditor(id = null) {
  const r = id ? state.portfolio.rules.find((x) => x.id === id) : null;
  state.editingRule = id;
  $('rule-title').textContent = r ? 'Edit rule' : 'New rule';
  $('rule-symbol').innerHTML = symbolOptions(r?.symbol ?? Object.keys(state.prices.quotes ?? {})[0]);
  $('rule-when').innerHTML = Object.entries(CONDITIONS).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join('');
  $('rule-repeat').innerHTML = Object.entries(REPEATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('rule-when').value = r?.when.type ?? 'price_below';
  $('rule-value').value = r?.when.value ?? '';
  $('rule-side').value = r?.action.side ?? 'buy';
  fillUnits(r?.action.unit);
  $('rule-amount').value = r?.action.amount || '';
  $('rule-repeat').value = r?.repeat ?? 'once';
  $('rule-enabled').checked = r?.enabled ?? true;
  $('rule-error').textContent = '';
  $('rule-test').innerHTML = '';
  if (!r) { suggestValue(); $('rule-amount').value = 100; }
  updateRuleEditor();
  $('rule-dialog').showModal();
}

function fillUnits(selected) {
  const side = $('rule-side').value;
  $('rule-unit').innerHTML = Object.entries(UNITS[side]).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('rule-unit').value = UNITS[side][selected] ? selected : Object.keys(UNITS[side])[0];
}

// Puts a sensible starting number in the value box for the chosen condition.
function suggestValue() {
  const q = quote($('rule-symbol').value);
  const type = $('rule-when').value;
  const unit = CONDITIONS[type].unit;
  $('rule-value').value = unit === 'price' ? (q ? +(q.price * (type === 'price_below' ? 0.95 : 1.05)).toFixed(2) : '')
    : unit === '%' ? 10 : type === 'every' ? 30 : 50;
}

function ruleFromEditor() {
  return newRule({
    symbol: $('rule-symbol').value,
    when: { type: $('rule-when').value, value: $('rule-value').value },
    action: { side: $('rule-side').value, unit: $('rule-unit').value, amount: $('rule-unit').value === 'all' ? 0 : $('rule-amount').value },
    repeat: $('rule-repeat').value,
    enabled: $('rule-enabled').checked,
  });
}

function updateRuleEditor() {
  const c = CONDITIONS[$('rule-when').value];
  const q = quote($('rule-symbol').value);
  $('rule-value-unit').textContent = c.unit === 'price' ? `${q?.currency ?? ''} (now ${price(q?.price)})` : c.unit;
  $('rule-amount-label').hidden = $('rule-unit').value === 'all';
  const r = ruleFromEditor();
  const errs = checkRule(r, Object.keys(state.prices.quotes ?? {}));
  $('rule-sentence').textContent = errs.length ? '' : describeRule(r, { currency: q?.currency, name: q?.name });
}

function saveRuleFromEditor(e) {
  e.preventDefault();
  const r = ruleFromEditor();
  const errs = checkRule(r, Object.keys(state.prices.quotes ?? {}));
  if (errs.length) { $('rule-error').textContent = errs.join(' '); return; }
  const old = state.portfolio.rules.find((x) => x.id === state.editingRule);
  if (old) { r.id = old.id; r.note = old.note; }
  delete state.backtests[r.id];
  saveRules((rules) => {
    const i = rules.findIndex((x) => x.id === r.id);
    if (i >= 0) rules[i] = r; else rules.push(r);
  });
  $('rule-dialog').close();
}

function testRuleInEditor() {
  const r = ruleFromEditor();
  const errs = checkRule(r, Object.keys(state.prices.quotes ?? {}));
  if (errs.length) { $('rule-error').textContent = errs.join(' '); return; }
  state.backtests.editor = backtest([r], quote(r.symbol), btOptions());
  $('rule-test').innerHTML = `<div data-bt="editor" data-bt-name="${esc(`${r.symbol} rule being edited`)}">${renderBacktest(state.backtests.editor)}</div>`;
  drawBacktestCharts($('rule-test'));
}

// ---------- AI strategist ----------

function renderStrategist() {
  const count = String(Object.keys(state.prices.quotes ?? {}).length);
  if ($('st-focus').dataset.count !== count) {
    const keep = $('st-focus').value;
    $('st-focus').innerHTML = `<option value="all">Whole watchlist</option>${symbolOptions(keep)}`;
    $('st-focus').dataset.count = count;
  }
  if (!$('st-run').disabled) $('st-status').innerHTML = state.ai.key ? '' : 'Needs your Anthropic API key. <button type="button" class="ghost small-btn" data-open-settings>Add API key</button>';
  const a = state.strategist;
  if (!a) { $('strategist').innerHTML = ''; return; }
  a.strategies.forEach((s, i) => { state.backtests[`s${i}`] ??= s.rules.length ? backtest(s.rules, quote(s.symbol), btOptions()) : null; });
  $('strategist').innerHTML = `
    <div class="analysis">
      <p class="muted small">From ${fmtDateTime(a.createdAt)} · ${esc(madeBy(a))} · about US$${a.usage.costUsd.toFixed(2)}</p>
      <p class="lead">${esc(a.summary)}</p>
      ${a.observations.length ? `<ul>${a.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      ${a.strategies.map((s, i) => {
        const q = quote(s.symbol);
        return `<article class="strategy" data-bt="s${i}" data-bt-name="${esc(`${s.title} (${s.symbol})`)}">
          <header><strong>${esc(s.title)}</strong> <span class="chip">${esc(s.style)}</span><span class="chip">${esc(s.symbol)}</span></header>
          <p>${esc(s.rationale)}</p>
          <ol class="rules-list">${s.rules.map((r) => `<li>${esc(describeRule(r, { currency: q?.currency, name: q?.name }))}</li>`).join('')}</ol>
          ${s.problems.length ? `<p class="small muted">Left out ${s.problems.length} rule${s.problems.length > 1 ? 's' : ''} the simulator can't run: ${esc(s.problems.join(' '))}</p>` : ''}
          <p class="small"><strong>Risks:</strong> ${esc(s.risks)}</p>
          ${sources(s.source_urls)}
          ${renderBacktest(state.backtests[`s${i}`])}
          ${s.rules.length ? `<div class="row"><button class="small-btn" data-adopt="${i}">Add ${s.rules.length > 1 ? 'these rules' : 'this rule'} (paused)</button></div>` : ''}
        </article>`;
      }).join('')}
      ${a.caveats ? `<p class="muted small">${esc(a.caveats)}</p>` : ''}
    </div>`;
  drawBacktestCharts($('strategist'));
}

async function runStrategist(e) {
  e.preventDefault();
  if (!state.ai.key) { openSettings(); return; }
  $('st-run').disabled = true;
  $('st-error').textContent = '';
  $('st-status').textContent = 'Claude is reading the news and a year of prices… this usually takes 1–3 minutes.';
  try {
    const { client, Anthropic } = await loadClient(state.ai.key);
    const context = buildContext({ prices: state.prices, portfolio: state.portfolio, focus: $('st-focus').value, risk: $('st-risk').value, question: $('st-question').value });
    state.strategist = await analyze({ client, Anthropic, model: state.ai.model, context, quotes: state.prices.quotes });
    trackBrowserSpend('strategist', state.strategist.usage?.costUsd);
    for (const k of Object.keys(state.backtests)) if (k.startsWith('s')) delete state.backtests[k];
    writeStore(KEYS.strategist, state.strategist);
    $('st-status').textContent = '';
  } catch (err) {
    $('st-error').textContent = err.message;
    $('st-status').textContent = '';
  } finally {
    $('st-run').disabled = false;
    render();
  }
}

function adoptStrategy(i) {
  const s = state.strategist.strategies[i];
  saveRules((rules) => {
    for (const r of s.rules) rules.push({ ...structuredClone(r), id: newRule(r).id, enabled: false, state: freshState() });
  });
  notify(`Added ${s.rules.length} paused rule${s.rules.length > 1 ? 's' : ''} from "${s.title}". Review them under Auto-trading and switch them on.`);
}

// ---------- AI fund ----------

function repoUrl() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : null;
}
const repoActionsUrl = () => repoUrl() && `${repoUrl()}/actions/workflows/prices.yml`;

// ----- AI fund: admin controls -----

const brokerLabel = (f) => {
  if (f.settings?.broker !== 'tiger') return 'Simulator (virtual money)';
  if (f.broker?.accountType === 'live') return 'Tiger LIVE account (real money)';
  if (f.broker?.accountType === 'paper') return 'Tiger paper account (simulated money)';
  return 'Tiger (not connected yet)';
};

const fundList = () => state.funds?.funds ?? [];
// The fund shown on the AI fund page: the one picked, else the first running one, else the first.
function selectedFund() {
  const list = fundList();
  return list.find((f) => f.id === state.fundId) ?? list.find((f) => !f.stoppedAt) ?? list[0] ?? null;
}
function selectFund(id) {
  state.fundId = id;
  writeStore(KEYS.fundId, id);
  fundControlsKey = null;
  render();
}

const modelOptions = (selected) => `<option value="">Default (${esc(modelName(TIERS.advanced))})</option>${Object.entries(MODELS)
  .map(([id, m]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}`;
const styleOptions = (selected) => Object.entries(STYLES).map(([id, st]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(st.label)}</option>`).join('');

// The fields both forms share: mandate, limits, shorts and model.
const mandateFields = (p, v) => `
  <label>Name <input id="${p}-name" maxlength="40" value="${esc(v.name ?? '')}" placeholder="e.g. Steady banks"></label>
  <label>Style <select id="${p}-style">${styleOptions(v.style)}</select></label>
  <label class="wide">Focus (optional) <input id="${p}-focus" maxlength="300" value="${esc(v.focus ?? '')}" placeholder="e.g. Only Singapore banks and REITs · Big US tech · Avoid airlines"></label>
  <p class="small muted wide" id="${p}-style-brief">${esc(STYLES[v.style]?.brief ?? '')}</p>
  <label>AI model <select id="${p}-model">${modelOptions(v.model)}</select></label>
  <label>Largest single order, % of budget <input id="${p}-max-order" type="number" min="1" max="100" step="1" value="${v.maxOrderPct}"></label>
  <label>Pause after losing in a day, % <input id="${p}-daily-loss" type="number" min="0.5" max="50" step="0.5" value="${v.dailyLossPct}"></label>
  <label class="check"><input type="checkbox" id="${p}-shorts" ${v.allowShorts !== false ? 'checked' : ''}> Short selling allowed</label>
  <label class="check"><input type="checkbox" id="${p}-learning" ${v.learning !== false ? 'checked' : ''}> Learns from its results (leave one fund off to compare)</label>
  <label class="check"><input type="checkbox" id="${p}-skip-quiet" ${v.skipQuiet !== false ? 'checked' : ''}> Save AI cost: skip a decision when nothing has changed</label>`;
const readMandate = (p) => ({
  name: $(`${p}-name`).value.trim(), style: $(`${p}-style`).value, focus: $(`${p}-focus`).value.trim(),
  settings: {
    model: $(`${p}-model`).value || null, maxOrderPct: numberOf(`${p}-max-order`), dailyLossPct: numberOf(`${p}-daily-loss`),
    allowShorts: $(`${p}-shorts`).checked, learning: $(`${p}-learning`).checked, skipQuiet: $(`${p}-skip-quiet`).checked,
  },
});

// Start/stop/pause buttons and settings for admins. Rebuilt only when something they show changes,
// so typing isn't lost when prices refresh.
let fundControlsKey = null;
function renderFundControls() {
  const el = $('fund-controls');
  const list = fundList();
  const f = selectedFund();
  const running = list.filter((x) => !x.stoppedAt);
  const cmd = state.fundCmd;
  const key = JSON.stringify([authEnabled, state.user?.isAdmin, state.funds === undefined, f?.id, list.map((x) => [x.id, x.name, x.style, x.focus, x.stoppedAt, x.paused?.at, x.settings]), cmd?.phase, cmd?.message]);
  if (key === fundControlsKey) return;
  fundControlsKey = key;
  el.hidden = !authEnabled || state.funds === undefined;
  if (el.hidden) return;
  if (!state.user?.isAdmin) {
    el.innerHTML = '<p class="muted small">Only admins can start, pause or stop AI funds.</p>';
    return;
  }
  const busy = cmd && ['sending', 'sent', 'accepted'].includes(cmd.phase) ? 'disabled' : '';
  const full = running.length >= MAX_ACTIVE_FUNDS;
  const startForm = full
    ? `<p class="small">${MAX_ACTIVE_FUNDS} funds are running, the most at once. Stop one to start another.</p>`
    : `<form id="fund-start-form" class="form-grid fund-form">
      ${mandateFields('new', { style: DEFAULT_STYLE, ...STYLES[DEFAULT_STYLE].defaults })}
      <label>Amount <input id="fund-amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="e.g. 10000"></label>
      <label>Currency
        <select id="fund-currency"><option value="USD">USD · trades US stocks</option><option value="SGD">SGD · trades SGX stocks</option></select>
      </label>
      <label>Decisions per trading day
        <select id="fund-decisions"><option value="1">1 (cheapest)</option><option value="2">2</option><option value="4">4</option></select>
      </label>
      <label>Trades go to
        <select id="fund-broker"><option value="simulator">Simulator (virtual money)</option><option value="tiger">Tiger Brokers account</option></select>
      </label>
      <label>Approval
        <select id="fund-approval"><option value="manual">I approve each trade</option><option value="auto">Automatic</option></select>
      </label>
      <label>Fees like
        <select id="fund-fees"><option value="tiger">Tiger Brokers</option><option value="scb">Standard Chartered</option><option value="none">No fees</option></select>
      </label>
      <p class="small muted wide">Each fund trades on its own, with its own money. With Tiger, all Tiger funds share your Tiger account (paper or live is set by the Tiger secrets on GitHub); one account can't be long and short the same stock, so a fund can't take the other side of another Tiger fund's position. Approval applies to Tiger; the simulator always trades on its own.</p>
      <div class="row"><button type="submit" class="primary" ${busy}>Start fund</button></div>
    </form>`;
  const s = f?.settings ?? {};
  const selectedControls = f ? `
    <p class="small"><strong>${esc(f.name)}</strong> · trading through <strong class="${f.broker?.accountType === 'live' ? 'down' : ''}">${esc(brokerLabel(f))}</strong>${s.broker === 'tiger' ? ` · ${s.approval === 'manual' ? 'you approve each trade' : 'automatic'}` : ''}</p>
    <div class="row">
      ${f.stoppedAt
        ? `<button type="button" class="ghost" data-fund-cmd="remove" ${busy}>Remove this fund from the list</button>`
        : `${f.paused
          ? `<button type="button" class="primary" data-fund-cmd="resume" ${busy}>Resume trading</button>`
          : `<button type="button" class="danger" data-fund-cmd="pause" ${busy}>Pause this fund</button>`}
        <button type="button" class="ghost" data-fund-stop ${busy}>Stop fund and close positions</button>`}
      ${running.length > 1 ? `<button type="button" class="danger" data-fund-cmd="pause-all" ${busy}>Pause all funds</button>` : ''}
    </div>
    ${f.stoppedAt ? '' : `<details class="fund-new"><summary>Mandate, approval and limits</summary>
      <form id="fund-settings-form" class="form-grid fund-form">
        ${mandateFields('set', { name: f.name, style: f.style, focus: f.focus, model: s.model, maxOrderPct: s.maxOrderPct ?? 25, dailyLossPct: s.dailyLossPct ?? 5, allowShorts: s.allowShorts, learning: s.learning, skipQuiet: s.skipQuiet })}
        <label>Approval
          <select id="set-approval"><option value="manual" ${s.approval === 'manual' ? 'selected' : ''}>I approve each trade</option><option value="auto" ${s.approval === 'auto' ? 'selected' : ''}>Automatic</option></select>
        </label>
        <p class="small muted wide">Changing the style changes the AI's brief from its next decision. It doesn't change the limits above by itself.</p>
        <div class="row"><button type="submit" class="primary" ${busy}>Save</button></div>
      </form>
    </details>`}` : '';
  // Keep open sections open when the controls are redrawn.
  const wasOpen = new Set([...el.querySelectorAll('details[open] > summary')].map((x) => x.textContent));
  el.innerHTML = `
    <div class="panel-head"><h2>${list.length ? 'Control the AI funds' : 'Start an AI fund'}</h2></div>
    ${selectedControls}
    ${list.length ? `<details class="fund-new"><summary>Start another fund</summary>${startForm}</details>` : startForm}
    ${cmd?.message ? `<p class="small ${cmd.phase === 'failed' ? 'down' : 'muted'}" role="status">${esc(cmd.message)}</p>` : ''}`;
  for (const d of el.querySelectorAll('details')) if (wasOpen.has(d.querySelector('summary')?.textContent)) d.open = true;
  const brokerSel = $('fund-broker');
  if (brokerSel) {
    const sync = () => {
      const tiger = brokerSel.value === 'tiger';
      $('fund-approval').disabled = !tiger;
      $('fund-fees').disabled = tiger;
      if (tiger) $('fund-fees').value = 'tiger';
    };
    brokerSel.addEventListener('change', sync);
    sync();
  }
  // Picking a style for a new fund fills in that style's limits; for a running fund it only shows the brief.
  for (const p of ['new', 'set']) {
    const sel = $(`${p}-style`);
    if (!sel) continue;
    sel.addEventListener('change', () => {
      const st = STYLES[sel.value];
      $(`${p}-style-brief`).textContent = st.brief;
      if (p === 'new') {
        $('new-max-order').value = st.defaults.maxOrderPct;
        $('new-daily-loss').value = st.defaults.dailyLossPct;
        $('new-shorts').checked = st.defaults.allowShorts;
      }
    });
  }
}

const COMMAND_TEXT = {
  start: ['Starting the fund', 'The fund is running. Its first decision comes 15 minutes after its market opens.'],
  stop: ['Stopping the fund', 'The fund is stopped and its positions are being closed.'],
  pause: ['Pausing', 'Paused. No new trades are made and open orders are cancelled; stop-losses still work.'],
  resume: ['Resuming the fund', 'The fund is trading again.'],
  settings: ['Saving', 'Saved.'],
  remove: ['Removing the fund', 'Removed.'],
  approve: ['Sending approved trades', 'Done.'],
  reject: ['Rejecting', 'Rejected.'],
};

async function submitFundCommand(action, fields = {}) {
  const [what] = COMMAND_TEXT[action];
  state.fundCmd = { phase: 'sending', action, message: `${what}: sending the request…` };
  render();
  try {
    const row = await sendFundCommand({ action, ...fields });
    state.fundCmd = { id: row.id, action, fund: fields.payload?.fund ?? null, ids: fields.payload?.ids, createdAt: row.created_at, phase: 'sent', message: `${what}: asking GitHub to run it…` };
  } catch (err) {
    state.fundCmd = { phase: 'failed', action, message: err.message };
  }
  render();
  if (state.fundCmd.id) watchFundCommand(state.fundCmd);
}

// Whether the funds (as last loaded) show that a command has been carried out.
function commandDone(cmd, c) {
  const since = Date.parse(cmd.createdAt);
  const handled = c?.lastCommand && Date.parse(c.lastCommand.time) >= since;
  const f = (c?.funds ?? []).find((x) => x.id === cmd.fund);
  const targets = cmd.fund === 'all' ? (c?.funds ?? []).filter((x) => !x.stoppedAt) : f ? [f] : [];
  switch (cmd.action) {
    case 'start': return handled && c.lastCommand.action === 'start';
    case 'stop': return Boolean(f?.stoppedAt && Date.parse(f.stoppedAt) >= since) || (handled && !c.lastCommand.ok);
    case 'pause': return (targets.length && targets.every((x) => x.paused)) || (handled && !c.lastCommand.ok);
    case 'resume': return (targets.length && targets.every((x) => !x.paused)) || (handled && !c.lastCommand.ok);
    case 'remove': return !f || (handled && !c.lastCommand.ok);
    default: return handled;
  }
}

// Follows a request until GitHub accepts it and the funds show the change (usually 3-5 minutes).
async function watchFundCommand(cmd) {
  const [what, doneText] = COMMAND_TEXT[cmd.action];
  const started = Date.now();
  while (state.fundCmd === cmd && Date.now() - started < 20 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, cmd.phase === 'sent' ? 4000 : 20000));
    try {
      if (cmd.phase === 'sent') {
        const st = await fundCommandStatus(cmd.id);
        if (st.state === 'failed') {
          cmd.phase = 'failed';
          cmd.message = `GitHub didn't accept the request (${st.status ?? 'no response'}${st.detail ? `: ${st.detail}` : ''}). Check the GitHub token in Supabase Vault.`;
        } else if (st.state === 'accepted') {
          cmd.phase = 'accepted';
          cmd.message = `${what}: GitHub is running it now. This page updates by itself in about 3–5 minutes.`;
        }
      } else {
        await loadSideData();
        if (commandDone(cmd, state.funds)) {
          const lc = state.funds?.lastCommand;
          const own = lc && Date.parse(lc.time) >= Date.parse(cmd.createdAt);
          cmd.phase = own && !lc.ok ? 'failed' : 'done';
          cmd.message = own && lc.message ? lc.message : doneText;
          if (cmd.action === 'start' && own && lc.ok && lc.fund) selectFund(lc.fund); // show the new fund
        }
      }
    } catch (err) {
      console.warn('Checking the fund request failed', err);
    }
    if (currentView() === 'fund') render();
    if (['done', 'failed'].includes(cmd.phase)) return;
  }
  if (state.fundCmd === cmd && cmd.phase !== 'done') {
    cmd.phase = 'failed';
    cmd.message = 'No change after 20 minutes. Check the latest run on GitHub (Actions tab) for errors.';
    render();
  }
}

const numberOf = (id) => Number($(id).value);

document.addEventListener('submit', (e) => {
  if (e.target.id === 'fund-start-form') {
    e.preventDefault();
    const amount = Math.round(numberOf('fund-amount') * 100) / 100;
    const currency = $('fund-currency').value;
    const decisionsPerDay = numberOf('fund-decisions');
    const broker = $('fund-broker').value;
    const m = readMandate('new');
    const settings = { ...m.settings, broker, approval: $('fund-approval').value, feePlan: $('fund-fees').value };
    if (!(amount > 0)) return;
    const where = broker === 'tiger' ? `through your Tiger account (${settings.approval === 'manual' ? 'you approve each trade' : 'automatically'})` : 'in the simulator';
    const label = m.name ? `"${m.name}"` : 'a new AI fund';
    if (!confirm(`Start ${label} (${STYLES[m.style].label}) with ${money(amount, currency)}, trading ${where}, deciding ${decisionsPerDay} time${decisionsPerDay > 1 ? 's' : ''} a trading day? Funds already running keep going.`)) return;
    submitFundCommand('start', { amount, currency, decisionsPerDay, payload: { name: m.name, style: m.style, focus: m.focus, settings } });
  }
  if (e.target.id === 'lesson-form') {
    e.preventDefault();
    const text = $('lesson-text').value.trim();
    if (text) submitFundCommand('settings', { payload: { fund: e.target.dataset.fund, playbook: { add: text } } });
  }
  if (e.target.id === 'fund-settings-form') {
    e.preventDefault();
    const m = readMandate('set');
    submitFundCommand('settings', { payload: { fund: selectedFund()?.id, name: m.name, style: m.style, focus: m.focus, settings: { ...m.settings, approval: $('set-approval').value } } });
  }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-fund-stop], [data-fund-cmd], [data-proposal], [data-fund-select], [data-lesson-remove], [data-lesson-restore]');
  if (!t) return;
  const f = selectedFund();
  if (t.dataset.lessonRemove) {
    if (confirm('Remove this lesson? The AI stops seeing it. You can restore it later.')) submitFundCommand('settings', { payload: { fund: f.id, playbook: { remove: t.dataset.lessonRemove } } });
  } else if (t.dataset.lessonRestore) {
    submitFundCommand('settings', { payload: { fund: f.id, playbook: { restore: t.dataset.lessonRestore } } });
  } else if (t.matches('[data-fund-select]')) {
    selectFund(t.dataset.fundSelect);
  } else if (t.matches('[data-fund-stop]')) {
    const tiger = f?.settings?.broker === 'tiger';
    if (confirm(`Stop "${f.name}"? ${tiger ? 'It sends orders to Tiger to close every position' : 'It sells and covers everything at the latest prices'} and stops trading. Other funds keep going.`)) submitFundCommand('stop', { payload: { fund: f.id } });
  } else if (t.dataset.fundCmd === 'pause') {
    if (confirm(`Pause "${f.name}"? It makes no new trades and its open orders are cancelled. Stop-losses keep working.`)) submitFundCommand('pause', { payload: { fund: f.id } });
  } else if (t.dataset.fundCmd === 'pause-all') {
    if (confirm('Pause ALL funds? None makes new trades and their open orders are cancelled. Stop-losses keep working.')) submitFundCommand('pause', { payload: { fund: 'all' } });
  } else if (t.dataset.fundCmd === 'resume') {
    submitFundCommand('resume', { payload: { fund: f.id } });
  } else if (t.dataset.fundCmd === 'remove') {
    if (confirm(`Remove "${f.name}" from the list? A one-line summary of its result is kept.`)) submitFundCommand('remove', { payload: { fund: f.id } });
  } else if (t.dataset.proposal) {
    const [verb, ids] = [t.dataset.proposal, t.dataset.ids.split(',')];
    const list = (f?.proposals ?? []).filter((p) => ids.includes(p.id));
    const text = list.map((p) => `${p.action} ${p.shares} ${p.symbol} (limit ${price(p.limitPrice)})`).join(', ');
    if (verb === 'approve' && !confirm(`Send to Tiger: ${text}?`)) return;
    submitFundCommand(verb, { payload: { ids, fund: f?.id } });
  }
});

// ----- AI fund: page -----

const ORDER_STATUS = {
  queued: 'waiting to send', sent: 'at Tiger, not filled yet', partial: 'partly filled', filled: 'filled',
  cancelled: 'cancelled', rejected: 'rejected by Tiger', failed: 'not sent',
};

function renderProposals(f) {
  const waiting = (f.proposals ?? []).filter((p) => p.status === 'awaiting');
  const admin = state.user?.isAdmin || !authEnabled;
  const busy = state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '';
  if (!waiting.length) return '';
  return `<section class="panel approvals">
    <div class="panel-head"><h2>Waiting for your approval</h2>
      ${admin && authEnabled && waiting.length > 1 ? `<button class="primary small-btn" data-proposal="approve" data-ids="${waiting.map((p) => p.id).join(',')}" ${busy}>Approve all</button>` : ''}</div>
    <p class="small muted">Each is a limit order: it can't fill at a worse price than shown. A proposal expires after an hour, or if the price moves more than 2% before you approve.</p>
    <ul class="orders">${waiting.map((p) => `<li>
      <span class="chip ${p.action === 'buy' || p.action === 'cover' ? 'buy' : 'sell'}">${esc(p.action)}</span>
      ${Number(p.shares).toLocaleString()} <strong>${esc(p.symbol)}</strong> · limit ${price(p.limitPrice)} ${esc(f.currency)} (≈ ${money(p.shares * p.limitPrice, f.currency)})
      <span class="muted small">${esc(p.reason)} · expires ${fmtDateTime(p.expiresAt)}</span>
      ${admin && authEnabled ? `<span class="row"><button class="small-btn primary" data-proposal="approve" data-ids="${esc(p.id)}" ${busy}>Approve</button>
        <button class="small-btn ghost" data-proposal="reject" data-ids="${esc(p.id)}" ${busy}>Reject</button></span>` : ''}
    </li>`).join('')}</ul>
  </section>`;
}

const ORDER_SOURCE = { decision: 'AI decision', approved: 'AI decision', protection: 'stop-loss / take-profit', guard: 'stop-loss held by Tiger', stop: 'fund stopped' };

function renderBrokerOrders(f) {
  const orders = (f.brokerOrders ?? []).slice().reverse().slice(0, 30);
  if (!orders.length) return '';
  const guards = (f.brokerOrders ?? []).filter((o) => o.source === 'guard' && ['sent', 'partial'].includes(o.status) && !o.cancelRequested);
  return `<section class="panel">
    <div class="panel-head"><h2>Tiger orders</h2></div>
    ${guards.length ? `<p class="small">Standing stop-loss orders at Tiger (they trigger even if this app's scheduled job is late):
      ${guards.map((o) => `<strong>${esc(o.symbol)}</strong> ${o.side === 'sell' ? 'sells' : 'buys back'} ${Number(o.qty).toLocaleString()} if the price ${o.side === 'sell' ? 'falls to' : 'rises to'} ${price(o.stopPrice)}`).join('; ')}.</p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Placed</th><th>Order</th><th class="num">Limit / stop</th><th>Status</th><th class="num hide-sm">Filled</th></tr></thead>
      <tbody>${orders.map((o) => `<tr>
        <td>${fmtDateTime(o.createdAt)}<br><span class="muted small">${esc(ORDER_SOURCE[o.source] ?? o.source)}</span></td>
        <td><span class="chip ${o.side === 'buy' ? 'buy' : 'sell'}">${esc(o.action)}</span> ${Number(o.qty).toLocaleString()} ${esc(o.symbol)}${o.note && o.status === 'queued' ? `<br><span class="muted small">${esc(o.note)}</span>` : ''}</td>
        <td class="num">${o.type === 'stop' ? `stop ${price(o.stopPrice)}` : price(o.limitPrice)}</td>
        <td class="${['rejected', 'failed'].includes(o.status) ? 'down' : ''}">${esc(ORDER_STATUS[o.status] ?? o.status)}${o.cancelRequested && ['queued', 'sent', 'partial'].includes(o.status) ? ' · cancelling' : ''}
          ${o.error ? `<br><span class="small">${esc(o.error)}</span>` : ''}</td>
        <td class="num hide-sm">${o.filledQty ? `${o.filledQty} at ${price(o.avgFillPrice)}` : '–'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

// ----- AI fund: what it has learned -----

const LESSON_SOURCE = { results: 'from its results', 'weekly review': 'weekly review', owner: 'added by you', 'market memory': 'market memory' };
const moveCell = (h) => (h ? `<span class="${tone(h.move)}">${pct(h.move)}</span>${h.index != null ? ` <span class="muted small">(${pct(h.move - h.index)} vs index)</span>` : ''}` : '<span class="muted small">not yet</span>');
const rate = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
// What "the price went the idea's way" means for each kind of outcome.
const hitPhrase = (outcome) => (outcome === 'traded' ? 'went its way' : ['exit', 'stop-loss', 'take-profit'].includes(outcome) ? 'kept going after' : 'would have gone its way');

function renderLearning(f, c) {
  const pb = f.playbook;
  const on = f.settings?.learning !== false;
  const admin = authEnabled && state.user?.isAdmin;
  const market = marketForCurrency(f.currency);
  const memory = c.marketMemory?.[market];
  const hidden = new Set(pb?.hidden ?? []);
  const lessons = activeLessons(pb);
  const marketLessons = (memory?.lessons ?? []).filter((l) => !hidden.has(l.id));
  const lessonItem = (l) => `<li><strong>${esc(l.text)}</strong><span class="chip">${esc(LESSON_SOURCE[l.source] ?? l.source)}</span>
    ${l.evidence ? `<br><span class="muted small">${esc(l.evidence)}</span>` : ''}
    ${admin ? ` <button type="button" class="ghost small-btn" data-lesson-remove="${esc(l.id)}">Remove</button>` : ''}</li>`;
  const outcomes = Object.entries(pb?.stats?.byOutcome ?? {}).filter(([, v]) => v.week);
  const known = new Map([...(pb?.lessons ?? []), ...(pb?.review ?? []), ...(memory?.lessons ?? [])].map((l) => [l.id, l.text]));
  const hiddenList = [...hidden].filter((id) => known.has(id));
  return `<section class="panel">
    <div class="panel-head"><h2>What it has learned</h2><span class="chip">${on ? 'learning on' : 'learning off (for comparison)'}</span></div>
    <p class="small muted">Every idea is graded against what prices did afterwards: trades it made, trades you declined or its limits blocked, ideas it passed on, and its exits and stop-losses.
      ${on ? 'These lessons are shown to the AI at every decision.' : 'This fund doesn\'t use them, so it shows whether learning helps.'}
      ${pb ? `${pb.graded} idea${pb.graded === 1 ? '' : 's'} graded so far${pb.reviewedAt ? `; last weekly review ${fmtDate(pb.reviewedAt)}` : ''}. Lessons need at least ${MIN_CASES} cases; the weekly review needs ${REVIEW_MIN_NEW} newly graded ideas.` : ''}</p>
    ${lessons.length ? `<ul class="lessons">${lessons.map(lessonItem).join('')}</ul>` : `<p class="muted">No lessons yet: ideas are graded once a week of trading has passed, and a lesson needs ${MIN_CASES} similar cases.</p>`}
    ${admin ? `<form id="lesson-form" class="row lesson-form" data-fund="${esc(f.id)}"><input id="lesson-text" maxlength="300" placeholder="Add your own lesson, e.g. Avoid airlines before their results"><button type="submit" class="ghost small-btn">Add</button></form>` : ''}
    ${hiddenList.length && admin ? `<p class="small muted">Removed lessons: ${hiddenList.map((id) => `<button type="button" class="ghost small-btn" data-lesson-restore="${esc(id)}" title="${esc(known.get(id))}">Restore: ${esc(known.get(id).slice(0, 50))}${known.get(id).length > 50 ? '…' : ''}</button>`).join(' ')}</p>` : ''}
    ${outcomes.length ? chartSlot((el) => hbars(el, outcomes.map(([k, v]) => {
        const x = v.week.avgExcess ?? v.week.avgMove;
        return {
          label: OUTCOME_LABELS[k] ?? k, sub: `${plural(v.week.n, 'case')} · ${rate(v.week.hitRate)} ${hitPhrase(k)}`, value: x * 100, display: pct(x),
          tip: [{ value: pct(x), label: v.week.avgExcess != null ? 'vs the index, a week later' : 'a week later' }, { value: pct(v.week.avgMove), label: 'price move in its direction' }, { value: rate(v.week.hitRate), label: `${hitPhrase(k)}, of ${v.week.n}` }],
        };
      }), { tickFmt: pctTick, ariaLabel: 'How its ideas did' }), {
        title: 'Its ideas, a week later',
        caption: 'The average move a week later in each idea\'s direction, against the index. Right of 0 is good for trades it made; for ideas it didn\'t act on, it means it missed a gain; for exits and stop-losses, that the price kept going the position\'s way, so the exit was early.',
        table: tableToggle(['Ideas', 'Cases', 'Went its way', 'Average', 'vs index'], outcomes.map(([k, v]) => [OUTCOME_LABELS[k] ?? k, String(v.week.n), rate(v.week.hitRate), pct(v.week.avgMove), v.week.avgExcess == null ? '–' : pct(v.week.avgExcess)])),
      }) : ''}
    ${pb?.recent?.length ? `<details class="fund-new"><summary>Latest graded ideas</summary><ul class="orders">${pb.recent.slice(0, 15).map((g) => `<li>${fmtDate(g.time)}:
      <span class="chip ${g.action === 'buy' || g.action === 'cover' ? 'buy' : 'sell'}">${esc(g.action)}</span> ${esc(g.symbol)} <span class="muted small">(${esc(OUTCOME_LABELS[g.outcome] ?? g.outcome)}, ${esc(IDEA_LABELS[g.ideaType] ?? g.ideaType)})</span>
      · a week later ${moveCell(g.week)} · a month later ${moveCell(g.month)}${g.reason ? `<br><span class="muted small">${esc(g.reason)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>${esc(MARKETS[market].label)} market memory</h2></div>
    <p class="small muted">How ${esc(MARKETS[market].label)} stocks have moved after company news and after big one-day moves over the past year, measured from prices (not the AI's opinion). Every fund trading ${esc(MARKETS[market].label)} stocks sees these.
      ${memory ? `${memory.events} news event${memory.events === 1 ? '' : 's'} and ${memory.bigMoves} big moves measured.` : ''}</p>
    ${marketLessons.length ? `<ul class="lessons">${marketLessons.map(lessonItem).join('')}</ul>` : '<p class="muted small">No clear patterns yet.</p>'}
    ${memory ? (() => {
      const cases = [['bigUp', 'After a 4%+ jump'], ['bigDown', 'After a 4%+ drop'], ['positive', 'After good news'], ['negative', 'After bad news']]
        .filter(([k]) => memory.stats[k]?.vsIndex != null).map(([k, label]) => ({ k, label, st: memory.stats[k] }));
      const shown = cases.filter(({ st }) => st.n >= MEMORY_MIN_CASES);
      const note = shown.length < cases.length ? ` Rows with fewer than ${MEMORY_MIN_CASES} cases are only in the Table.` : '';
      return cases.length ? chartSlot((el) => (shown.length ? hbars(el, shown.map(({ label, st }) => ({
        label, sub: `${plural(st.n, 'case')} · ${rate(st.continued)} kept going`, value: st.vsIndex * 100, display: pct(st.vsIndex),
        tip: [{ value: pct(st.vsIndex), label: 'next week vs the index, in the move\'s direction' }, { value: rate(st.continued), label: `kept going, of ${st.n}` }],
      })), { tickFmt: pctTick, ariaLabel: 'Market memory' }) : (el.innerHTML = '<p class="muted small">Not enough cases for a chart yet.</p>')), {
        title: 'The following week',
        caption: `Right of 0 (+): the move tended to keep going the same way, against the index. Left (−): it tended to reverse.${note}`,
        table: tableToggle(['After', 'Cases', 'Kept going', 'Next week vs index'], cases.map(({ label, st }) => [label, String(st.n), rate(st.continued), pct(st.vsIndex)])),
      }) : '';
    })() : ''}
    ${memory?.recent?.length ? `<details class="fund-new"><summary>Latest news measured</summary><ul class="orders">${memory.recent.slice(0, 15).map((e) => `<li>${esc(e.date)} <strong>${esc(e.symbol)}</strong> ${esc(e.headline)}
      <span class="muted small">(${esc(e.tone)} ${esc(e.type)})</span> · on the day ${e.day ? `<span class="${tone(e.day.move)}">${pct(e.day.move)}</span>` : '–'} · next week ${moveCell(e.week)}</li>`).join('')}</ul>
      <p class="muted small">Moves are shown in the direction of the news: + means the price went the way the news pointed.</p></details>` : ''}
    ${!memory?.events ? `<p class="small">To fill this in from the past year's news (one-off, about US$1–2), run ${repoActionsUrl() ? `<a href="${repoActionsUrl()}" target="_blank" rel="noopener">Actions → Update prices, AI picks and AI fund</a>` : 'Actions → Update prices, AI picks and AI fund'} → Run workflow with <em>Learning: look up the past year of news</em> ticked. New news is added every day by itself.</p>` : ''}
  </section>`;
}

// What the scheduled AI cost, month by month and by job, against the monthly cap.
const SPEND_SERIES = [
  { key: 'picks', label: 'AI picks', color: SERIES[0] }, { key: 'fund', label: 'AI fund decisions', color: SERIES[1] },
  { key: 'learning', label: 'Weekly reviews', color: SERIES[2] }, { key: 'backfill', label: 'News backfill', color: SERIES[3] },
];
function renderSpend() {
  const months = Object.entries(state.spend?.months ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  if (!months.length) return '';
  const monthName = (ym, opts = { month: 'short', year: 'numeric' }) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  const series = SPEND_SERIES.filter((s) => months.some(([, v]) => v[s.key] > 0));
  const usd = (v) => `US$${v.toFixed(2)}`;
  const cap = state.spend?.cap;
  const table = tableToggle(['Month', 'Total', ...series.map((x) => x.label)], months.map(([ym, v]) => [monthName(ym, { month: 'long', year: 'numeric' }), usd(v.total ?? 0), ...series.map((x) => usd(v[x.key] ?? 0))]).reverse());
  const about = 'Estimated cost of the scheduled AI (picks, AI fund decisions, weekly reviews and the news backfill). What you run in this browser with your own key isn\'t included.';
  let chart;
  if (months.length < 2) {
    // One month: how much of the cap is used, by job.
    const [ym, v] = months[0];
    const total = v.total ?? series.reduce((s, x) => s + (v[x.key] ?? 0), 0);
    const segs = series.map((x) => ({ label: x.label, value: v[x.key] ?? 0, color: x.color, display: usd(v[x.key] ?? 0) }));
    if (cap > total) segs.push({ label: 'Left before the cap', value: cap - total, color: TRACK, display: usd(cap - total), track: true });
    const over = cap && total > cap;
    chart = chartSlot((el) => stackBar(el, segs, { shares: false, ariaLabel: 'AI spend this month', mark: over ? cap : null, markLabel: `US$${cap} cap` }), {
      title: `${usd(total)}${cap ? ` of the US$${cap} cap` : ''} in ${monthName(ym, { month: 'long', year: 'numeric' })}${over ? `, ${usd(total - cap)} over` : ''}`, caption: about, table, key: 'spend',
    });
  } else {
    let year = null;
    const groups = months.map(([ym, v]) => {
      const y = ym.slice(0, 4), axis = y !== year ? monthName(ym) : monthName(ym, { month: 'short' });
      year = y;
      return { label: monthName(ym, { month: 'long', year: 'numeric' }), axis, axisLong: monthName(ym), values: v };
    });
    chart = chartSlot((el) => columns(el, groups, series, { ref: cap || null, refLabel: cap ? `cap ${cap}` : '', fmt: usd, ariaLabel: 'AI spend by month' }), {
      caption: `${about} Amounts in US$${cap ? `, against the US$${cap} monthly cap` : ''}.`, table, key: 'spend',
    });
  }
  return `<section class="panel">
    <div class="panel-head"><h2>AI spend by month</h2></div>
    ${chart}
  </section>`;
}

// The funds side by side, best first: return, against the index, and after the AI's cost.
function renderLeaderboard(c, selected) {
  const quotes = state.prices.quotes ?? {};
  const fx = state.prices.fx?.USDSGD;
  const rows = c.funds.map((f) => {
    const a = summarize(f.portfolio, quotes).accounts[f.currency];
    const bench = benchmarkFor({ currency: f.currency, amount: f.budget, since: f.startedAt, quotes, plan: planFor(f.settings?.feePlan ?? 'tiger') });
    const costUsd = fundAiCost(f);
    const cost = f.currency === 'USD' ? costUsd : fx ? costUsd * fx : 0;
    return { f, a, bench, afterCost: (a.net - cost) / f.budget };
  }).sort((x, y) => Number(Boolean(x.f.stoppedAt)) - Number(Boolean(y.f.stoppedAt)) || y.afterCost - x.afterCost);
  const status = (f) => (f.stoppedAt ? 'stopped' : f.paused ? 'paused' : 'running');
  const bars = rows.map(({ f, a, bench, afterCost }) => ({
    label: f.name, sub: `${STYLES[f.style]?.label ?? ''} · ${f.currency}`, value: a.netPct * 100, display: pct(a.netPct),
    marker: bench ? bench.pct * 100 : null,
    tip: [
      { value: pct(a.netPct), label: `${f.name} return` },
      ...(bench ? [{ value: pct(bench.pct), label: `${bench.label}, same money` }] : []),
      { value: pct(afterCost), label: 'after AI cost' },
    ],
  }));
  return `<section class="panel">
    <div class="panel-head"><h2>${c.funds.length > 1 ? 'Your AI funds, best first' : 'Your AI fund'}</h2></div>
    ${chartSlot((el) => hbars(el, bars, { signColors: true, markerLabel: 'Its index, same money and time', tickFmt: pctTick, ariaLabel: 'Fund returns' }),
      { caption: `Each bar is a fund's return since it started.${rows.some((r) => r.bench) ? ` The short upright tick is what the same money made in its index (${esc(BENCHMARKS.USD.label)} for USD funds, ${esc(BENCHMARKS.SGD.label)} for SGD) over the same time.` : ''}`, key: 'leaderboard' })}
    <div class="table-wrap"><table class="leaderboard">
      <thead><tr><th>Fund</th><th class="num">Value</th><th class="num">Return</th><th class="num">vs index</th><th class="num hide-sm">After AI cost</th><th class="hide-sm">Status</th></tr></thead>
      <tbody>${rows.map(({ f, a, bench, afterCost }) => `<tr data-fund-select="${esc(f.id)}" class="${f.id === selected?.id ? 'selected' : ''}" tabindex="0">
        <td><strong>${esc(f.name)}</strong><span class="chip">${esc(STYLES[f.style]?.label ?? f.style)}</span>
          <span class="name">${esc(f.currency)} · ${f.settings?.broker === 'tiger' ? 'Tiger' : 'simulator'}${f.settings?.model ? ` · ${esc(modelName(f.settings.model))}` : ''}${f.settings?.learning === false ? ' · not learning' : ''}${f.focus ? ` · ${esc(f.focus)}` : ''}</span></td>
        <td class="num">${money(a.equity, f.currency)}</td>
        <td class="num ${tone(a.netPct)}">${pct(a.netPct)}</td>
        <td class="num ${bench ? tone(a.netPct - bench.pct) : ''}">${bench ? `${a.netPct - bench.pct >= 0 ? '+' : '−'}${Math.abs((a.netPct - bench.pct) * 100).toFixed(2)} pts` : '–'}</td>
        <td class="num hide-sm ${tone(afterCost)}">${pct(afterCost)}</td>
        <td class="hide-sm small">${status(f)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">${c.funds.length > 1 ? 'Tap a fund to see it below. ' : ''}"vs index" is the fund's return minus what the same money made in ${esc(BENCHMARKS.USD.label)} or ${esc(BENCHMARKS.SGD.label)} since it started, after fees.
      ${c.archived?.length ? `Removed earlier: ${c.archived.slice(-5).map((x) => `${esc(x.name)} ${pct((x.finalValue ?? x.budget) / x.budget - 1)}`).join(', ')}.` : ''}</p>
  </section>`;
}

// The fund's value over time against its budget and the same money in the index.
function fundValueChart(f, bench, quotes) {
  const hist = f.history ?? [];
  const idx = bench && !bench.partial ? benchmarkSeries(bench, quotes[bench.symbol], hist.map(([t]) => t)) : [];
  const compareLabel = idx.some((v) => v != null) ? `${bench.label}, same money` : '';
  const pts = hist.map(([t, v], i) => ({ label: fmtDateTime(t), axis: fmtDate(t), value: v, compare: idx[i] ?? null }));
  const fmt = (v) => money(v, f.currency);
  return chartSlot((el) => lineChart(el, pts, { ref: f.budget, refLabel: 'Budget', fmt, compareLabel, title: `${f.name ?? 'AI fund'} value` }), {
    key: `fund-value-${f.id}`,
    table: pts.length < 2 ? '' : tableToggle(['When', 'Value', ...(compareLabel ? [compareLabel] : [])], pts.slice().reverse().map((p) => [p.label, fmt(p.value), ...(compareLabel ? [p.compare == null ? '–' : fmt(p.compare)] : [])])),
  });
}

function renderFund() {
  const el = $('fund');
  const c = state.funds;
  const f = c === undefined ? undefined : selectedFund();
  const actions = repoActionsUrl();
  const runLink = actions
    ? `<a href="${actions}" target="_blank" rel="noopener">Actions → Update prices, AI picks and AI fund</a>`
    : '<strong>Actions → Update prices, AI picks and AI fund</strong>';
  if (f === undefined) { el.innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>'; return; }
  if (!f) {
    el.innerHTML = `<section class="panel">
      <h2>AI fund</h2>
      <p>Give Claude an amount and let it trade on its own, aiming for the biggest profit it can make, in the simulator or through your Tiger Brokers account. It runs on GitHub, so it keeps trading while this page is closed.</p>
      <p>You can run up to ${MAX_ACTIVE_FUNDS} funds at once, each with its own amount, market, style (cautious, balanced or aggressive), focus and AI model, and compare them side by side.</p>
      ${authEnabled ? '' : `<ol>
        <li>Add your Anthropic API key to the GitHub repo as a secret named <code>ANTHROPIC_API_KEY</code> (Settings → Secrets and variables → Actions).</li>
        <li>Open ${runLink}, press <strong>Run workflow</strong>, and fill in <em>Start a NEW AI fund with this amount</em>, its currency (USD trades US stocks, SGD trades SGX stocks) and how many decisions a day.</li>
        <li>Come back here in a few minutes.</li>
      </ol>`}
      <p class="small"><strong>Hard limits:</strong> the fund can only use its amount; any order costing more than its buying power, or more than the per-order limit, is rejected. It pauses itself after losing the daily limit, and shorts are closed automatically at a 40% loss.</p>
      <p class="muted small">Cost: each decision is one Claude call with web search, roughly US$0.05–0.15: Claude Haiku 4.5 reads the news and Claude Sonnet 5 decides.</p>
    </section>
    ${renderSpend()}`;
    flushCharts();
    return;
  }
  const quotes = state.prices.quotes ?? {};
  const { accounts, positions } = summarize(f.portfolio, quotes);
  const a = accounts[f.currency];
  const market = marketForCurrency(f.currency);
  const s = f.settings ?? {};
  const status = f.stoppedAt
    ? `Stopped ${fmtDateTime(f.stoppedAt)}`
    : f.paused
      ? 'Paused'
      : `Running · ${f.decisionsPerDay} decision${f.decisionsPerDay > 1 ? 's' : ''} per trading day · ${MARKETS[market].label} ${STATUS_LABELS[marketStatus(market)]}`;
  const check = c.brokerCheck ?? reconcileAll(c); // all Tiger funds against the one Tiger account
  const bench = benchmarkFor({ currency: f.currency, amount: f.budget, since: f.startedAt, quotes, plan: planFor(s.feePlan ?? 'tiger') });
  const fx = state.prices.fx?.USDSGD;
  const aiCostUsd = fundAiCost(f);
  const aiCost = f.currency === 'USD' ? aiCostUsd : fx ? aiCostUsd * fx : null; // in the fund's currency
  const cap = state.spend?.cap, month = monthSpend(state.spend);
  el.innerHTML = `
    ${renderLeaderboard(c, f)}
    ${check && !check.ok ? `<div class="notice warn fund-alert"><span><strong>Your Tiger account doesn't hold what the funds think:</strong> ${check.mismatches.map((m) => `${esc(m.symbol)}: funds ${m.fund}, Tiger ${m.tiger}`).join('; ')}. Check the Tiger app before trading further.</span></div>` : ''}
    <div class="fund-title"><h2>${esc(f.name ?? 'AI fund')}</h2><span class="chip">${esc(STYLES[f.style]?.label ?? '')}</span>
      ${f.focus ? `<span class="muted small">Focus: ${esc(f.focus)}</span>` : ''}</div>
    ${f.aiCapped ? `<div class="notice warn fund-alert"><span><strong>AI paused for the month:</strong> ${esc(f.aiCapped.message)}</span></div>` : ''}
    ${f.paused ? `<div class="notice warn fund-alert"><span><strong>Trading is paused</strong> (${fmtDateTime(f.paused.at)}): ${esc(f.paused.reason)} Stop-losses still work.</span></div>` : ''}
    ${f.broker?.error && s.broker === 'tiger' ? `<div class="notice warn fund-alert"><span><strong>Tiger:</strong> ${esc(f.broker.error)}</span></div>` : ''}
    ${renderProposals(f)}
    <section class="cards">
      <div class="card"><div class="label">${esc(f.name ?? 'AI fund')} · profit / loss</div>
        <div class="big ${tone(a.net)}">${money(a.net, f.currency, { sign: true })}</div>
        <div class="${tone(a.net)}">${pct(a.netPct)} on ${money(f.budget, f.currency)}</div></div>
      <div class="card"><div class="label">Value now</div><div class="big">${money(a.equity, f.currency)}</div>
        <div class="sub"><span>Cash</span><span>${money(a.cash, f.currency)}</span><span>Buying power</span><span>${money(a.buyingPower, f.currency)}</span>
          <span>Fees paid</span><span>${money(a.fees ?? 0, f.currency)}</span></div></div>
      <div class="card"><div class="label">Versus the index</div>
        ${bench ? `<div class="big ${tone(a.net - bench.net)}">${money(a.net - bench.net, f.currency, { sign: true })}</div>
          <div class="small">${a.net >= bench.net ? 'ahead of' : 'behind'} ${esc(bench.label)} bought with the same ${money(f.budget, f.currency)} ${bench.partial ? `on ${fmtDate(bench.since)}` : 'when the fund started'}</div>
          <div class="sub"><span>Index</span><span class="${tone(bench.pct)}">${pct(bench.pct)} (${money(bench.value, f.currency)})</span><span>AI fund</span><span class="${tone(a.netPct)}">${pct(a.netPct)}</span></div>`
          : '<p class="muted small">No index prices yet.</p>'}</div>
      <div class="card"><div class="label">AI cost (estimated)</div>
        <div class="big">US$${aiCostUsd.toFixed(2)}</div>
        <div class="small">for this fund's ${f.decisions.filter((d) => d.usage).length} decisions</div>
        <div class="sub">${aiCost != null ? `<span>Profit after AI cost</span><span class="${tone(a.net - aiCost)}">${money(a.net - aiCost, f.currency, { sign: true })}</span>` : ''}
          <span>All scheduled AI, ${new Date().toLocaleDateString(undefined, { month: 'long' })}</span><span>US$${month.toFixed(2)}${cap ? ` of US$${cap} cap` : ''}</span></div></div>
      <div class="card"><div class="label">Status</div><p>${esc(status)}</p>
        <p class="small">Trades through: <strong class="${f.broker?.accountType === 'live' ? 'down' : ''}">${esc(brokerLabel(f))}</strong>${s.broker === 'tiger' ? `<br>${s.approval === 'manual' ? 'You approve each trade' : 'Trades automatically'}` : ''}</p>
        <p class="muted small">Limits: ${s.maxOrderPct ?? 25}% of the budget per order; pauses after losing ${s.dailyLossPct ?? 5}% in a day; ${s.allowShorts === false ? 'no short selling' : 'shorts allowed'}.<br>
          Model: ${esc(modelName(s.model || TIERS.advanced))}.<br>
          Fees: ${esc(s.broker === 'tiger' ? 'what Tiger charges' : planFor(s.feePlan ?? 'tiger').label)}.<br>
          Started ${fmtDateTime(f.startedAt)}. Last decision ${f.lastDecisionAt ? ago(f.lastDecisionAt) : 'not yet'}.</p>
        ${f.lastError ? `<p class="down small">Last decision failed ${ago(f.lastError.time)}: ${esc(f.lastError.message)}</p>` : ''}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Fund value</h2></div>
      ${fundValueChart(f, bench, quotes)}
      <p class="muted small">Hard limit: the fund can only use its ${money(f.budget, f.currency)}. Orders beyond its buying power or the per-order limit are rejected, and shorts are closed automatically at a 40% loss.${s.broker === 'tiger' ? ' Values use Tiger\'s actual fill prices.' : ''}</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Positions</h2></div>
      ${positions.length ? `<div class="chart-grid">${allocationChart(positions, a.buyingPower, f.currency, 'Where the money is', f.portfolio)}${pnlChart(positions, 'Profit or loss by position')}</div>` : ''}
      <div class="table-wrap"><table>${positions.length ? `
        <thead><tr><th>Stock</th><th class="num">Shares</th><th class="num hide-sm">Avg price</th><th class="num hide-sm">Price</th><th class="num">Profit / loss</th><th class="hide-sm">Protection</th></tr></thead>
        <tbody>${positions.map((p) => {
          const pr = f.protections?.[p.symbol];
          const prot = pr ? [pr.stop_loss_pct ? `stop −${pr.stop_loss_pct}%` : '', pr.take_profit_pct ? `take +${pr.take_profit_pct}%` : ''].filter(Boolean).join(', ') : '–';
          return `<tr><td><strong>${esc(p.symbol)}</strong>${p.short ? '<span class="chip sell">short</span>' : ''}<span class="name">${esc(quotes[p.symbol]?.name ?? '')}</span></td>
          <td class="num">${p.qty.toLocaleString()}</td><td class="num hide-sm">${price(p.avgCost)}</td><td class="num hide-sm">${price(p.price)}</td>
          <td class="num ${tone(p.unrealized)}">${money(p.unrealized, p.currency, { sign: true })}<br><span class="small">${pct(p.unrealizedPct)}</span></td>
          <td class="hide-sm small">${esc(prot)}</td></tr>`;
        }).join('')}</tbody>` : '<tr><td class="empty">All in cash.</td></tr>'}</table></div>
    </section>
    ${renderBrokerOrders(f)}
    ${renderLearning(f, c)}
    <section class="panel">
      <div class="panel-head"><h2>Decisions</h2></div>
      ${f.decisions.slice().reverse().slice(0, 30).map((d) => d.skipped ? `<p class="muted small decision-skip">${fmtDateTime(d.time)}: ${esc(d.outlook)}</p>` : `<article class="decision">
        <header><strong>${fmtDateTime(d.time)}</strong>${d.usage ? ` <span class="muted small">${esc(madeBy(d))} · about US$${d.usage.costUsd.toFixed(2)}</span>` : ''}${d.learned ? ' <span class="chip">used its lessons</span>' : ''}</header>
        <p>${esc(d.outlook)}</p>
        ${d.orders.length ? `<ul class="orders">${d.orders.map((o) => `<li><span class="chip ${o.action === 'buy' || o.action === 'cover' ? 'buy' : 'sell'}">${esc(o.action)}</span>
          ${Number(o.shares).toLocaleString()} ${esc(o.symbol)}
          ${o.status === 'filled' ? `at ${price(o.price)}${o.fee ? ` <span class="muted small">+ ${money(o.fee, f.currency)} fees</span>` : ''}`
            : o.status === 'rejected' ? `<span class="down">rejected: ${esc(o.message)}</span>`
            : `<span class="muted">${esc(o.status)}${o.limitPrice ? `, limit ${price(o.limitPrice)}` : ''}</span>`}
          <span class="muted small">${esc(o.reason)}</span></li>`).join('')}</ul>` : '<p class="muted small">No trades this round.</p>'}
        ${d.considered?.length ? `<p class="small muted">Also considered: ${d.considered.map((c) => `${esc(c.stance)} ${esc(c.symbol)} (${esc(c.why_not)})`).join('; ')}.</p>` : ''}
        ${sources(d.source_urls)}
      </article>`).join('') || '<p class="muted">No decisions yet. The first one happens 15 minutes after the market opens.</p>'}
    </section>
    ${f.events.length ? `<section class="panel"><div class="panel-head"><h2>Automatic events</h2></div><ul class="orders">
      ${f.events.slice().reverse().slice(0, 20).map((e) => `<li>${fmtDateTime(e.time)}: ${['split', 'dividend'].includes(e.action) ? esc(e.why) : `${esc(e.action)} ${Number(e.shares).toLocaleString()} ${esc(e.symbol)} at ${price(e.price)} <span class="muted small">(${esc(e.why)})</span>`}</li>`).join('')}
    </ul></section>` : ''}
    ${renderSpend()}
    ${authEnabled ? '' : `<p class="muted small">To stop the fund and close its positions, or to start a new one, use ${runLink} → Run workflow.</p>`}`;
  flushCharts();
}

// ---------- settings ----------

function openSettings() {
  const a = state.portfolio.accounts;
  $('api-key').value = state.ai.key;
  $('ai-model').innerHTML = Object.entries(MODELS).map(([id, m]) => `<option value="${id}">${esc(m.label)}</option>`).join('');
  $('ai-model').value = MODELS[state.ai.model] ? state.ai.model : TIERS.advanced;
  $('start-sgd').value = a.SGD?.start ?? DEFAULT_START.SGD;
  $('start-usd').value = a.USD?.start ?? DEFAULT_START.USD;
  $('settings-started').textContent = `Current portfolio started ${fmtDate(state.portfolio.createdAt)}, ${state.portfolio.trades.length} trades.`;
  $('settings-error').textContent = '';
  const c = state.portfolio.customFees ?? { pct: { US: 0.1, SGX: 0.1 }, min: { US: 1, SGX: 1 } };
  $('fee-plan').value = state.portfolio.feePlan ?? 'tiger';
  $('fee-us-pct').value = c.pct.US; $('fee-us-min').value = c.min.US;
  $('fee-sgx-pct').value = c.pct.SGX; $('fee-sgx-min').value = c.min.SGX;
  $('fee-fx').value = c.fx ?? 0.2;
  showFeeSummary();
  renderConnections();
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
}

// What this app connects to and where each one's keys live. Keys that must stay secret (Tiger's
// private key, the key the scheduled jobs use) are GitHub secrets, never fields on this public page.
function renderConnections() {
  const repo = repoUrl();
  const secretsLink = repo ? `<a href="${repo}/settings/secrets/actions" target="_blank" rel="noopener">GitHub → Settings → Secrets and variables → Actions</a>` : 'the GitHub repo → Settings → Secrets and variables → Actions';
  const status = (ok, text) => `<span class="${ok ? 'ok' : 'off'}">${esc(text)}</span>`;
  const row = (name, badge, body) => `<li><div class="conn-head"><strong>${name}</strong>${badge}</div>${body}</li>`;
  const f = fundList().find((x) => x.settings?.broker === 'tiger' && !x.stoppedAt) ?? fundList().find((x) => x.settings?.broker === 'tiger');
  const tiger = Boolean(f);
  const tigerOk = tiger && f.broker?.accountType && !f.broker?.error;
  const picksAt = state.sitePicks?.createdAt;
  const rows = [
    row('Anthropic (AI strategist, "Refresh now" on picks)',
      status(!!state.ai.key, state.ai.key ? 'Key saved in this browser' : 'No key yet'),
      `<p class="muted small">${state.ai.key ? 'Change or remove it below.' : '<a href="#api-key-heading" data-focus-key>Add it below</a>.'} Stored only in this browser.
        Spent from this browser this month: about US$${monthSpend(state.browserSpend).toFixed(2)}.</p>`),
    row('Anthropic (scheduled AI picks and AI fund)',
      status(!!picksAt, picksAt ? `Working, last picks ${fmtDateTime(picksAt)}` : 'No AI picks yet'),
      `<p class="muted small">Uses the <code>ANTHROPIC_API_KEY</code> secret in ${secretsLink}.
        This month: about US$${monthSpend(state.spend).toFixed(2)}${state.spend?.cap ? ` of the US$${state.spend.cap} monthly cap (change it with the <code>AI_MONTHLY_CAP_USD</code> repository variable)` : ' (no monthly cap)'}.</p>`),
    row('Tiger Brokers (AI fund orders)',
      status(tigerOk, tigerOk ? brokerLabel(f) : tiger ? 'Not connected' : 'Not in use (no fund trades through Tiger)'),
      `<p class="muted small">Tiger's keys are not typed in here: anything on this page is public, and Tiger's private key must stay secret.
        Add them as secrets in ${secretsLink}: <code>TIGEROPEN_TIGER_ID</code>, <code>TIGEROPEN_ACCOUNT</code> (your paper account first),
        <code>TIGEROPEN_PRIVATE_KEY</code> and <code>TIGEROPEN_LICENSE</code> (<code>TBSG</code>). Then start the AI fund with Tiger as the broker.</p>
        ${tiger && f.broker?.error ? `<p class="small">${esc(f.broker.error)}</p>` : ''}`),
  ];
  if (authEnabled) rows.push(row('Account (Supabase)', status(!!state.user, state.user ? `Signed in as ${state.user.email}` : 'Signed out'),
    '<p class="muted small">Your portfolio syncs to your account.</p>'));
  $('connections').innerHTML = rows.join('');
}

function showFeeSummary() {
  const custom = $('fee-plan').value === 'custom';
  $('fee-custom').hidden = !custom;
  $('fee-summary').textContent = custom ? 'A percentage of each trade, with a minimum per trade, in each market.' : FEE_PLANS[$('fee-plan').value].summary;
}

// Saves the fee plan with the portfolio (so it syncs with your account too).
function saveFeeSettings() {
  const plan = $('fee-plan').value;
  const num = (id) => Math.max(0, Number($(id).value) || 0);
  state.portfolio = structuredClone(state.portfolio);
  state.portfolio.feePlan = plan;
  if (plan === 'custom') state.portfolio.customFees = { pct: { US: num('fee-us-pct'), SGX: num('fee-sgx-pct') }, min: { US: num('fee-us-min'), SGX: num('fee-sgx-min') }, fx: num('fee-fx') };
  savePortfolio();
  showFeeSummary();
}

function saveAiSettings() {
  state.ai = { key: $('api-key').value.trim(), model: $('ai-model').value || TIERS.advanced };
  writeStore(KEYS.ai, state.ai);
}

function reset() {
  const raw = [$('start-sgd').value.trim(), $('start-usd').value.trim()];
  const [sgd, usd] = raw.map((v) => Math.round(Number(v) * 100) / 100);
  if (raw.includes('') || !(sgd >= 0 && usd >= 0)) {
    $('settings-error').textContent = 'Enter a starting amount of zero or more for both SGD and USD.';
    return;
  }
  if (!confirm('Delete all holdings and trades and start over?')) return;
  const rules = state.portfolio.rules.map((r) => ({ ...r, state: freshState() }));
  const { feePlan, customFees } = state.portfolio;
  state.portfolio = { ...newPortfolio({ SGD: sgd, USD: usd }), rules, feePlan: feePlan ?? 'tiger', ...(customFees ? { customFees } : {}) };
  savePortfolio();
  $('settings-dialog').close();
  render();
}

function exportPortfolio() {
  const blob = new Blob([JSON.stringify(state.portfolio, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `paper-trader-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importPortfolio(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const p = validatePortfolio(JSON.parse(await file.text()));
    if (!confirm(`Replace your current portfolio with this one (${p.trades.length} trades, ${p.rules.length} rules)?`)) return;
    state.portfolio = p;
    savePortfolio();
    $('settings-dialog').close();
    render();
  } catch (err) {
    $('settings-error').textContent = err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message;
  }
}

// ---------- wiring ----------

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.trade) openTrade(d.trade, d.side);
  else if (d.cancelOrder) {
    if (confirm('Cancel this order?')) {
      state.portfolio = cancelOrder(state.portfolio, d.cancelOrder);
      savePortfolio();
      render();
    }
  } else if (d.editRule) openRuleEditor(d.editRule);
  else if (d.testRule) {
    const r = state.portfolio.rules.find((x) => x.id === d.testRule);
    state.backtests[r.id] = backtest([r], quote(r.symbol), btOptions());
    render();
  } else if (d.deleteRule) {
    if (confirm('Delete this rule?')) saveRules((rules) => rules.splice(rules.findIndex((x) => x.id === d.deleteRule), 1));
  } else if (d.adopt) adoptStrategy(Number(d.adopt));
});
document.addEventListener('change', (e) => {
  const id = e.target.dataset?.toggleRule;
  if (!id) return;
  // Switching a rule on starts it from now, so it never acts on prices from while it was off.
  saveRules((rules) => {
    const r = rules.find((x) => x.id === id);
    r.enabled = e.target.checked;
    if (r.enabled) r.state = { ...r.state, cursor: Math.floor(Date.now() / 1000), armed: true, lastError: null };
  });
});
window.addEventListener('hashchange', () => { $('tooltip').hidden = true; render(); });
$('market-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.marketFilter = btn.dataset.market;
  for (const b of $('market-filter').children) b.setAttribute('aria-selected', b === btn);
  renderMarkets();
});
$('side').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !state.trade) return;
  state.trade.side = btn.dataset.side;
  $('trade-error').textContent = '';
  updateTradeDialog();
});
$('qty').addEventListener('input', () => { $('trade-error').textContent = ''; updateTradeDialog(); });
$('qty-max').addEventListener('click', () => { $('qty').value = maxQty(); updateTradeDialog(); });
$('trade-form').addEventListener('submit', submitTrade);
$('trade-cancel').addEventListener('click', () => $('trade-dialog').close());

$('new-rule').addEventListener('click', () => openRuleEditor());
$('rule-form').addEventListener('submit', saveRuleFromEditor);
$('rule-form').addEventListener('input', (e) => {
  if (e.target.id === 'rule-side') fillUnits($('rule-unit').value);
  if (e.target.id === 'rule-when' || e.target.id === 'rule-symbol') suggestValue();
  $('rule-error').textContent = '';
  $('rule-test').innerHTML = '';
  updateRuleEditor();
});
$('rule-backtest').addEventListener('click', testRuleInEditor);
$('rule-cancel').addEventListener('click', () => $('rule-dialog').close());

$('strategist-form').addEventListener('submit', runStrategist);
$('picks-refresh').addEventListener('click', refreshPicks);

$('cards').addEventListener('click', (e) => { if (e.target.id === 'open-convert') openConvert(); });
document.addEventListener('keydown', (e) => {
  const row = e.target.closest?.('[data-fund-select]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFund(row.dataset.fundSelect); }
});
$('convert-form').addEventListener('submit', submitConvert);
$('convert-form').addEventListener('input', () => { $('convert-error').textContent = ''; updateConvert(); });
$('convert-cancel').addEventListener('click', () => $('convert-dialog').close());

$('open-settings').addEventListener('click', openSettings);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) { openSettings(); $('api-key').focus(); }
  if (e.target.closest('[data-focus-key]')) { e.preventDefault(); $('api-key').focus(); }
});
$('api-key').addEventListener('change', saveAiSettings);
for (const id of ['fee-plan', 'fee-us-pct', 'fee-us-min', 'fee-sgx-pct', 'fee-sgx-min', 'fee-fx']) $(id).addEventListener('change', saveFeeSettings);
$('ai-model').addEventListener('change', saveAiSettings);
$('forget-key').addEventListener('click', () => { $('api-key').value = ''; saveAiSettings(); });
$('settings-form').addEventListener('submit', () => { saveAiSettings(); render(); });
$('reset').addEventListener('click', reset);
$('export').addEventListener('click', exportPortfolio);
$('import').addEventListener('change', importPortfolio);
$('refresh').addEventListener('click', () => { loadPrices(); loadSideData(); });

// Charts size themselves to their box, so redraw them when the window changes size.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 250);
});

// Another tab traded or changed rules: pick up its changes.
window.addEventListener('storage', (e) => {
  if (e.key === portfolioKey()) { state.portfolio = loadPortfolio(); render(); }
});

$('sign-out').addEventListener('click', doSignOut);
$('open-invites').addEventListener('click', () => openInvites(state.user?.email));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshFromAccount(); });

let started = false;
function startApp() {
  if (authEnabled) $('foot').textContent = 'Virtual money only; nothing here is financial advice. Prices come from Yahoo Finance via a scheduled job and may be delayed. Your portfolio and rules are saved to your account.';
  render();
  if (started) { loadPrices(); loadSideData(); return; } // signed in again, maybe as someone else
  started = true;
  loadPrices();
  loadSideData();
  setInterval(() => { loadPrices(); loadSideData(); }, PRICE_REFRESH_MS);
}

if (authEnabled) {
  wireAuthScreen();
  wireInvites(() => state.user?.email);
  showAuth('loading');
  onAuthChange(handleAuth).catch((err) => showAuth('error', `Could not load sign-in: ${err.message}`));
} else {
  state.portfolio = loadPortfolio();
  startApp();
}
