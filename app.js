import { newPortfolio, applyTrade, summarize, validatePortfolio, buyingPower, DEFAULT_START, SHORT_MARGIN } from './portfolio.js';
import { CONDITIONS, UNITS, REPEATS, newRule, freshState, checkRule, describeRule, runRules, backtest } from './rules.js';
import { MODELS, TIERS, loadClient, analyze, recommend, buildContext } from './ai.js';
import { MARKETS, isOpen, marketForCurrency } from './markets.js';
import { authEnabled, onAuthChange, signOut, myInvite, loadCloudPortfolio, saveCloudPortfolio } from './auth.js';
import { showAuth, hideAuth, wireAuthScreen, openInvites, wireInvites } from './login.js';

const KEYS = { portfolio: 'paper-trader:portfolio', ai: 'paper-trader:ai', picks: 'paper-trader:picks', strategist: 'paper-trader:strategist' };
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
  localPicks: readStore(KEYS.picks),
  strategist: readStore(KEYS.strategist),
  fund: undefined, // undefined = not loaded yet, null = no fund
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
  const [picks, fund] = await Promise.allSettled([fetchJson('data/picks.json'), fetchJson('data/ai-fund.json')]);
  state.sitePicks = picks.status === 'fulfilled' ? picks.value : null;
  state.fund = fund.status === 'fulfilled' ? fund.value : null;
  render();
}

const quote = (symbol) => state.prices.quotes?.[symbol];

// ---------- automation ----------

// Runs auto-trading rules over any prices they haven't seen. Re-reads storage first so two open tabs don't double-trade.
function runAutomation() {
  if (authEnabled && !state.user) return; // signed out: nothing to trade for
  try {
    const saved = readStore(portfolioKey());
    if (saved) state.portfolio = validatePortfolio(saved);
  } catch { /* keep the in-memory copy */ }
  if (!state.portfolio.rules.some((r) => r.enabled)) return;
  const { portfolio, log } = runRules(state.portfolio, state.prices.quotes ?? {});
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
  return fmtCache[key].format(n);
}
const price = (n) => n == null ? '–' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
const pct = (n) => (n > 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
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

// A single-series line chart with a hover crosshair and tooltip. points: [{ label, value }].
// Axis labels are plain numbers (the currency is in the tooltip and the text around the chart).
const axisNumber = (v) => v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });

function lineChart(el, points, { ref = null, refLabel = '', fmt = (v) => v, height = 180 } = {}) {
  if (points.length < 2) { el.innerHTML = '<p class="muted small">Not enough data for a chart yet.</p>'; return; }
  const W = Math.max(280, el.clientWidth || 600), H = height, L = 56, R = 12, T = 10, B = 22;
  const vals = points.map((p) => p.value).concat(ref == null ? [] : [ref]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.02 || 1;
  lo -= pad; hi += pad;
  const x = (i) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  el.innerHTML = `
    <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Line chart of value over time">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(axisNumber(v))}</text>`).join('')}
      ${ref == null ? '' : `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/><text class="axis" x="${W - R}" y="${y(ref) - 5}" text-anchor="end">${esc(refLabel)}</text>`}
      <text class="axis" x="${L}" y="${H - 4}">${esc(points[0].axis ?? points[0].label)}</text>
      <text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${esc(points.at(-1).axis ?? points.at(-1).label)}</text>
      <path class="line" d="${path}"/>
      <line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <circle class="dot" r="4" visibility="hidden"/>
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
    </svg>`;
  const svg = el.querySelector('svg'), cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot'), tip = $('tooltip');
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) * (W / box.width);
    const i = Math.max(0, Math.min(points.length - 1, Math.round((px - L) / (W - L - R) * (points.length - 1))));
    const p = points[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.value)); dot.setAttribute('visibility', 'visible');
    tip.innerHTML = `<div class="muted">${esc(p.label)}</div><strong>${esc(fmt(p.value))}</strong>`;
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

// ---------- rendering ----------

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
}

const VIEWS = ['home', 'markets', 'auto', 'strategist', 'fund', 'history'];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');

function render() {
  const view = currentView();
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== view;
  for (const a of $('tabs').children) a.setAttribute('aria-selected', a.getAttribute('href') === `#${view}`);
  $('cards').hidden = view === 'fund';

  const { accounts, positions } = summarize(state.portfolio, state.prices.quotes);
  renderCards(accounts);
  if (view === 'home') { renderPicks(); renderHoldings(positions); }
  if (view === 'markets') renderMarkets();
  if (view === 'auto') renderRules();
  if (view === 'strategist') renderStrategist();
  if (view === 'fund') renderFund();
  if (view === 'history') renderTrades();
  if ($('trade-dialog').open) updateTradeDialog();

  $('updated').textContent = state.sample ? 'Sample prices'
    : state.prices.updatedAt ? `Prices updated ${ago(state.prices.updatedAt)}` : '';
  showBanner(state.sample
    ? 'Showing made-up sample prices so you can try the app. Real prices appear once the price job has run on GitHub (see README).'
    : '');
}

