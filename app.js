import { newPortfolio, applyTrade, summarize, validatePortfolio, DEFAULT_START } from './portfolio.js';

const STORAGE_KEY = 'paper-trader:portfolio';
const PRICE_REFRESH_MS = 5 * 60 * 1000;
const $ = (id) => document.getElementById(id);

const state = {
  prices: { quotes: {}, fx: {} },
  sample: false,
  portfolio: loadPortfolio(),
  marketFilter: 'all',
  trade: null, // { symbol, side }
};

// ---------- storage ----------

function loadPortfolio() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return validatePortfolio(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not read saved portfolio', err);
  }
  return newPortfolio();
}

function savePortfolio() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.portfolio));
  } catch {
    showBanner('This browser is not letting the page save, so trades will be lost when you close it. Export your portfolio to keep it.');
  }
}

// ---------- prices ----------

async function loadPrices() {
  try {
    const res = await fetch(`data/prices.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(res.status);
    state.prices = await res.json();
    state.sample = false;
  } catch {
    const res = await fetch('data/sample-prices.json');
    state.prices = await res.json();
    state.sample = true;
  }
  render();
}

const quote = (symbol) => state.prices.quotes?.[symbol];

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

// ---------- market hours (by the clock; exchange holidays aren't known) ----------

const MARKET = {
  SGX: { tz: 'Asia/Singapore', sessions: [[9 * 60, 12 * 60], [13 * 60, 17 * 60]], label: 'SGX' },
  US: { tz: 'America/New_York', sessions: [[9 * 60 + 30, 16 * 60]], label: 'US' },
};

function isOpen(market, now = new Date()) {
  const m = MARKET[market];
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: m.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return m.sessions.some(([a, b]) => mins >= a && mins < b);
}

// ---------- rendering ----------

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
}

function render() {
  const { accounts, positions } = summarize(state.portfolio, state.prices.quotes);
  renderCards(accounts);
  renderHoldings(positions);
  renderMarkets();
  renderTrades();
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
        <p class="muted small">USD converted at today's rate of ${fx.toFixed(4)}. Each account's own figure above ignores exchange rates.</p>
      </div>`);
  }
  $('cards').innerHTML = cards.join('');
}

