// What the AI costs, month by month (estimated from token and web-search counts, see ai.js).
// The scheduled jobs keep one ledger (ai-spend.json on the ai-state branch, published with the site);
// the browser keeps its own for what you run with your key. A monthly cap stops the scheduled jobs
// calling the AI once reached: set it with the repository variable AI_MONTHLY_CAP_USD.

export const monthKey = (now = new Date()) => now.toISOString().slice(0, 7);
const cents = (n) => Math.round(n * 100) / 100;
// The ledger adds to a hundredth of a cent (as ai.js prices a call): a question or a logged article
// costs a fraction of a cent, which rounding each addition to whole cents would drop every time.
// Rounded to cents only where it's shown.
const r4 = (n) => Math.round(n * 1e4) / 1e4;

// Adds a cost to a ledger ({ months: { 'YYYY-MM': { total, [task]: cost } } }) and returns it.
export function addSpend(ledger, task, costUsd, now = new Date()) {
  const l = ledger?.months ? ledger : { months: {} };
  const cost = Number(costUsd) || 0;
  const m = (l.months[monthKey(now)] ??= { total: 0 });
  m[task] = r4((m[task] ?? 0) + cost);
  m.total = r4(m.total + cost);
  const keys = Object.keys(l.months).sort();
  for (const k of keys.slice(0, -24)) delete l.months[k]; // two years is plenty
  return l;
}

export const monthSpend = (ledger, now = new Date()) => ledger?.months?.[monthKey(now)]?.total ?? 0;

// True when a cap (US$) is set and this month's spend has reached it.
export function capReached(ledger, cap, now = new Date()) {
  const c = Number(cap);
  return c > 0 && monthSpend(ledger, now) >= c;
}

// What an AI fund's decisions have cost since it started (US$): its decisions', plus what calls that failed after being billed cost (fund.failedAiCost).
export const fundAiCost = (fund) => cents((fund?.decisions ?? []).reduce((s, d) => s + (d.usage?.costUsd ?? 0), 0) + (fund?.failedAiCost ?? 0));