function renderCards(accounts) {
  const cards = Object.values(accounts).map((a) => `
    <div class="card">
      <div class="label">${a.currency} account · net profit / loss</div>
      <div class="big ${tone(a.net)}">${money(a.net, a.currency, { sign: true })}</div>
      <div class="${tone(a.net)}">${pct(a.netPct)} on ${money(a.start, a.currency)}</div>
      <div class="sub">
        <span>Cash</span><span>${money(a.cash, a.currency)}</span>
        ${a.hasShorts ? `<span>Buying power</span><span>${money(a.buyingPower, a.currency)}</span>` : ''}
        <span>Holdings</span><span>${money(a.marketValue, a.currency)}</span>
        <span>Realized</span><span class="${tone(a.realized)}">${money(a.realized, a.currency, { sign: true })}</span>
        <span>Unrealized</span><span class="${tone(a.unrealized)}">${money(a.unrealized, a.currency, { sign: true })}</span>
      </div>
    </div>`);

  const fx = state.prices.fx?.USDSGD;
  if (fx && accounts.SGD && accounts.USD) {
    const net = accounts.SGD.net + accounts.USD.net * fx;
    const start = accounts.SGD.start + accounts.USD.start * fx;
    cards.push(`
      <div class="card">
        <div class="label">Combined, in SGD</div>
        <div class="big ${tone(net)}">${money(net, 'SGD', { sign: true })}</div>
        <div class="${tone(net)}">${pct(start ? net / start : 0)}</div>
        <p class="muted small">USD converted at today's rate of ${fx.toFixed(4)}. Each account's own figure ignores exchange rates.</p>
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
    render();
  } catch (err) {
    $('picks-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
}

function renderHoldings(positions) {
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
  const status = Object.keys(MARKETS).map((m) => `${MARKETS[m].label} ${isOpen(m) ? 'open' : 'closed'}`).join(' · ');
  $('market-status').textContent = `${status}. Prices may be delayed; outside trading hours, orders fill at the last price.`;

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

function renderTrades() {
  const trades = state.portfolio.trades.slice().sort((a, b) => b.time.localeCompare(a.time));
  if (!trades.length) {
    $('trades').innerHTML = '<tr><td class="empty">No trades yet.</td></tr>';
    return;
  }
  const ruleNote = (id) => state.portfolio.rules.find((r) => r.id === id)?.note;
  $('trades').innerHTML = `
    <thead><tr>
      <th>When</th><th>Stock</th><th class="num">Shares</th><th class="num">Price</th><th class="num hide-sm">Amount</th><th class="num">Realized</th>
    </tr></thead>
    <tbody>${trades.map((t) => `<tr>
      <td>${fmtDateTime(t.time)}</td>
      <td><strong>${esc(t.symbol)}</strong><span class="chip ${t.side}">${t.side}</span>${t.rule ? `<span class="chip" title="${esc(ruleNote(t.rule) || 'Auto-trading rule')}">auto</span>` : ''}</td>
      <td class="num">${t.qty.toLocaleString()}</td>
      <td class="num">${price(t.price)}</td>
      <td class="num hide-sm">${money(t.value, t.currency)}</td>
      <td class="num ${tone(t.realized)}">${t.realized ? money(t.realized, t.currency, { sign: true }) : ''}</td>
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
  if (side === 'buy') return held < 0 ? -held : Math.floor(bp / q.price);
  return held > 0 ? held : Math.floor(bp / (q.price * (SHORT_MARGIN - 1)));
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
  $('trade-submit').textContent = label;
  $('trade-submit').className = side === 'buy' ? 'primary' : 'danger';

  const facts = [
    ['Price', `${price(q.price)} ${ccy}`],
    ['You hold', held < 0 ? `${shares(-held)} short` : shares(held)],
    ['Buying power', money(buyingPower(state.portfolio, ccy), ccy)],
  ];
  if (closing) {
    const pl = (q.price - avg) * closing * Math.sign(held);
    facts.push(['Profit / loss on what you close', `<span class="${tone(pl)}">${money(pl, ccy, { sign: true })}</span>`]);
  }
  facts.push([side === 'buy' ? 'Total cost' : 'You receive', `<strong>${money(qty * q.price, ccy)}</strong>`]);
  $('trade-facts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const notes = [];
  if (side === 'sell' && opening > 0) {
    notes.push(`${closing ? `This sells your ${shares(closing)} and shorts` : 'This shorts'} ${shares(opening)}: you profit if the price falls and lose if it rises. A short sets aside ${SHORT_MARGIN * 100}% of its value from your buying power until you cover it.`);
  }
  if (q.time) notes.push(`Fills at the last price, from ${fmtDateTime(q.time)}.`);
  if (!isOpen(q.market)) notes.push(`${MARKETS[q.market].label} is closed now, so that is the latest close.`);
  $('trade-note').textContent = notes.join(' ');
}

function submitTrade(e) {
  e.preventDefault();
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  try {
    state.portfolio = applyTrade(state.portfolio, { symbol, side, qty: $('qty').value, price: q.price, currency: q.currency });
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
      <dt>Strategy result</dt><dd class="${tone(bt.returnPct)}"><strong>${pct(bt.returnPct)}</strong></dd>
      <dt>Buying and holding instead</dt><dd class="${tone(bt.buyHoldPct)}">${pct(bt.buyHoldPct)}</dd>
      <dt>Trades · worst drop</dt><dd>${bt.trades} · ${pct(-bt.maxDrawdown)}</dd>
    </dl>
    <div class="bt-chart"></div>
    <p class="muted small">Starts with ${money(bt.startCash, bt.currency)}${bt.startInvested ? ' fully invested (these rules only sell)' : ' in cash'}. Uses daily closing prices, so it's an approximation. Past results don't predict future ones.</p>
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
    lineChart(chart, pts, { ref: bt.startCash, refLabel: 'Start', fmt: (v) => money(v, bt.currency), height: 120 });
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
    return `<div class="rule" data-bt="${esc(r.id)}">
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
  state.backtests.editor = backtest([r], quote(r.symbol));
  $('rule-test').innerHTML = `<div data-bt="editor">${renderBacktest(state.backtests.editor)}</div>`;
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
  if (!$('st-run').disabled) $('st-status').textContent = state.ai.key ? '' : 'Add your Anthropic API key in Settings first.';
  const a = state.strategist;
  if (!a) { $('strategist').innerHTML = ''; return; }
  a.strategies.forEach((s, i) => { state.backtests[`s${i}`] ??= s.rules.length ? backtest(s.rules, quote(s.symbol)) : null; });
  $('strategist').innerHTML = `
    <div class="analysis">
      <p class="muted small">From ${fmtDateTime(a.createdAt)} · ${esc(madeBy(a))} · about US$${a.usage.costUsd.toFixed(2)}</p>
      <p class="lead">${esc(a.summary)}</p>
      ${a.observations.length ? `<ul>${a.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      ${a.strategies.map((s, i) => {
        const q = quote(s.symbol);
        return `<article class="strategy" data-bt="s${i}">
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

function repoActionsUrl() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}/actions/workflows/prices.yml` : null;
}

function renderFund() {
  const el = $('fund');
  const f = state.fund;
  const actions = repoActionsUrl();
  const runLink = actions
    ? `<a href="${actions}" target="_blank" rel="noopener">Actions → Update prices, AI picks and AI fund</a>`
    : '<strong>Actions → Update prices, AI picks and AI fund</strong>';
  if (f === undefined) { el.innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>'; return; }
  if (!f) {
    el.innerHTML = `<section class="panel">
      <h2>AI fund</h2>
      <p>Give Claude an amount and let it trade on its own, aiming for the biggest profit it can make. It runs on GitHub, so it keeps trading while this page is closed.</p>
      <ol>
        <li>Add your Anthropic API key to the GitHub repo as a secret named <code>ANTHROPIC_API_KEY</code> (Settings → Secrets and variables → Actions).</li>
        <li>Open ${runLink}, press <strong>Run workflow</strong>, and fill in <em>Start a NEW AI fund with this amount</em>, its currency (USD trades US stocks, SGD trades SGX stocks) and how many decisions a day.</li>
        <li>Come back here in a few minutes.</li>
      </ol>
      <p class="small"><strong>Hard limit:</strong> the fund's ledger starts with exactly that amount and nothing is ever added, so any order costing more than its buying power is rejected. Shorts need 150% collateral and are closed automatically at a 40% loss, so the fund can't lose more than its amount.</p>
      <p class="muted small">Cost: each decision is one Claude call with web search, roughly US$0.05–0.15: Claude Haiku 4.5 reads the news and Claude Sonnet 5 decides.</p>
    </section>`;
    return;
  }
  const quotes = state.prices.quotes ?? {};
  const { accounts, positions } = summarize(f.portfolio, quotes);
  const a = accounts[f.currency];
  const market = marketForCurrency(f.currency);
  const status = f.stoppedAt
    ? `Stopped ${fmtDateTime(f.stoppedAt)}`
    : `Running · ${f.decisionsPerDay} decision${f.decisionsPerDay > 1 ? 's' : ''} per trading day · ${MARKETS[market].label} ${isOpen(market) ? 'open' : 'closed'}`;
  el.innerHTML = `
    <section class="cards">
      <div class="card"><div class="label">AI fund · profit / loss</div>
        <div class="big ${tone(a.net)}">${money(a.net, f.currency, { sign: true })}</div>
        <div class="${tone(a.net)}">${pct(a.netPct)} on ${money(f.budget, f.currency)}</div></div>
      <div class="card"><div class="label">Value now</div><div class="big">${money(a.equity, f.currency)}</div>
        <div class="sub"><span>Cash</span><span>${money(a.cash, f.currency)}</span><span>Buying power</span><span>${money(a.buyingPower, f.currency)}</span></div></div>
      <div class="card"><div class="label">Status</div><p>${esc(status)}</p>
        <p class="muted small">Started ${fmtDateTime(f.startedAt)}. Last decision ${f.lastDecisionAt ? ago(f.lastDecisionAt) : 'not yet'}.</p>
        ${f.lastError ? `<p class="down small">Last decision failed ${ago(f.lastError.time)}: ${esc(f.lastError.message)}</p>` : ''}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Fund value</h2></div>
      <div id="fund-chart"></div>
      <p class="muted small">Hard limit: the fund can only use its ${money(f.budget, f.currency)}. Orders beyond its buying power are rejected, and shorts are closed automatically at a 40% loss.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Positions</h2></div>
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
    <section class="panel">
      <div class="panel-head"><h2>Decisions</h2></div>
      ${f.decisions.slice().reverse().slice(0, 30).map((d) => `<article class="decision">
        <header><strong>${fmtDateTime(d.time)}</strong>${d.usage ? ` <span class="muted small">${esc(madeBy(d))} · about US$${d.usage.costUsd.toFixed(2)}</span>` : ''}</header>
        <p>${esc(d.outlook)}</p>
        ${d.orders.length ? `<ul class="orders">${d.orders.map((o) => `<li><span class="chip ${o.action === 'buy' || o.action === 'cover' ? 'buy' : 'sell'}">${esc(o.action)}</span>
          ${Number(o.shares).toLocaleString()} ${esc(o.symbol)} ${o.status === 'filled' ? `at ${price(o.price)}` : `<span class="down">rejected: ${esc(o.message)}</span>`}
          <span class="muted small">${esc(o.reason)}</span></li>`).join('')}</ul>` : '<p class="muted small">No trades this round.</p>'}
        ${sources(d.source_urls)}
      </article>`).join('') || '<p class="muted">No decisions yet. The first one happens 15 minutes after the market opens.</p>'}
    </section>
    ${f.events.length ? `<section class="panel"><div class="panel-head"><h2>Automatic closes</h2></div><ul class="orders">
      ${f.events.slice().reverse().slice(0, 20).map((e) => `<li>${fmtDateTime(e.time)}: ${esc(e.action)} ${e.shares.toLocaleString()} ${esc(e.symbol)} at ${price(e.price)} <span class="muted small">(${esc(e.why)})</span></li>`).join('')}
    </ul></section>` : ''}
    <p class="muted small">To stop the fund and close its positions, or to start a new one, use ${runLink} → Run workflow.</p>`;
  lineChart($('fund-chart'), (f.history ?? []).map(([t, v]) => ({ label: fmtDateTime(t), axis: fmtDate(t), value: v })), { ref: f.budget, refLabel: 'Budget', fmt: (v) => money(v, f.currency) });
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
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
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
  state.portfolio = { ...newPortfolio({ SGD: sgd, USD: usd }), rules };
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
  else if (d.editRule) openRuleEditor(d.editRule);
  else if (d.testRule) {
    const r = state.portfolio.rules.find((x) => x.id === d.testRule);
    state.backtests[r.id] = backtest([r], quote(r.symbol));
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

$('open-settings').addEventListener('click', openSettings);
$('api-key').addEventListener('change', saveAiSettings);
$('ai-model').addEventListener('change', saveAiSettings);
$('forget-key').addEventListener('click', () => { $('api-key').value = ''; saveAiSettings(); });
$('settings-form').addEventListener('submit', () => { saveAiSettings(); render(); });
$('reset').addEventListener('click', reset);
$('export').addEventListener('click', exportPortfolio);
$('import').addEventListener('change', importPortfolio);
$('refresh').addEventListener('click', () => { loadPrices(); loadSideData(); });

// Another tab traded or changed rules: pick up its changes.
window.addEventListener('storage', (e) => {
  if (e.key === portfolioKey()) { state.portfolio = loadPortfolio(); render(); }
});

$('sign-out').addEventListener('click', doSignOut);
$('open-invites').addEventListener('click', () => openInvites(state.user?.email));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshFromAccount(); });

let started = false;
function startApp() {
  render();
  if (started) { loadPrices(); return; }
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
