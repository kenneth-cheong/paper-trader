import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFund, decisionDue, applyOrders, setProtections, checkProtections, recordValue, stopFund } from '../fund.js';
import { summarize, buyingPower } from '../portfolio.js';

// Wed 7 Jan 2026. US market: 14:30-21:00 UTC. SGX: 01:00-04:00 and 05:00-09:00 UTC.
const at = (hhmm) => new Date(`2026-01-07T${hhmm}:00Z`);
const q = (price, extra = {}) => ({ currency: 'USD', price, daily: [], intraday: [], ...extra });

test('a new fund holds exactly its budget', () => {
  const f = newFund({ budget: 5000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('10:00') });
  assert.equal(f.portfolio.accounts.USD.cash, 5000);
  assert.deepEqual(Object.keys(f.portfolio.accounts), ['USD']);
  assert.throws(() => newFund({ budget: 0, currency: 'USD' }), /above 0/);
  assert.throws(() => newFund({ budget: 10, currency: 'EUR' }), /Unsupported/);
});

// Prices as the page and the job see them: the newest quote per market was at `quoteAt`.
const pricesAt = (quoteAt, market = 'US', updatedAt = quoteAt) => ({
  updatedAt: updatedAt.toISOString(),
  quotes: { X: { market, currency: market === 'US' ? 'USD' : 'SGD', price: 1, time: quoteAt.toISOString() } },
});
const live = (now, market = 'US') => pricesAt(new Date(now.getTime() - 20 * 60000), market, now);

test('decisions are due 15 minutes after the open, then spaced through the session', () => {
  const f = newFund({ budget: 5000, currency: 'USD', decisionsPerDay: 2, now: at('10:00') });
  const due = (t, fund = f) => decisionDue(fund, at(t), live(at(t)));
  assert.equal(decisionDue(f, at('14:40'), pricesAt(at('14:35'))), false); // 10 min after open
  assert.equal(decisionDue(f, at('14:45'), pricesAt(at('14:40'))), true);
  f.lastDecisionAt = at('14:45').toISOString();
  assert.equal(due('16:30'), false);
  assert.equal(due('18:00'), true); // 195-minute gap for 2 a day
  assert.equal(due('22:00'), false); // closed
  const sgx = newFund({ budget: 5000, currency: 'SGD', now: at('00:00') });
  assert.equal(decisionDue(sgx, at('01:20'), pricesAt(at('01:15'), 'SGX')), true);
  assert.equal(decisionDue(sgx, at('04:30'), pricesAt(at('04:00'), 'SGX')), false); // lunch break
  f.stoppedAt = at('15:00').toISOString();
  assert.equal(due('18:00'), false);
});

test('no decision on a holiday or after an early close, when the clock says open but prices stopped', () => {
  const f = newFund({ budget: 5000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('10:00') });
  const yesterdayClose = new Date('2026-01-06T21:00:00Z');
  // A US holiday: the price job runs, but the newest US price is from yesterday.
  assert.equal(decisionDue(f, at('18:00'), pricesAt(yesterdayClose, 'US', at('17:55'))), false);
  // No prices at all
  assert.equal(decisionDue(f, at('18:00'), null), false);
  // An early close at 13:00 New York (18:00 UTC): by 19:30 UTC the newest price is 90 minutes old.
  assert.equal(decisionDue(f, at('19:30'), pricesAt(at('18:00'), 'US', at('19:25'))), false);
});

test('the fund can never spend more than its budget', () => {
  const f = newFund({ budget: 1000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('10:00') });
  const quotes = { A: q(100), B: q(50), C: { ...q(10), currency: 'SGD' } };
  const res = applyOrders(f, [
    { symbol: 'A', action: 'buy', shares: 8, reason: '' },
    { symbol: 'B', action: 'buy', shares: 5, reason: '' }, // 250 > the 200 left
    { symbol: 'C', action: 'buy', shares: 1, reason: '' },
    { symbol: 'Z', action: 'buy', shares: 1, reason: '' },
  ], quotes, at('15:00'));
  assert.deepEqual(res.map((r) => r.status), ['filled', 'rejected', 'rejected', 'rejected']);
  assert.match(res[1].message, /Not enough USD cash/);
  assert.equal(f.portfolio.accounts.USD.cash, 200);
});

