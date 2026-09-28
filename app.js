import { newPortfolio, applyTrade, placeOrder, cancelOrder, convertCash, summarize, validatePortfolio, buyingPower, DEFAULT_START, SHORT_MARGIN } from './portfolio.js';
import { applyCorporateActions, describeAction } from './actions.js';
import { BENCHMARKS, benchmarkFor, benchmarkSeries } from './benchmark.js';
import { scorePicks, summarizeScores } from './scorecard.js';
import { addSpend, monthSpend } from './spend.js';
import { hbars, stackBar, columns, lineChart, rangeBars, sparkTrend, tableToggle, shareLabels, focusQuietly, tipOpenFor, hideTips, SERIES, OTHER, CASH, TRACK } from './charts.js';
import { valueHistory, indexHistory, realizedHistory } from './history.js';
import { MIN_CASES as MEMORY_MIN_CASES, MOVE_NEWS } from './memory.js';
import { regimeNow, regimeWords, yearLessons, studyNumbers, STUDY_LABELS, STUDY_SHORT, LONG, HOLDOUT_NOISE } from './memory-long.js';
import { CONDITIONS, UNITS, REPEATS, newRule, freshState, checkRule, describeRule, runRules, backtest, fillPendingOrders } from './rules.js';
import { MODELS, FUND_MODELS, DEEPSEEK_PEAK, TIERS, loadClient, analyze, recommend, buildContext, strategistRequest } from './ai.js';
import { MARKETS, marketForCurrency, marketDate, tradingStatus, STATUS_LABELS } from './markets.js';
import { resultsCalendar, nextResults } from './calendar.js';
import { recentRatingChanges, describeChange } from './analysts.js';
import { loadFunds, reconcileAll, STYLES, DEFAULT_STYLE, MAX_ACTIVE_FUNDS } from './funds.js';
import { ALL, fundsOverview } from './fund-views.js';
import {
  activeLessons, lessonKind, filterWords, behaviourBase, OUTCOME_LABELS, IDEA_LABELS, REVIEW_MIN_NEW, NOISE_CHECK, CAL_NOISE_CHECK, CALIBRATION,
  FILTER_KEYS, FILTER_VALUES, TRACK_LABELS, BOOK, HOLD_NOISE, DECLINE_MIN_CASES,
} from './learning.js';
import { DECLINE_REASONS, DECISION_CHOICES, EVERY_RUN } from './fund.js';
import { reportLines, reportLabel, dayWords, lessonName, weekOf, droppedWords, REPORT } from './report.js';
import { positionThesis, thesisProgress, moveWords, CATALYST_LABELS, HORIZON_LABELS, STALE_DAYS } from './thesis.js';
import { buildDossiers, picksRecord, positionRisk, exDateVsStop, exDateLate, stopLogSummary, indexName, DOSSIER } from './dossier.js';
import { GATE, confidenceOf, FUND_BETA_DAYS } from './stats.js';
import { READING, READING_NOISE, REASON_LABELS, siteName, siteRecords, latestCalls, monthResults, recordOf, soFar, gradeDay } from './reading.js';
import { FACTOR_LABELS, BUCKETS, PAGE_MIN_BETS, LAB, CASE_DAYS, COND_NOISE_CHECK, conditionWords } from './factors.js';
import { statusLabel, describeSpec, ASK } from './hypotheses.js';
import { calcFee, planFor, fxSpreadFor, FEE_PLANS } from './fees.js';
import { authEnabled, onAuthChange, signOut, myInvite, loadCloudPortfolio, saveCloudPortfolio, sendFundCommand, fundCommandStatus, loadPrivateFund } from './auth.js';
import { showAuth, hideAuth, wireAuthScreen, openInvites, wireInvites } from './login.js';

const KEYS = { portfolio: 'paper-trader:portfolio', ai: 'paper-trader:ai', picks: 'paper-trader:picks', strategist: 'paper-trader:strategist', spend: 'paper-trader:ai-spend', fundId: 'paper-trader:fund', fundTab: 'paper-trader:fund-tab', deepLink: 'paper-trader:deep-link' };
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
  company: null, // results dates and analysts' views from Yahoo (analysts.js), once a day
  filings: null, // US results releases from SEC filings (calendar.js)
  longMemory: null, // the ten-year market memory (memory-long.js), rebuilt weekly
  dossiers: null, // the stock cards' public part (dossier.js, data/dossiers.json), refreshed daily
  readingCalls: null, // the reading guide: investing sites' calls (reading.js, data/reading-calls.json), read once a day
  readingDraft: null, // an article being logged ("Log an article"): { url, text }, kept while the page re-renders
  askDraft: null, // a question being written (Ask the data), kept while the page re-renders
  stockView: null, // the stock whose notes are open: { symbol, fundId }
  noteDraft: null, // the owner's note being written in it: { symbol, text }
  noteCmd: null, // the stock whose note the latest command saves or clears
  browserSpend: readStore(KEYS.spend), // what this browser spent with your own key
  localPicks: readStore(KEYS.picks),
  strategist: readStore(KEYS.strategist),
  funds: undefined, // the AI funds (funds.js): undefined = not loaded yet, null = none
  fundId: readStore(KEYS.fundId), // the fund shown on the AI fund page, or ALL for all funds combined
  fundTab: readSession(KEYS.fundTab) ?? 'overview', // the fund's sub-tab shown (FUND_TABS), kept for the session
  startOpen: false, // the "Start a fund" form is open (its card in the switcher)
  fundCmd: null, // the admin's latest start/stop request: { id, action, createdAt, phase, message }
  lessonDraft: null, // the owner's lesson being written, kept while the page re-renders (lessonForm)
  reportWeek: {}, // the week picked in each fund's weekly report (renderWeekly): { fundId: '2026-W40' }; the latest by default
  declining: null, // the proposal whose Reject is asking why (renderProposals)
  jumpTo: null, // after a link from Telegram: 'week' (the weekly report) or 'approve' (the trades waiting)
  linkedFund: null, // a link from Telegram waiting for the funds to load: { id, jump } (followDeepLink)
  linkGone: null, // the fund a link was for, when it has been removed
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
// For this visit only (the fund page's sub-tab): gone when the tab is closed.
function readSession(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}
function writeSession(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* kept in memory for this page */ }
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
  const [picks, fund, history, spend, company, filings, longMemory, dossierFile, reading] = await Promise.allSettled([
    fetchJson('data/picks.json'), fundSource(), fetchJson('data/picks-history.json'), fetchJson('data/ai-spend.json'),
    fetchJson('data/company-data.json'), fetchJson('data/results-dates.json'), fetchJson('data/memory-long.json'), fetchJson('data/dossiers.json'),
    fetchJson('data/reading-calls.json'),
  ]);
  state.company = company.status === 'fulfilled' ? company.value : null;
  state.longMemory = longMemory.status === 'fulfilled' && longMemory.value?.markets ? longMemory.value : null;
  state.dossiers = dossierFile.status === 'fulfilled' && dossierFile.value?.stocks ? dossierFile.value : null;
  state.readingCalls = reading.status === 'fulfilled' && Array.isArray(reading.value?.calls) ? reading.value : null;
  state.filings = filings.status === 'fulfilled' ? filings.value : null;
  state.sitePicks = picks.status === 'fulfilled' ? picks.value : null;
  state.picksHistory = history.status === 'fulfilled' ? history.value : null;
  state.spend = spend.status === 'fulfilled' ? spend.value : null;
  state.funds = fund.status === 'fulfilled' && fund.value ? loadFunds(fund.value) : null;
  render();
}

const quote = (symbol) => state.prices.quotes?.[symbol];

