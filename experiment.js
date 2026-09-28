// Experiments with the AI funds' settings: funds started together with the same money, market and style,
// each changing one setting from its baseline (the fund with role 'A'; funds.js experimentOf). The AI's
// decisions can't be tested on past prices (the models have read about those years, and the news as it
// stood then can't be fetched), so the test runs forward, and this module judges it honestly: each
// fund's weekly return after its AI cost against its baseline's in the same weeks, with a likely range,
// and a verdict only when the difference is clear of what noise alone would give.
//
// A week's return is its last recorded value over the last value of the week before (or the fund's
// starting amount), less the AI cost of that week's decisions (converted to the fund's currency; a fund's
// value doesn't include its AI cost). Weeks are ISO weeks (stats.js isoWeek) on the value history the job
// records after each run (fund.history). Pure functions, for the page (app.js) and the tests.

import { isoWeek, quantile } from './stats.js';
import { convert } from './fund-views.js';

// No verdict before this many weeks in common; then only when the average weekly difference is at least
// T times its standard error (the bar the factor lab uses, factors.js LAB). LIKELY: the likely range
// holds the true difference with an 8-in-10 chance.
export const EXPERIMENT = { minWeeks: 6, t: 2.5, likely: 0.8 };

// A fund's AI cost in each ISO week, in its own currency (null when that needs a rate there isn't).
function weeklyCost(f, fx) {
  const out = new Map();
  for (const d of f.decisions ?? []) {
    const usd = d.usage?.costUsd;
    if (!usd || !d.time) continue;
    const c = convert(usd, 'USD', f.currency, fx);
    if (c == null) return null;
    const k = isoWeek(Date.parse(d.time) / 1000);
    out.set(k, (out.get(k) ?? 0) + c);
  }
  return out;
}

// { week: return after AI cost } for each ISO week the fund has a recorded value in, oldest first.
export function weeklyReturns(f, { fx = null } = {}) {
  const costs = weeklyCost(f, fx);
  const byWeek = new Map();
  for (const [iso, v] of f.history ?? []) if (v > 0) byWeek.set(isoWeek(Date.parse(iso) / 1000), v);
  const out = new Map();
  let prev = Number(f.budget) || null;
  for (const [week, v] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (prev > 0) out.set(week, (v - prev - (costs?.get(week) ?? 0)) / prev);
    prev = v;
  }
  return costs == null ? null : out;
}

// A fund against its baseline: the weekly differences in the weeks both have, their average with its
// likely range, and the verdict: 'too-early' (fewer than EXPERIMENT.minWeeks weeks), 'better' or 'worse'
// (clear of noise), 'leaning-better' or 'leaning-worse' (the likely range is all on one side of zero, but
// the difference isn't yet clear of noise), or 'unclear'. null when either can't be measured (no rate
// for its AI cost).
export function compareToBaseline(f, base, { fx = null } = {}) {
  const a = weeklyReturns(f, { fx }), b = weeklyReturns(base, { fx });
  if (!a || !b) return null;
  const diffs = [...a.keys()].filter((k) => b.has(k)).map((k) => a.get(k) - b.get(k));
  const n = diffs.length;
  const mean = n ? diffs.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : null;
  const q = n > 1 ? quantile(0.5 + EXPERIMENT.likely / 2, n - 1) : null;
  const t = se > 0 ? mean / se : 0;
  const lo = se != null ? mean - q * se : null, hi = se != null ? mean + q * se : null;
  const verdict = n < EXPERIMENT.minWeeks ? 'too-early' : Math.abs(t) >= EXPERIMENT.t ? (mean > 0 ? 'better' : 'worse')
    : lo > 0 ? 'leaning-better' : hi < 0 ? 'leaning-worse' : 'unclear';
  return {
    weeks: n, mean, lo, hi, t, verdict,
    total: diffs.reduce((s, x) => s + x, 0),
  };
}

// The experiments among the funds: { id, market, started, amount, funds: [{ fund, role, tests, result }] }
// with the baseline first, then by role; each fund's result against the baseline (the baseline's is null).
// An experiment without its baseline is listed with no results.
export function experiments(funds, { fx = null } = {}) {
  const groups = new Map();
  for (const f of funds ?? []) {
    if (!f.experiment?.id) continue;
    const key = `${f.experiment.id}|${f.currency}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(f);
  }
  return [...groups.values()].map((list) => {
    list.sort((x, y) => x.experiment.role.localeCompare(y.experiment.role));
    const base = list.find((f) => f.experiment.role === 'A') ?? null;
    return {
      id: list[0].experiment.id, currency: list[0].currency, started: list.map((f) => f.startedAt).sort()[0], amount: Number(list[0].budget),
      baseline: base,
      funds: list.map((f) => ({ fund: f, role: f.experiment.role, tests: f.experiment.tests, result: base && f !== base ? compareToBaseline(f, base, { fx }) : null })),
    };
  });
}