test('sells run before buys so the freed cash can be reused', () => {
  const f = newFund({ budget: 1000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('10:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }], { A: q(100) }, at('15:00'));
  const res = applyOrders(f, [
    { symbol: 'B', action: 'buy', shares: 10, reason: '' },
    { symbol: 'A', action: 'sell', shares: 10, reason: '' },
  ], { A: q(100), B: q(100) }, at('16:00'));
  assert.deepEqual(res.map((r) => `${r.symbol}:${r.status}`), ['A:filled', 'B:filled']);
});

test('short and cover work, but actions must match the position', () => {
  const f = newFund({ budget: 1500, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('10:00') });
  const quotes = { A: q(100) };
  let res = applyOrders(f, [{ symbol: 'A', action: 'short', shares: 10, reason: '' }], quotes, at('15:00'));
  assert.equal(res[0].status, 'filled');
  assert.equal(buyingPower(f.portfolio, 'USD'), 1000);
  res = applyOrders(f, [
    { symbol: 'A', action: 'buy', shares: 1, reason: '' },
    { symbol: 'A', action: 'sell', shares: 1, reason: '' },
  ], { A: q(90) }, at('16:00'));
  assert.deepEqual(res.map((r) => `${r.action}:${r.status}`), ['sell:rejected', 'buy:rejected']);
  assert.match(res[1].message, /use cover/);
  res = applyOrders(f, [{ symbol: 'A', action: 'cover', shares: 50, reason: '' }], { A: q(90) }, at('16:15'));
  assert.equal(res[0].status, 'filled');
  assert.equal(res[0].shares, 10); // capped at the short size
  assert.equal(f.portfolio.accounts.USD.realized, 100);
});

test('stop-loss and take-profit fire on the 15-minute prices between decisions', () => {
  const f = newFund({ budget: 10000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 10, reason: '' }, { symbol: 'B', action: 'buy', shares: 10, reason: '' }], { A: q(100), B: q(100) }, at('14:45'));
  setProtections(f, [
    { symbol: 'A', stop_loss_pct: 5, take_profit_pct: 0 },
    { symbol: 'B', stop_loss_pct: 0, take_profit_pct: 10 },
    { symbol: 'Z', stop_loss_pct: 5, take_profit_pct: 5 }, // not held: ignored
  ]);
  assert.deepEqual(Object.keys(f.protections), ['A', 'B']);
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  const quotes = {
    A: q(96, { intraday: [[t('15:00'), 98], [t('15:15'), 94.9], [t('15:30'), 96]] }),
    B: q(111, { intraday: [[t('15:00'), 105], [t('15:15'), 108], [t('15:30'), 111]] }),
  };
  const events = checkProtections(f, quotes);
  assert.deepEqual(events.map((e) => `${e.symbol}@${e.price}:${e.why}`), ['A@94.9:stop-loss at -5%', 'B@111:take-profit at +10%']);
  assert.deepEqual(f.portfolio.positions, {});
  assert.equal(checkProtections(f, quotes).length, 0); // already seen
});

test('a short 40% under water is covered even without a stop-loss, keeping losses within the budget', () => {
  const f = newFund({ budget: 1000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('14:00') });
  // The largest short one order allows: worth the whole budget (the per-order limit is 100% here)
  applyOrders(f, [{ symbol: 'A', action: 'short', shares: 10, reason: '' }], { A: q(100) }, at('14:45'));
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  const events = checkProtections(f, { A: q(141, { intraday: [[t('15:00'), 120], [t('15:15'), 140], [t('15:30'), 141]] }) });
  assert.equal(events.length, 1);
  assert.match(events[0].why, /forced cover/);
  assert.equal(events[0].price, 140);
  const a = summarize(f.portfolio, {}).accounts.USD;
  assert.equal(a.equity, 600); // lost 400 of the 1000, never more than the budget
  assert.ok(a.cash >= 0);
});

test('stopping closes everything; recordValue tracks the fund value', () => {
  const f = newFund({ budget: 1000, currency: 'USD', settings: { maxOrderPct: 100 }, now: at('14:00') });
  applyOrders(f, [{ symbol: 'A', action: 'buy', shares: 5, reason: '' }], { A: q(100) }, at('14:45'));
  assert.equal(recordValue(f, { A: q(110) }, at('15:00')), 1050);
  stopFund(f, { A: q(120) }, at('16:00'));
  assert.ok(f.stoppedAt);
  assert.equal(f.portfolio.accounts.USD.cash, 1100);
  assert.equal(f.decisions.at(-1).orders[0].status, 'filled');
});

test('a small order\'s minimum fee doesn\'t set off its stop-loss: stops count from the price paid', () => {
  // SGD 100, as the owner's first SGX fund: SGD 25 orders pay the S$1.99 minimum plus GST (about 8.7%)
  const sgx = (price, extra = {}) => ({ currency: 'SGD', market: 'SGX', price, daily: [], intraday: [], ...extra });
  const f = newFund({ budget: 100, currency: 'SGD', now: at('01:00') });
  const [r] = applyOrders(f, [{ symbol: 'C38U.SI', action: 'buy', shares: 10, reason: '' }], { 'C38U.SI': sgx(2.5) }, at('01:30'));
  assert.equal(r.status, 'filled');
  const pos = f.portfolio.positions['C38U.SI'];
  assert.ok(pos.avgCost > 2.7, 'the cost, for profit and loss, includes the fee');
  assert.equal(pos.entry, 2.5);
  setProtections(f, [{ symbol: 'C38U.SI', stop_loss_pct: 5, take_profit_pct: 8 }]);
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  // unchanged and 2% down: nothing (before the fix, the fee alone put it 8% "down" and it sold at once)
  assert.deepEqual(checkProtections(f, { 'C38U.SI': sgx(2.45, { intraday: [[t('01:45'), 2.5], [t('02:00'), 2.45]] }) }), []);
  assert.equal(f.portfolio.positions['C38U.SI'].qty, 10);
  assert.equal(f.tracks['C38U.SI'].entry, 2.5);
  assert.equal(f.tracks['C38U.SI'].worst, -0.02);
  // 5.2% under the price paid: the stop fires
  const events = checkProtections(f, { 'C38U.SI': sgx(2.37, { intraday: [[t('02:15'), 2.37]] }) });
  assert.deepEqual(events.map((e) => e.why), ['stop-loss at -5%']);
  assert.deepEqual(f.portfolio.positions, {});
});

test('a short\'s stop also counts from the price it was sold at, not after the fee', () => {
  const sgx = (price, extra = {}) => ({ currency: 'SGD', market: 'SGX', price, daily: [], intraday: [], ...extra });
  const f = newFund({ budget: 100, currency: 'SGD', now: at('01:00') });
  applyOrders(f, [{ symbol: 'C38U.SI', action: 'short', shares: 10, reason: '' }], { 'C38U.SI': sgx(2.5) }, at('01:30'));
  assert.equal(f.portfolio.positions['C38U.SI'].entry, 2.5);
  setProtections(f, [{ symbol: 'C38U.SI', stop_loss_pct: 5, take_profit_pct: 0 }]);
  const t = (hhmm) => at(hhmm).getTime() / 1000;
  assert.deepEqual(checkProtections(f, { 'C38U.SI': sgx(2.55, { intraday: [[t('01:45'), 2.5], [t('02:00'), 2.55]] }) }), []);
  assert.deepEqual(checkProtections(f, { 'C38U.SI': sgx(2.63, { intraday: [[t('02:15'), 2.63]] }) }).map((e) => e.why), ['stop-loss at -5%']);
});

test('each trading day has exactly the decisions chosen, SGX\'s lunch break included; or one at every run', async () => {
  const { decisionSlot, EVERY_RUN, DECISION_CHOICES } = await import('../fund.js');
  // a quote 20 minutes old, as Yahoo's SGX prices are
  const livePrices = (now, market) => pricesAt(new Date(now.getTime() - 20 * 60000), market, now);
  const day = (ccy, market, from, to, n) => {
    const f = newFund({ budget: 1000, currency: ccy, decisionsPerDay: n, now: new Date(from) });
    const at = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60000) {
      const now = new Date(t);
      if (decisionDue(f, now, livePrices(now, market))) { f.lastDecisionAt = now.toISOString(); at.push(now.toISOString().slice(11, 16)); }
    }
    return at;
  };
  // SGX 09:00-17:00 Singapore (01:00-09:00 UTC), with lunch 12:00-13:00; runs every 15 minutes
  const sgx = (n) => day('SGD', 'SGX', '2026-09-28T00:45:00Z', '2026-09-28T09:15:00Z', n);
  assert.deepEqual(sgx(1), ['01:30']); // before, a second one came at 16:30 Singapore time
  assert.deepEqual(sgx(2), ['01:30', '05:15']);
  assert.deepEqual(sgx(4), ['01:30', '03:15', '05:15', '07:15']);
  assert.equal(sgx(8).length, 8);
  assert.equal(sgx(16).length, 15); // a slot wholly inside the lunch break is skipped, never made up
  assert.equal(sgx(EVERY_RUN).length, 26); // each run while it trades with fresh prices, lunch aside
  // US 09:30-16:00 New York (13:30-20:00 UTC in September)
  const us = (n) => day('USD', 'US', '2026-09-28T13:15:00Z', '2026-09-28T20:15:00Z', n);
  assert.deepEqual([us(1).length, us(2).length, us(4).length, us(8).length, us(16).length], [1, 2, 4, 8, 16]);
  // the next day starts afresh
  const f = newFund({ budget: 1000, currency: 'SGD', decisionsPerDay: 1, now: new Date('2026-09-28T00:00:00Z') });
  f.lastDecisionAt = '2026-09-28T01:30:00Z';
  const next = new Date('2026-09-29T01:30:00Z');
  assert.equal(decisionDue(f, next, livePrices(next, 'SGX')), true);
  // every run: two runs minutes apart (both timers) are one run
  const e = newFund({ budget: 1000, currency: 'SGD', decisionsPerDay: EVERY_RUN, now: new Date('2026-09-28T00:00:00Z') });
  e.lastDecisionAt = '2026-09-28T02:00:00Z';
  for (const [t, due] of [['2026-09-28T02:05:00Z', false], ['2026-09-28T02:15:00Z', true]]) assert.equal(decisionDue(e, new Date(t), livePrices(new Date(t), 'SGX')), due);
  // only the listed choices
  assert.deepEqual(DECISION_CHOICES, [1, 2, 4, 8, 16, 0]);
  for (const bad of [3, 100, -1, '', 'x']) assert.throws(() => newFund({ budget: 1, currency: 'USD', decisionsPerDay: bad }), /Decisions per day/);
  assert.equal(decisionSlot('SGX', 4, new Date('2026-09-28T04:30:00Z')), null); // lunch
});
