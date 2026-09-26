// Trading fees, per broker and market. Each trade's fee is worked out here and taken out of cash:
// a buy's fee is added to what the shares cost you, and a sale's fee is taken from what you receive,
// so profit and loss are always after fees.
//
// Rates are the brokers' published retail rates as of September 2026 and can change; check your
// broker's fee page. Sources: Tiger Brokers SG pricing (itiger.com/sg/commissions), Standard Chartered
// SG online trading fee schedule (sc.com/sg). US regulatory fees (SEC, FINRA TAF) apply to sales only.

const GST = 0.09; // Singapore GST, charged on the broker's own fees and on SGX's fees

// A charge is max(min, pct x value + perShare x shares), capped at maxPct x value when given.
// `gst: true` means GST applies to it.
const US_REG = [
  { label: 'SEC fee (sales)', pct: 0.0000278, sellOnly: true },
  { label: 'FINRA TAF (sales)', perShare: 0.000166, max: 8.3, sellOnly: true },
];
const SGX_EXCHANGE = [
  { label: 'SGX clearing fee', pct: 0.000325, gst: true },
  { label: 'SGX trading fee', pct: 0.000075, gst: true },
];

export const FEE_PLANS = {
  tiger: {
    label: 'Tiger Brokers (Singapore)',
    summary: 'US: US$0.005/share + US$0.005/share platform fee (US$1.99 minimum). SGX: 0.03% + 0.03% platform fee (S$1.99 minimum) + SGX fees. Plus 9% GST.',
    US: [
      { label: 'Commission', perShare: 0.005, min: 0.99, maxPct: 0.005, gst: true },
      { label: 'Platform fee', perShare: 0.005, min: 1, maxPct: 0.005, gst: true },
      ...US_REG,
    ],
    SGX: [
      { label: 'Commission', pct: 0.0003, min: 0.99, gst: true },
      { label: 'Platform fee', pct: 0.0003, min: 1, gst: true },
      ...SGX_EXCHANGE,
    ],
  },
  scb: {
    label: 'Standard Chartered Online Trading',
    summary: 'SGX: 0.20% (S$10 minimum) + SGX fees. US: 0.20% (US$10 minimum; check your rate). Plus 9% GST. Priority and accredited customers pay less.',
    US: [{ label: 'Commission', pct: 0.002, min: 10, gst: true }, ...US_REG],
    SGX: [{ label: 'Commission', pct: 0.002, min: 10, gst: true }, ...SGX_EXCHANGE],
  },
  none: { label: 'No fees', summary: 'Trades cost nothing extra (unrealistic, but simple).', US: [], SGX: [] },
};
export const DEFAULT_FEE_PLAN = 'tiger';

// A plan from its id, or a custom one: { pct: {US, SGX} (percent), min: {US, SGX} }.
export function planFor(id = DEFAULT_FEE_PLAN, custom = null) {
  if (id === 'custom' && custom) {
    const market = (m) => [{ label: 'Commission', pct: (Number(custom.pct?.[m]) || 0) / 100, min: Number(custom.min?.[m]) || 0, gst: false }];
    return { label: 'Custom', summary: `US: ${custom.pct?.US ?? 0}% (minimum ${custom.min?.US ?? 0}). SGX: ${custom.pct?.SGX ?? 0}% (minimum ${custom.min?.SGX ?? 0}).`, US: market('US'), SGX: market('SGX') };
  }
  return FEE_PLANS[id] ?? FEE_PLANS[DEFAULT_FEE_PLAN];
}

const cents = (n) => Math.round(n * 100) / 100;

// { total, parts: [{ label, amount }] } for one trade. `market` is 'US' or 'SGX'.
export function calcFee(plan, market, side, qty, price) {
  const value = qty * price;
  const parts = [];
  let gstBase = 0;
  for (const c of plan?.[market] ?? []) {
    if (c.sellOnly && side !== 'sell') continue;
    let amount = (c.pct ?? 0) * value + (c.perShare ?? 0) * qty;
    if (c.min) amount = Math.max(c.min, amount);
    if (c.maxPct) amount = Math.min(c.maxPct * value, amount);
    if (c.max) amount = Math.min(c.max, amount);
    if (amount <= 0) continue;
    parts.push({ label: c.label, amount: cents(amount) });
    if (c.gst) gstBase += amount;
  }
  if (gstBase > 0) parts.push({ label: 'GST 9%', amount: cents(gstBase * GST) });
  return { total: cents(parts.reduce((s, p) => s + p.amount, 0)), parts };
}

// The fee for a trade in a portfolio, using the portfolio's own plan.
export const feeFor = (portfolio, market, side, qty, price) =>
  (market ? calcFee(planFor(portfolio.feePlan, portfolio.customFees), market, side, qty, price).total : 0);

// A short description for the AI: what one round trip (buy then sell) of a typical order costs.
export function describeFees(portfolioOrPlan, market, typicalValue) {
  const plan = portfolioOrPlan.US ? portfolioOrPlan : planFor(portfolioOrPlan.feePlan, portfolioOrPlan.customFees);
  const price = 50;
  const qty = Math.max(1, Math.round(typicalValue / price));
  const roundTrip = calcFee(plan, market, 'buy', qty, price).total + calcFee(plan, market, 'sell', qty, price).total;
  return `${plan.label}: ${plan.summary} A round trip (buy then sell) of about ${typicalValue.toFixed(0)} costs about ${roundTrip.toFixed(2)} in fees (${(roundTrip / (qty * price) * 100).toFixed(2)}%).`;
}