// The results calendar (calendar.js), rebuilt when the prices or the company data change.
let calendarCache = { key: null, value: null };
function calendar() {
  const key = `${state.prices.updatedAt}|${state.company?.fetchedAt}|${state.filings?.checkedAt}|${new Date().toISOString().slice(0, 13)}`;
  if (calendarCache.key !== key) calendarCache = { key, value: resultsCalendar({ company: state.company, filings: state.filings, quotes: state.prices.quotes ?? {} }) };
  return calendarCache.value;
}
const SOURCE_LABELS = { filing: 'from its SEC filing', yahoo: 'confirmed, from Yahoo Finance', estimated: 'an estimate from Yahoo Finance; the company hasn\'t confirmed it yet' };
// "results in 3 days" when a stock reports within two weeks; "(estimate)" when the date isn't confirmed.
function resultsChip(symbol) {
  if (state.sample) return '';
  const n = nextResults(calendar(), symbol, state.prices.quotes, new Date());
  if (!n || n.daysAway < 0 || n.daysAway > 10) return '';
  // calendar days from the stock's market's own date (not the UTC one: Singapore's day starts 8 hours earlier)
  const today = marketDate(state.prices.quotes[symbol]?.market ?? 'US', new Date());
  const days = Math.round((Date.parse(n.source === 'filing' ? n.effectiveDate : n.date) - Date.parse(today)) / 86400000);
  const when = n.source === 'filing' ? 'results out' : days <= 0 ? 'results today' : days === 1 ? 'results tomorrow' : `results in ${days} days`;
  return `<span class="chip results" title="Results ${esc(fmtDate(`${n.date}T12:00:00Z`))}: ${esc(SOURCE_LABELS[n.source])}">${when}${n.source === 'estimated' ? ' (estimate)' : ''}</span>`;
}
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
      notify(`Rule-based trade: ${t.side === 'buy' ? 'bought' : 'sold'} ${t.qty.toLocaleString()} ${t.symbol} at ${price(t.price)} ${t.currency} (${when}).`, rule);
    } else {
      notify(`Rule-based trade skipped for ${rule?.symbol}: ${entry.error} (${when}).`, rule, true);
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
const MODEL_NAMES = { 'claude-haiku-4-5': 'Haiku 4.5', 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-5': 'Opus 5', 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };
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

// A link from Telegram (alerts.js fundLink): #fund/<id> opens that fund's page at its weekly report, and
// #fund/<id>/approve at its trades waiting for approval; #fund/all opens all the funds combined. The address becomes #fund, so the tabs work as
// usual, and the link waits for the funds to load (resolveLinkedFund): then the fund is remembered as if
// it had been tapped, or, if it has been removed, the page says so rather than showing another fund's
// report as if it were the linked one. A sign-in on the way, which can drop the address (Google's
// does), still ends there (startApp).
function followDeepLink() {
  const m = /^#fund\/([^/]+)(?:\/(approve))?\/?$/.exec(location.hash);
  if (!m) return false;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return false; }
  if (id === ALL && !m[2]) {
    state.fundId = ALL;
    writeStore(KEYS.fundId, ALL);
    // a working link: no notice about an earlier link to a removed fund, and no fund link still waiting
    state.linkGone = null;
    state.linkedFund = null;
    // no fund id in what's kept for a sign-in (it would read as a removed fund): only that the page is #fund
    try { sessionStorage.setItem(KEYS.deepLink, JSON.stringify({ view: 'fund' })); } catch { /* the address below is enough without a sign-in */ }
    history.replaceState(null, '', `${location.pathname}${location.search}#fund`);
    fundControlsKey = null;
    return true;
  }
  state.linkedFund = { id, jump: m[2] === 'approve' ? 'approve' : 'week' };
  try { sessionStorage.setItem(KEYS.deepLink, JSON.stringify(state.linkedFund)); } catch { /* the address below is enough without a sign-in */ }
  history.replaceState(null, '', `${location.pathname}${location.search}#fund`);
  fundControlsKey = null;
  return true;
}
// Once the funds have loaded (`c`): the linked fund, at its weekly report or its trades waiting, or
// state.linkGone when it isn't among them (the page keeps the fund it showed before).
function resolveLinkedFund(c) {
  const link = state.linkedFund;
  if (!link || !c) return;
  state.linkedFund = null;
  if (!fundList().some((f) => f.id === link.id)) { state.linkGone = link.id; return; }
  state.linkGone = null;
  state.fundId = link.id;
  writeStore(KEYS.fundId, link.id);
  delete state.reportWeek[link.id]; // its latest report
  state.jumpTo = link.jump;
  fundControlsKey = null;
}

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
  if (view === 'home') { renderOverview(); renderPicks(); renderScorecard(); renderHoldings(positions, accounts); renderReading(); }
  if (view === 'markets') renderMarkets();
  if (view === 'auto') renderRules();
  if (view === 'strategist') renderStrategist();
  if (view === 'fund') { resolveLinkedFund(state.funds); renderFundControls(); renderFund(); }
  if (view === 'history') renderTrades();
  if ($('trade-dialog').open) updateTradeDialog();
  if ($('stock-dialog').open) renderStockDialog();
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
// A small trend line inside a line of text (charts.js sparkTrend), drawn like the other charts once
// it's on the page. Its numbers are in the text beside it and in a table twin (keptTable).
function sparkSlot(draw) {
  const id = `chart-${++chartSeq}`;
  chartJobs.push([id, draw]);
  return `<span id="${id}" class="spark-box"></span>`;
}
// A chart's "Table" (tableToggle) that isn't under one chart: it stays open when the page re-renders,
// as a chart card's does (chartSlot).
const keptTable = (table, key) => (table ? `<div class="chart-card table-only" data-key="${esc(key)}">${table.replace('<details class="chart-table', `<details data-key="${esc(key)}"${openTables.has(key) ? ' open' : ''} class="chart-table`)}</div>` : '');
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
  if (a.dataset?.fundSelect) return { sel: `#fund-switcher [data-fund-select="${CSS.escape(a.dataset.fundSelect)}"]` };
  // the fund's sub-tabs, and its header's buttons (data-fk: a name for what the button does)
  if (a.dataset?.fundTab && a.closest('#fund-tabs')) return { sel: `#fund-tabs [data-fund-tab="${CSS.escape(a.dataset.fundTab)}"]` };
  if (a.dataset?.fk) return { sel: `[data-fk="${CSS.escape(a.dataset.fk)}"]` };
  if (a.id === 'report-week') return { sel: '#report-week' };
  // a field of the fund's settings or start form, when a command moving on redraws it
  if (a.id && a.closest?.(FUND_FORMS)) return { sel: `#${CSS.escape(a.id)}`, caret: typeof a.selectionStart === 'number' ? a.selectionStart : null };
  // the owner's lesson (lessonForm), note on a stock (stockNoteSection), logged article (readingForm) or
  // question (askForm) being written, with the caret where it was
  if (a.id && a.closest?.('#lesson-form, #stock-note-form, #reading-form, #ask-form')) return { sel: `#${CSS.escape(a.id)}`, caret: typeof a.selectionStart === 'number' ? a.selectionStart : null };
  const box = a.closest?.('.chart-card[data-key], [data-bt]');
  if (!box) return null;
  const scope = box.matches('[data-bt]') ? `[data-bt="${CSS.escape(box.dataset.bt)}"]` : `.chart-card[data-key="${CSS.escape(box.dataset.key)}"]`;
  const tip = a.getAttribute('data-tip'), open = tipOpenFor(a);
  // a card holding several small charts (the factor lab's) numbers each one's marks from 0: the chart too
  const sub = a.closest?.('[data-lab]');
  if (tip != null) return { sel: `${scope} ${sub ? `[data-lab="${CSS.escape(sub.dataset.lab)}"] ` : ''}[data-tip="${CSS.escape(tip)}"]`, open };
  for (const s of ['svg.line-chart', 'details.chart-table > summary', '.chart-table .table-wrap']) if (a.matches(s)) return { sel: `${scope} ${s}`, at: a.dataset.at, open };
  return null;
}
function restoreFocus(f) {
  const el = f && document.querySelector(f.sel);
  if (!el || el === document.activeElement) return;
  if (f.at) el.dataset.at = f.at;
  if (f.open) el.focus({ preventScroll: true });
  else focusQuietly(el);
  if (f.caret != null) el.setSelectionRange?.(f.caret, f.caret);
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
        ${stockLink(p.symbol)} <span class="muted small">${esc(q?.name ?? '')}</span>
        <span class="chips"><span class="chip ${p.stance === 'long' ? 'buy' : 'sell'}">${p.stance}</span><span class="chip">${esc(p.conviction)} conviction</span><span class="chip">${esc(p.horizon)}</span></span>
      </header>
      <p>${esc(p.thesis)}</p>
      <p class="small"><strong>News:</strong> ${esc(p.news)}</p>
      <details class="small"><summary>What would make this wrong</summary><p>${esc(p.risks)}</p></details>
      ${sources(p.source_urls)}
      <footer>
        <span class="small muted">Now ${price(q?.price)} ${esc(q?.currency ?? '')}${right == null ? '' : ` · <span class="${tone(right)}">${pct(since)} since the pick</span>`}</span>
        <span class="row pick-actions">${state.sample || !q ? '' : `<button class="small-btn ghost" data-stock="${esc(p.symbol)}" aria-haspopup="dialog">Stock notes</button>`}<button class="small-btn" data-trade="${esc(p.symbol)}" data-side="${p.stance === 'long' ? 'buy' : 'sell'}">${p.stance === 'long' ? 'Buy' : 'Short'}</button></span>
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
    state.localPicks = await recommend({ client, Anthropic, model: state.ai.model, prices: state.prices, ...(state.sample ? {} : { company: state.company, calendar: calendar() }) });
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

// ----- home: the reading guide (reading.js) -----

// What investing sites recommended for the watchlist's stocks (data/reading-calls.json: read once a day
// from the news feeds' headlines and the start of their summaries), each site's calls graded a month
// later as the AI picks are, with the honest limits; and your own reading (admins): the articles you log
// here, kept with the funds and graded the same way. None of it reaches the AI.
const READING_TEXT = { log: ['Logging your article', 'Your article is logged.'] };
const VERDICT_WORDS = { unclear: 'no evidence either way yet', better: 'did better than the index so far', worse: 'did worse than the index so far' };
const verdictWords = (r) => (r.verdict === 'too-few' ? `too early for a verdict (${r.n} of ${READING.verdict} graded calls)` : VERDICT_WORDS[r.verdict]);
const CALL_WORDS = { long: 'buy', short: 'sell', hold: 'hold' };
const CALL_CHIP = { long: 'buy', short: 'sell', hold: '' };
const likelyRange = (r) => (r.lo == null ? '–' : `${pct(r.lo)} to ${pct(r.hi)}`);
const readingLeft = (text) => `${Math.max(0, READING.pasteMax - String(text ?? '').length).toLocaleString()} characters left`;
const siteLabel = (site) => (site == null ? 'All sites' : siteName(site));
const callChip = (p) => `<span class="chip ${CALL_CHIP[p.stance]}">${CALL_WORDS[p.stance]}</span>`;

function renderReading() {
  const el = $('reading');
  const admin = authEnabled && state.user?.isAdmin;
  const record = state.readingCalls;
  $('reading-panel').hidden = !record?.calls?.length && !admin;
  if (!record?.calls?.length && !admin) { el.innerHTML = ''; return; }
  const latest = latestCalls(record, 30);
  el.innerHTML = `
    <p class="small muted">Once a day, Claude Haiku reads up to ${READING.perDay} new headlines from the news feeds that name a watchlist stock, investing sites first, with the start of each one's summary, and notes the article's own call on the stock: buy, sell or hold (a news report, or a broker's rating it only reports, isn't a call). One call per site, per stock, per week. Each is graded like the AI picks: a month later, in the call's direction, against the same bet on the index (dividends count; fees don't).</p>
    ${readingSites(record)}
    <p class="small reading-honest">A site's record takes a year or more to mean anything. There are 17 stocks, a site calls a few of them a month and calls bunch after results, so the same few price moves count again and again, and for months a record is mostly luck. So there's no verdict before ${READING.verdict} graded calls, and then only when the average is well clear of noise: of ${READING_NOISE.sims.toLocaleString()} made-up sites with no skill at all, ${(READING_NOISE.any * 100).toFixed(1)}% showed one at some point in a year, checked every week. Calls are graded against the index without allowing for beta, so buying stocks that swing more than the index looks good in a rising market. For your reading only: the AI funds and the picks never see these calls.</p>
    ${latest.length ? `<details class="fund-new"><summary>Latest calls (the last ${READING.listDays / 7} weeks)</summary><ul class="orders reading-list">${latest.map((c) => `<li>${esc(shortDay(c.createdAt))} ${callChip(c.pick)}${stockLink(c.pick.symbol)}
      <span class="muted small">${esc(siteLabel(c.source))}${c.pick.target ? ` · target ${price(c.pick.target)}` : ''}${c.pick.reasons?.length ? ` · ${esc(c.pick.reasons.map((x) => REASON_LABELS[x] ?? x).join(', '))}` : ''}</span>
      <br><a class="small" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer">${esc(c.headline)}</a></li>`).join('')}</ul>
      <p class="muted small">What the sites wrote, not advice. Each will be graded a month after it was published.</p></details>` : ''}
    ${admin ? yourReading() : ''}`;
  flushCharts();
}

// Each site's record (reading.js siteRecords): the calls a month old, against the index, with the
// likely range, as a chart of the sites with enough of them and a table of every site.
function readingSites(record) {
  if (!record?.calls?.length) return '<p class="muted small">No calls yet: the first read comes with the news feeds\' next fetch.</p>';
  if (state.sample) return '<p class="muted small">Each site\'s record appears once real prices are loaded.</p>';
  const rows = siteRecords(record, state.prices.quotes ?? {});
  const all = rows[0];
  const shown = rows.filter((r) => r.n >= READING.chartMin);
  const counts = `${plural(all.calls, 'call')} from ${plural(rows.length - 1, 'site')} since ${esc(fmtDate(record.calls[0].createdAt))}${all.holds ? ` (${all.holds} of them ${all.holds === 1 ? 'a hold' : 'holds'}, which ${all.holds === 1 ? 'isn\'t' : 'aren\'t'} graded: a hold has no direction)` : ''}; ${all.n ? `${all.n} a month old, graded` : 'none a month old yet'}.`;
  const chart = chartSlot((box) => (shown.length ? rangeBars(box, shown.map((r) => ({
    label: siteLabel(r.site), sub: `${r.n} graded · ${plural(r.weeks, 'week')}`, // graded calls: the table's Graded column
    value: r.avg * 100, lo: (r.lo ?? r.avg) * 100, hi: (r.hi ?? r.avg) * 100, display: pct(r.avg),
    tip: [
      { value: pct(r.avg), label: 'a month later against the same bet on the index, on average (each week once)' },
      { value: likelyRange(r), label: 'likely range (an 8-in-10 chance)' },
      { value: `${r.beat} of ${r.n}`, label: 'beat the index' },
      { label: verdictWords(r) },
    ],
  })), { tickFmt: pctTick, ariaLabel: 'Each site\'s calls a month later, against the index', dotLabel: 'Average, each week once' })
    : (box.innerHTML = `<p class="muted small">No site has ${READING.chartMin} graded calls yet: a call is graded once a month of trading has passed.</p>`)), {
    title: 'Each site\'s calls, a month later',
    caption: `In the call's direction, against the same bet on the index (SPY or ES3): right of 0, the calls did better than the index. The dot is the average, counting each week once (calls on the same stock and side within a month are one bet), and the bar its likely range (an 8-in-10 chance it's inside). Sites with fewer than ${READING.chartMin} graded calls are only in the Table.`,
    key: 'reading-sites',
    table: tableToggle(['Site', 'Calls', 'Graded', 'Separate weeks', 'Beat the index', 'A month later vs index', 'Likely range', 'Verdict'],
      rows.map((r) => [siteLabel(r.site), `${r.calls}${r.holds ? ` (${plural(r.holds, 'hold')})` : ''}`, String(r.n), String(r.weeks), r.n ? `${r.beat} of ${r.n}` : '–',
        r.avg == null ? '–' : pct(r.avg), likelyRange(r), verdictWords(r)]), 1, { className: 'wrap-head reading-table' }),
  });
  return `<p class="small">${counts}</p>${chart}`;
}

// Your reading (admins): the articles you logged (the funds' c.reading, in their private copy), each call
// graded a month on from when you logged it, the record of all of them, and the box to log another.
function yourReading() {
  const quotes = state.prices.quotes ?? {};
  const list = Array.isArray(state.funds?.reading) ? state.funds.reading : [];
  const results = state.sample ? [] : monthResults(list, quotes);
  const rec = recordOf(results);
  const hidden = !list.length && state.funds?.readingLogged;
  const line = (e) => {
    const t = Date.parse(e.createdAt) / 1000;
    const calls = e.picks.map((p) => {
      const idx = esc(indexName(BENCHMARKS[quotes[p.symbol]?.currency]?.symbol ?? 'the index'));
      const r = p.stance === 'hold' ? null : results.find((x) => x.t === t && x.symbol === p.symbol && x.direction === (p.stance === 'short' ? -1 : 1));
      let grade;
      if (p.stance === 'hold') grade = 'not graded: a hold has no direction';
      else if (r) grade = `a month later <span class="${tone(r.x)}">${pct(r.x)}</span> against ${idx}`;
      else {
        const s = state.sample ? null : soFar(e.createdAt, p, quotes);
        grade = `${s?.vsIndex != null ? `so far <span class="${tone(s.vsIndex)}">${pct(s.vsIndex)}</span> against ${idx}; ` : ''}graded around ${esc(dayOf(gradeDay(e.createdAt)))}`;
      }
      return `${callChip(p)}${stockLink(p.symbol)}${p.target ? ` <span class="muted small">target ${price(p.target)}</span>` : ''} · ${grade}`;
    }).join('<br>');
    const name = e.title || (e.site ? siteLabel(e.site) : 'Your pasted text');
    return `<li>${calls}<br><span class="small">${e.url ? `<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>` : esc(name)}</span>
      <span class="muted small">(${esc(e.site ? siteLabel(e.site) : 'pasted text')}, logged ${esc(fmtDate(e.createdAt))}${e.published ? `, published ${esc(fmtDate(e.published))}` : ''})</span></li>`;
  };
  const picks = list.reduce((n, e) => n + e.picks.length, 0);
  const summary = list.length ? `<p class="small">${plural(list.length, 'article')} logged, with ${plural(picks, 'call')}${rec.n
    ? `; ${rec.n} a month old: ${pct(rec.avg)} against the index on average${rec.lo != null ? ` (likely ${likelyRange(rec)})` : ''}, beating it ${rec.beat} of ${rec.n} times; ${verdictWords(rec)}`
    : '; none a month old yet'}.</p>` : '';
  return `<h3 class="col-head reading-own">Your reading</h3>
    <p class="small muted">Articles you read, in Tiger, Standard Chartered or anywhere: give the link, or paste the text when the page is behind a paywall. The job reads the page (or your text) the same way, and each call is graded the same way, from when you log it, so an older article isn't graded on moves you'd already seen. Kept with the funds, so private only when they're kept private (README: Keeping the AI fund private); the AI never sees them.</p>
    ${hidden ? `<p class="small">You've logged ${plural(hidden, 'article')}. The public copy of the funds leaves your reading out, so it isn't shown here; keep the funds private to see it.</p>` : ''}
    ${summary}
    ${list.length ? `<ul class="orders reading-list">${[...list].reverse().slice(0, 20).map(line).join('')}</ul>` : ''}
    ${readingForm()}`;
}

// The box that logs an article: a link, or pasted text (up to READING.pasteMax characters), sent to the
// job as 'settings' ({ fund: 'all', reading }), which reaches it whole. If the job can't read the page, its
// message says so and the box keeps the link, so the text can be added.
function readingForm() {
  const d = state.readingDraft ?? { url: '', text: '' };
  const cmd = state.fundCmd?.text === READING_TEXT.log ? state.fundCmd : null;
  const busy = state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '';
  return `<form id="reading-form" class="reading-form" novalidate>
    <label for="reading-url">Log an article: its link</label>
    <input id="reading-url" type="url" inputmode="url" maxlength="500" autocomplete="off" placeholder="https://" value="${esc(d.url)}">
    <label for="reading-text">Or its text, pasted</label>
    <textarea id="reading-text" maxlength="${READING.pasteMax}" rows="3" placeholder="e.g. Buy Singtel, target S$4.20: its dividend looks safe…">${esc(d.text)}</textarea>
    <div class="row"><button type="submit" class="primary small-btn" ${busy}>Log the article</button><span class="muted small" id="reading-left">${readingLeft(d.text)}</span></div>
    <p class="error" id="reading-error" role="alert"></p>
    ${cmd?.message ? `<p class="small ${cmd.phase === 'failed' ? 'down' : 'muted'}" role="status">${esc(cmd.message)}</p>` : ''}
  </form>`;
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
        <td>${stockLink(p.symbol)}${p.short ? '<span class="chip sell">short</span>' : ''}${resultsChip(p.symbol)}<span class="name">${esc(q?.name ?? '')}</span></td>
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
  const regimes = state.sample ? [] : Object.keys(MARKETS).map((m) => regimeNow(state.prices.quotes, state.prices.macro, m)).filter(Boolean);
  $('market-regime').hidden = !regimes.length;
  $('market-regime').innerHTML = regimes.length ? `<span class="chip regime-chip" title="${esc(REGIME_NOTE)}">Regime today</span> ${regimes.map((r) => `${esc(MARKETS[r.market].label)}: ${esc(regimeWords(r))}.`).join(' ')}` : '';

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
        <td>${stockLink(symbol)}<span class="chip">${esc(q.market)}</span>${resultsChip(symbol)}<span class="name">${esc(q.name)}</span></td>
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
      <td><strong>${esc(t.symbol)}</strong><span class="chip ${t.side}">${t.side}</span>${t.rule ? `<span class="chip" title="${esc(ruleNote(t.rule) || 'Trading rule')}">rule</span>` : ''}</td>
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

// With a key in this browser the strategist runs here, straight away. Without one, an admin's request goes
// to the scheduled job like the fund buttons ({ fund: 'all', strategist }, sent as 'settings'; see
// scripts/ai-fund.mjs), which runs it with the repository's key and keeps the answer with the funds
// (c.strategist), so it's shown from their private copy. The page shows the newer of the two answers.
const STRATEGIST_TEXT = { run: ['Asking the AI strategist', 'The strategist has answered.'] };
const strategistByJob = () => !state.ai.key && authEnabled && state.user?.isAdmin;
function shownStrategy() {
  const mine = state.strategist, job = state.user?.isAdmin ? state.funds?.strategist : null;
  if (!job?.strategies) return mine ?? null;
  return !mine || Date.parse(job.createdAt) > Date.parse(mine.createdAt) ? job : mine;
}
function renderStrategist() {
  const count = String(Object.keys(state.prices.quotes ?? {}).length);
  if ($('st-focus').dataset.count !== count) {
    const keep = $('st-focus').value;
    $('st-focus').innerHTML = `<option value="all">Whole watchlist</option>${symbolOptions(keep)}`;
    $('st-focus').dataset.count = count;
  }
  const cmd = state.fundCmd?.text === STRATEGIST_TEXT.run ? state.fundCmd : null;
  if (strategistByJob()) {
    const running = cmd && ['sending', 'sent', 'accepted'].includes(cmd.phase);
    $('st-run').disabled = running;
    $('st-status').innerHTML = cmd ? `<span class="${cmd.phase === 'failed' ? 'down' : ''}">${esc(cmd.message)}</span>`
      : 'Runs on GitHub with the scheduled AI\'s key (no key in this browser): the answer appears here in about 3–5 minutes and counts toward the monthly cap.';
  } else if (!$('st-run').disabled) $('st-status').innerHTML = state.ai.key ? '' : 'Needs your Anthropic API key. <button type="button" class="ghost small-btn" data-open-settings>Add API key</button>';
  const a = shownStrategy();
  if (!a) { $('strategist').innerHTML = ''; return; }
  // the backtests belong to the answer shown: a newer answer starts them afresh
  if (state.backtestsFor !== a.createdAt) {
    for (const k of Object.keys(state.backtests)) if (k.startsWith('s')) delete state.backtests[k];
    state.backtestsFor = a.createdAt;
  }
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
  if (strategistByJob()) {
    const context = buildContext({ prices: state.prices, portfolio: state.portfolio, focus: $('st-focus').value, risk: $('st-risk').value, question: $('st-question').value });
    const strategist = strategistRequest({ context, focus: $('st-focus').value, risk: $('st-risk').value, question: $('st-question').value });
    $('st-error').textContent = '';
    submitFundCommand('settings', { payload: { fund: 'all', strategist } }, STRATEGIST_TEXT.run);
    render();
    return;
  }
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
  const s = shownStrategy().strategies[i];
  saveRules((rules) => {
    for (const r of s.rules) rules.push({ ...structuredClone(r), id: newRule(r).id, enabled: false, state: freshState() });
  });
  notify(`Added ${s.rules.length} paused rule${s.rules.length > 1 ? 's' : ''} from "${s.title}". Review them under Rule-based and switch them on.`);
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
// What the AI fund page shows: ALL (every fund combined, once there are two or more), else a fund.
const shownFund = () => (state.fundId === ALL && fundList().length >= 2 ? ALL : selectedFund());
function selectFund(id) {
  state.fundId = id;
  state.linkGone = null;
  writeStore(KEYS.fundId, id);
  fundControlsKey = null;
  render();
}
// The fund's sub-tabs: every section of its page is under one of them. Ask the data and Settings are
// for admins. The tab picked is kept for the session and for every fund.
const FUND_TABS = { overview: 'Overview', holdings: 'Holdings', decisions: 'Decisions', learning: 'Learning', reports: 'Reports', ask: 'Ask the data', settings: 'Settings' };
const fundTabs = () => Object.keys(FUND_TABS).filter((t) => !['ask', 'settings'].includes(t) || (authEnabled && state.user?.isAdmin));
function setFundTab(tab) {
  state.fundTab = tab;
  writeSession(KEYS.fundTab, tab);
}

const modelOptions = (selected) => `<option value="">Default (${esc(modelName(TIERS.advanced))})</option>${Object.entries(FUND_MODELS)
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
// How often a fund decides, with roughly what that costs a month for the fund's model: each decision is one
// AI call of about US$0.05-0.15 on the default model (reusing the day's news), scaled by the model's price
// against it (Haiku about half, Opus about 2.5x), over about 21 trading days. Every run is about 26 a day;
// "skip when nothing has changed" skips up to two quiet runs in a row, so roughly a third of that.
const DECISION_COST = [0.05, 0.15];
// by the blended price of a decision (about 30 tokens in for each one out, most of it the market data); for
// DeepSeek at its peak-hour rate, which covers most of SGX's trading day, to be safe
const blended = (m) => (m ? (m.inPerM * 30 + m.outPerM) * (m.provider === 'deepseek' ? DEEPSEEK_PEAK.factor : 1) : null);
const modelCostFactor = (model) => (blended(FUND_MODELS[model || TIERS.advanced]) ?? blended(MODELS[TIERS.advanced])) / blended(MODELS[TIERS.advanced]);
const decisionWords = (n) => (Number(n) === EVERY_RUN ? 'at every run (about every 15 minutes)' : `${n} time${n > 1 ? 's' : ''} a trading day`);
function decisionOptions(selected = 1, model = null) {
  const factor = modelCostFactor(model);
  return DECISION_CHOICES.map((n) => {
    const perDay = n === EVERY_RUN ? 26 : n;
    const [lo, hi] = DECISION_COST.map((c) => perDay * 21 * c * factor);
    const cost = hi < 1 ? 'under US$1 a month' : `about US$${Math.max(1, Math.round(lo))}–${Math.max(1, Math.round(lo), Math.round(hi))} a month`;
    const label = n === EVERY_RUN ? `Every run, about every 15 minutes (${cost}; about a third with quiet runs skipped)`
      : `${n}${n === 1 ? ' (cheapest)' : ''}: ${cost}`;
    return `<option value="${n}" ${Number(selected) === n ? 'selected' : ''}>${label}</option>`;
  }).join('');
}
const readMandate = (p) => ({
  name: $(`${p}-name`).value.trim(), style: $(`${p}-style`).value, focus: $(`${p}-focus`).value.trim(),
  settings: {
    model: $(`${p}-model`).value || null, maxOrderPct: numberOf(`${p}-max-order`), dailyLossPct: numberOf(`${p}-daily-loss`),
    allowShorts: $(`${p}-shorts`).checked, learning: $(`${p}-learning`).checked, skipQuiet: $(`${p}-skip-quiet`).checked,
  },
});

// The fund forms are redrawn whenever a command moves on (sending, running, done), from the fund's saved
// values. So a change the owner made, or has just saved and is waiting for, isn't wiped: each field
// remembers the value it was drawn with, and one that differs is carried into the redrawn form (for the
// same fund only; the start form's, whichever fund is shown). Once the job has saved the change, the
// field is drawn with it and nothing differs.
const FUND_FORMS = '#fund-settings-form, #fund-start-form';
const fieldValue = (x) => (x.type === 'checkbox' ? String(x.checked) : x.value);
const formOwner = (x, fundId) => (x.closest('#fund-start-form') ? 'new' : String(fundId));
function unsavedEdits(el, fundId) {
  const edits = {};
  for (const x of el.querySelectorAll(`:is(${FUND_FORMS}) :is(input, select, textarea)`)) {
    if (x.id && x.dataset.drawn !== undefined && x.dataset.fund === formOwner(x, fundId) && fieldValue(x) !== x.dataset.drawn) edits[x.id] = fieldValue(x);
  }
  return edits;
}
function keepEdits(el, fundId, edits) {
  for (const x of el.querySelectorAll(`:is(${FUND_FORMS}) :is(input, select, textarea)`)) {
    x.dataset.drawn = fieldValue(x);
    x.dataset.fund = formOwner(x, fundId);
    if (!(x.id in edits)) continue;
    if (x.type === 'checkbox') x.checked = edits[x.id] === 'true'; else x.value = edits[x.id];
  }
  const style = $('set-style');
  if (style && 'set-style' in edits) $('set-style-brief').textContent = STYLES[style.value]?.brief ?? '';
}

// For admins: the Settings tab of the fund shown (pause, stop or remove it, and its mandate, approval
// and limits), and the "Start a fund" form under the switcher. Rebuilt only when something they show
// changes, so typing isn't lost when prices refresh.
let fundControlsKey = null;
function renderFundControls() {
  const el = $('fund-controls'), startEl = $('fund-start');
  const list = fundList();
  const f = selectedFund();
  const running = list.filter((x) => !x.stoppedAt);
  const cmd = state.fundCmd;
  const admin = authEnabled && state.user?.isAdmin && state.funds !== undefined;
  const key = JSON.stringify([admin, state.startOpen, f?.id, list.map((x) => [x.id, x.name, x.style, x.focus, x.stoppedAt, x.paused?.at, x.settings, x.decisionsPerDay, x.broker?.accountType]), cmd?.phase]);
  if (key === fundControlsKey) return;
  fundControlsKey = key;
  startEl.hidden = !admin || !(state.startOpen || !list.length);
  if (!admin) {
    el.innerHTML = '';
    startEl.innerHTML = '';
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
        <select id="fund-decisions">${decisionOptions(1, null)}</select>
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
  const settings = f ? `<section class="panel">
      <div class="panel-head"><h2>Settings</h2></div>
      <p class="small"><strong>${esc(f.name)}</strong> · trading through <strong class="${f.broker?.accountType === 'live' ? 'down' : ''}">${esc(brokerLabel(f))}</strong>${s.broker === 'tiger' ? ` · ${s.approval === 'manual' ? 'you approve each trade' : 'automatic'}` : ''}</p>
      <div class="row">
        ${f.stoppedAt
          ? `<button type="button" class="ghost" data-fund-cmd="remove" ${busy}>Remove this fund from the list</button>`
          : `${f.paused
            ? `<button type="button" class="primary" data-fund-cmd="resume" ${busy}>Resume trading</button>`
            : `<button type="button" class="danger" data-fund-cmd="pause" ${busy}>Pause this fund</button>`}
          <button type="button" class="ghost" data-fund-stop ${busy}>Stop fund and close positions</button>`}
      </div>
      ${f.stoppedAt ? '<p class="small muted">A stopped fund stays listed until you remove it; a one-line summary of its result is kept.</p>' : '<p class="small muted">Pausing stops new trades and cancels open orders; stop-losses keep working. Stopping closes every position and ends the fund. Pause all funds is on All funds.</p>'}
    </section>
    ${f.stoppedAt ? '' : `<section class="panel">
      <div class="panel-head"><h2>Mandate, approval and limits</h2></div>
      <form id="fund-settings-form" class="form-grid fund-form">
        ${mandateFields('set', { name: f.name, style: f.style, focus: f.focus, model: s.model, maxOrderPct: s.maxOrderPct ?? 25, dailyLossPct: s.dailyLossPct ?? 5, allowShorts: s.allowShorts, learning: s.learning, skipQuiet: s.skipQuiet })}
        <label>Decisions per trading day <select id="set-decisions">${decisionOptions(f.decisionsPerDay, s.model)}</select></label>
        ${s.broker === 'tiger' ? `<label>Approval
          <select id="set-approval"><option value="manual" ${s.approval === 'manual' ? 'selected' : ''}>I approve each trade</option><option value="auto" ${s.approval === 'auto' ? 'selected' : ''}>Automatic</option></select>
        </label>` : '<p class="small muted">Approval: none needed. The simulator trades with virtual money, so its trades go through as the AI decides; approving each trade is for funds that trade through Tiger.</p>'}
        <p class="small muted wide">Changing the style changes the AI's brief from its next decision. It doesn't change the limits above by itself.</p>
        <div class="row"><button type="submit" class="primary" ${busy}>Save</button></div>
      </form>
    </section>`}` : '';
  const view = el.closest('.view');
  const edits = unsavedEdits(view, f?.id);
  // A fund that has just started empties the start form, so it can't be started twice by mistake.
  if (cmd?.action === 'start' && cmd.phase === 'done') for (const id of Object.keys(edits)) if (id.startsWith('new-') || id.startsWith('fund-')) delete edits[id];
  el.innerHTML = settings;
  startEl.innerHTML = `<div class="panel-head"><h2>${list.length ? 'Start a fund' : 'Start an AI fund'}</h2>
      ${list.length ? '<button type="button" class="ghost" data-close-start data-fk="close-start">Close</button>' : ''}</div>
    ${startForm}`;
  keepEdits(view, f?.id, edits);
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
  // The monthly costs beside each decisions choice follow the model picked.
  for (const [p, id] of [['new', 'fund-decisions'], ['set', 'set-decisions']]) {
    const model = $(`${p}-model`), decisions = $(id);
    if (!model || !decisions) continue;
    const redo = () => { const keep = decisions.value; decisions.innerHTML = decisionOptions(keep, model.value); };
    model.addEventListener('change', redo);
    if (model.value !== (p === 'set' ? f?.settings?.model ?? '' : '')) redo(); // a model carried over from an unsaved edit
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

// What the owner does to a fund's lessons. These go to the job as 'settings' (the only command whose
// payload reaches it whole), so each says what it's doing rather than "Saving".
const LESSON_TEXT = {
  add: ['Adding your lesson', 'Your lesson is added.'], remove: ['Removing the lesson', 'The lesson is removed.'],
  restore: ['Restoring the lesson', 'The lesson is back.'], keep: ['Keeping the lesson', 'The lesson is kept: it won\'t expire.'],
};

// `text`: [what's happening, what's done], when the action's own words (COMMAND_TEXT) don't say it.
async function submitFundCommand(action, fields = {}, text = COMMAND_TEXT[action]) {
  const [what] = text;
  state.fundCmd = { phase: 'sending', action, text, message: `${what}: sending the request…` };
  render();
  try {
    const row = await sendFundCommand({ action, ...fields });
    state.fundCmd = { id: row.id, action, text, fund: fields.payload?.fund ?? null, ids: fields.payload?.ids, createdAt: row.created_at, phase: 'sent', message: `${what}: asking GitHub to run it…` };
  } catch (err) {
    state.fundCmd = { phase: 'failed', action, text, message: err.message };
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
  const [what, doneText] = cmd.text ?? COMMAND_TEXT[cmd.action];
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
          if (cmd.action === 'start' && own && lc.ok && lc.fund) { state.startOpen = false; selectFund(lc.fund); } // show the new fund
          if (cmd.text === READING_TEXT.log && cmd.phase === 'done') state.readingDraft = null; // logged: the box empties (a failure keeps it, to add the text)
          if (cmd.text === ASK_TEXT.ask && cmd.phase === 'done') state.askDraft = null; // asked: the box empties (a failure keeps it)
        }
      }
    } catch (err) {
      console.warn('Checking the fund request failed', err);
    }
    if (['fund', 'home', 'strategist'].includes(currentView()) || $('stock-dialog').open) render();
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
    if (!confirm(`Start ${label} (${STYLES[m.style].label}) with ${money(amount, currency)}, trading ${where}, deciding ${decisionWords(decisionsPerDay)}? Funds already running keep going.`)) return;
    // The Supabase table takes only 1, 2 or 4 (supabase/fund-control.sql); the choice itself travels in the
    // command, which the job reads first.
    submitFundCommand('start', { amount, currency, decisionsPerDay: [1, 2, 4].includes(decisionsPerDay) ? decisionsPerDay : 1, payload: { name: m.name, style: m.style, focus: m.focus, decisionsPerDay, settings } });
  }
  if (e.target.id === 'lesson-form') {
    e.preventDefault();
    const d = lessonDraft(), text = d.text.trim();
    if (!text) return;
    const tracked = FILTER_KEYS.some((k) => d.filter[k] !== 'any');
    submitFundCommand('settings', { payload: { fund: e.target.dataset.fund, playbook: { add: text, ...(tracked ? { filter: d.filter, claim: d.claim } : {}) } } }, LESSON_TEXT.add);
    state.lessonDraft = null;
  }
  if (e.target.id === 'stock-note-form') {
    e.preventDefault();
    const symbol = e.target.dataset.symbol, text = $('stock-note-text').value.trim();
    if (!text) return;
    state.noteCmd = symbol;
    state.noteDraft = null;
    submitFundCommand('settings', { payload: { fund: 'all', stockNote: { symbol, text } } }, NOTE_TEXT.save);
  }
  if (e.target.id === 'reading-form') {
    e.preventDefault();
    const url = $('reading-url').value.trim(), text = $('reading-text').value.trim().slice(0, READING.pasteMax);
    const err = $('reading-error');
    if (!url && !text) { err.textContent = 'Give a link to the article, or paste its text.'; return; }
    if (url && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) { err.textContent = 'That doesn\'t look like a link to a web page (it should start with https://).'; return; }
    state.readingDraft = { url, text };
    submitFundCommand('settings', { payload: { fund: 'all', reading: { ...(url ? { url } : {}), ...(text ? { text } : {}) } } }, READING_TEXT.log);
  }
  if (e.target.id === 'ask-form') {
    e.preventDefault();
    const text = $('ask-text').value.replace(/\s+/g, ' ').trim().slice(0, ASK.maxChars);
    if (!text) { $('ask-error').textContent = 'Type a question first.'; return; }
    if (text.length < 8) { $('ask-error').textContent = 'Write the question out in a few words (at least 8 characters).'; return; }
    state.askDraft = text;
    submitFundCommand('settings', { payload: { fund: 'all', ask: text } }, ASK_TEXT.ask);
  }
  if (e.target.id === 'fund-settings-form') {
    e.preventDefault();
    const m = readMandate('set');
    submitFundCommand('settings', { payload: { fund: selectedFund()?.id, name: m.name, style: m.style, focus: m.focus, decisionsPerDay: Number($('set-decisions').value), settings: { ...m.settings, ...($('set-approval') ? { approval: $('set-approval').value } : {}) } } });
  }
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-fund-stop], [data-fund-cmd], [data-proposal], [data-fund-select], [data-fund-open], [data-fund-tab], [data-open-start], [data-close-start], [data-lesson-remove], [data-lesson-restore], [data-lesson-keep], [data-decline], [data-decline-why], [data-decline-cancel]');
  if (!t) return;
  const f = selectedFund();
  if (t.dataset.fundTab) {
    // a sub-tab, or a link to one from inside the page ("All details"): that tab, with the tabs in sight
    const inTabs = Boolean(t.closest('#fund-tabs'));
    setFundTab(t.dataset.fundTab);
    render();
    if (!inTabs) {
      const tab = document.querySelector(`#fund-tabs [data-fund-tab="${CSS.escape(t.dataset.fundTab)}"]`);
      tab?.focus({ preventScroll: true });
      if (tab && tab.getBoundingClientRect().top < 0) $('fund-head').scrollIntoView({ block: 'start' });
    }
  } else if (t.dataset.fundOpen) {
    // a fund named on All funds: that fund, with its card focused
    selectFund(t.dataset.fundOpen);
    document.querySelector(`#fund-switcher [data-fund-select="${CSS.escape(t.dataset.fundOpen)}"]`)?.focus();
  } else if (t.matches('[data-open-start]')) {
    state.startOpen = !state.startOpen;
    fundControlsKey = null;
    render();
    if (state.startOpen) { $('fund-start').scrollIntoView({ block: 'nearest' }); ($('new-name') ?? $('fund-start'))?.focus({ preventScroll: true }); }
  } else if (t.matches('[data-close-start]')) {
    state.startOpen = false;
    fundControlsKey = null;
    render();
    document.querySelector('[data-open-start]')?.focus();
  } else if (t.dataset.decline) {
    // Reject asks why: its four reasons appear under the trade, the first one focused
    state.declining = state.declining === t.dataset.decline ? null : t.dataset.decline;
    render();
    (state.declining ? document.querySelector(`[data-decline-why][data-ids="${CSS.escape(state.declining)}"]`) : document.querySelector(`[data-decline="${CSS.escape(t.dataset.decline)}"]`))?.focus();
  } else if (t.dataset.declineCancel) {
    state.declining = null;
    render();
    document.querySelector(`[data-decline="${CSS.escape(t.dataset.declineCancel)}"]`)?.focus();
  } else if (t.dataset.declineWhy) {
    // A rejection with the owner's reason goes as 'settings' (the only command whose payload reaches the
    // job whole), so its messages say what's being done
    const p = (f?.proposals ?? []).find((x) => x.id === t.dataset.ids);
    const words = DECLINE_REASONS[t.dataset.declineWhy];
    const what = p ? `${p.action} ${Number(p.shares).toLocaleString()} ${p.symbol}` : 'the trade';
    state.declining = null;
    submitFundCommand('settings', { payload: { fund: f.id, reject: [t.dataset.ids], why: t.dataset.declineWhy } }, [`Declining ${what} (${words})`, `Declined ${what} (${words}).`]);
  } else if (t.dataset.lessonRemove) {
    if (confirm('Remove this lesson? The AI stops seeing it. You can restore it later.')) submitFundCommand('settings', { payload: { fund: f.id, playbook: { remove: t.dataset.lessonRemove } } }, LESSON_TEXT.remove);
  } else if (t.dataset.lessonRestore) {
    submitFundCommand('settings', { payload: { fund: f.id, playbook: { restore: t.dataset.lessonRestore } } }, LESSON_TEXT.restore);
  } else if (t.dataset.lessonKeep) {
    submitFundCommand('settings', { payload: { fund: f.id, playbook: { keep: t.dataset.lessonKeep } } }, LESSON_TEXT.keep);
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

// Trades waiting for the owner's approval. Reject asks why first (fund.js DECLINE_REASONS: too risky,
// bad timing, don't like the stock, other); the reason goes to the job with the rejection, through the
// settings passthrough, and grades the owner's own calls (learning.js, "Your calls").
function renderProposals(f) {
  const waiting = (f.proposals ?? []).filter((p) => p.status === 'awaiting');
  const admin = state.user?.isAdmin || !authEnabled;
  const busy = state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '';
  if (!waiting.length) return '';
  const why = (p) => `<div class="decline-why" role="group" aria-label="Why are you declining ${esc(p.action)} ${esc(p.symbol)}?">
    <span class="small">Why?</span>${Object.entries(DECLINE_REASONS).map(([k, words]) => `<button type="button" class="reason-btn" data-decline-why="${k}" data-ids="${esc(p.id)}" ${busy}>${esc(words)}</button>`).join('')}
    <button type="button" class="ghost small-btn" data-decline-cancel="${esc(p.id)}">Cancel</button>
    <span class="small muted">Your reason is graded with the trade, so you can see how your own calls do.</span></div>`;
  return `<section class="panel approvals">
    <div class="panel-head"><h2>Waiting for your approval</h2>
      ${admin && authEnabled && waiting.length > 1 ? `<button class="primary small-btn" data-proposal="approve" data-ids="${waiting.map((p) => p.id).join(',')}" ${busy}>Approve all</button>` : ''}</div>
    <p class="small muted">Each is a limit order: it can't fill at a worse price than shown. A proposal expires after an hour, or if the price moves more than 2% before you approve.</p>
    <ul class="orders">${waiting.map((p) => `<li>
      <span class="chip ${p.action === 'buy' || p.action === 'cover' ? 'buy' : 'sell'}">${esc(p.action)}</span>
      ${Number(p.shares).toLocaleString()} <strong>${esc(p.symbol)}</strong> · limit ${price(p.limitPrice)} ${esc(f.currency)} (≈ ${money(p.shares * p.limitPrice, f.currency)})
      <span class="muted small">${esc(p.reason)} · expires ${fmtDateTime(p.expiresAt)}</span>${p.thesis ? `<br><span class="thesis small">${esc(thesisWords(p.thesis, { short: p.action === 'short' }))}</span>` : ''}
      ${admin && authEnabled ? `<span class="row"><button class="small-btn primary" data-proposal="approve" data-ids="${esc(p.id)}" ${busy}>Approve</button>
        <button class="small-btn ghost" data-decline="${esc(p.id)}" aria-expanded="${state.declining === p.id}" ${busy}>Reject</button></span>
        ${state.declining === p.id ? why(p) : ''}` : ''}
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

// What a lesson's number per week measures (learning.js evaluateLessons `measure`).
const measureLabel = (l) => ({ index: 'Against the index', peers: `Against ${l.vs ?? 'its peers'}`, diff: 'High minus low conviction', split: 'Against the other side' }[l.measure] ?? 'Edge');
const LESSON_SOURCE = { results: 'from its results', 'weekly review': 'weekly review', owner: 'added by you', 'market memory': 'market memory', calibration: 'calibration', conditions: 'when its ideas work' };
const moveCell = (h) => (h ? `<span class="${tone(h.move)}">${pct(h.move)}</span>${h.index != null ? ` <span class="muted small">(${pct(h.move - h.index)} vs index)</span>` : ''}` : '<span class="muted small">not yet</span>');
const rate = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

// A group's confidence on the page: its level once it passes the gate, else why it isn't a lesson yet.
const groupConfidence = (ev) => (ev.bets < GATE.bets ? `needs ${GATE.bets} bets` : ev.edge.p >= GATE.p && Math.abs(ev.edge.edge) >= GATE.edge ? confidenceOf(ev.edge.p) : 'not clear yet');
const chance = (p) => `${Math.round(p * 100)}% chance`;

// The evidence behind each kind of idea a week later: the stock-specific edge with its likely range,
// and in the table what it's made of (vs the index, from beta, fees) and the money made per trade.
function edgeChart(pb, ccy) {
  const groups = [
    ...Object.entries(pb?.stats?.byOutcome ?? {}).map(([k, v]) => ({ label: OUTCOME_LABELS[k] ?? k, ev: v.ev })),
    ...Object.entries(pb?.stats?.tradedByType ?? {}).map(([k, v]) => ({ label: `Traded: ${IDEA_LABELS[k] ?? k}`, ev: v.ev })),
  ].filter((g) => g.ev?.edge);
  if (!groups.length) return '';
  const range = (e) => `${pct(e.lo)} to ${pct(e.hi)}`;
  const leftOver = (ev) => ev.vsIndex - ev.fromBeta + ev.fees; // before it's pulled towards 0
  return chartSlot((el) => rangeBars(el, groups.map(({ label, ev }) => ({
    label, sub: `${plural(ev.bets, 'separate bet')} · ${groupConfidence(ev)}`,
    value: ev.edge.edge * 100, lo: ev.edge.lo * 100, hi: ev.edge.hi * 100, display: pct(ev.edge.edge),
    tip: [
      { value: pct(ev.edge.edge), label: 'stock-specific edge a week' }, { value: range(ev.edge), label: 'likely range' },
      { value: pct(ev.vsIndex), label: 'vs the index' }, { value: pct(ev.fromBeta), label: 'of that from beta' },
      ...(ev.fees ? [{ value: pct(ev.fees), label: 'fees' }] : []),
      { value: pct(leftOver(ev)), label: 'left over, before it\'s pulled towards 0' },
      { value: String(ev.bets), label: `separate bets (of ${plural(ev.ideas, 'idea')})` }, { value: chance(ev.edge.p), label: 'that the edge has this sign' },
      ...(ev.money != null ? [{ value: money(ev.money, ccy, { sign: true }), label: 'made per trade after fees' }] : []),
    ],
  })), { tickFmt: pctTick, ariaLabel: 'Stock-specific edge by kind of idea' }), {
    title: 'Its edge, a week later',
    caption: `What each kind of idea made a week later beyond what the market explains, per week, with its likely range (an 8-in-10 chance it's inside). Against the index = from beta (how much the stocks move with the market) + this stock-specific edge, minus fees. The edge is an estimate pulled towards zero when there are few bets, so it can be smaller than what's left over (in the Table). Ideas on the same stock and side within a week count as one separate bet. For ideas it didn't act on, right of 0 means it missed a gain; for exits and stop-losses, that the price kept going the position's way.`,
    key: 'fund-edge',
    table: tableToggle(['Ideas', 'Separate bets', 'vs index', 'From beta', 'Fees', 'Left over', 'Stock-specific edge (likely range)', 'Confidence', 'Per trade after fees'],
      groups.map(({ label, ev }) => [label, `${ev.bets} of ${ev.ideas}`, pct(ev.vsIndex), pct(ev.fromBeta), ev.fees ? pct(ev.fees) : '–', pct(leftOver(ev)), `${pct(ev.edge.edge)} (${range(ev.edge)})`, groupConfidence(ev), ev.money == null ? '–' : money(ev.money, ccy, { sign: true })]), 1, { className: 'wrap-head' }),
  });
}

// ----- AI fund: theses and calibration -----

const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

// "expects +6% in a month · results 23 Oct · wrong if NIM guidance is cut": an order's or position's
// thesis in words (thesis.js), plus what the code flagged. A short's moves read as the price's own:
// "expects a 6% fall in a month · so far a 1% rise".
function thesisWords(th, { soFar = null, short = false } = {}) {
  if (!th) return '';
  const parts = [
    th.expected != null && th.horizon ? `expects ${moveWords(th.expected / 100, short)} in ${HORIZON_LABELS[th.horizon]}` : '',
    th.catalyst && th.catalyst !== 'none' ? `${CATALYST_LABELS[th.catalyst] ?? th.catalyst}${th.catalystDate ? ` ${shortDate(th.catalystDate)}` : ''}${th.stale ? ` (over ${STALE_DAYS} trading days old)` : ''}` : '',
    soFar != null ? `so far ${moveWords(soFar, short)}` : '',
    th.wrongIf ? `wrong if ${th.wrongIf}` : '',
    th.beatsFees === false ? 'expected move under the round-trip fee' : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

// The thesis line under a fund position: what it expects, the catalyst, how it's doing, what would prove it wrong.
function positionThesisLine(f, p, quotes) {
  const th = positionThesis(f, p.symbol, p.short ? 'short' : 'long');
  if (!th) return '';
  const { daysLeft, soFar } = thesisProgress(th, { price: p.price, short: p.short, quote: quotes[p.symbol] });
  const left = daysLeft == null ? '' : daysLeft >= 0 ? ` · ${plural(daysLeft, 'trading day')} left` : ' · past its horizon';
  return `<span class="thesis small">${esc(thesisWords(th, { soFar, short: p.short }))}${left}</span>`;
}

// Every lesson the fund could have cited, by id: its own, the review's, calibration's, the factor lab's, the rule-made
// ones and the market memory's, and the wording of lessons it cited that have since gone
// (fund.citedLessons, learning.js rememberCited).
function lessonsById(f, c) {
  const pb = f.playbook ?? {};
  const market = marketForCurrency(f.currency);
  const memory = [...(c.marketMemory?.[market]?.lessons ?? []), ...(state.longMemory?.markets?.[market]?.lessons ?? [])];
  return new Map([...Object.entries(f.citedLessons ?? {}), ...[...(pb.own ?? []), ...(pb.review ?? []), ...(pb.calibrationLessons ?? []), ...(pb.conditionLessons ?? []), ...(pb.lessons ?? []), ...memory].map((l) => [l.id, l.text])]);
}

// The lessons an order or idea says it applied, as chips (the text on hover). An unknown entry that
// looks like a lesson id (no spaces) is a lesson no longer known: "an earlier lesson", its id on hover;
// anything else is text the AI quoted, shown as written.
const looksLikeId = (x) => !/\s/.test(x) && /[:-]/.test(x);
function citedChips(ids, known) {
  if (!ids?.length) return '';
  return ids.map((id) => {
    const text = known.get(id) ?? (looksLikeId(id) ? null : id);
    if (text == null) return `<span class="chip lesson-chip" title="${esc(id)}">applied: an earlier lesson</span>`;
    return `<span class="chip lesson-chip" title="${esc(text)}">applied: ${esc(text.length > 44 ? `${text.slice(0, 43)}…` : text)}</span>`;
  }).join('');
}

// Expected against realised, by conviction, horizon and catalyst: each thesis at its own horizon, in
// separate bets, and the result against the index at 5, 21 and 63 trading days (horizon fit).
function calibrationTable(pb, pooled) {
  const cal = pb?.calibration;
  if (!cal?.all) return '';
  const rows = [];
  const row = (label, g) => { if (g) rows.push([label, g]); };
  row('All its orders', cal.all);
  for (const k of ['high', 'medium', 'low']) row(`Conviction: ${k}`, cal.byConviction?.[k]);
  for (const h of [5, 21, 63]) row(`Horizon: ${HORIZON_LABELS[h]}`, cal.byHorizon?.[h]);
  row('Catalyst: results', cal.byCatalyst?.results);
  row('Catalyst: anything else', cal.byCatalyst?.other);
  row(`Catalyst over ${STALE_DAYS} trading days old`, cal.stale);
  if (pooled?.funds >= 2) row(`${pooled.funds === 2 ? 'Both' : `All ${pooled.funds}`} funds in this market`, pooled.all);
  const pctT = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`;
  const at = (g, k) => (g.at?.[k] == null ? '–' : pctT(g.at[k]));
  const notes = [
    cal.formulaic ? `Its expected moves are formulaic (they vary by only ${cal.sdExpected.toFixed(1)} points), so they can't be judged.` : '',
    cal.catalystChecked?.ideas ? `Where code could check (results and dividends), the catalyst came within the idea's horizon in ${cal.catalystChecked.passed} of ${cal.catalystChecked.ideas}.` : '',
    cal.fees?.ideas ? `In ${cal.fees.notCovered} of ${cal.fees.ideas} orders the expected move didn't cover the round-trip fee.` : '',
  ].filter(Boolean).join(' ');
  return `<h3 class="col-head cal-head">Calibration: what it expected against what happened</h3>
    <p class="small muted">Each order's thesis (the move it expected, in its direction, before fees) against the move at its own horizon, dividends included, in separate bets. The last three columns are the result against the index after 5, 21 and 63 trading days: if a later one is better, ideas are paying later than the AI thought. A lesson needs ${CALIBRATION.minBets} separate bets (${CALIBRATION.groupBets} for comparing kinds of ideas). ${esc(notes)}</p>
    <div class="table-wrap"><table class="calibration">
      <thead><tr><th>Ideas</th><th class="num"><span class="hide-sm">Separate bets</span><span class="show-sm">Bets</span></th><th class="num"><span class="hide-sm">Expected</span><span class="show-sm">Exp.</span></th><th class="num"><span class="hide-sm">Realised</span><span class="show-sm">Got</span></th><th class="num hide-sm">vs index</th><th class="num hide-sm">At 5 days</th><th class="num hide-sm">At 21</th><th class="num hide-sm">At 63</th></tr></thead>
      <tbody>${rows.map(([label, g]) => `<tr><td>${esc(label)}</td><td class="num">${g.bets}</td><td class="num">${pctT(g.expected)}</td>
        <td class="num ${tone(g.realised)}">${pctT(g.realised)}</td><td class="num hide-sm ${g.vsIndex == null ? '' : tone(g.vsIndex)}">${g.vsIndex == null ? '–' : pctT(g.vsIndex)}</td>
        <td class="num hide-sm">${at(g, 'week')}</td><td class="num hide-sm">${at(g, 'month')}</td><td class="num hide-sm">${at(g, 'quarter')}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// ----- AI fund: lessons you can check (learning.js, the lesson book) -----

const TRACK_CHIP = { held: 'held', 'didnt-hold': 'warn' };
const shareOf = ([k, n]) => `${Math.round((k / n) * 100)}%`;

// The behaviour check in words: "Trades (news): 40% of its trades before it was learned (12 of 30),
// 15% since (3 of 20)."
function behaviourWords(filter, { before, after }, when = 'it was learned') {
  const what = filterWords(filter), among = behaviourBase(filter);
  if (!before[1] && !after[1]) return '';
  if (!before[1]) return `${what}: ${shareOf(after)} of ${among} since ${when} (${after[0]} of ${after[1]}).`;
  return `${what}: ${shareOf(before)} of ${among} before ${when} (${before[0]} of ${before[1]}), ${after[1] ? `${shareOf(after)} since (${after[0]} of ${after[1]})` : 'none since yet'}.`;
}

// Under each lesson: when it was learned and on how much evidence, how it has done on the ideas since
// (a lesson with a filter), whether the AI's ideas changed, and how often it was cited; for the weekly
// review's opinions, that they aren't checked and when they expire. `e`: its lesson book record.
function sinceLearned(l, e, { opinion = false, kept = false, admin = false } = {}) {
  if (opinion) {
    const born = l.bornAt ?? e?.bornAt;
    const until = born ? fmtDate(Date.parse(born) + BOOK.opinionDays * 86400000) : null;
    const fate = kept ? 'you kept it, so it doesn\'t expire' : `it expires${until ? ` on ${until}` : ` ${BOOK.opinionDays / 7} weeks after the review that wrote it`} unless you keep it`;
    const words = born ? `From the review of ${fmtDate(born)}; ${fate}.` : `${fate.charAt(0).toUpperCase()}${fate.slice(1)}.`;
    return `<br><span class="small since">Opinion, not checked: it's about all its ideas, so no data can check it. ${esc(words)}</span>`;
  }
  if (!e?.bornAt) return '';
  const learned = `${l.source === 'owner' ? 'Added' : 'Learned'} ${fmtDate(e.bornAt)}`;
  const per = e.measure === 'peers' ? `a week against ${l.vs ?? 'its peers'}` : 'a week';
  const parts = [];
  if (!e.filter) parts.push(`${learned}.`);
  else {
    const then = e.inSample?.bets ? `${plural(e.inSample.bets, 'separate bet')}, ${pct(e.inSample.edge)} ${per}` : null;
    if (l.source === 'owner') {
      // what an owner's lesson is checked as (the dropdowns' choice), which decides whether it held
      parts.push(`Tracked as: ${filterWords(e.filter)} do ${e.claim === 'better' ? 'better' : 'worse'} than the market explains.`);
      parts.push(then ? `${learned}; its ideas like this until then: ${then}.` : `${learned}, when none of its graded ideas were like this.`);
    } else parts.push(then ? `${learned} from ${then}.` : `${learned}.`);
    const n = e.since?.bets ?? 0;
    parts.push(n ? `Since then: ${plural(n, 'new separate bet')}, ${pct(e.since.edge)} ${per}${n < BOOK.newBets ? ` (it takes ${BOOK.newBets} to tell)` : ''}.` : 'No new separate bets since.');
    if (e.behaviour) parts.push(behaviourWords(e.filter, e.behaviour, l.source === 'owner' ? 'you added it' : 'it was learned'));
  }
  if (e.cited) parts.push(`Cited in its decisions ${plural(e.cited, 'time')}.`);
  const failed = e.filter && e.status === 'didnt-hold' ? ` <strong>Didn't hold on new data.</strong> ${admin ? 'Remove it?' : 'Its owner decides whether to remove it.'}` : '';
  return `<br><span class="small since">${esc(parts.filter(Boolean).join(' '))}${failed}</span>`;
}

// "Of the 14 lessons it has had that can be checked, 5 held on new data, 3 didn't, 2 aren't clear yet and
// 4 are too early to tell." Only lessons with a filter can be checked; the review's opinions and the
// proposals its check dropped (with why) are counted too.
function trackRecordLine(pb) {
  const t = pb?.trackRecord;
  if (!t || !(t.lessons || t.opinions || t.dropped)) return '';
  const one = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  const bits = [
    // "didn't" alone only after "held on new data"
    t.held && `${t.held} held on new data`, t['didnt-hold'] && `${t['didnt-hold']} ${t.held ? 'didn\'t' : 'didn\'t hold on new data'}`,
    t.unclear && one(t.unclear, 'isn\'t clear yet', 'aren\'t clear yet'), t['too-early'] && one(t['too-early'], 'is too early to tell', 'are too early to tell'),
  ].filter(Boolean);
  const list = bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}` : bits[0];
  const status = ['held', 'didnt-hold', 'unclear', 'too-early'].find((k) => t[k]);
  const parts = [
    t.lessons === 1 && status ? `Its one lesson that can be checked: ${TRACK_LABELS[status]}.` : t.lessons ? `Of the ${plural(t.lessons, 'lesson')} it has had that can be checked, ${list}.` : '',
    t.opinions ? `${one(t.opinions, 'opinion from the weekly review wasn\'t', 'opinions from the weekly review weren\'t')} checked.` : '',
    t.dropped ? `The check dropped ${one(t.dropped, 'lesson the weekly review proposed', 'lessons the weekly review proposed')}${droppedWords(t.droppedFor)}.` : '',
  ];
  return `<p class="small track-record"><strong>Track record:</strong> ${esc(parts.filter(Boolean).join(' '))}</p>`;
}

// The owner's lesson being written, read from the form, so it survives the page re-rendering around it.
function lessonDraft() {
  const form = $('lesson-form');
  if (!form) return state.lessonDraft;
  return {
    fund: form.dataset.fund, text: $('lesson-text').value, open: $('lesson-filter')?.open ?? false,
    filter: Object.fromEntries(FILTER_KEYS.map((k) => [k, $(`lesson-${k}`)?.value ?? 'any'])), claim: $('lesson-claim')?.value ?? 'worse',
  };
}
for (const type of ['input', 'change']) document.addEventListener(type, (e) => { if (e.target.closest?.('#lesson-form')) state.lessonDraft = lessonDraft(); });
document.addEventListener('input', (e) => { if (e.target.id === 'stock-note-text') state.noteDraft = { symbol: e.target.closest('form')?.dataset.symbol, text: e.target.value }; });
document.addEventListener('input', (e) => {
  if (!e.target.closest?.('#reading-form')) return;
  state.readingDraft = { url: $('reading-url').value, text: $('reading-text').value };
  $('reading-error').textContent = '';
  $('reading-left').textContent = readingLeft(state.readingDraft.text);
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'ask-text') return;
  state.askDraft = e.target.value;
  $('ask-error').textContent = '';
  $('ask-left').textContent = askLeft(e.target.value);
});
document.addEventListener('toggle', (e) => { if (e.target.id === 'lesson-filter') state.lessonDraft = lessonDraft(); }, true);

// Words for the dropdowns that say which of its ideas an owner's lesson is about (learning.js FILTER_VALUES).
const FILTER_LABELS = {
  outcome: ['Ideas', { any: 'Any idea', traded: 'Trades it made', declined: 'Trades you declined', expired: 'Proposals that expired', blocked: 'Orders its limits blocked', passed: 'Ideas it passed on', exit: 'Its exits', 'stop-loss': 'Stop-losses', 'take-profit': 'Take-profits' }],
  idea_type: ['Kind', { any: 'Any kind', ...IDEA_LABELS }],
  direction: ['Side', { any: 'Either side', long: 'Long', short: 'Short' }],
  symbol: ['Stock', { any: 'Any stock' }],
  conviction: ['Conviction', { any: 'Any conviction', low: 'Low', medium: 'Medium', high: 'High' }],
  horizon: ['Horizon it gave', { any: 'Any horizon', week: 'A week', month: 'A month', quarter: 'A quarter' }],
  catalyst_type: ['Catalyst', { any: 'Any catalyst', ...CATALYST_LABELS, none: 'No dated catalyst' }],
};

// The form for the owner's own lesson: the words, and optionally which of its ideas it's about and
// whether they do better or worse, so it's tracked like the others.
function lessonForm(f) {
  const d = state.lessonDraft?.fund === f.id ? state.lessonDraft : null;
  const quotes = state.prices.quotes ?? {};
  const symbols = Object.keys(quotes).filter((x) => quotes[x].currency === f.currency && !quotes[x].etf).sort();
  const pick = (k) => {
    const [label, words] = FILTER_LABELS[k];
    const values = k === 'symbol' ? ['any', ...symbols] : FILTER_VALUES[k];
    const now = d?.filter?.[k] ?? 'any';
    const word = (v) => { const x = words[v] ?? v; return k === 'symbol' ? x : x.charAt(0).toUpperCase() + x.slice(1); };
    return `<label>${esc(label)}<select id="lesson-${k}">${values.map((v) => `<option value="${esc(v)}"${v === now ? ' selected' : ''}>${esc(word(v))}</option>`).join('')}</select></label>`;
  };
  const claim = d?.claim ?? 'worse';
  return `<form id="lesson-form" class="lesson-form" data-fund="${esc(f.id)}">
    <div class="row"><input id="lesson-text" maxlength="300" value="${esc(d?.text ?? '')}" placeholder="Add your own lesson, e.g. Avoid airlines before their results" aria-label="Your lesson"><button type="submit" class="ghost small-btn">Add</button></div>
    <details id="lesson-filter" class="lesson-filter"${d?.open ? ' open' : ''}><summary>Track it (optional): which of its ideas it's about</summary>
      <div class="lesson-filter-grid">${FILTER_KEYS.map(pick).join('')}
        <label class="claim">Those ideas<select id="lesson-claim"><option value="worse"${claim === 'worse' ? ' selected' : ''}>do worse than the market explains</option><option value="better"${claim === 'better' ? ' selected' : ''}>do better than the market explains</option></select></label></div>
      <p class="small muted">With at least one choice made, the page shows how those ideas did before you added it and since, and whether the AI's share of them changed. The AI sees only your words.</p>
    </details>
  </form>`;
}

// ----- AI fund: your calls (learning.js declinedByReason) -----

// How the trades you declined would have done, by the reason you gave: how many would have lost money
// (you were right) a week and a month later, after fees, and what they'd have made against the index.
// The public copy of the fund leaves the reasons out (scripts/public-fund.mjs); there, an admin is told
// where to find them instead.
function callsTable(f) {
  const pb = f.playbook;
  const calls = pb?.stats?.declinedByReason;
  const head = (words) => `<h3 class="col-head calls-head">${words}</h3>`;
  if (!calls) {
    const declined = pb?.stats?.byOutcome?.declined; // graded declines: their reasons aren't in this copy
    return declined && authEnabled && state.user?.isAdmin
      ? `${head('Your calls')}<p class="small muted">Your reasons for declining its trades are left out of the public copy of the fund, so they aren't shown here. They're in its weekly report on Telegram, and here too if you keep the fund private (README: Keeping the AI fund private).</p>` : '';
  }
  const rows = Object.entries(calls).sort(([a, x], [b, y]) => Number(a === 'none') - Number(b === 'none') || y.ideas - x.ideas || a.localeCompare(b));
  if (!rows.length) return '';
  const right = (h) => (h ? `${h.right} of ${h.n}` : '–');
  const vs = (h) => (h?.vsIndex == null ? '–' : pct(h.vsIndex));
  const both = (long, short) => `<span class="hide-sm">${long}</span><span class="show-sm">${short}</span>`;
  return `${head('Your calls: the trades you declined')}
    <p class="small muted">How the trades you declined would have done, by the reason you gave. You were right when the trade would have lost money by then, after fees; "vs index" is what it would have made against the index, after fees (for a sale you declined, right means the stock kept going the position's way). The same stock and side within a week count once in separate bets. A reason reaches the AI once you've used it ${DECLINE_MIN_CASES} times, as your preferences and record, not as a rule.</p>
    <div class="table-wrap"><table class="calls">
      <thead><tr><th>You said</th><th class="num">Declined</th><th class="num">${both('Right a week later', 'Right, a week')}</th><th class="num">${both('vs index', 'vs index')}</th><th class="num hide-sm">Right a month later</th><th class="num hide-sm">vs index</th></tr></thead>
      <tbody>${rows.map(([why, c]) => `<tr><td>${esc(why === 'none' ? 'no reason given' : DECLINE_REASONS[why] ?? why)}${why !== 'none' && c.ideas >= DECLINE_MIN_CASES ? '<span class="chip">the AI sees it</span>' : ''}</td>
        <td class="num">${c.ideas}<br><span class="muted small">${plural(c.bets, 'separate bet')}</span></td>
        <td class="num">${right(c.week)}</td><td class="num">${vs(c.week)}</td>
        <td class="num hide-sm">${right(c.month)}</td><td class="num hide-sm">${vs(c.month)}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function renderLearning(f, c) {
  const pb = f.playbook;
  const on = f.settings?.learning !== false;
  const admin = authEnabled && state.user?.isAdmin;
  const owner = state.user?.isAdmin || !authEnabled;
  const market = marketForCurrency(f.currency);
  const memory = c.marketMemory?.[market];
  const hidden = new Set(pb?.hidden ?? []);
  const lessons = activeLessons(pb);
  const yearOnes = yearLessons(memory, state.longMemory, market); // the past year's big-move lessons give way to the ten-year ones
  const marketLessons = yearOnes.filter((l) => !hidden.has(l.id));
  const kept = new Set(pb?.kept ?? []);
  // each lesson with its status (how it has done since it was learned, an opinion not checked, or for a
  // lesson that compares other things, or one of yours without a filter, not checked on new data), its
  // numbers, the "since learned" line and its evidence; the market memory's have no record here
  const unchecked = (l) => (l.source === 'owner' ? 'Without the ideas it\'s about (Track it, when you add a lesson), it isn\'t checked on the ideas after it.'
    : 'It compares its ideas in another way (such as expected against realised moves, or against the market\'s part), so it isn\'t checked on the ideas after it.');
  const lessonItem = (l) => {
    const e = pb?.lessonBook?.[l.id];
    const opinion = l.source === 'weekly review' && lessonKind(l) === 'opinion';
    const status = opinion ? ['opinion, not checked', ''] : e?.filter ? [TRACK_LABELS[e.status ?? 'too-early'], TRACK_CHIP[e.status] ?? '']
      : l.source !== 'market memory' ? ['not checked on new data', '', unchecked(l)] : null;
    const when = l.condition ? `<span class="chip" title="A lesson from When its ideas work reaches the AI only while its condition holds.">the AI sees it ${esc(conditionWords(l.condition, market))}</span>` : '';
    return `<li><strong>${esc(l.text)}</strong><span class="chip">${esc(LESSON_SOURCE[l.source] ?? l.source)}</span>${when}${status ? `<span class="chip ${status[1]}"${status[2] ? ` title="${esc(status[2])}"` : ''}>${esc(status[0])}</span>` : ''}${l.confidence ? `<span class="chip">${esc(l.confidence)} confidence</span>` : ''}
      ${l.confidence ? `<br><span class="small">${esc(measureLabel(l))} ${pct(l.edge)} a week, likely ${pct(l.lo)} to ${pct(l.hi)}, from ${plural(l.bets, 'separate bet')}${l.stockEdge != null ? `; stock-specific edge ${pct(l.stockEdge)}` : ''}.</span>${trendLine(lessonTrend(pb, l.id), lessonName(l.text))}` : ''}
      ${sinceLearned(l, e, { opinion, kept: kept.has(l.id), admin })}
      ${l.evidence ? `<br><span class="muted small">${esc(opinion ? `The review's words, not checked: ${l.evidence}` : l.evidence)}</span>` : ''}
      ${admin ? ` <span class="lesson-actions">${opinion && !kept.has(l.id) ? `<button type="button" class="ghost small-btn" data-lesson-keep="${esc(l.id)}">Keep</button> ` : ''}<button type="button" class="ghost small-btn" data-lesson-remove="${esc(l.id)}">Remove</button></span>` : ''}</li>`;
  };
  const watching = owner ? (pb?.watching ?? []).filter((w) => !hidden.has(w.id)) : [];
  const known = lessonsById(f, c); // every lesson that can be removed, calibration's included
  const hiddenList = [...hidden].filter((id) => known.has(id));
  const noise = `Checked on pure noise: of ${NOISE_CHECK.sims} made-up funds with no skill at all, ${Math.round(NOISE_CHECK.any * 100)}% showed a false lesson at some point in half a year, and ${Math.round(NOISE_CHECK.moreThanOne * 100)}% more than one. The calibration rules, on ${CAL_NOISE_CHECK.sims} made-up funds whose expected moves were honest: ${Math.round(CAL_NOISE_CHECK.any * 100)}% showed a false calibration lesson, ${Math.round(CAL_NOISE_CHECK.moreThanOne * 100)}% more than one.`;
  return `<section class="panel">
    <div class="panel-head"><h2>What it has learned</h2><span class="chip">${on ? 'learning on' : 'learning off (for comparison)'}</span></div>
    <p class="small muted">Every idea is graded against what prices did afterwards: trades it made, trades you declined or its limits blocked, ideas it passed on, and its exits and stop-losses.
      Dividends count, fees count, and the part of a result that just reflects how much the stocks move with the market (their beta) is taken out, leaving the stock-specific edge.
      ${on ? 'These lessons are shown to the AI at every decision.' : 'This fund doesn\'t use them, so it shows whether learning helps.'}
      ${pb ? `${plural(pb.graded, 'idea')} graded so far${pb.reviewedAt ? `; last weekly review ${fmtDate(pb.reviewedAt)}` : ''}.` : ''}
      A lesson needs at least ${GATE.bets} separate bets (the same stock and side within a week counts once), an edge of ${(GATE.edge * 100).toFixed(1)}% a week or more, and a ${Math.round(GATE.p * 100)}% chance that the edge is on that side of zero (above or below); it stays until that chance falls below ${Math.round(GATE.keep * 100)}%. The weekly review needs ${REVIEW_MIN_NEW} newly graded ideas. ${noise}</p>
    <p class="small muted">Most lessons say which of its ideas they're about, and are checked again on the ideas that came after they were learned: once there are ${BOOK.newBets} new separate bets, a lesson <em>held on new data</em> if they give a ${Math.round(BOOK.p * 10)}-in-10 chance that it's right, and <em>didn't hold</em> if they give that chance the other way (on made-up funds with no skill, ${(HOLD_NOISE.held * 100).toFixed(1)}% of lessons showed as held and ${(HOLD_NOISE.didntHold * 100).toFixed(1)}% as didn't hold, by chance). Nothing is removed for that: you decide. The weekly review's lessons are checked on its graded ideas before they're kept, with the numbers worked out here rather than the review's; one about all its ideas can't be checked, so it's an opinion that expires after ${BOOK.opinionDays / 7} weeks unless you keep it.</p>
    ${trackRecordLine(pb)}
    ${lessons.length ? `<ul class="lessons">${lessons.map(lessonItem).join('')}</ul>` : `<p class="muted">No lessons yet: ideas are graded once a week of trading has passed, and a lesson needs ${GATE.bets} separate bets with a clear edge. Expect this to take months.</p>`}
    ${(() => {
      const rows = lessons.map((l) => ({ name: lessonName(l.text), points: lessonTrend(pb, l.id) })).filter((r) => r.points.length >= 2);
      return rows.length ? `<p class="small muted trend-note">The small line under a lesson's numbers is its number per week at each weekly report (up to ${REPORT.historyWeeks} weeks), with zero marked.</p>${trendTable(rows, `lesson-trends-${f.id}`)}` : '';
    })()}
    ${watching.length ? `<details class="fund-new"><summary>Watching (${watching.length})</summary><ul class="lessons">${watching.map((w) => `<li>${esc(w.text)}
      <br><span class="muted small">${chance(w.p)} so far, edge ${pct(w.edge)} a week, ${plural(w.bets, 'separate bet')}${w.more ? `: about ${plural(w.more, 'more bet')} needed` : ''}.</span></li>`).join('')}</ul>
      <p class="muted small">Patterns on their way to becoming lessons, shown only to you. The AI doesn't see them.</p></details>` : ''}
    ${admin ? lessonForm(f) : ''}
    ${hiddenList.length && admin ? `<p class="small muted">Removed lessons: ${hiddenList.map((id) => `<button type="button" class="ghost small-btn" data-lesson-restore="${esc(id)}" title="${esc(known.get(id))}">Restore: ${esc(known.get(id).slice(0, 50))}${known.get(id).length > 50 ? '…' : ''}</button>`).join(' ')}</p>` : ''}
    ${edgeChart(pb, f.currency)}
    ${calibrationTable(pb, c.calibration?.[market])}
    ${pb?.recent?.length ? `<details class="fund-new"><summary>Latest graded ideas</summary><ul class="orders">${pb.recent.slice(0, 15).map((g) => `<li>${fmtDate(g.time)}:
      <span class="chip ${g.action === 'buy' || g.action === 'cover' ? 'buy' : 'sell'}">${esc(g.action)}</span> ${esc(g.symbol)} <span class="muted small">(${esc(OUTCOME_LABELS[g.outcome] ?? g.outcome)}, ${esc(IDEA_LABELS[g.ideaType] ?? g.ideaType)}${g.repeats > 1 ? `, came up ${g.repeats} times that week` : ''})</span>
      · a week later ${moveCell(g.week)} · a month later ${moveCell(g.month)}${g.quarter ? ` · a quarter later ${moveCell(g.quarter)}` : ''}${g.thesis?.expected != null && g.thesis.horizon ? ` <span class="muted small">(expected ${moveWords(g.thesis.expected / 100, g.action === 'short')} in ${HORIZON_LABELS[g.thesis.horizon]})</span>` : ''}${g.reason ? `<br><span class="muted small">${esc(g.reason)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
  </section>
  ${renderFactorLab(f, c)}
  <section class="panel">
    <div class="panel-head"><h2>${esc(MARKETS[market].label)} market memory</h2></div>
    <p class="small muted">How ${esc(MARKETS[market].label)} stocks have moved after company news and after big one-day moves over the past year, measured from prices (not the AI's opinion). Every fund trading ${esc(MARKETS[market].label)} stocks sees these.
      ${memory ? `${memory.events} news event${memory.events === 1 ? '' : 's'} and ${memory.bigMoves} big moves measured.` : ''}
      ${yearOnes.length < (memory?.lessons ?? []).length ? 'Its lessons on big one-day moves give way to the ten-year study below, which has far more cases.' : ''}</p>
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
    ${moveNewsSection(memory?.moveNews, market)}
    ${memory?.recent?.length ? `<details class="fund-new"><summary>Latest news measured</summary><ul class="orders">${memory.recent.slice(0, 15).map((e) => `<li>${esc(e.date)} <strong>${esc(e.symbol)}</strong> ${esc(e.headline)}
      <span class="muted small">(${esc(e.tone)} ${esc(e.type)}${e.from === 'filing' ? ', SEC filing' : e.from === 'yahoo' ? ', Yahoo Finance' : ''})</span> · on the day ${e.day ? `<span class="${tone(e.day.move)}">${pct(e.day.move)}</span>` : '–'} · next week ${moveCell(e.week)}</li>`).join('')}</ul>
      <p class="muted small">Moves are shown in the direction of the news: + means the price went the way the news pointed. US results come from the companies' SEC filings when those are set up.</p></details>` : ''}
    ${renderRatingChanges(market)}
    ${!memory?.events ? `<p class="small">To fill this in from the past year's news (one-off, about US$1–2), run ${repoActionsUrl() ? `<a href="${repoActionsUrl()}" target="_blank" rel="noopener">Actions → Update prices, AI picks and AI fund</a>` : 'Actions → Update prices, AI picks and AI fund'} → Run workflow with <em>Learning: look up the past year of news</em> ticked. New news is added every day by itself.</p>` : ''}
  </section>
  ${renderLongMemory(market, { hidden, admin })}`;
}

// ----- AI fund: the factor and regime lab (factors.js) -----

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const share100 = (x) => `${Math.round(x * 100)}%`;
const STYLE_FACTORS = ['move1m', 'ma50', 'high52', 'volume20'];
const STYLE_SHORT = { move1m: 'the month\'s move for its volatility', ma50: 'price against its 50-day average', high52: 'nearness to its 52-week high', volume20: 'volume against its 20-day average' };
// the same, short enough for a chart row on a phone (the table and the sentences say it in full)
const STYLE_CHART = { move1m: 'month\'s move vs usual', ma50: 'vs 50-day average', high52: 'near 52-week high', volume20: 'volume vs 20-day avg.' };
const LAB_WHY = {
  bets: `each side needs ${LAB.bets} separate bets`, weeks: `each side needs bets from ${LAB.weeks} different weeks`, episodes: `each side needs ${LAB.episodes} separate episodes`,
  t: 'the difference isn\'t clear of noise', halves: 'the difference isn\'t the same in both halves of the record',
};
const SPLIT_NAMES = { results: ['In the 5 trading days before results', 'other ideas'], index: ['Index below its 200-day average', 'above it'], vix: ['VIX stressed (over 25)', 'calm (under 16)'] };

// A style factor's average: a volume ratio as "1.02x", the month's move in typical months as "+0.17",
// the rest as percentages.
const styleValue = ({ k, avg }) => (avg == null ? '–' : k === 'volume20' ? `${avg.toFixed(2)}x` : k === 'move1m' ? `${avg > 0 ? '+' : avg < 0 ? '−' : ''}${Math.abs(avg).toFixed(2)}` : pct(avg));

// "Its buys (14 since 6 Oct) sat at the 78th percentile of its market's stocks on the month's move for
// its volatility, ...": where the stocks it chose sat among its market's, at the time.
function styleWords(st, what, index) {
  const ranked = STYLE_FACTORS.filter((k) => st.percentile[k] != null);
  const parts = ranked.map((k, i) => `${i ? '' : 'the '}${ordinal(st.percentile[k])}${i ? '' : ` percentile of its market's stocks`} on ${STYLE_SHORT[k]}`);
  const avgHigh = st.average.high52 != null ? ` and ${Math.abs(st.average.high52 * 100).toFixed(1)}% below their 52-week high on average` : '';
  const shares = [st.beforeResults != null ? `${share100(st.beforeResults)} were opened in the ${LAB.window} trading days before results` : '', st.indexAbove != null ? `${share100(st.indexAbove)} with ${index} above its 200-day average` : ''].filter(Boolean);
  return `Its ${what} (${plural(st.cases, 'case')}) ${parts.length ? `sat at ${parts.join(', ')}${avgHigh}` : 'can\'t be ranked against its market yet'}.${shares.length ? ` ${shares.join(', and ')}.` : ''} It called ${share100(st.topShare)} of them ${IDEA_LABELS[st.topType] ?? st.topType} ideas.`;
}

// The fund's revealed style (pb.style) and its market's "When its ideas work" (c.factorLab): each factor's
// buckets, fixed in advance, with the stock-specific edge a week later and how much evidence is behind
// it (greyed below PAGE_MIN_BETS separate bets); the three splits that can become lessons, and why each
// isn't one yet. Descriptive: only a split that passes every gate reaches the AI.
function renderFactorLab(f, c) {
  const market = marketForCurrency(f.currency);
  const lab = c.factorLab?.[market];
  const style = f.playbook?.style;
  const idx = indexName(BENCHMARKS[f.currency].symbol);
  const pooled = lab?.funds >= 2 ? `the ${lab.funds} ${f.currency} funds' ideas pooled` : 'its ideas';
  // its revealed style
  const sides = [['buys', style?.buys], ['shorts', style?.shorts]].filter(([, st]) => st);
  const styleRows = sides.flatMap(([what, st]) => STYLE_FACTORS.filter((k) => st.percentile[k] != null).map((k) => ({ what, k, p: st.percentile[k], avg: st.average[k] })));
  const styleChart = styleRows.length ? chartSlot((el) => hbars(el, styleRows.map((r) => ({
    label: `${r.what === 'buys' ? 'Buys' : 'Shorts'}: ${STYLE_CHART[r.k]}`, value: r.p, display: ordinal(r.p),
    tip: [{ label: `${r.what === 'buys' ? 'Buys' : 'Shorts'}: ${STYLE_SHORT[r.k]}` }, { value: ordinal(r.p), label: 'percentile among its market\'s stocks, on average' }, { value: styleValue(r), label: 'the average value' }],
  })), { ref: 50, refLabel: 'Middle', domain: [0, 100], tickFmt: (v) => String(v), ariaLabel: 'Where the stocks it chose sat among its market\'s' }), {
    title: 'Where its stocks sat among its market\'s',
    caption: 'The average percentile, at the time of each idea, of the stock it chose among its market\'s stocks (index funds left out): 0 the lowest that day, 100 the highest. Right of 50, it chose stocks higher on that measure than most.',
    key: `style-${f.id}`,
    table: tableToggle(['Measure', 'Percentile', 'Average value'], styleRows.map((r) => [`${r.what === 'buys' ? 'Buys' : 'Shorts'}: ${STYLE_SHORT[r.k]}`, ordinal(r.p), styleValue(r)])),
  }) : '';
  const styleHtml = `<h3 class="col-head">Its revealed style</h3>
    ${sides.length ? `<p class="small">${sides.map(([what, st]) => esc(styleWords(st, what, idx))).join(' ')}</p>` : '<p class="muted small">Not enough of its ideas have been graded yet: an idea counts from a week after it was made.</p>'}
    <p class="small muted">From the trades it made or proposed since ${style?.from ? esc(fmtDate(`${style.from}T12:00:00Z`)) : 'it started'} (not the ideas it passed on), one case per stock and side per ${CASE_DAYS} trading days, each measured from the prices before it. What it calls an idea (value, momentum...) is its own label; this is what it actually chose.</p>
    ${styleChart}`;
  // when its ideas work
  const groups = ['results', 'index200', market === 'US' ? 'vix' : 'usdsgd1m', 'move1m', 'ma50', 'high52', 'volume20']
    .map((key) => ({ key, rows: (lab?.rows ?? []).filter((r) => r.key === key) })).filter((g) => g.rows.length);
  const bucketName = (r) => BUCKETS[r.key][r.bucket]?.label ?? '';
  // bets and weeks fit beside a phone's bars; the episodes are in the tooltip and the table
  const rowWords = (r) => `${plural(r.bets, 'bet')} · ${plural(r.weeks, 'week')}`;
  const range = (r) => (r.lo == null ? '–' : `${pct(r.lo)} to ${pct(r.hi)}`);
  const allRows = groups.flatMap((g) => g.rows);
  const works = allRows.length ? chartSlot((el) => {
    el.innerHTML = `<div class="lab-grid">${groups.map((g, i) => `<div class="lab-cell"><h4 class="lab-title">${esc(FACTOR_LABELS[g.key])}</h4><div class="lab-chart" data-lab="${i}"></div></div>`).join('')}</div>`;
    groups.forEach((g, i) => hbars(el.querySelector(`[data-lab="${i}"]`), g.rows.map((r) => ({
      label: bucketName(r), sub: rowWords(r), value: r.mean * 100, display: pct(r.mean), muted: r.bets < PAGE_MIN_BETS,
      tip: [{ value: pct(r.mean), label: 'edge a week later, after beta and fees' }, { value: range(r), label: 'likely range' },
        { value: String(r.n), label: 'cases' }, { value: String(r.bets), label: `separate bets${r.bets < PAGE_MIN_BETS ? ` (under ${PAGE_MIN_BETS}: too few to read much into)` : ''}` },
        { value: `${r.weeks} / ${r.episodes}`, label: 'weeks / episodes' }, { value: share100(r.right), label: 'of bets made money after fees' }],
    })), { signColors: true, tickFmt: pctTick, ariaLabel: FACTOR_LABELS[g.key] }));
  }, {
    title: 'The edge a week later, by condition',
    caption: `What its ideas made a week later beyond what the market explains (after beta and fees), per week, in each bucket fixed in advance. Grey rows have fewer than ${PAGE_MIN_BETS} separate bets: too few to read much into.`,
    key: `lab-${market}`,
    table: tableToggle(['Condition', 'Cases', 'Separate bets', 'Weeks', 'Episodes', 'Edge a week later', 'Likely range', 'Made money'],
      allRows.map((r) => [`${FACTOR_LABELS[r.key]}: ${bucketName(r)}`, String(r.n), String(r.bets), String(r.weeks), String(r.episodes), pct(r.mean), range(r), share100(r.right)]), 1,
      { className: 'wrap-head', rowClass: (_, i) => (allRows[i].bets < PAGE_MIN_BETS ? 'muted-row' : '') }),
  }) : '';
  const splitLine = (sp) => {
    const [a, b] = sp.sides, [na, nb] = SPLIT_NAMES[sp.id];
    const counts = `${esc(na)}: ${plural(a.bets ?? 0, 'separate bet')}${a.bets ? ` from ${plural(a.weeks, 'week')}` : ''}; ${esc(nb)}: ${plural(b.bets ?? 0, 'separate bet')}${b.bets ? ` from ${plural(b.weeks, 'week')}` : ''}`;
    const diff = sp.diff != null ? ` Difference ${pct(sp.diff)} a week, ${Math.abs(sp.t).toFixed(1)} times what noise alone would usually give.` : '';
    return `<li>${counts}.${diff} <span class="chip ${sp.passes ? 'held' : ''}">${sp.passes ? 'a lesson' : `not a lesson: ${esc(LAB_WHY[sp.why] ?? '')}`}</span></li>`;
  };
  const worksHtml = `<h3 class="col-head">When its ideas work</h3>
    <p class="small muted">${lab?.cases ? `${plural(lab.cases, 'case')} from ${esc(pooled)} since ${esc(fmtDate(`${lab.from}T12:00:00Z`))}` : 'No graded ideas with their conditions yet'}: trades made or proposed, one case per fund, stock and side per ${CASE_DAYS} trading days, each with the conditions measured from the prices before it and graded a week later. Separate bets count the same stock and side within a week once; episodes are separate spells of a condition (for results, separate stocks' quarters).</p>
    ${works}
    <p class="small muted">Only three comparisons, fixed in advance, can become lessons for the AI. Each side needs ${LAB.bets} separate bets from ${LAB.weeks} different weeks and ${LAB.episodes} separate episodes, the difference at least ${LAB.t} times what noise alone would usually give (counted by week), and the same sign in both halves of the record. On ${COND_NOISE_CHECK.sims} made-up markets with no skill, re-checked every week for a year, ${share100(COND_NOISE_CHECK.any)} showed a false lesson at some point. The AI sees one only while its condition holds.</p>
    ${lab?.splits?.length ? `<ul class="small lab-splits">${lab.splits.map(splitLine).join('')}</ul>` : ''}
    <p class="small muted">A condition bucket here is often one or two stocks, and a regime can last months: read it as a description of its ideas so far, not as a rule.</p>`;
  return `<section class="panel lab">
    <div class="panel-head"><h2>Its style, and when its ideas work</h2></div>
    ${styleHtml}
    ${worksHtml}
  </section>`;
}

// Big moves against the index with and without news (memory.js moveNewsStudy): what followed each group
// in the move's direction, with the counts. Whether a move had news was judged before any search, so
// the searches can't move a move from one group to the other. Descriptive: no lesson comes from it.
function moveNewsSection(s, market) {
  if (!s) return '';
  const label = MARKETS[market].label;
  const rows = [['With news', s.withNews], ['Without news', s.noNews]].filter(([, g]) => g?.week?.vsIndex != null).map(([name, g]) => ({ name, w: g.week, m: g.month }));
  const shown = rows.filter(({ w }) => w.n >= MEMORY_MIN_CASES);
  const est = (w) => (w.est ? `${pct(w.est.edge)} (${pct(w.est.lo)} to ${pct(w.est.hi)})` : '–');
  const chart = rows.length ? chartSlot((el) => (shown.length ? hbars(el, shown.map(({ name, w }) => ({
    label: name, sub: `${plural(w.n, 'move')} · ${rate(w.continued)} kept going`, value: w.vsIndex * 100, display: pct(w.vsIndex),
    tip: [{ value: pct(w.vsIndex), label: 'the next week vs the index, in the move\'s direction' }, { value: rate(w.continued), label: `kept going, of ${w.n}` },
      ...(w.est ? [{ value: `${pct(w.est.lo)} to ${pct(w.est.hi)}`, label: `likely range after beta, ${plural(w.est.bets, 'separate bet')}` }] : [])],
  })), { tickFmt: pctTick, ariaLabel: 'Big moves with and without news' }) : (el.innerHTML = '<p class="muted small">Not enough moves for a chart yet.</p>')), {
    title: 'What followed big moves, with and without news',
    caption: `Right of 0 (+): the move tended to keep going the same way, against the index. Left (−): it tended to reverse.${shown.length < rows.length ? ` Rows with fewer than ${MEMORY_MIN_CASES} moves are only in the Table.` : ''}`,
    key: `move-news-${market}`,
    table: tableToggle(['Moves', 'Measured', 'Kept going', 'Next week vs index', 'After beta (likely range)', 'Next month vs index'],
      rows.map(({ name, w, m }) => [name, String(w.n), rate(w.continued), pct(w.vsIndex), est(w), m?.vsIndex != null ? `${pct(m.vsIndex)} (${m.n})` : '–']), 1),
  }) : '';
  const found = (m) => (!m.searched ? 'not searched' : m.searched.failed ? 'the search failed' : !m.searched.found ? 'a search found nothing'
    : `a search found: ${m.searched.url ? `<a href="${esc(safeUrl(m.searched.url))}" target="_blank" rel="noopener noreferrer">${esc(m.searched.headline)}</a>` : esc(m.searched.headline)}`);
  const recent = s.recent?.length ? `<details class="fund-new"><summary>Latest moves with no news</summary><ul class="orders">${s.recent.map((m) => `<li>${esc(fmtDate(`${m.date}T12:00:00Z`))} <strong>${esc(m.symbol)}</strong>
    <span class="${tone(m.excess)}">${pct(m.excess)}</span> <span class="muted small">vs the index</span> · ${found(m)}</li>`).join('')}</ul></details>` : '';
  const measuring = s.measured < s.moves ? ` ${plural(s.moves - s.measured, 'move')} ${s.moves - s.measured === 1 ? 'is' : 'are'} too recent to have a week after ${s.moves - s.measured === 1 ? 'it' : 'them'} yet.` : '';
  // since the feeds started, or over the year of prices once they're older than that
  const when = !s.from || s.from === s.since ? `Since the news feeds started (${esc(fmtDate(`${s.since}T12:00:00Z`))})` : `Over the past year (since ${esc(fmtDate(`${s.from}T12:00:00Z`))})`;
  const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  const which = !s.withoutNews ? (s.moves === 1 ? 'it had news' : 'each had news')
    : s.withoutNews === s.moves ? (s.moves === 1 ? 'it had no news' : 'none of them had news') : `${s.withoutNews} of them had no news`;
  const counts = s.moves
    ? `${when}, ${label} stocks moved ${MOVE_NEWS.move * 100}% or more against the index in a day ${times(s.moves)}; ${which} within a trading day (a news item, filing, rating change or news feed headline naming the stock), judged before anything was searched.${measuring}`
    : `${when}, no ${label} stock has moved ${MOVE_NEWS.move * 100}% or more against the index in a day, as far as can be judged: a move is judged once the session after it is over.`;
  return `<h3 class="col-head">Big moves with and without news</h3>
    <p class="small muted">${counts} For each move with no news the job searches the web once (at most ${MOVE_NEWS.perMonth} a month)${s.searched ? `: ${s.searched} searched so far, ${s.found} found news, which joins the news events above` : ''}. What followed is shown in the move's direction, against the index. A comparison with few cases for months: no lesson comes from it.</p>
    ${chart}${recent}`;
}

// ----- AI fund: ten years of prices (memory-long.js) -----

const REGIME_NOTE = 'Descriptive: the index against the average of its last 200 closes and, for US stocks, the VIX (under 16 calm, over 25 stressed). No ten-year lesson depends on it; a lesson from When its ideas work can.';
const LONG_STATUS = { held: ['held on 2024 onwards', 'held'], 'didnt-hold': ['didn\'t hold on 2024 onwards', ''], 'no-pattern': ['no reliable pattern', ''], fact: ['base rate', ''], 'too-few': ['too few to check', ''] };
function regimeChip(market) {
  const r = state.sample ? null : regimeNow(state.prices.quotes ?? {}, state.prices.macro, market);
  return r ? `<span class="chip regime-chip" title="${esc(REGIME_NOTE)}">Regime today: ${esc(regimeWords(r))}</span>` : '';
}

// Ten years of the market's own prices: its lessons (each found on the earlier years and checked on
// 2024 onwards, which it wasn't found on), each study on both periods with its likely range, and how
// far ordinary swings reach against a stop-loss, stock by stock.
function renderLongMemory(market, { hidden, admin }) {
  const mem = state.longMemory, m = mem?.markets?.[market];
  const label = MARKETS[market].label;
  const head = `<div class="panel-head"><h2>${esc(label)}: ten years of prices</h2>${regimeChip(market)}</div>`;
  if (!m) {
    return `<section class="panel">${head}<p class="small muted">Once a week the job reads ten years of daily prices for the watchlist and checks a few patterns, fixed in advance, on years they weren't found on. ${mem ? `It had no ${esc(label)} prices this week.` : 'It shows here after its first weekly run.'}</p></section>`;
  }
  const p1 = (x) => { const v = Math.abs(x) < 0.0005 ? 0 : x; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}%`; };
  const item = (l) => {
    const [status, cls] = LONG_STATUS[l.status] ?? [l.status, ''];
    return `<li><strong>${esc(l.text)}</strong><span class="chip ${cls}">${esc(status)}</span>${l.confidence ? `<span class="chip">${esc(l.confidence)} confidence</span>` : ''}
      <br><span class="muted small">${esc(l.evidence)}</span>${admin ? ` <button type="button" class="ghost small-btn" data-lesson-remove="${esc(l.id)}">Remove</button>` : ''}</li>`;
  };
  const lessons = m.lessons.filter((l) => !hidden.has(l.id));
  const checked = Object.entries(m.studies).filter(([k, st]) => STUDY_LABELS[k] && st.check && st.check.status !== 'too-few');
  const tooFew = Object.entries(m.studies).filter(([k, st]) => STUDY_LABELS[k] && st.check?.status === 'too-few');
  const per = (st) => (st.h === 5 ? 'the next week' : `the next ${st.h} trading days`);
  // two rows per study: the years it was measured on (its estimate, with the likely range), then the
  // held-out years (their plain average, which is what the check compares, with the likely range
  // around their estimate); the verdict goes on the held-out row only
  const VERDICT = { held: 'held', 'didnt-hold': 'didn\'t hold', 'no-pattern': 'no pattern' };
  const unit = (key, n) => plural(n, key === 'best-worst' ? 'week' : 'bet');
  const rows = checked.flatMap(([key, st]) => {
    const { train, test } = studyNumbers(key, st);
    const what = `${STUDY_LABELS[key].toLowerCase()}, over ${per(st)}, beyond the market and each stock's usual drift`;
    const bets = (e) => ({ value: String(e.bets), label: key === 'best-worst' ? 'weeks' : 'separate bets' });
    return [{
      label: `${STUDY_SHORT[key]}, ${st.years.train}`, sub: `${unit(key, train.bets)} · measured here`, value: train.edge * 100, lo: train.lo * 100, hi: train.hi * 100, display: p1(train.edge),
      tip: [{ value: p1(train.edge), label: `${what} (the estimate)` }, { value: `${p1(train.lo)} to ${p1(train.hi)}`, label: 'likely range' }, bets(train), { value: `${Math.round(train.p * 100)}%`, label: 'chance of this sign' }],
    }, {
      label: `${STUDY_SHORT[key]}, ${st.years.test}`, sub: `${unit(key, test.bets)} · ${VERDICT[st.check.status]}`, value: test.mean * 100, lo: test.lo * 100, hi: test.hi * 100, display: p1(test.mean),
      tip: [{ value: p1(test.mean), label: `${what}: the plain average, what the check uses (${LONG_STATUS[st.check.status][0]})` },
        { value: `${p1(test.edge)} (${p1(test.lo)} to ${p1(test.hi)})`, label: 'estimate and likely range' }, bets(test)],
    }];
  });
  const chart = rows.length ? chartSlot((el) => rangeBars(el, rows, { tickFmt: pctTick, ariaLabel: `${label}: ten-year studies`, dotLabel: 'Estimate (years measured); plain average (years held out)' }), {
    title: 'Each pattern, where it was measured and on the years held out',
    caption: `What followed each kind of day over ${checked.some(([, st]) => st.h > 5) ? 'the next week (21 trading days after an ex-date or results)' : 'the next week'}, beyond the market and each stock's usual drift. The first row of each is the years it was measured on: the estimate, with its likely range (an 8-in-10 chance it's inside). The second is the years held out: their plain average, which is what the check uses, with the likely range around their estimate. After a drop, + means the price bounced back. A pattern is a lesson only if the held-out years' average has the same sign at half its size or more.`,
    key: `long-${market}`,
    table: tableToggle(['Study and years', 'Separate bets', 'Plain average', 'Estimate (likely range)', 'Verdict'], checked.flatMap(([key, st]) => {
      const { train, test } = studyNumbers(key, st);
      return [[`${STUDY_SHORT[key]}, ${st.years.train}`, String(train.bets), p1(train.mean), `${p1(train.edge)} (${p1(train.lo)} to ${p1(train.hi)})`, 'measured here'],
        [`${STUDY_SHORT[key]}, ${st.years.test}`, String(test.bets), p1(test.mean), `${p1(test.edge)} (${p1(test.lo)} to ${p1(test.hi)})`, LONG_STATUS[st.check.status][0]]];
    }), 1, { className: 'wrap-head long-table' }),
  }) : '';
  const pooled = m.studies.stops; // all the market's stocks together
  const at = (c, k) => (c ? `${Math.round(c[LONG.stopKs.indexOf(k)] * 100)}%` : '–');
  const stocks = Object.entries(mem.stocks ?? {}).filter(([, s]) => s.market === market && s.stops);
  const stops = stocks.length ? `<details class="fund-new"><summary>How far ordinary swings reach, stock by stock</summary>
    <p class="small muted">For a position opened at any close in the ten years: how often the price touched a stop-loss set 2 or 3 typical daily moves away within 21 trading days (a typical daily move is the spread of the last 60 days' moves, today shown as a %), and the stop that ordinary swings reached in only 1 hold in 5, at today's daily move. A stop tighter than that is hit by ordinary swings in more than 1 hold in 5. ${esc(label)} stocks overall: a stop 2 moves below was hit in ${at(pooled?.train?.long, 2)} of holds before 2024 and ${at(pooled?.test?.long, 2)} since.</p>
    <div class="table-wrap"><table class="long-stops">
      <thead><tr><th>Stock</th><th class="num"><span class="hide-sm">Daily move</span><span class="show-sm">Daily</span></th><th class="num"><span class="hide-sm">Hit at 2 moves</span><span class="show-sm">2 moves</span></th><th class="num hide-sm">Hit at 3 moves</th><th class="num"><span class="hide-sm">Stop hit in 1 hold in 5</span><span class="show-sm">1 in 5</span></th><th class="num hide-sm">For a short</th></tr></thead>
      <tbody>${stocks.map(([sym, s]) => `<tr><td><strong>${esc(sym)}</strong></td><td class="num">${s.typical_daily_move_pct == null ? '–' : `${s.typical_daily_move_pct.toFixed(1)}%`}</td>
        <td class="num">${at(s.stops.long.hits, 2)}</td><td class="num hide-sm">${at(s.stops.long.hits, 3)}</td>
        <td class="num">${s.suggested_stop_pct?.long == null ? '–' : `−${s.suggested_stop_pct.long.toFixed(1)}%`} <span class="muted small hide-sm">(${s.stops.long.k} moves)</span></td>
        <td class="num hide-sm">${s.suggested_stop_pct?.short == null ? '–' : `+${s.suggested_stop_pct.short.toFixed(1)}%`}</td></tr>`).join('')}</tbody>
    </table></div></details>` : '';
  const inMarket = (symbol) => (symbol.endsWith('.SI') ? 'SGX' : 'US') === market;
  const notes = [
    ...(m.asOf ? [`This week's download of ${label} prices came back short, so these are the results of the build of ${fmtDate(m.asOf)}.`] : []),
    ...(mem.data?.rebuilt ?? []).filter((x) => mem.stocks?.[x.symbol]?.market === market).map((x) => `${x.symbol}'s dividend-adjusted prices from Yahoo were broken (${x.why}), so its total return was rebuilt from its closes and dividends.`),
    ...(mem.data?.leftOut ?? []).filter((x) => inMarket(x.symbol)).map((x) => `${x.symbol} was left out: ${x.why}.`),
    ...(mem.data?.carried ?? []).filter((x) => inMarket(x.symbol)).map((x) => `${x.symbol}'s download failed this week, so its figures are from the build of ${fmtDate(x.asOf)}.`),
    ...tooFew.map(([k]) => `${STUDY_LABELS[k]}: too few cases before 2024 to check yet${k === 'results' ? ' (results dates only go back a few years)' : ''}.`),
  ];
  return `<section class="panel">${head}
    <p class="small muted">How the ${m.stocks} ${esc(label)} stocks on today's watchlist moved after big one-day moves, ${market === 'SGX' ? 'ex-dividend dates' : 'results'} and last week's winners and losers, from ${esc(fmtDate(`${mem.from}T12:00:00Z`))} to ${esc(fmtDate(`${mem.to}T12:00:00Z`))}: measured from prices, dividends included, beyond the market's part (each stock's beta) and each stock's own usual drift. Each study was fixed in advance, measured on ${esc(m.years.train)} and then checked on ${esc(m.years.test)}, which it wasn't found on. Only a pattern that held there is a lesson; otherwise the lesson is that there's no reliable pattern, so the AI doesn't assume one.</p>
    <p class="small muted"><strong>Measured on the ${m.stocks} ${esc(label)} stocks on today's watchlist, which survived and mostly won; tendencies, not laws.</strong> On pure noise, ${(HOLDOUT_NOISE.held * 100).toFixed(1)}% of ${HOLDOUT_NOISE.sims} made-up studies with no pattern passed the check. The AI sees up to 6 market-memory lessons, in shorter words (those with no reliable pattern as one), those with evidence from days like today first. Updated weekly, last ${esc(fmtDate(mem.updatedAt))}.</p>
    ${lessons.length ? `<ul class="lessons">${lessons.map(item).join('')}</ul>` : '<p class="muted small">No lessons to show.</p>'}
    ${chart}
    ${stops}
    ${notes.length ? `<p class="muted small">${notes.map(esc).join(' ')}</p>` : ''}
  </section>`;
}

// ----- AI fund: Ask the data (hypotheses.js) -----

// The owner's questions (admins): each with its status, how the code read it and its answer, newest
// first, and the box to ask another, sent as 'settings' ({ fund: 'all', ask }), which reaches the job
// whole. Kept with the funds (c.questions), so shown only from their private copy.
const ASK_TEXT = { ask: ['Sending your question', 'Your question is in.'] };
const askLeft = (text) => `${Math.max(0, ASK.maxChars - String(text ?? '').length)} characters left`;
function renderAskData() {
  const c = state.funds;
  const list = Array.isArray(c?.questions) ? c.questions : [];
  const hidden = !list.length && c?.questionsAsked;
  const item = (q) => {
    const [label, cls] = statusLabel(q);
    const body = q.status === 'cant-answer' ? (q.answer ?? q.reason ?? '') : q.status === 'waiting'
      ? `Waiting for the ${q.spec?.population === 'fund_ideas' ? 'funds\' next run' : 'ten years of prices'}: answered within a day.` : q.answer ?? '';
    return `<li><strong>${esc(q.text)}</strong> <span class="chip ${cls}">${esc(label)}</span>
      ${q.spec ? `<br><span class="muted small">Read as: ${esc(describeSpec(q.spec))}</span>` : ''}
      ${body ? `<br><span class="small">${esc(body)}</span>` : ''}${q.note ? `<br><span class="muted small">${esc(q.note)}</span>` : ''}
      <br><span class="muted small">Asked ${esc(fmtDate(q.askedAt))}${q.answeredAt && q.status !== 'cant-answer' ? `, answered ${esc(fmtDate(q.answeredAt))}` : ''}</span></li>`;
  };
  const newest = [...list].reverse(), recent = newest.slice(0, 8), older = newest.slice(8);
  const d = state.askDraft ?? '';
  const cmd = state.fundCmd?.text === ASK_TEXT.ask ? state.fundCmd : null;
  const busy = state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '';
  return `<section class="panel" id="ask-data">
    <div class="panel-head"><h2>Ask the data</h2></div>
    <p class="small muted">Ask how the watchlist's stocks have behaved: after big one-day moves, ex-dividend dates or results, or in ordinary weeks; for a stock or a market; with the VIX calm or stressed, or the index above or below its 200-day average; over the next day, week or month. Once the funds have ${ASK.ideaMonths} months of graded ideas, you can ask about those too. Claude Haiku turns your question into a fixed kind of query, or says why this data can't answer it; code answers it from ten years of prices the same way as the ten-year studies above: found on 2016–2023, then checked on 2024 onwards, which it wasn't found on. "No reliable pattern" is a common, honest answer. Answered within a day.</p>
    <p class="small muted">Measured on today's watchlist, which survived and mostly won: tendencies, not laws. Kept with the funds, so private only when they're kept private (README: Keeping the AI fund private); the AI funds never see your questions or the answers.</p>
    ${hidden ? `<p class="small">You've asked ${plural(hidden, 'question')}. The public copy of the funds leaves them out, so they aren't shown here; keep the funds private to see them.</p>` : ''}
    <form id="ask-form" class="ask-form" novalidate>
      <label for="ask-text">Your question</label>
      <textarea id="ask-text" maxlength="${ASK.maxChars}" rows="2" placeholder="e.g. Do SGX banks recover after going ex-dividend?">${esc(d)}</textarea>
      <div class="row"><button type="submit" class="primary small-btn" ${busy}>Ask</button><span class="muted small" id="ask-left">${askLeft(d)}</span></div>
      <p class="error" id="ask-error" role="alert"></p>
      ${cmd?.message ? `<p class="small ${cmd.phase === 'failed' ? 'down' : 'muted'}" role="status">${esc(cmd.message)}</p>` : ''}
    </form>
    <p class="muted small">For example: "Does NVDA keep falling the week after a big drop?", "After US results that beat, does the stock keep rising for a month?", "Do stocks that beat the index one week lag it the next?"</p>
    ${recent.length ? `<ul class="lessons ask-list">${recent.map(item).join('')}</ul>` : ''}
    ${older.length ? `<details class="fund-new"><summary>Earlier questions (${older.length})</summary><ul class="lessons ask-list">${older.map(item).join('')}</ul></details>` : ''}
  </section>`;
}

// Brokers' real upgrades and downgrades in the market over the last 30 days, with how the stock has
// moved since: dated facts, with no ranking of the brokers.
function renderRatingChanges(market) {
  if (!state.company) return '';
  const list = recentRatingChanges(state.company, state.prices.quotes, market, new Date(), 30).slice(0, 12);
  return `<details class="fund-new"><summary>Broker rating changes</summary>
    ${list.length ? `<ul class="orders">${list.map((c) => `<li>${esc(fmtDate(c.t * 1000))} <strong>${esc(c.symbol)}</strong> <span class="chip">${c.dir > 0 ? 'upgrade' : 'downgrade'}</span>${esc(describeChange(c))}
      · since then ${c.move == null ? '–' : `<span class="${tone(c.move)}">${pct(c.move)}</span>`}${c.move != null && c.index != null ? ` <span class="muted small">(${pct(c.move - c.index)} vs index)</span>` : ''}</li>`).join('')}</ul>` : `<p class="muted small">None in the last 30 days${market === 'SGX' ? ' (Yahoo Finance has little analyst data for SGX stocks)' : ''}.</p>`}
    <p class="muted small">Upgrades and downgrades from Yahoo Finance over the last 30 days; ratings kept or only a new price target aren't listed. The move is since the last close before the change.</p></details>`;
}

// What the scheduled AI cost, month by month and by job, against the monthly cap.
const SPEND_SERIES = [
  { key: 'picks', label: 'AI picks', color: SERIES[0] }, { key: 'fund', label: 'AI fund decisions', color: SERIES[1] },
  { key: 'learning', label: 'Weekly reviews', color: SERIES[2] }, { key: 'backfill', label: 'News backfill', color: SERIES[3] },
  { key: 'articles', label: 'Article look-ups', color: SERIES[4] }, { key: 'reading', label: 'Reading guide', color: SERIES[5] },
  { key: 'ask', label: 'Ask the data', color: SERIES[6] }, { key: 'strategist', label: 'AI strategist', color: SERIES[7] },
];
function renderSpend() {
  const months = Object.entries(state.spend?.months ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  if (!months.length) return '';
  const monthName = (ym, opts = { month: 'short', year: 'numeric' }) => new Date(`${ym}-15T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  const series = SPEND_SERIES.filter((s) => months.some(([, v]) => v[s.key] > 0));
  // the ledger keeps fractions of a cent (a question costs about a quarter of one): shown as such, not as 0.00
  const usd = (v) => (v > 0 && v < 0.005 ? 'under US$0.01' : `US$${v.toFixed(2)}`);
  const cap = state.spend?.cap;
  const table = tableToggle(['Month', 'Total', ...series.map((x) => x.label)], months.map(([ym, v]) => [monthName(ym, { month: 'long', year: 'numeric' }), usd(v.total ?? 0), ...series.map((x) => usd(v[x.key] ?? 0))]).reverse());
  const about = 'Estimated cost of the scheduled AI (picks, AI fund decisions, weekly reviews, the news backfill, article look-ups: the searches behind big moves with no news, and the reading guide: its daily read of the headlines and the articles you log, and Ask the data: reading your questions). What you run in this browser with your own key isn\'t included.';
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

// ----- AI fund: this week (report.js) -----

// A lesson's evidence week by week (pb.lessonHistory), up to market date `upTo`: its number per week and
// separate bets, as a trend line's points.
function lessonTrend(pb, id, upTo = '9999') {
  return (pb?.lessonHistory?.[id] ?? []).filter((p) => p.date <= upTo).slice(-REPORT.historyWeeks)
    .map((p) => ({ label: `Week to ${dayWords(p.date)}`, value: p.edge * 100, display: `${pct(p.edge)} a week`, sub: plural(p.bets, 'separate bet'), date: p.date, bets: p.bets, edge: p.edge }));
}
// on a line of its own, under the sentence it belongs to
const trendLine = (points, name) => (points.length >= 2 ? `<br>${sparkSlot((el) => sparkTrend(el, points, { label: `${name}, its number per week` }))}` : '');
// The trend lines' table twin: each lesson's points, newest first.
const trendTable = (rows, key) => keptTable(tableToggle(['Lesson', 'Week to', 'Separate bets', 'A week'],
  rows.flatMap(({ name, points }) => [...points].reverse().map((p) => [name, dayWords(p.date), String(p.bets), pct(p.edge)])), 2), key);

// The fund's weekly report ("What we learned", report.js), under its Reports tab, with a picker for
// the weeks kept: how the week went against the index, the ideas graded, what changed in its lessons
// (each with its trend over the weeks), the review's summary, your calls, what's coming up and the cost.
// Counts and trends, not verdicts.
function renderWeekly(f) {
  const reports = [...(f.reports ?? [])].reverse();
  if (!reports.length && f.stoppedAt) return '';
  const market = marketForCurrency(f.currency);
  const title = `<h2>This week <span class="muted weekly-fund">· ${esc(f.name ?? 'AI fund')}</span></h2>`;
  // when the next report comes: after this week's last session, unless this week's is already out (or,
  // for a first report, it's the weekend: then next week's)
  const today = marketDate(market, new Date());
  const thisWeek = weekOf(today), weekend = [0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay());
  const soon = (done) => (done ? 'next week' : 'this week (Friday, after the close)');
  if (!reports.length) {
    return `<section class="panel weekly"><div class="panel-head">${title}</div>
      <p class="small muted">Its first weekly report comes after the last ${esc(MARKETS[market].label)} session ${soon(weekend)}: how the fund did against its index, the ideas graded that week with the best and the worst, what changed in its lessons, your calls on trades you declined, results and ex-dividend dates coming up for what it holds, and the month's AI cost. It goes to Telegram too, when that's set up.</p></section>`;
  }
  const chosen = reports.find((r) => r.week === state.reportWeek[f.id]) ?? reports[0];
  const picker = reports.length > 1 ? `<label class="week-pick">Week <select id="report-week" data-fund="${esc(f.id)}">${reports.map((r) => `<option value="${esc(r.week)}"${r === chosen ? ' selected' : ''}>${esc(reportLabel(r).replace(/^Week /, ''))}</option>`).join('')}</select></label>` : '';
  const [head, ...rest] = reportLines(chosen);
  const pb = f.playbook;
  const trends = [];
  const line = (l) => {
    const points = l.id ? lessonTrend(pb, l.id, chosen.to) : [];
    const name = chosen.lessons?.find((c) => c.id === l.id)?.name ?? '';
    if (points.length >= 2) trends.push({ name, points });
    return `<li class="report-${esc(l.kind)}">${esc(l.text)}${trendLine(points, name)}</li>`;
  };
  const latest = chosen === reports[0];
  const cut = head.text.indexOf(': '); // "Week to 2 Oct" in bold, then the week's result
  const next = latest && !f.stoppedAt ? `The next report comes after the last ${esc(MARKETS[market].label)} session ${soon(reports[0].week >= thisWeek)}.` : '';
  return `<section class="panel weekly"><div class="panel-head">${title}${picker}</div>
    <p class="report-head"><strong>${esc(head.text.slice(0, cut + 1))}</strong>${esc(head.text.slice(cut + 1))}</p>
    ${rest.length ? `<ul class="report-lines">${rest.map(line).join('')}</ul>` : ''}
    ${trends.length ? trendTable(trends, `report-trends-${f.id}`) : ''}
    <p class="small muted">${chosen.short ? next : `${next} Counts and trends, not verdicts: a week holds a handful of ideas. Results against the index are after fees, dividends included.${trends.length ? ' The small line under a lesson is its number per week (the stock-specific edge after the market\'s part and fees, or what the lesson measures) at each weekly report, with zero marked.' : ''}${chosen.summary ? ' The review\'s summary is the AI\'s own words, written when the weekly review runs.' : ''}`}</p>
  </section>`;
}

// How far a closed position went against and for the fund while it was held (fund.js tracks), after its
// exit; one opened before tracking began was followed only from then.
const heldLine = (tr) => (tr?.worst == null ? '' : ` <span class="muted small">· ${tr.late ? `since tracking began${tr.openedAt ? ` (${esc(fmtDate(tr.openedAt))})` : ''}` : 'while held'}: at worst ${pctP(tr.worst * 100)}, at best ${pctP(tr.best * 100)}</span>`);

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

// ----- AI fund: the page -----

// The AI fund page: the fund switcher on top (a card per fund, ranked, and "All funds" once there are
// two or more), then the fund picked, with its header, its notices and its sub-tabs (FUND_TABS), or all
// the funds combined. The figures come from fund-views.js; this only draws them.

const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)} pts`;
const pct1 = (x) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
const styleLabel = (f) => STYLES[f.style]?.label ?? f.style ?? '';
const fundModel = (f) => modelName(f.settings?.model || TIERS.advanced);
const listWords = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
const STATUS_CHIP = { paused: ['Paused', 'warn'], stopped: ['Stopped', ''] };
// A share as a bar, beside the number it draws (so the bar is never the only way to read it).
const shareBar = (share, max = 1) => `<span class="share-bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, (share / (max || 1)) * 100)).toFixed(1)}%"></span></span>`;
// How much is invested against what's free to spend, with the numbers in its label and beside it.
const investedBar = (share, rest) => `<div class="inv-bar" role="img" aria-label="${Math.round(share * 100)}% invested, ${Math.round((1 - share) * 100)}% ${esc(rest)}"><span class="inv" style="width:${(share * 100).toFixed(1)}%"></span><span class="rest"></span></div>`;
const commandBusy = () => (state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '');
const runLink = () => (repoActionsUrl()
  ? `<a href="${repoActionsUrl()}" target="_blank" rel="noopener">Actions → Update prices, AI picks and AI fund</a>`
  : '<strong>Actions → Update prices, AI picks and AI fund</strong>');

// The switcher: the funds ranked as the leaderboard ranks them (return after AI cost, stopped funds last),
// each with its value, return, stocks held and share invested; "All funds" first, and for admins a card
// that opens the start form. On a phone they're a row of small chips that scrolls sideways. Redrawn only
// when what it shows changes, so a row scrolled by hand stays where it was.
let switcherHtml = '';
function renderFundSwitcher(ov, shown) {
  const el = $('fund-switcher');
  el.hidden = !ov.funds.length;
  if (el.hidden) { switcherHtml = ''; el.innerHTML = ''; return; }
  const ret = (x) => `<strong class="${tone(x)}"><span class="sr-only">return </span>${pct(x)}</strong>`;
  const card = (id, cls, body) => {
    const on = id === (shown === ALL ? ALL : shown?.id);
    return `<li><button type="button" class="fund-card${cls}${on ? ' selected' : ''}" data-fund-select="${esc(id)}"${on ? ' aria-current="true"' : ''}>${body}</button></li>`;
  };
  const cards = [];
  const v = ov.combined;
  if (v) {
    const t = v.totals;
    cards.push(card(ALL, ' all', `<span class="fc-head"><span class="fc-name">All funds</span><span class="chip fc-chip">${plural(ov.funds.length, 'fund')}</span></span>
      <span class="fc-style">${t ? `Combined, in ${t.currency}` : v.currencies.length ? 'Each currency on its own' : 'No fund running'}</span>
      <span class="fc-value"><span class="v">${t ? money(t.value, t.currency) : v.currencies.map((x) => money(x.value, x.currency)).join(' + ')}</span>${t ? ret(t.netPct) : ''}</span>
      <span class="fc-stocks">${plural(v.stocks, 'stock')}${t ? ` · ${Math.round(t.investedPct * 100)}% invested` : ''}</span>
      <span class="fc-compact">${plural(v.stocks, 'stock')}${t ? ` · ${ret(t.netPct)}` : ''}</span>`));
  }
  for (const x of ov.funds) {
    const f = x.fund;
    const [word, cls] = STATUS_CHIP[x.status] ?? [];
    cards.push(card(f.id, x.status === 'stopped' ? ' stopped' : '', `<span class="fc-head"><span class="fc-name">${esc(f.name ?? 'AI fund')}</span>
        <span class="fc-chips">${word ? `<span class="chip ${cls}">${word}</span>` : ''}<span class="chip fc-chip">${esc(MARKETS[x.market].label)}</span></span></span>
      <span class="fc-style">${esc(styleLabel(f))} · ${esc(fundModel(f))}${f.settings?.learning === false ? ' · learning off' : ''}</span>
      <span class="fc-value"><span class="v">${money(x.account.equity, f.currency)}</span>${ret(x.account.netPct)}</span>
      <span class="fc-stocks">${plural(x.stocks, 'stock')} · ${Math.round(x.investedPct * 100)}% invested</span>
      <span class="fc-compact">${word ? `${word} · ` : ''}${plural(x.stocks, 'stock')} · ${ret(x.account.netPct)}</span>`));
  }
  if (authEnabled && state.user?.isAdmin) {
    cards.push(`<li><button type="button" class="fund-card add" data-open-start data-fk="open-start" aria-expanded="${state.startOpen}" aria-controls="fund-start">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Start a fund</button></li>`);
  }
  const html = `<div class="fs-head"><h2 class="fs-title">Your AI funds</h2>${ov.funds.length > 1 ? '<span class="muted small">Ranked by return after AI cost</span>' : ''}</div>
    <ul class="fund-cards" id="fund-cards">${cards.join('')}</ul>`;
  if (html === switcherHtml) return;
  const before = $('fund-cards');
  const order = (row) => [...(row?.querySelectorAll('[data-fund-select]') ?? [])].map((b) => b.dataset.fundSelect).join(' ');
  const scrolled = before?.scrollLeft ?? 0, was = before?.querySelector('[aria-current="true"]')?.dataset.fundSelect, wasOrder = order(before);
  switcherHtml = html;
  el.innerHTML = html;
  const row = $('fund-cards'), sel = row.querySelector('[aria-current="true"]');
  row.scrollLeft = scrolled;
  // a fund just picked (or the page just opened), or the funds re-ranked (the prices came in after the
  // funds, or changed) so the chosen card moved: its card in sight, on a phone where the row scrolls
  if (sel && (sel.dataset.fundSelect !== was || order(row) !== wasOrder) && row.scrollWidth > row.clientWidth) {
    const a = sel.getBoundingClientRect(), b = row.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) row.scrollLeft += a.left - b.left - 16;
  }
}

// What the latest request to the job is doing (sending, running, done or failed), under the switcher.
function renderFundStatus() {
  const el = $('fund-status'), cmd = state.fundCmd;
  const text = cmd?.message ?? '';
  if (el.textContent !== text) el.textContent = text;
  el.className = `small fund-status ${cmd?.phase === 'failed' ? 'down' : 'muted'}`;
}

// A part of the page drawn only when its HTML changes (the fund's header keeps its tabs scrolled, and
// the buttons in it their focus).
const drawn = {};
function drawIfChanged(id, html) {
  if (drawn[id] === html && $(id).innerHTML) return false;
  drawn[id] = html;
  $(id).innerHTML = html;
  return true;
}

// <details> opened on the fund page stay open when it's redrawn (by the fund and tab, and their summary).
const openDetails = new Set();
const detailsKey = (d) => `${d.closest('[data-panel]')?.dataset.panel ?? ''}|${d.querySelector('summary')?.textContent.trim() ?? ''}`;
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName !== 'DETAILS' || d.dataset.key || !d.closest('#fund-body')) return;
  if (d.open) openDetails.add(detailsKey(d)); else openDetails.delete(detailsKey(d));
}, true);
function drawFundBody(html, panel) {
  const body = $('fund-body');
  body.innerHTML = `<div data-panel="${esc(panel)}">${html}</div>`;
  for (const d of body.querySelectorAll('details:not([data-key])')) if (openDetails.has(detailsKey(d))) d.open = true;
}

// The notices that belong at the top of a fund: a link to a removed fund, Tiger's account against the
// funds, the AI's monthly cap, a pause, Tiger's errors and a decision that failed.
function fundNotices(f, c) {
  const check = c.brokerCheck ?? reconcileAll(c); // all Tiger funds against the one Tiger account
  return [
    state.linkGone ? `<div class="notice warn fund-alert link-gone" role="status"><span><strong>That fund has been removed:</strong> the link you followed was for a fund that's no longer here, so this is ${f ? `"${esc(f.name ?? 'AI fund')}"` : 'all your funds'}.</span></div>` : '',
    check && !check.ok ? `<div class="notice warn fund-alert"><span><strong>Your Tiger account doesn't hold what the funds think:</strong> ${check.mismatches.map((m) => `${esc(m.symbol)}: funds ${m.fund}, Tiger ${m.tiger}`).join('; ')}. Check the Tiger app before trading further.</span></div>` : '',
    ...(f ? [
      f.aiCapped ? `<div class="notice warn fund-alert"><span><strong>AI paused for the month:</strong> ${esc(f.aiCapped.message)}</span></div>` : '',
      f.paused ? `<div class="notice warn fund-alert"><span><strong>Trading is paused</strong> (${fmtDateTime(f.paused.at)}): ${esc(f.paused.reason)} Stop-losses still work.</span></div>` : '',
      f.broker?.error && f.settings?.broker === 'tiger' ? `<div class="notice warn fund-alert"><span><strong>Tiger:</strong> ${esc(f.broker.error)}</span></div>` : '',
      f.lastError ? `<div class="notice warn fund-alert"><span><strong>Last decision failed</strong> ${esc(ago(f.lastError.time))}: ${esc(f.lastError.message)}</span></div>` : '',
    ] : []),
  ].join('');
}

// The fund's header: its name, what it is (status, style, broker, decisions and model, focus), Pause or
// Resume and Settings for admins, and its sub-tabs; then its notices and any trades waiting for approval.
function fundHead(x, c, tabs, tab) {
  const f = x.fund, s = f.settings ?? {};
  const admin = authEnabled && state.user?.isAdmin;
  const perDay = Number(f.decisionsPerDay);
  const chips = [
    x.status === 'stopped' ? `<span class="chip">Stopped ${esc(fmtDate(f.stoppedAt))}</span>`
      : x.status === 'paused' ? '<span class="chip warn">Paused</span>'
        : `<span class="chip ok">Running · ${esc(MARKETS[x.market].label)} ${esc(STATUS_LABELS[marketStatus(x.market)])}</span>`,
    `<span class="chip">${esc(styleLabel(f))}</span>`,
    `<span class="chip${f.broker?.accountType === 'live' ? ' sell' : ''}">${esc(brokerLabel(f))}${s.broker === 'tiger' ? ` · ${s.approval === 'manual' ? 'you approve each trade' : 'automatic'}` : ''}</span>`,
    // a stopped fund decides no more: only when it last did, if it ever did
    x.status === 'stopped' ? '' : `<span class="chip">${perDay === EVERY_RUN ? 'Decides at every run' : `${plural(Math.max(1, perDay || 1), 'decision')} a trading day`} · ${esc(fundModel(f))}</span>`,
    f.lastDecisionAt ? `<span class="chip">Last decision ${esc(ago(f.lastDecisionAt))}</span>`
      : x.status === 'stopped' ? '<span class="chip">No decisions made</span>' : '<span class="chip">Last decision not yet</span>',
    s.learning === false ? '<span class="chip">Learning off, for comparison</span>' : '',
    f.focus ? `<span class="chip focus">Focus: ${esc(f.focus)}</span>` : '',
  ].join('');
  const busy = commandBusy();
  const actions = admin ? `<div class="fund-actions">
      ${x.status === 'stopped' ? '' : f.paused
        ? `<button type="button" class="primary" data-fund-cmd="resume" data-fk="resume" ${busy}>Resume</button>`
        : `<button type="button" class="danger" data-fund-cmd="pause" data-fk="pause" ${busy}>Pause</button>`}
      <button type="button" data-fund-tab="settings" data-fk="settings">Settings</button></div>` : '';
  const count = (n) => ` <span class="tab-count"><span class="sr-only">(</span>${n}<span class="sr-only"> ${n === 1 ? 'stock' : 'stocks'})</span></span>`;
  const tabHtml = tabs.map((t) => `<button type="button" role="tab" id="fund-tab-${t}" data-fund-tab="${t}" aria-selected="${t === tab}" aria-controls="${t === 'settings' ? 'fund-controls' : 'fund-body'}" tabindex="${t === tab ? 0 : -1}">${esc(FUND_TABS[t])}${t === 'holdings' ? count(x.stocks) : ''}</button>`).join('');
  return `<section class="panel fund-head" aria-labelledby="fund-name">
      <div class="fund-head-top"><div class="fund-head-text"><h2 id="fund-name">${esc(f.name ?? 'AI fund')}</h2><div class="fund-chips">${chips}</div></div>${actions}</div>
      <div class="fund-tabs" role="tablist" id="fund-tabs" aria-label="${esc(f.name ?? 'AI fund')}: sections">${tabHtml}</div>
    </section>
    ${fundNotices(f, c)}
    ${renderProposals(f)}`;
}

// ----- AI fund: one fund's tabs -----

// What a fund with no decisions says instead (a stopped fund won't make its first).
// What of a DeepSeek answer had to be fixed to fit the decision's format (ai.js repairAnswer): values read
// as the right kind or an unknown category taken as 'other', and items left out because they couldn't be.
const repairedNote = (r) => (r && (r.fixed || r.dropped) ? ` <span class="muted small">· answer tidied: ${[r.fixed ? `${plural(r.fixed, 'value')} fixed` : '', r.dropped ? `${plural(r.dropped, 'item')} left out` : ''].filter(Boolean).join(', ')}</span>` : '');
const noDecisions = (f) => `<p class="muted">${f.stoppedAt ? 'It made no decisions before it was stopped.' : 'No decisions yet. The first one happens 15 minutes after the market opens.'}</p>`;

// One decision: what the AI thought, its orders (or none) and, in the full list, what else it considered
// and its sources.
function decisionOrders(d, f, known) {
  return d.orders.length ? `<ul class="orders">${d.orders.map((o) => `<li><span class="chip ${o.action === 'buy' || o.action === 'cover' ? 'buy' : 'sell'}">${esc(o.action)}</span>
    ${Number(o.shares).toLocaleString()} ${esc(o.symbol)}
    ${o.status === 'filled' ? `at ${price(o.price)}${o.fee ? ` <span class="muted small">+ ${money(o.fee, f.currency)} fees</span>` : ''}${heldLine(o.track)}`
      : o.status === 'rejected' ? `<span class="down">rejected: ${esc(o.message)}</span>`
      : `<span class="muted">${esc(o.status)}${o.limitPrice ? `, limit ${price(o.limitPrice)}` : ''}</span>`}
    <span class="muted small">${esc(o.reason)}</span>${o.thesis ? `<br><span class="thesis small">${esc(thesisWords(o.thesis, { short: o.action === 'short' }))}</span>` : ''}${citedChips(o.lessonsApplied, known)}</li>`).join('')}</ul>` : '<p class="muted small">No trades this round.</p>';
}
function decisionItem(d, f, known) {
  if (d.skipped) return `<p class="muted small decision-skip">${fmtDateTime(d.time)}: ${esc(d.outlook)}</p>`;
  return `<article class="decision">
    <header><strong>${fmtDateTime(d.time)}</strong>${d.usage ? ` <span class="muted small">${esc(madeBy(d))} · about US$${d.usage.costUsd.toFixed(2)}</span>` : ''}${d.learned ? ' <span class="chip">used its lessons</span>' : ''}${repairedNote(d.repaired)}</header>
    <p>${esc(d.outlook)}</p>
    ${decisionOrders(d, f, known)}
    ${d.considered?.length ? `<p class="small muted">Also considered: ${d.considered.map((c, i, a) => `${esc(c.stance)} ${esc(c.symbol)} (${esc(c.why_not)})${i < a.length - 1 ? ';' : '.'}${citedChips(c.lessonsApplied, known)}`).join(' ')}</p>` : ''}
    ${sources(d.source_urls)}
  </article>`;
}

// "Needs you": trades waiting for approval (shown at the top of the fund), and its stops and risk's
// warnings; otherwise what happens to its trades.
function needsYou(x, owner) {
  const f = x.fund, s = f.settings ?? {};
  const waiting = (f.proposals ?? []).filter((p) => p.status === 'awaiting').length;
  const items = [];
  if (waiting) items.push(`<strong>${plural(waiting, 'trade')} waiting for ${owner ? 'your' : 'the owner\'s'} approval</strong>, at the top of this fund. A proposal expires after an hour.`);
  if (x.positions.length) {
    const { rows, uneven } = positionRisk(x.positions, x.account.equity, dossiers(), f.protections, { quotes: state.prices.quotes ?? {}, now: new Date() });
    if (uneven) items.push(`${esc(uneven.symbol)} is ${Math.round(uneven.weight * 100)}% of the fund but ${Math.round(uneven.riskShare * 100)}% of its daily risk (Holdings: Stops and risk).`);
    const close = rows.filter((r) => stopMovesShown(r) != null && stopMovesShown(r) < 2).map((r) => r.symbol);
    if (close.length) items.push(`${esc(listWords(close))} ${close.length === 1 ? 'is' : 'are'} within 2 typical daily moves of ${close.length === 1 ? 'its' : 'their'} stop-loss, which ordinary swings often reach.`);
  }
  const calm = x.status === 'stopped' ? 'Nothing: the fund is stopped.'
    : s.broker !== 'tiger' ? 'Nothing waiting. Simulator trades go through by themselves.'
      : s.approval === 'manual' ? 'Nothing waiting. Trades the AI proposes wait at the top of this fund for approval, for up to an hour.'
        : 'Nothing waiting. Its trades go to Tiger by themselves.';
  return `<section class="panel needs">
    <div class="panel-head"><h2>${owner ? 'Needs you' : 'Needs attention'}</h2></div>
    <ul class="needs-list">${(items.length ? items : [calm]).map((t) => `<li class="${items.length ? 'warn-item' : ''}">${t}</li>`).join('')}</ul>
  </section>`;
}

// Overview: the fund in four tiles (value, against the index, holdings, AI cost), its value against the
// index, its holdings in short, its latest decision and what needs you.
function fundOverview(x, c, ov) {
  const f = x.fund, a = x.account, s = f.settings ?? {};
  const quotes = state.prices.quotes ?? {};
  const bench = x.bench;
  const cap = state.spend?.cap, month = monthSpend(state.spend);
  const owner = state.user?.isAdmin || !authEnabled;
  const known = lessonsById(f, c);
  const freeWord = x.shorts ? 'buying power' : 'cash';
  const tiles = `<section class="kpis" aria-label="${esc(f.name ?? 'AI fund')} in figures">
    <div class="card"><div class="label">Value now</div>
      <div class="big">${money(a.equity, f.currency)}</div>
      <div class="${tone(a.net)}">${money(a.net, f.currency, { sign: true })} (${pct(a.netPct)}) on ${money(f.budget, f.currency)}</div>
      <div class="sub"><span>Cash</span><span>${money(a.cash, f.currency)}</span><span>Buying power</span><span>${money(a.buyingPower, f.currency)}</span>
        <span>Fees paid</span><span>${money(a.fees ?? 0, f.currency)}</span></div></div>
    <div class="card"><div class="label">Against the index</div>
      ${bench ? `<div class="big ${tone(x.vsIndex)}">${pts(x.vsIndex)}</div>
        <div class="small">${esc(bench.label)} made <span class="${tone(bench.pct)}">${pct(bench.pct)}</span> (${money(bench.value, f.currency)}) with the same ${money(f.budget, f.currency)} ${bench.partial ? `since ${fmtDate(bench.since)}` : 'since the fund started'}: the fund is ${a.net >= bench.net ? 'ahead' : 'behind'} by ${money(Math.abs(a.net - bench.net), f.currency)}.</div>
        <div class="sub"><span>Beta</span><span>${x.beta ? `${x.beta.beta.toFixed(2)} <span class="muted">(${x.beta.days} days)</span>` : `after ${FUND_BETA_DAYS} trading days`}</span></div>`
        : '<p class="muted small">No index prices yet.</p>'}</div>
    <div class="card"><div class="label">Holdings</div>
      <div class="big">${x.stocks ? plural(x.stocks, 'stock') : 'All in cash'}</div>
      ${investedBar(x.investedPct, freeWord)}
      <div class="small">${Math.round(x.investedPct * 100)}% invested · ${money(x.free, f.currency)} ${freeWord}</div></div>
    <div class="card"><div class="label">AI cost (estimated)</div>
      <div class="big">US$${x.costUsd.toFixed(2)}</div>
      <div class="small">for this fund's ${plural(f.decisions.filter((d) => d.usage).length, 'decision')}</div>
      <div class="sub">${x.cost != null ? `<span>Profit after AI cost</span><span class="${tone(a.net - x.cost)}">${money(a.net - x.cost, f.currency, { sign: true })}</span>` : ''}
        <span>All scheduled AI, ${new Date().toLocaleDateString(undefined, { month: 'long' })}</span><span>US$${month.toFixed(2)}${cap ? ` of US$${cap} cap` : ''}</span></div></div>
  </section>`;
  const top = x.positions.slice(0, 8);
  const most = Math.max(0, ...top.map((p) => p.weight ?? 0));
  const holdings = `<section class="panel">
    <div class="panel-head"><h2>Holdings (${x.stocks})</h2><button type="button" class="link-btn" data-fund-tab="holdings">All details</button></div>
    ${top.length ? `<ul class="hold-list">${top.map((p) => `<li><span class="hl-name">${stockLink(p.symbol, f.id)}${p.short ? '<span class="chip sell">short</span>' : ''} <span class="muted small">${esc(quotes[p.symbol]?.name ?? '')}</span></span>
        ${shareBar(p.weight ?? 0, most)}<span class="hl-num">${pct1(p.weight)}</span><span class="hl-num ${tone(p.unrealizedPct)}">${pct(p.unrealizedPct)}</span></li>`).join('')}</ul>
      ${x.stocks > top.length ? `<p class="small">And ${x.stocks - top.length} more in All details.</p>` : ''}
      <p class="muted small">The bar and first number: each stock's share of the fund. The last: its profit or loss since bought, after the fees on buying.</p>`
      : '<p class="muted">All in cash.</p>'}
  </section>`;
  const d = [...f.decisions].reverse().find((x) => !x.skipped);
  const latest = `<section class="panel">
    <div class="panel-head"><h2>Latest decision${d ? ` · ${esc(fmtDateTime(d.time))}` : ''}</h2>${f.decisions.length ? '<button type="button" class="link-btn" data-fund-tab="decisions">All decisions</button>' : ''}</div>
    ${d ? `<p>${esc(d.outlook)}</p>${decisionOrders(d, f, known)}` : noDecisions(f)}
  </section>`;
  const archived = !ov.combined && c.archived?.length ? `Removed earlier: ${c.archived.slice(-5).map((y) => `${esc(y.name)} ${pct((y.finalValue ?? y.budget) / y.budget - 1)}`).join(', ')}.` : '';
  return `${tiles}
    <div class="ov-grid">
      <section class="panel">
        <div class="panel-head"><h2>Fund value</h2></div>
        ${fundValueChart(f, bench, quotes)}
        <p class="muted small">Hard limit: the fund can only use its ${money(f.budget, f.currency)}. Orders beyond its buying power or the per-order limit are rejected, and shorts are closed automatically at a 40% loss.${s.broker === 'tiger' ? ' Values use Tiger\'s actual fill prices.' : ''}</p>
        <p class="muted small">Limits: ${s.maxOrderPct ?? 25}% of the budget per order; pauses after losing ${s.dailyLossPct ?? 5}% in a day; ${s.allowShorts === false ? 'no short selling' : 'shorts allowed'}. Fees: ${esc(s.broker === 'tiger' ? 'what Tiger charges' : planFor(s.feePlan ?? 'tiger').label)}. Started ${fmtDateTime(f.startedAt)}.</p>
      </section>
      ${holdings}
      ${latest}
      ${needsYou(x, owner)}
    </div>
    <p class="muted small">"Against the index" is the fund's return minus what the same money made in ${esc(BENCHMARKS[f.currency].label)} since it started, after fees, in percentage points. Beta is how much the fund's value has moved with its index day to day (1: in step with it; 0.5: half as much, as with half in cash; below 0: against it, as when net short), shown after ${FUND_BETA_DAYS} trading days: a fund with a beta above 1 should beat a rising index without any skill. ${archived}</p>
    ${ov.combined ? '' : renderSpend()}
    ${authEnabled && state.user && !state.user.isAdmin ? '<p class="muted small">Only admins can start, pause or stop AI funds.</p>' : ''}
    ${authEnabled ? '' : `<p class="muted small">To stop the fund and close its positions, or to start a new one, use ${runLink()} → Run workflow.</p>`}`;
}

// Holdings: every position, where the money is, profit or loss by position, stops and risk, Tiger's
// orders and the automatic events (stop-losses, take-profits, dividends, splits).
function fundHoldings(x) {
  const f = x.fund, a = x.account, positions = x.positions;
  const quotes = state.prices.quotes ?? {};
  return `<section class="panel">
      <div class="panel-head"><h2>Positions</h2></div>
      ${positions.length ? `<div class="chart-grid">${allocationChart(positions, a.buyingPower, f.currency, 'Where the money is', f.portfolio)}${pnlChart(positions, 'Profit or loss by position')}</div>` : ''}
      <div class="table-wrap"><table>${positions.length ? `
        <thead><tr><th>Stock</th><th class="num">Shares</th><th class="num hide-sm">Avg price</th><th class="num hide-sm">Price</th><th class="num">Profit / loss</th><th class="hide-sm">Protection</th></tr></thead>
        <tbody>${positions.map((p) => {
          const pr = f.protections?.[p.symbol];
          const prot = pr ? [pr.stop_loss_pct ? `stop −${pr.stop_loss_pct}%` : '', pr.take_profit_pct ? `take +${pr.take_profit_pct}%` : ''].filter(Boolean).join(', ') : '–';
          return `<tr><td>${stockLink(p.symbol, f.id)}${p.short ? '<span class="chip sell">short</span>' : ''}${resultsChip(p.symbol)}<span class="name">${esc(quotes[p.symbol]?.name ?? '')}</span>${positionThesisLine(f, p, quotes)}${noteLine(p.symbol)}</td>
          <td class="num">${p.qty.toLocaleString()}</td><td class="num hide-sm">${price(p.avgCost)}</td><td class="num hide-sm">${price(p.price)}</td>
          <td class="num ${tone(p.unrealized)}">${money(p.unrealized, p.currency, { sign: true })}<br><span class="small">${pct(p.unrealizedPct)}</span></td>
          <td class="hide-sm small">${esc(prot)}</td></tr>`;
        }).join('')}</tbody>` : '<tr><td class="empty">All in cash.</td></tr>'}</table></div>
      ${renderStopsAndRisk(f, positions, a.equity)}
    </section>
    ${renderBrokerOrders(f)}
    ${f.events.length ? `<section class="panel"><div class="panel-head"><h2>Automatic events</h2></div><ul class="orders">
      ${f.events.slice().reverse().slice(0, 20).map((e) => `<li>${fmtDateTime(e.time)}: ${['split', 'dividend'].includes(e.action) ? esc(e.why) : `${esc(e.action)} ${Number(e.shares).toLocaleString()} ${esc(e.symbol)} at ${price(e.price)} <span class="muted small">(${esc(e.why)})</span>${heldLine(e.track)}`}</li>`).join('')}
    </ul></section>` : ''}`;
}

// Reports: the weekly report and your calls on the trades you declined.
function fundReports(f) {
  const weekly = renderWeekly(f), calls = callsTable(f);
  return `${weekly}${calls ? `<section class="panel calls-panel">${calls}</section>` : ''}${weekly || calls ? '' : '<section class="panel"><p class="muted">No weekly reports: the fund stopped before its first one.</p></section>'}`;
}

function fundTabBody(x, c, ov, tab) {
  const f = x.fund;
  if (tab === 'holdings') return fundHoldings(x);
  if (tab === 'decisions') {
    const known = lessonsById(f, c);
    return `<section class="panel">
      <div class="panel-head"><h2>Decisions</h2></div>
      ${f.decisions.slice().reverse().slice(0, 30).map((d) => decisionItem(d, f, known)).join('') || noDecisions(f)}
    </section>`;
  }
  if (tab === 'learning') return renderLearning(f, c);
  if (tab === 'reports') return fundReports(f);
  if (tab === 'ask') return renderAskData();
  return fundOverview(x, c, ov);
}

// ----- AI fund: all funds combined -----

// "Where the money is" across the funds `t` (fund-views.js totals): US stocks, SGX stocks and what's
// free to spend, in one currency.
function combinedMoneyChart(t, title = '') {
  const segs = [
    { label: 'US stocks', value: t.longs.US, color: SERIES[0] },
    { label: 'SGX stocks', value: t.longs.SGX, color: SERIES[2] },
    { label: t.shorts ? 'Buying power' : 'Cash', value: t.free, color: CASH },
  ].filter((x) => x.value > 0).map((x) => ({ ...x, display: money(x.value, t.currency) }));
  if (!segs.length) return '';
  const shares = shareLabels(segs.map((x) => x.value));
  return chartSlot((el) => stackBar(el, segs, { ariaLabel: `Where the money is, in ${t.currency}` }), {
    title, key: `combined-money-${t.currency}`,
    caption: `In ${t.currency}${t.shorts ? '. Short positions and the cash set aside for them aren\'t shown' : ''}.`,
    table: tableToggle(['Where', `In ${t.currency}`, 'Share'], segs.map((x, i) => [x.label, x.display, shares[i]])),
  });
}

// Every stock the funds hold, the same stock in several funds as one row, largest first.
function combinedHoldingsTable(rows, base) {
  const quotes = state.prices.quotes ?? {};
  const most = Math.max(0, ...rows.map((h) => h.weight ?? 0));
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Every holding, combined"><table class="all-holdings">
    <thead><tr><th>Stock</th><th class="hide-sm">Held by</th><th class="num">Value${base ? ` (${base})` : ''}</th><th class="hide-sm">Weight</th><th class="num">Since bought</th></tr></thead>
    <tbody>${rows.map((h) => `<tr><td>${stockLink(h.symbol)}${h.short ? '<span class="chip sell">short</span>' : ''}<span class="name">${esc(quotes[h.symbol]?.name ?? '')}</span><span class="name show-sm held-by-sm">${pct1(h.weight)} of the funds · held by ${esc(h.funds.map((x) => x.name).join(', '))}</span></td>
      <td class="held-by hide-sm">${h.funds.map((x) => `<span class="chip">${esc(x.name)}</span>`).join('')}</td>
      <td class="num">${money(h.value, base ?? h.currency)}</td>
      <td class="hide-sm"><span class="share-cell">${shareBar(h.weight ?? 0, most)}<span class="hl-num">${pct1(h.weight)}</span></span></td>
      <td class="num ${tone(h.plPct)}">${pct(h.plPct)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// All funds: what they're worth together and against their indexes, the stocks they hold, the month's AI
// cost, where the money is, each fund side by side (the leaderboard) and every holding combined.
function renderCombined(ov, c) {
  const v = ov.combined, t = v.totals;
  const admin = authEnabled && state.user?.isAdmin;
  const running = ov.funds.filter((x) => x.status !== 'stopped');
  const indexes = [...new Set(running.map((x) => BENCHMARKS[x.currency].label))];
  const cap = state.spend?.cap, month = monthSpend(state.spend);
  const sub = [
    `${v.running > v.paused || !v.paused ? plural(v.running - v.paused, 'running fund') : ''}${v.running > v.paused && v.paused ? ', ' : ''}${v.paused ? plural(v.paused, 'paused fund') : ''}${v.stopped ? ` (${v.stopped} stopped, not counted)` : ''}`,
    v.fx ? `US dollars shown in SGD at ${v.fx.toFixed(4)}, the latest rate; each fund's own figures ignore exchange rates`
      : !t && v.currencies.length > 1 ? 'no exchange rate yet, so each currency is added up on its own' : t ? `in ${t.currency}` : '',
  ].filter(Boolean).join(' · ');
  const waiting = ov.funds.map((x) => [x, (x.fund.proposals ?? []).filter((p) => p.status === 'awaiting').length]).filter(([, n]) => n);
  const paused = running.filter((x) => x.status === 'paused');
  const capped = running.find((x) => x.fund.aiCapped);
  const head = `<section class="panel fund-head combined-head" aria-labelledby="fund-name">
      <div class="fund-head-top"><div class="fund-head-text"><h2 id="fund-name">All funds, combined</h2><p class="muted small">${esc(sub)}</p></div>
        ${admin && running.some((x) => x.status === 'running') ? `<div class="fund-actions"><button type="button" class="danger" data-fund-cmd="pause-all" data-fk="pause-all" ${commandBusy()}>Pause all funds</button></div>` : ''}</div>
    </section>
    ${fundNotices(null, c)}
    ${capped ? `<div class="notice warn fund-alert"><span><strong>AI paused for the month:</strong> ${esc(capped.fund.aiCapped.message)}</span></div>` : ''}
    ${paused.length ? `<div class="notice warn fund-alert"><span><strong>Paused:</strong> ${esc(listWords(paused.map((x) => x.fund.name)))}. Stop-losses still work.</span></div>` : ''}
    ${waiting.map(([x, n]) => `<div class="notice warn fund-alert"><span><strong>${esc(x.fund.name)}:</strong> ${plural(n, 'trade')} waiting for approval.</span><button type="button" class="small-btn" data-fund-open="${esc(x.id)}">Open the fund<span class="sr-only">: ${esc(x.fund.name)}</span></button></div>`).join('')}`;
  const shared = v.shared.length ? `: ${esc(listWords(v.shared.map((h) => h.symbol)))} ${v.shared.length === 1 ? 'is' : 'are'} held by more than one fund` : v.positions ? ', none held by more than one fund' : '';
  const stocksTile = `<div class="card"><div class="label">Stocks held</div>
      <div class="big">${v.stocks ? plural(v.stocks, 'stock') : 'All in cash'}</div>
      ${t ? investedBar(t.investedPct, t.shorts ? 'buying power' : 'cash') : ''}
      <div class="small">${t ? `${Math.round(t.investedPct * 100)}% invested · ` : ''}${plural(v.positions, 'position')}${shared}</div></div>`;
  const costTile = `<div class="card"><div class="label">AI cost this month</div>
      <div class="big">US$${month.toFixed(2)}</div>
      <div class="small">${cap ? `of the US$${cap} monthly cap, ` : ''}for all the scheduled AI, the picks included</div>
      <div class="sub"><span>These funds' decisions, since they started</span><span>US$${v.costUsd.toFixed(2)}</span></div></div>`;
  const tiles = t ? `<div class="card"><div class="label">Combined value</div>
      <div class="big">${money(t.value, t.currency)}</div>
      <div class="${tone(t.net)}">${money(t.net, t.currency, { sign: true })} (${pct(t.netPct)}) on ${money(t.invested, t.currency)}</div></div>
    <div class="card"><div class="label">Against their ${indexes.length > 1 ? 'indexes' : 'index'}</div>
      ${t.vsIndex != null ? `<div class="big ${tone(t.vsIndex)}">${pts(t.vsIndex)}</div><div class="small">The same money in ${esc(listWords(indexes))} made <span class="${tone(t.benchPct)}">${pct(t.benchPct)}</span>.</div>`
        : '<p class="muted small">Not every fund\'s index has prices yet.</p>'}</div>`
    : v.currencies.map((y) => `<div class="card"><div class="label">${esc(y.currency)} ${y.funds === 1 ? 'fund' : 'funds'} (${y.funds})</div>
      <div class="big">${money(y.value, y.currency)}</div>
      <div class="${tone(y.net)}">${money(y.net, y.currency, { sign: true })} (${pct(y.netPct)}) on ${money(y.invested, y.currency)}</div>
      ${y.vsIndex != null ? `<div class="small">${pts(y.vsIndex)} against ${esc(BENCHMARKS[y.currency].label)}</div>` : ''}</div>`).join('');
  const where = t ? combinedMoneyChart(t) : v.currencies.map((y) => combinedMoneyChart(y, `${y.currency} funds`)).join('');
  const byFund = `<div class="table-wrap" tabindex="0" role="region" aria-label="Your funds, by fund"><table class="by-fund">
      <thead><tr><th>Fund</th><th class="num hide-sm">Value</th>${v.fx ? '<th class="num hide-sm">In SGD</th>' : ''}<th class="num">Return</th><th class="num hide-sm">vs index</th><th class="num hide-sm">Beta</th><th class="num hide-sm">After AI cost</th><th class="num">Stocks</th><th>Share of the total</th></tr></thead>
      <tbody>${v.byFund.map((x) => `<tr class="${x.status === 'stopped' ? 'muted-row' : ''}">
        <td><button type="button" class="link-btn fund-link" data-fund-open="${esc(x.id)}">${esc(x.fund.name)}</button>
          <span class="name show-sm">${money(x.account.equity, x.currency)}${x.inBase != null && x.currency !== v.base ? ` (${money(x.inBase, v.base)})` : ''}${x.vsIndex == null ? '' : ` · <span class="${tone(x.vsIndex)}">${pts(x.vsIndex)}</span> vs index`}</span>
          <span class="name">${x.status === 'running' ? '' : `<strong>${x.status}</strong> · `}${esc(x.currency)} · ${esc(styleLabel(x.fund))} · ${x.fund.settings?.broker === 'tiger' ? 'Tiger' : 'simulator'} · ${esc(fundModel(x.fund))}${x.fund.settings?.learning === false ? ' · not learning' : ''}${x.fund.focus ? ` · ${esc(x.fund.focus)}` : ''}</span></td>
        <td class="num hide-sm">${money(x.account.equity, x.currency)}</td>
        ${v.fx ? `<td class="num hide-sm">${x.inBase == null ? '–' : money(x.inBase, 'SGD')}</td>` : ''}
        <td class="num ${tone(x.account.netPct)}">${pct(x.account.netPct)}</td>
        <td class="num hide-sm ${x.vsIndex == null ? '' : tone(x.vsIndex)}">${x.vsIndex == null ? '–' : pts(x.vsIndex)}</td>
        <td class="num hide-sm">${x.beta ? x.beta.beta.toFixed(2) : '–'}</td>
        <td class="num hide-sm ${x.afterCost == null ? '' : tone(x.afterCost)}">${x.afterCost == null ? '–' : pct(x.afterCost)}</td>
        <td class="num">${x.stocks}</td>
        <td>${x.share == null ? '<span class="muted">–</span>' : `<span class="share-cell">${shareBar(x.share)}<span class="hl-num">${Math.round(x.share * 100)}%</span></span>`}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">Best first, by return after the AI's cost; paused and stopped funds are marked, and stopped ones come last. "vs index" is a fund's return minus what the same money made in ${esc(BENCHMARKS.USD.label)} or ${esc(BENCHMARKS.SGD.label)} since it started, after fees. Beta is how much a fund's value has moved with its index day to day (1: in step with it; 0.5: half as much, as with half in cash; below 0: against it, as when net short), shown after ${FUND_BETA_DAYS} trading days: a fund with a beta above 1 should beat a rising index without any skill, so judge "vs index" with it in mind. ${v.fx ? 'Share of the total is in SGD. ' : !t ? 'Without an exchange rate, each fund\'s share is of the funds in its own currency. ' : ''}
      ${c.archived?.length ? `Removed earlier: ${c.archived.slice(-5).map((y) => `${esc(y.name)} ${pct((y.finalValue ?? y.budget) / y.budget - 1)}`).join(', ')}.` : ''}</p>`;
  const body = `${v.running ? `<section class="kpis" aria-label="All funds in figures">${tiles}${stocksTile}${costTile}</section>` : '<section class="panel"><p class="muted">No fund is running: the stopped ones are listed below until you remove them.</p></section>'}
    ${where ? `<section class="panel"><div class="panel-head"><h2>Where the money is</h2></div>${where}</section>` : ''}
    <section class="panel"><div class="panel-head"><h2>By fund</h2></div>${byFund}</section>
    ${v.holdings.length ? `<section class="panel"><div class="panel-head"><h2>Every holding, combined (${plural(v.stocks, 'stock')})</h2><span class="muted small">Largest first · weight is of ${t ? 'all the funds together' : 'the funds in the same currency'}</span></div>
      ${combinedHoldingsTable(v.holdings, t?.currency ?? null)}
      <p class="muted small">Since bought: the profit or loss of every fund's position in the stock together, after the fees on buying.</p></section>` : ''}
    ${renderSpend()}`;
  return { head, body };
}

// The AI fund page: the switcher, then the fund picked (or all funds), redrawn at every render.
function renderFund() {
  const c = state.funds;
  renderFundStatus();
  if (c === undefined) {
    renderFundSwitcher({ funds: [], combined: null }, null);
    drawIfChanged('fund-head', '');
    $('fund-controls').hidden = true;
    $('fund-body').innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>';
    return;
  }
  const ov = fundsOverview(c, state.prices.quotes ?? {}, { fx: state.prices.fx?.USDSGD });
  const shown = ov.funds.length ? shownFund() : null;
  renderFundSwitcher(ov, shown);
  const body = $('fund-body');
  if (!shown) {
    state.jumpTo = null;
    drawIfChanged('fund-head', state.linkGone ? '<div class="notice warn fund-alert link-gone" role="status"><span><strong>That fund has been removed:</strong> the link you followed was for a fund that\'s no longer here.</span></div>' : '');
    $('fund-controls').hidden = true;
    body.hidden = false;
    body.removeAttribute('role');
    body.innerHTML = `<section class="panel">
      <h2>AI fund</h2>
      <p>Give Claude an amount and let it trade on its own, aiming for the biggest profit it can make, in the simulator or through your Tiger Brokers account. It runs on GitHub, so it keeps trading while this page is closed.</p>
      <p>You can run up to ${MAX_ACTIVE_FUNDS} funds at once, each with its own amount, market, style (cautious, balanced or aggressive), focus and AI model, and compare them side by side.</p>
      ${authEnabled ? '' : `<ol>
        <li>Add your Anthropic API key to the GitHub repo as a secret named <code>ANTHROPIC_API_KEY</code> (Settings → Secrets and variables → Actions).</li>
        <li>Open ${runLink()}, press <strong>Run workflow</strong>, and fill in <em>Start a NEW AI fund with this amount</em>, its currency (USD trades US stocks, SGD trades SGX stocks) and how many decisions a day.</li>
        <li>Come back here in a few minutes.</li>
      </ol>`}
      <p class="small"><strong>Hard limits:</strong> the fund can only use its amount; any order costing more than its buying power, or more than the per-order limit, is rejected. It pauses itself after losing the daily limit, and shorts are closed automatically at a 40% loss.</p>
      <p class="muted small">Cost: each decision is one Claude call with web search, roughly US$0.05–0.15: Claude Haiku 4.5 reads the news and Claude Sonnet 5 decides.</p>
    </section>
    ${renderSpend()}`;
    flushCharts();
    return;
  }
  if (shown === ALL) {
    state.jumpTo = null;
    const { head, body: html } = renderCombined(ov, c);
    drawIfChanged('fund-head', head);
    $('fund-controls').hidden = true;
    body.hidden = false;
    body.removeAttribute('role');
    body.removeAttribute('aria-labelledby');
    drawFundBody(html, 'all');
    flushCharts();
    return;
  }
  const x = ov.funds.find((y) => y.fund === shown);
  const tabs = fundTabs();
  // after a link from Telegram: its weekly report (Reports), or its trades waiting for approval (at the
  // top of every tab; the weekly report when none are waiting any more)
  const waiting = (shown.proposals ?? []).some((p) => p.status === 'awaiting');
  if (state.jumpTo === 'week' || (state.jumpTo === 'approve' && !waiting)) setFundTab('reports');
  const tab = tabs.includes(state.fundTab) ? state.fundTab : 'overview';
  if (drawIfChanged('fund-head', fundHead(x, c, tabs, tab))) {
    // on a phone the sub-tabs scroll sideways: keep the one shown in sight
    const row = $('fund-tabs'), sel = row.querySelector('[aria-selected="true"]');
    if (sel && row.scrollWidth > row.clientWidth) {
      const a = sel.getBoundingClientRect(), b = row.getBoundingClientRect();
      if (a.left < b.left || a.right > b.right) row.scrollLeft += a.left - b.left - 12;
    }
  }
  $('fund-controls').hidden = tab !== 'settings';
  body.hidden = tab === 'settings';
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', `fund-tab-${tab}`);
  drawFundBody(tab === 'settings' ? '' : fundTabBody(x, c, ov, tab), `${shown.id}:${tab}`);
  flushCharts();
  if (state.jumpTo) {
    const target = state.jumpTo === 'approve' ? document.querySelector('#fund-head .approvals') : body.querySelector('.weekly');
    state.jumpTo = null;
    target?.scrollIntoView({ block: 'start' });
  }
}

// ----- AI fund: stops and risk (dossier.js positionRisk) -----

// Each position against its stock's typical daily move: its share of the fund, how much a typical day's
// move in it moves the fund, its stop-loss (set from its average price) with how far today's price is
// from it in daily moves, next to the stop ordinary swings reached in only 1 hold in 5, and how far it
// has gone against and for the fund since it opened (fund.tracks, as its stops see it; for one opened
// before tracking began, since then). Worked out from the positions as they are now, so the warnings
// show straight away: risk sitting unevenly, positions that move together, an ex-date drop that
// reaches a stop, and how tight its stops have been set (fund.protectionLog). Advice only: no limit
// changes.
// A position's stop in typical daily moves from today's price, as the page shows it (one decimal), or
// null; 0 or less is at or through the stop.
const stopMovesShown = (r) => (r.stopMoves == null ? null : Math.round(r.stopMoves * 10) / 10);
function renderStopsAndRisk(f, positions, equity) {
  if (!positions.length) return '';
  const ds = dossiers();
  const { rows, uneven, together } = positionRisk(positions, equity, ds, f.protections, { quotes: state.prices.quotes ?? {}, now: new Date() });
  if (!rows.some((r) => r.move != null)) return '';
  const p0 = (x) => `${Math.round(x * 100)}%`;
  const p2 = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const tracks = f.tracks ?? {};
  const notes = together.map((t) => `${t.a} and ${t.b} moved together over the year (a correlation of ${t.correlation.toFixed(2)}): holding both is close to one bet.`);
  for (const r of rows) {
    const x = r.side === 'long' && r.stopDistance > 0 ? exDateVsStop(ds[r.symbol], r.stopDistance * 100) : null;
    if (!x) continue;
    const when = x.late ? `is due to go ex-dividend any day (the estimate, about ${dayOf(x.date)}, has passed)` : `goes ex-dividend about ${dayOf(x.date)} (an estimate)`;
    notes.push(`${r.symbol} ${when}: it usually drops about ${x.dropPct}% that day, and its stop-loss is only ${(r.stopDistance * 100).toFixed(1)}% below today's price, so it could trigger on the dividend alone.`);
  }
  const log = stopLogSummary(f.protectionLog);
  if (log) notes.push(`Its stop-losses have been set at a median of ${log.median} typical daily moves (${plural(log.n, 'stop')} set${log.since ? ` since ${fmtDate(log.since)}` : ''})${log.under2 ? `; ${log.under2} of them under 2 moves, which ordinary swings often reach` : ''}.`);
  const sideSign = (r) => (r.side === 'short' ? '+' : '−');
  return `<h3 class="col-head risk-head">Stops and risk</h3>
    ${uneven ? `<div class="notice warn risk-uneven"><span><strong>Risk is uneven:</strong> ${esc(uneven.symbol)} is ${p0(uneven.weight)} of the fund but ${p0(uneven.riskShare)} of its daily risk. A typical day's move in each position moves the fund by ${p2(uneven.lo)} to ${p2(uneven.hi)}.</span></div>` : ''}
    <div class="table-wrap"><table class="risk-table">
      <thead><tr><th>Stock</th><th class="num hide-sm">Of the fund</th><th class="num hide-sm">Typical day</th><th class="num"><span class="hide-sm">Risk a day</span><span class="show-sm">Risk</span></th><th class="num"><span class="hide-sm">Stop-loss</span><span class="show-sm">Stop</span></th><th class="num hide-sm">1-in-5 stop</th><th class="num"><span class="hide-sm">Worst / best</span><span class="show-sm">Worst/best</span></th></tr></thead>
      <tbody>${rows.map((r) => {
        const t = tracks[r.symbol];
        return `<tr><td>${stockLink(r.symbol, f.id)}${r.side === 'short' ? '<span class="chip sell">short</span>' : ''}</td>
          <td class="num hide-sm">${r.weight == null ? '–' : p0(r.weight)}</td>
          <td class="num hide-sm">${r.move == null ? '–' : `±${(r.move * 100).toFixed(1)}%`}</td>
          <td class="num">${r.risk == null ? '–' : `${p2(r.risk)}<br><span class="muted small">${p0(r.riskShare)} of all</span>`}</td>
          <td class="num">${r.stop ? `${sideSign(r)}${r.stop}%${stopMovesShown(r) != null ? `<br><span class="small ${stopMovesShown(r) < 2 ? 'down' : 'muted'}">${stopMovesShown(r) <= 0 ? 'at the stop' : `${stopMovesShown(r) >= 10 ? Math.round(stopMovesShown(r)) : stopMovesShown(r).toFixed(1)} moves`}</span>` : ''}` : '<span class="muted">none</span>'}</td>
          <td class="num hide-sm">${r.suggested == null ? '–' : `${sideSign(r)}${r.suggested.toFixed(1)}%`}</td>
          <td class="num"${t?.late ? ` title="${esc(`Since tracking began${t.openedAt ? ` (${fmtDate(t.openedAt)})` : ''}: the position is older`)}"` : ''}>${t?.worst == null ? '–' : `<span class="${tone(t.worst)}">${pctP(t.worst * 100)}</span><br><span class="small ${tone(t.best)}">${pctP(t.best * 100)}</span>${t.late ? `<br><span class="small muted">${t.openedAt ? `from ${esc(shortDay(t.openedAt))}` : 'since tracking began'}</span>` : ''}`}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="small muted">A typical day is the spread of a stock's last ${DOSSIER.moveDays} days' moves; risk a day is how much a typical day's move in the position moves the fund, and its share of them all. A stop-loss is set from the position's average price; under it is how far today's price is from that level, in typical daily moves: under 2 is often reached by ordinary swings. The 1-in-5 stop is how far they went within 21 trading days in only 1 hold in 5 over ten years. Worst and best are how far each position has gone against and for the fund since it opened (for one opened before tracking began, since the date shown), as its stops see it. Advice only: the fund's limits don't change.</p>
    ${notes.length ? `<ul class="risk-notes small">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}

// ---------- stock notes (dossier.js): each stock's own history and risk ----------

// Every stock's card: data/dossiers.json (refreshed daily), else built here from what the page has (the
// prices, the ten-year memory, the results calendar and the picks' history). None on sample prices.
let dossierCache = { key: null, value: {} };
function dossiers() {
  if (state.sample) return {};
  if (state.dossiers?.stocks) return state.dossiers.stocks;
  const key = [state.prices.updatedAt, state.longMemory?.updatedAt, state.company?.fetchedAt, state.filings?.checkedAt, state.picksHistory?.length].join('|');
  if (dossierCache.key !== key) {
    const quotes = state.prices.quotes ?? {};
    dossierCache = { key, value: buildDossiers({ quotes, long: state.longMemory, calendar: calendar(), picksScores: scorePicks(state.picksHistory ?? [], quotes), now: new Date() }).stocks };
  }
  return dossierCache.value;
}

// A number already in % with its sign: +1.2%, −0.4%.
const pctP = (x, d = 1) => (x == null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}%`);
const monthList = (ms) => {
  const names = ms.map((m) => new Date(Date.UTC(2026, m - 1, 15)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const dayOf = (iso) => fmtDate(`${iso}T12:00:00Z`);
// "3 Sep": an instant's day, short
const shortDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// The owner's note on a stock, shared by every fund (the funds' c.stockNotes): { text, at }. The public
// copy of the funds keeps only when it was saved.
const stockNote = (symbol) => state.funds?.stockNotes?.[symbol] ?? null;
const noteLine = (symbol) => { const n = stockNote(symbol); return n?.text ? `<span class="owner-note small"><strong>Your note:</strong> ${esc(n.text)}</span>` : ''; };

// A stock's symbol as a button that opens its notes; `fundId`: the fund it was opened from (its trades
// and its position are shown).
function stockLink(symbol, fundId = null) {
  if (state.sample) return `<strong>${esc(symbol)}</strong>`;
  return `<button type="button" class="stock-link" data-stock="${esc(symbol)}"${fundId ? ` data-stock-fund="${esc(fundId)}"` : ''} aria-haspopup="dialog" title="Stock notes: its own history and risk">${esc(symbol)}</button>`;
}

function openStock(symbol, fundId = null) {
  if (state.sample || (!quote(symbol) && !dossiers()[symbol])) return;
  if (state.stockView?.symbol !== symbol) state.noteDraft = null;
  state.stockView = { symbol, fundId };
  const dlg = $('stock-dialog');
  if (!dlg.open) dlg.showModal(); // first, so its chart measures its width
  renderStockDialog();
  dlg.scrollTop = 0;
}

// Where the fund it was opened from (or you, from the home page) stands in the stock: the position, its
// share and risk, its stop in daily moves, and how far it has gone against and for the fund.
function stockPosition(symbol, fund) {
  const quotes = state.prices.quotes ?? {};
  const { accounts, positions } = summarize(fund ? fund.portfolio : state.portfolio, quotes);
  const p = positions.find((x) => x.symbol === symbol);
  if (!p) return '';
  const r = positionRisk([p], accounts[p.currency]?.equity ?? 0, dossiers(), fund?.protections ?? {}, { quotes, now: new Date() }).rows[0];
  const t = fund?.tracks?.[symbol];
  const where = fund ? 'the fund' : `your ${p.currency} account`;
  // the stop-loss is set from the average price: where that leaves it against today's price
  const k = stopMovesShown(r);
  const level = r.stopDistance == null ? '' : r.stopDistance <= 0 ? ', and today\'s price is at or through it'
    : `, ${(r.stopDistance * 100).toFixed(1)}% ${p.short ? 'above' : 'below'} today's price${k != null ? ` (${k.toFixed(1)} typical daily moves)` : ''}`;
  const bits = [
    `${fund ? `"${fund.name}" holds` : 'You hold'} ${p.short ? 'a short of ' : ''}${shares(Math.abs(p.qty))}${r.weight == null ? '' : `, ${Math.round(r.weight * 100)}% of ${where}`}`,
    r.risk != null ? `a typical day's move in it moves ${where} by ${(r.risk * 100).toFixed(2)}%` : '',
    fund ? (r.stop ? `its stop-loss is ${p.short ? '+' : '−'}${r.stop}% from its average price${level}` : 'no stop-loss') : '',
    t?.worst != null ? `since ${t.late ? `tracking began${t.openedAt ? ` (${fmtDate(t.openedAt)})` : ''}` : 'it opened'} it has gone as far as ${pctP(t.worst * 100)} against and ${pctP(t.best * 100)} for the fund` : '',
  ].filter(Boolean);
  return `<p class="small stock-position">${esc(bits.join('; '))}.</p>`;
}

// The past year's daily closes with its results days (coloured by how the stock did against its index
// that day), its ex-dividend dates and the fund's (or your) trades marked on the line, and every day in
// the Table.
function stockChart(symbol, d, fund) {
  const q = quote(symbol);
  const bars = (q?.daily ?? []).filter(([, c]) => c > 0);
  if (bars.length < 2) return '';
  const ccy = q.currency;
  const idx = indexName(d?.index ?? BENCHMARKS[ccy]?.symbol ?? '');
  const dates = bars.map(([t]) => new Date(t * 1000).toISOString().slice(0, 10));
  const pts = bars.map(([t, c]) => ({ t: t * 1000, label: fmtDate(t * 1000), axis: new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }), value: c }));
  const markers = [], events = new Map();
  const add = (i, m) => {
    if (i < 0) return;
    markers.push({ i, ...m });
    (events.get(i) ?? events.set(i, []).get(i)).push(`${m.value} ${m.label}`);
  };
  for (const [date, day, week] of d?.results?.reactions ?? []) {
    add(dates.indexOf(date), { shape: 'dot', color: day >= 0 ? 'var(--up)' : 'var(--down)', value: pctP(day), label: `against ${idx} on its results day${week != null ? ` (${pctP(week)} over the week)` : ''}` });
  }
  for (const [t, amount] of q.events?.dividends ?? []) add(dates.indexOf(new Date(t * 1000).toISOString().slice(0, 10)), { shape: 'diamond', color: 'var(--series-4)', value: `${price(amount)} ${ccy}`, label: 'dividend went ex' });
  const who = fund ? 'the fund' : 'you';
  for (const t of (fund ? fund.portfolio : state.portfolio).trades.filter((x) => x.symbol === symbol)) {
    const day = t.time.slice(0, 10);
    if (day < dates[0]) continue;
    let i = dates.length - 1;
    while (i > 0 && dates[i] > day) i--;
    add(i, { shape: t.side === 'buy' ? 'up' : 'down', color: 'var(--text)', value: `${t.qty.toLocaleString()} at ${price(t.price)}`, label: `${who} ${t.side === 'buy' ? 'bought' : 'sold'}` });
  }
  const has = (shape, color) => markers.some((m) => m.shape === shape && (!color || m.color === color));
  const keys = [
    has('dot', 'var(--up)') && { shape: 'dot', color: 'var(--up)', label: `Results day, beat ${idx}` },
    has('dot', 'var(--down)') && { shape: 'dot', color: 'var(--down)', label: `Results day, lagged ${idx}` },
    has('diamond') && { shape: 'diamond', color: 'var(--series-4)', label: 'Went ex-dividend' },
    has('up') && { shape: 'up', color: 'var(--text)', label: fund ? 'The fund bought' : 'You bought' },
    has('down') && { shape: 'down', color: 'var(--text)', label: fund ? 'The fund sold' : 'You sold' },
  ].filter(Boolean);
  const fmt = (v) => `${price(v)} ${ccy}`;
  // the caption names only the kinds of marker drawn, as the legend does
  const marked = [
    has('dot') && `its results days (${[has('dot', 'var(--up)') && `green where it beat ${esc(idx)} that day`, has('dot', 'var(--down)') && 'red where it lagged'].filter(Boolean).join(', ')})`,
    has('diamond') && 'its ex-dividend dates',
    (has('up') || has('down')) && `${fund ? 'the fund\'s' : 'your'} trades`,
  ].filter(Boolean);
  const listed = marked.length > 1 ? `${marked.slice(0, -1).join(', ')} and ${marked.at(-1)}` : marked[0];
  return chartSlot((el) => lineChart(el, pts, { time: true, fmt, height: 190, mainLabel: 'Close', title: `${symbol} over the past year`, markers, markerKeys: keys }), {
    title: 'The past year',
    caption: `Daily closes in ${esc(ccy)}${marked.length ? `, with ${listed} marked` : ''}. Hover, tap or use the arrow keys to read each day.`,
    key: `stock-${symbol}`,
    table: tableToggle(['Date', 'What happened', `Close (${ccy})`], pts.map((p, i) => [p.label, (events.get(i) ?? []).join('; '), price(p.value)]).reverse(), 2, { className: 'wrap-head stock-table' }),
  });
}

// The stock's own history in words: its typical day, the stocks it moves with, how far ordinary swings
// reach against a stop, its results days (a table of the latest) and its dividends.
function stockFacts(symbol, d, q) {
  const idx = indexName(d.index);
  const ccy = q?.currency ?? (d.market === 'SGX' ? 'SGD' : 'USD');
  const facts = [];
  if (d.daily_move_pct != null) facts.push(['Typical day', `±${d.daily_move_pct.toFixed(1)}%, the spread of its last ${DOSSIER.moveDays} days' moves.${d.beta_1y != null ? ` Beta ${d.beta_1y.toFixed(2)} against ${idx} over the year (1 moves with it, 0.5 half as much).` : ''}`]);
  const peers = d.peers ?? [];
  if (peers.length) {
    const close = peers.filter(([, c]) => c >= DOSSIER.together).map(([s]) => s);
    facts.push(['Moves most with', `${peers.map(([s, c]) => `${s} (${c.toFixed(2)})`).join(' and ')}: the correlation of their daily moves over the year${close.length ? `. Holding it with ${close.join(' or ')} is close to one bet` : ' (1 is always together, 0 unrelated)'}.`]);
  }
  const st = d.stops;
  if (st?.hits?.long) {
    const hit = (k) => Math.round((st.hits.long[LONG.stopKs.indexOf(k)] ?? 0) * 100);
    const m = d.daily_move_pct, s = st.suggested_stop_pct ?? {};
    facts.push(['Stop-losses', `Over ten years, ordinary swings touched a stop 2 typical daily moves below the price${m != null ? ` (−${(2 * m).toFixed(1)}% today)` : ''} within 21 trading days in ${hit(2)}% of holds, and one 3 moves below${m != null ? ` (−${(3 * m).toFixed(1)}%)` : ''} in ${hit(3)}%. Only 1 hold in 5 went as far as ${s.long != null ? `−${s.long.toFixed(1)}%` : '–'}${s.short != null ? ` (+${s.short.toFixed(1)}% against a short)` : ''}: a stop tighter than that is hit by ordinary swings in more than 1 hold in 5.`]);
  }
  const next = nextResults(calendar(), symbol, state.prices.quotes ?? {}, new Date());
  const r = d.results;
  if (r || next) {
    facts.push(['Results', [
      r?.typical_day_move_pct != null ? `Its results days moved it ±${r.typical_day_move_pct.toFixed(1)}% against ${idx} on average (${plural(r.n, 'result')}).` : '',
      next ? `Next: ${dayOf(next.date)}, ${SOURCE_LABELS[next.source] ?? next.source}.` : 'Its next date isn\'t known yet.',
    ].filter(Boolean).join(' ')]);
  }
  const dv = d.dividends;
  if (dv) {
    facts.push(['Dividends', [
      `Last ${price(dv.last[1])} ${ccy} on ${dayOf(dv.last[0])}${dv.yield_pct != null ? ` (${dv.yield_pct < 0.05 ? 'under 0.1%' : `${dv.yield_pct.toFixed(1)}%`} of today's price)` : ''}.`,
      dv.drop_vs_dividend != null ? `On its ex-dates the price fell about ${Math.round(dv.drop_vs_dividend * 100)}% of the dividend that day (${plural(dv.n, 'ex-date')} in ten years).` : '',
      dv.months?.length ? `It usually goes ex in ${monthList(dv.months)}.` : '',
      !dv.next ? '' : exDateLate(d, new Date()) ? `Next due any day: a year after the one a year before would have been about ${dayOf(dv.next.date)}, and it hasn't gone ex yet (an estimate).`
        : `Next about ${dayOf(dv.next.date)} (an estimate: a year after the one a year before).`,
    ].filter(Boolean).join(' ')]);
  }
  // (its note above the table rather than a caption, which would scroll with a table wider than a phone)
  const table = r?.reactions?.length ? `<p class="small muted stock-results-note">Its latest results days against ${esc(idx)}: the move on the day the price could react, and from the close before over a week and a month.</p>
    <div class="table-wrap"><table class="stock-results" aria-label="${esc(`${symbol}'s latest results days against ${idx}`)}">
      <thead><tr><th>Results</th><th class="num">Day</th><th class="num">Week</th><th class="num">Month</th></tr></thead>
      <tbody>${[...r.reactions].reverse().map(([date, day, week, month]) => {
        // a figure missing from an old results day wasn't measured (a ten-year memory from before it was); a recent one is still to come
        const gap = Date.now() - Date.parse(`${date}T12:00:00Z`) > 50 * 86400000 ? '–' : 'not yet';
        return `<tr><td>${dayOf(date)}</td><td class="num ${tone(day)}">${pctP(day)}</td>
        <td class="num ${week == null ? 'muted' : tone(week)}">${week == null ? gap : pctP(week)}</td><td class="num ${month == null ? 'muted' : tone(month)}">${month == null ? gap : pctP(month)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>` : '';
  return `<dl class="stock-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${table}
    ${d.data === 'rebuilt' ? `<p class="muted small">Yahoo's dividend-adjusted prices for ${esc(symbol)} were broken, so its ten-year figures come from its closes and dividends.</p>` : ''}`;
}

// The home page's AI picks' record on the stock (from the picks' history), and each fund's in its market
// (learning.js stockRecords, kept with the fund).
function stockRecordsSection(symbol, d) {
  const quotes = state.prices.quotes ?? {};
  const picks = state.picksHistory?.length ? picksRecord(scorePicks(state.picksHistory, quotes), symbol) : d?.picks ?? null;
  const rate = (x) => `${Math.round(x * 100)}%`;
  const after = (h, label) => (h ? `after ${label}, ${plural(h.n, 'pick')} scored: ${rate(h.right)} right${h.beat != null ? `, ${rate(h.beat)} beat the index` : ''}` : '');
  const items = [];
  if (picks) items.push(`<li><strong>The home page's AI picks:</strong> ${esc([after(picks.week, 'a week'), after(picks.month, 'a month')].filter(Boolean).join('; '))}.</li>`);
  const market = quotes[symbol]?.market ?? d?.market;
  for (const f of fundList()) {
    const rec = f.playbook?.stocks?.[symbol];
    if (!rec || marketForCurrency(f.currency) !== market) continue;
    const trades = rec.traded ? `${plural(rec.traded, 'trade')}${rec.bets ? ` (${plural(rec.bets, 'separate bet')})` : ''}${rec.edge != null ? `: a week later ${pct(rec.edge)} beyond the market's part and fees (likely ${pct(rec.lo)} to ${pct(rec.hi)}), and ${rate(rec.right)} made money` : ''}` : 'no trades';
    const other = rec.ideas - rec.traded;
    items.push(`<li><strong>${esc(f.name)}:</strong> ${esc(`${trades}${other ? `; ${plural(other, 'other idea')} (passed on, declined, blocked or expired)` : ''}.`)}</li>`);
  }
  if (!items.length) return '';
  return `<h4>Its record</h4><ul class="stock-records small">${items.join('')}</ul>
    <p class="muted small">Picks are graded a week and a month later, in their direction, against the index. A fund's edge is what's left a week later after the market's part (beta) and fees, pulled towards zero when there are few separate bets.</p>`;
}

// The owner's note on a stock: one per stock, shared by every fund (c.stockNotes), shown on each fund's
// position in it and read by every AI fund in its market. Admins write it; it goes to the job through
// the command path as 'settings' ({ fund: 'all', stockNote }), which reaches it whole.
const NOTE_TEXT = {
  save: ['Saving your note', 'Your note is saved: the AI reads it from its next decision.'],
  clear: ['Clearing your note', 'Your note is cleared.'],
};
function stockNoteSection(symbol) {
  const n = stockNote(symbol);
  const admin = authEnabled && state.user?.isAdmin;
  const owner = admin || !authEnabled; // who the notes are from (without accounts, whoever runs the page)
  const cmd = state.fundCmd && state.noteCmd === symbol && [NOTE_TEXT.save, NOTE_TEXT.clear].includes(state.fundCmd.text) ? state.fundCmd : null;
  const busy = state.fundCmd && ['sending', 'sent', 'accepted'].includes(state.fundCmd.phase) ? 'disabled' : '';
  const kept = n && !n.text; // the public copy of the funds keeps only when it was saved
  const saved = n?.at ? ` (${fmtDate(n.at)})` : '';
  const shown = n?.text ? `<p class="owner-note">${esc(n.text)}<span class="muted small">${esc(saved)}</span></p>`
    : kept && owner ? `<p class="small">You have a note on ${esc(symbol)}${esc(saved)}. The public copy of the funds leaves your notes out, so it isn't shown here; the AI still reads it. Keep the funds private to see it here (README: Keeping the AI fund private).</p>` : '';
  if (!admin && !shown) return '';
  const draft = state.noteDraft?.symbol === symbol ? state.noteDraft.text : n?.text ?? '';
  return `<section class="stock-note">
    <h4>${owner ? 'Your note' : 'The owner\'s note'}</h4>
    ${admin ? `<form id="stock-note-form" data-symbol="${esc(symbol)}">
      ${kept ? shown : ''}
      <textarea id="stock-note-text" maxlength="${DOSSIER.noteMax}" rows="2" placeholder="e.g. I also hold this in my own account, so don't short it" aria-label="Your note on ${esc(symbol)}">${esc(draft)}</textarea>
      <div class="row"><button type="submit" class="primary small-btn" ${busy}>Save note</button>${n ? `<button type="button" class="ghost small-btn" data-note-clear="${esc(symbol)}" ${busy}>Clear note</button>` : ''}</div>
      ${cmd?.message ? `<p class="small ${cmd.phase === 'failed' ? 'down' : 'muted'}" role="status">${esc(cmd.message)}</p>` : ''}
    </form>` : shown}
    <p class="muted small">${owner ? `One note per stock, shared by every fund: each fund's position in ${esc(symbol)} shows it, and every AI fund in its market reads it. It's stored with the funds, so it's private only when they're kept private.` : 'The owner\'s own note on this stock, which every AI fund in its market reads.'}</p>
  </section>`;
}

function renderStockDialog() {
  const v = state.stockView;
  if (!v) return;
  const { symbol } = v;
  const q = quote(symbol);
  const d = dossiers()[symbol] ?? null;
  const fund = v.fundId ? fundList().find((f) => f.id === v.fundId) ?? null : null;
  const dlg = $('stock-dialog'), top = dlg.scrollTop;
  const focused = focusKey();
  const day = q?.prevClose ? q.price / q.prevClose - 1 : null;
  const indexFund = !d && (q?.etf || Object.values(BENCHMARKS).some((b) => b.symbol === symbol));
  $('stock-body').innerHTML = `
    <h3 id="stock-title">${esc(q?.name ?? symbol)} <span class="muted">${esc(symbol)}</span></h3>
    <p class="small stock-sub">${q ? `${price(q.price)} ${esc(q.currency)}${day == null ? '' : ` <span class="${tone(day)}">${pct(day)}</span> today`} · ${esc(MARKETS[q.market]?.label ?? q.market)}` : ''}${resultsChip(symbol)}</p>
    ${stockPosition(symbol, fund)}
    ${stockChart(symbol, d, fund)}
    ${d ? stockFacts(symbol, d, q) : indexFund ? `<p class="muted small">${esc(symbol)} is an index fund: the notes on a stock's own swings, stop-losses, results and dividends are kept for the watchlist's stocks.</p>`
      : '<p class="muted small">No history for this stock yet: it appears after the next daily update.</p>'}
    ${stockRecordsSection(symbol, d)}
    ${stockNoteSection(symbol)}
    <p class="muted small stock-honest">Counts from this stock's own past, never rules: its next results or ex-date can go either way. Measured on today's watchlist, which survived and mostly won: tendencies, not laws.</p>`;
  flushCharts();
  dlg.scrollTop = top;
  restoreFocus(focused);
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
// DeepSeek, for the funds set to it: the key is a GitHub secret the page can't see, so this says which funds
// use it and whether the latest decision of one failed (a missing or rejected key shows up there).
function deepseekRow(row, status) {
  const funds = fundList().filter((f) => !f.stoppedAt && FUND_MODELS[f.settings?.model]?.provider === 'deepseek');
  if (!funds.length) return [];
  const failing = funds.find((f) => f.lastError && (!f.lastDecisionAt || Date.parse(f.lastError.time) > Date.parse(f.lastDecisionAt)));
  return [row('DeepSeek (AI fund decisions)',
    status(!failing, failing ? `Failing in "${failing.name}"` : `Used by ${funds.map((f) => `"${f.name}"`).join(', ')}`),
    `<p class="muted small">${failing ? `${esc(failing.lastError.message)} ` : ''}Uses the <code>DEEPSEEK_API_KEY</code> secret in GitHub (Settings → Secrets and variables → Actions). Only these funds' decisions go to DeepSeek, whose servers are in China; their news still comes from Claude.</p>`)];
}

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
      status(!!state.ai.key || strategistByJob(), state.ai.key ? 'Key saved in this browser' : strategistByJob() ? 'Strategist runs on GitHub' : 'No key yet'),
      `<p class="muted small">${strategistByJob() ? 'Without a key here, the AI strategist runs on GitHub with the scheduled key (3–5 minutes); a key here makes it answer straight away and turns on "Refresh now". ' : ''}${state.ai.key ? 'Change or remove it below.' : '<a href="#api-key-heading" data-focus-key>Add it below</a>.'} Stored only in this browser.
        Spent from this browser this month: about US$${monthSpend(state.browserSpend).toFixed(2)}.</p>`),
    row('Anthropic (scheduled AI picks and AI fund)',
      status(!!picksAt, picksAt ? `Working, last picks ${fmtDateTime(picksAt)}` : 'No AI picks yet'),
      `<p class="muted small">Uses the <code>ANTHROPIC_API_KEY</code> secret in ${secretsLink}.
        This month: about US$${monthSpend(state.spend).toFixed(2)}${state.spend?.cap ? ` of the US$${state.spend.cap} monthly cap (change it with the <code>AI_MONTHLY_CAP_USD</code> repository variable)` : ' (no monthly cap)'}.</p>`),
    ...deepseekRow(row, status),
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
  else if (d.stock) openStock(d.stock, d.stockFund ?? null);
  else if (d.noteClear) {
    if (confirm(`Clear your note on ${d.noteClear}? Every fund stops showing it and the AI stops reading it.`)) {
      state.noteCmd = d.noteClear;
      state.noteDraft = null;
      submitFundCommand('settings', { payload: { fund: 'all', stockNote: { symbol: d.noteClear, text: '' } } }, NOTE_TEXT.clear);
    }
  } else if (d.cancelOrder) {
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
window.addEventListener('hashchange', () => { $('tooltip').hidden = true; followDeepLink(); render(); });
document.addEventListener('change', (e) => {
  if (e.target.id !== 'report-week') return;
  state.reportWeek[e.target.dataset.fund] = e.target.value;
  render();
});
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
for (const id of ['stock-close', 'stock-x']) $(id).addEventListener('click', () => $('stock-dialog').close());
$('stock-dialog').addEventListener('close', () => { state.stockView = null; hideTips(); });

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
// The fund's sub-tabs, as tabs work: the arrow keys (and Home, End) move to the next tab and show it.
document.addEventListener('keydown', (e) => {
  const tab = e.target.closest?.('#fund-tabs [data-fund-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const all = [...$('fund-tabs').querySelectorAll('[data-fund-tab]')];
  const i = all.indexOf(tab);
  const next = all[e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
  setFundTab(next.dataset.fundTab);
  render();
  document.querySelector(`#fund-tabs [data-fund-tab="${CSS.escape(next.dataset.fundTab)}"]`)?.focus();
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
  // a link from Telegram that a sign-in took the page away from: back to the fund's page, still waiting
  // for the funds to load
  let linked = null;
  try { linked = sessionStorage.getItem(KEYS.deepLink); sessionStorage.removeItem(KEYS.deepLink); } catch { /* none */ }
  if (linked && currentView() !== 'fund') history.replaceState(null, '', `${location.pathname}${location.search}#fund`);
  try { const link = JSON.parse(linked); if (link?.id && !state.linkedFund) state.linkedFund = { id: String(link.id), jump: link.jump === 'approve' ? 'approve' : 'week' }; } catch { /* an older flag: the view alone */ }
  render();
  if (started) { loadPrices(); loadSideData(); return; } // signed in again, maybe as someone else
  started = true;
  loadPrices();
  loadSideData();
  setInterval(() => { loadPrices(); loadSideData(); }, PRICE_REFRESH_MS);
}

followDeepLink();
if (authEnabled) {
  wireAuthScreen();
  wireInvites(() => state.user?.email);
  showAuth('loading');
  onAuthChange(handleAuth).catch((err) => showAuth('error', `Could not load sign-in: ${err.message}`));
} else {
  state.portfolio = loadPortfolio();
  startApp();
}

// Installable as an app, and opens offline with the last prices (sw.js). Only on the real site (https):
// a local copy served over http runs without it.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('The offline copy could not be set up', err));
}
