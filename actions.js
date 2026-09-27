// Stock splits and dividends ("corporate actions"), from the events Yahoo reports with each stock's
// daily prices (quote.events, see scripts/fetch-prices.mjs). Pure functions, used for your portfolio
// (in the browser) and for the AI fund (in the scheduled job).
//
// - A split changes the number of shares, not their total cost: 10 shares at $300 become 30 at $100
//   in a 3-for-1 split. (Yahoo's prices are already split-adjusted, so without this a holding would
//   look like it crashed.)
// - A dividend is paid on the shares held when the stock goes ex-dividend (the start of the ex-date's
//   session), credited on that day. US dividends lose 30% to US withholding tax, the rate for a
//   Singapore resident; SGX dividends are paid in full. A short position pays the dividend instead.
// Each event is applied once (portfolio.actions remembers them), and only if it happened after the
// portfolio started.

export const WITHHOLDING = { US: 0.3, SGX: 0 };
const money = (n) => Math.round(n * 10000) / 10000;

// The dividends a share of `q` paid (before tax) with an ex-date after unix time t0 and up to t1.
// Holding from t0 to t1 earns them; a purchase made on the ex-date itself doesn't.
export function divsBetween(q, t0, t1) {
  let sum = 0;
  for (const [t, perShare] of q?.events?.dividends ?? []) if (t > t0 && t <= t1 && perShare > 0) sum += perShare;
  return sum;
}

// Those dividends as a share of `price`, for a bet in `direction`: a long (+1) receives them after
// withholding tax, a short (-1) pays them in full. Adding this to the price move gives the total
// return, so an idea isn't marked down (or a short marked up) just because the stock went ex-dividend.
export function dividendReturn(q, t0, t1, direction, price) {
  const d = divsBetween(q, t0, t1);
  if (!d || !(price > 0)) return 0;
  return direction > 0 ? d * (1 - (WITHHOLDING[q.market] ?? 0)) / price : -d / price;
}

// Shares of `symbol` held just before unix time `t`, replaying trades and the splits already applied.
export function holdingAt(portfolio, symbol, t) {
  const steps = [
    ...portfolio.trades.filter((x) => x.symbol === symbol).map((x) => ({ t: Date.parse(x.time) / 1000, delta: x.side === 'buy' ? x.qty : -x.qty })),
    ...(portfolio.actions ?? []).filter((a) => a.symbol === symbol && a.kind === 'split').map((a) => ({ t: a.t, ratio: a.ratio })),
  ].filter((x) => x.t < t).sort((a, b) => a.t - b.t);
  let qty = 0;
  for (const s of steps) qty = s.ratio ? Math.round(qty * s.ratio) : qty + s.delta;
  return qty;
}

// Applies every new split and dividend. Returns { portfolio, applied } (a new portfolio if anything
// changed). `quotes` are prices.json quotes; `now` stops events dated in the future being applied.
export function applyCorporateActions(portfolio, quotes = {}, now = new Date()) {
  const start = Date.parse(portfolio.createdAt) / 1000;
  const seen = new Set((portfolio.actions ?? []).map((a) => a.id));
  const todo = [];
  for (const [symbol, q] of Object.entries(quotes)) {
    const traded = portfolio.positions[symbol] || portfolio.trades.some((x) => x.symbol === symbol);
    if (!traded || !q.events) continue;
    for (const [t, ratio] of q.events.splits ?? []) todo.push({ id: `${symbol}:split:${t}`, symbol, kind: 'split', t, ratio, q });
    for (const [t, perShare] of q.events.dividends ?? []) todo.push({ id: `${symbol}:div:${t}`, symbol, kind: 'dividend', t, perShare, q });
  }
  const fresh = todo.filter((e) => !seen.has(e.id) && e.t > start && e.t <= now.getTime() / 1000).sort((a, b) => a.t - b.t);
  if (!fresh.length) return { portfolio, applied: [] };

  const p = structuredClone(portfolio);
  p.actions ??= [];
  const applied = [];
  for (const e of fresh) {
    const held = holdingAt(p, e.symbol, e.t);
    const pos = p.positions[e.symbol];
    const currency = pos?.currency ?? e.q.currency;
    const record = { id: e.id, t: e.t, time: new Date(e.t * 1000).toISOString(), symbol: e.symbol, kind: e.kind, qty: held, currency };
    if (e.kind === 'split') {
      if (!(e.ratio > 0) || e.ratio === 1) continue;
      record.ratio = e.ratio;
      if (held && pos) {
        // The shares held at the split are multiplied; the position's total cost stays the same.
        const extra = Math.round(held * e.ratio) - held;
        const cost = pos.avgCost * pos.qty;
        pos.qty += extra;
        if (pos.qty === 0) delete p.positions[e.symbol];
        else pos.avgCost = cost / pos.qty;
        record.newQty = pos.qty;
      }
    } else {
      if (!(e.perShare > 0)) continue;
      record.perShare = e.perShare;
      const acct = p.accounts[currency];
      if (held && acct) {
        const gross = held * e.perShare;
        const tax = held > 0 ? gross * (WITHHOLDING[e.q.market] ?? 0) : 0;
        const amount = money(gross - tax); // negative for a short: it pays the dividend
        acct.cash = money(acct.cash + amount);
        acct.realized = money(acct.realized + amount);
        acct.dividends = money((acct.dividends ?? 0) + amount);
        Object.assign(record, { amount, tax: money(tax) });
      }
    }
    p.actions.push(record);
    if (held) applied.push(record);
  }
  p.actions = p.actions.slice(-1000);
  return { portfolio: p, applied };
}

export function describeAction(a, fmt = (n) => n.toFixed(2)) {
  if (a.kind === 'split') {
    const r = a.ratio >= 1 ? `${+a.ratio.toFixed(4)}-for-1 split` : `1-for-${+(1 / a.ratio).toFixed(4)} reverse split`;
    return `${a.symbol} ${r}: ${a.qty.toLocaleString()} shares became ${(a.newQty ?? 0).toLocaleString()}`;
  }
  const shares = Math.abs(a.qty).toLocaleString();
  return a.qty > 0
    ? `${a.symbol} dividend of ${fmt(a.perShare)} a share on ${shares} shares: ${fmt(a.amount)}${a.tax ? ` after ${fmt(a.tax)} US withholding tax` : ''}`
    : `${a.symbol} dividend of ${fmt(a.perShare)} a share paid on ${shares} shorted shares: ${fmt(a.amount)}`;
}