function renderHoldings(positions) {
  if (!positions.length) {
    $('holdings').innerHTML = '<tr><td class="empty">No holdings yet. Pick a stock under Markets and press Buy.</td></tr>';
    return;
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  $('holdings').innerHTML = `
    <thead><tr>
      <th>Stock</th><th class="num">Shares</th><th class="num hide-sm">Avg cost</th><th class="num">Price</th>
      <th class="num hide-sm">Value</th><th class="num">Profit / loss</th><th></th>
    </tr></thead>
    <tbody>${positions.map((p) => {
      const q = quote(p.symbol);
      return `<tr>
        <td><strong>${esc(p.symbol)}</strong><span class="name">${esc(q?.name ?? '')}</span></td>
        <td class="num">${p.qty.toLocaleString()}</td>
        <td class="num hide-sm">${price(p.avgCost)}</td>
        <td class="num">${p.unpriced ? '<span title="No current price; valued at cost">–</span>' : price(p.price)}</td>
        <td class="num hide-sm">${money(p.marketValue, p.currency)}</td>
        <td class="num ${tone(p.unrealized)}">${money(p.unrealized, p.currency, { sign: true })}<br><span class="small">${pct(p.unrealizedPct)}</span></td>
        <td class="num"><button class="small-btn" data-trade="${esc(p.symbol)}" data-side="sell">Sell</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

function renderMarkets() {
  const status = Object.keys(MARKET).map((m) => `${MARKET[m].label} ${isOpen(m) ? 'open' : 'closed'}`).join(' · ');
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
        <td class="hide-sm">${sparkline(q.history)}</td>
        <td class="num hide-sm">${held ? held.toLocaleString() : ''}</td>
        <td class="num"><button class="small-btn" data-trade="${esc(symbol)}" data-side="buy">Buy</button></td>
      </tr>`;
    }).join('')}</tbody>`;
}

function renderTrades() {
  const trades = state.portfolio.trades.slice().reverse();
  if (!trades.length) {
    $('trades').innerHTML = '<tr><td class="empty">No trades yet.</td></tr>';
    return;
  }
  $('trades').innerHTML = `
    <thead><tr>
      <th>When</th><th>Stock</th><th class="num">Shares</th><th class="num">Price</th><th class="num hide-sm">Amount</th><th class="num">Realized</th>
    </tr></thead>
    <tbody>${trades.map((t) => `<tr>
      <td>${new Date(t.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td><strong>${esc(t.symbol)}</strong><span class="chip ${t.side}">${t.side}</span></td>
      <td class="num">${t.qty.toLocaleString()}</td>
      <td class="num">${price(t.price)}</td>
      <td class="num hide-sm">${money(t.value, t.currency)}</td>
      <td class="num ${tone(t.realized)}">${t.side === 'sell' ? money(t.realized, t.currency, { sign: true }) : ''}</td>
    </tr>`).join('')}</tbody>`;
}

// ---------- trade dialog ----------

function openTrade(symbol, side) {
  state.trade = { symbol, side };
  const q = quote(symbol);
  $('trade-title').textContent = `${symbol} · ${q?.name ?? ''}`;
  $('qty').value = q?.market === 'SGX' ? 100 : 1;
  if (side === 'sell') $('qty').value = state.portfolio.positions[symbol]?.qty ?? 0;
  $('trade-error').textContent = '';
  updateTradeDialog();
  $('trade-dialog').showModal();
  $('qty').select();
}

function maxQty() {
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  if (side === 'sell') return state.portfolio.positions[symbol]?.qty ?? 0;
  const cash = state.portfolio.accounts[q?.currency]?.cash ?? 0;
  const lot = q?.market === 'SGX' ? 100 : 1;
  return q?.price > 0 ? Math.floor(cash / q.price / lot) * lot : 0;
}

function updateTradeDialog() {
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  const qty = Number($('qty').value) || 0;
  const ccy = q?.currency ?? 'USD';
  const acct = state.portfolio.accounts[ccy];
  const pos = state.portfolio.positions[symbol];

  for (const b of $('side').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.side === side);
  $('trade-submit').textContent = side === 'buy' ? 'Buy' : 'Sell';
  $('trade-submit').className = side === 'buy' ? 'primary' : 'danger';

  const total = qty * (q?.price ?? 0);
  const facts = [
    ['Price', `${price(q?.price)} ${ccy}`],
    ['You hold', `${(pos?.qty ?? 0).toLocaleString()} shares`],
    ['Cash available', acct ? money(acct.cash, ccy) : '–'],
  ];
  if (side === 'sell' && pos) {
    facts.push(['Profit / loss on this sale', `<span class="${tone(q.price - pos.avgCost)}">${money((q.price - pos.avgCost) * qty, ccy, { sign: true })}</span>`]);
  }
  facts.push([side === 'buy' ? 'Total cost' : 'You receive', `<span class="total">${money(total, ccy)}</span>`]);
  $('trade-facts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const notes = [];
  if (q?.time) notes.push(`Fills at the last price, from ${new Date(q.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`);
  if (q && !isOpen(q.market)) notes.push(`${MARKET[q.market].label} is closed now, so that is the latest close.`);
  if (q?.market === 'SGX' && qty % 100) notes.push('SGX normally trades in lots of 100 shares.');
  $('trade-note').textContent = notes.join(' ');
}

function submitTrade(e) {
  e.preventDefault();
  const { symbol, side } = state.trade;
  const q = quote(symbol);
  try {
    state.portfolio = applyTrade(state.portfolio, { symbol, side, qty: $('qty').value, price: q?.price, currency: q?.currency });
    savePortfolio();
    $('trade-dialog').close();
    render();
  } catch (err) {
    $('trade-error').textContent = err.message;
  }
}

// ---------- settings dialog ----------

function openSettings() {
  const a = state.portfolio.accounts;
  $('start-sgd').value = a.SGD?.start ?? DEFAULT_START.SGD;
  $('start-usd').value = a.USD?.start ?? DEFAULT_START.USD;
  $('settings-started').textContent = `Current portfolio started ${new Date(state.portfolio.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}, ${state.portfolio.trades.length} trades.`;
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
}

function reset() {
  const sgd = Number($('start-sgd').value), usd = Number($('start-usd').value);
  if (!(sgd >= 0 && usd >= 0)) {
    $('settings-error').textContent = 'Starting cash must be zero or more.';
    return;
  }
  if (!confirm('Delete all holdings and trades and start over?')) return;
  state.portfolio = newPortfolio({ SGD: sgd, USD: usd });
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
    if (!confirm(`Replace your current portfolio with this one (${p.trades.length} trades)?`)) return;
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
  const btn = e.target.closest('[data-trade]');
  if (btn) openTrade(btn.dataset.trade, btn.dataset.side);
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
$('open-settings').addEventListener('click', openSettings);
$('reset').addEventListener('click', reset);
$('export').addEventListener('click', exportPortfolio);
$('import').addEventListener('change', importPortfolio);
$('refresh').addEventListener('click', loadPrices);

// Another tab traded: pick up its changes.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) { state.portfolio = loadPortfolio(); render(); }
});

loadPrices();
setInterval(loadPrices, PRICE_REFRESH_MS);
