// Track record of the home page's AI picks. Every scheduled set of picks is kept (picks-history.json)
// with each stock's price when it was picked; a pick is scored once a week (5 trading days) and a
// month (21 trading days) of daily closes have passed:
//   - its return in the direction picked (a short gains when the price falls);
//   - the index's return over the same days (SPY for US stocks, ES3 for SGX);
//   - whether it was right (made money) and whether it beat the index (a long rose more than the
//     index; a short fell more than the index, or rose less).

import { BENCHMARKS, priceAt, sessionLength } from './benchmark.js';

export const HORIZONS = [{ key: 'week', label: '1 week', days: 5 }, { key: 'month', label: '1 month', days: 21 }];
export const MAX_HISTORY = 400;

// Adds a set of picks to the history (once per set), newest last.
export function recordPicks(history, picks) {
  const h = Array.isArray(history) ? history : [];
  if (!picks?.createdAt || !picks.picks?.length || h.some((x) => x.createdAt === picks.createdAt)) return h;
  h.push({ createdAt: picks.createdAt, picks: picks.picks.map((p) => ({ symbol: p.symbol, stance: p.stance, conviction: p.conviction, horizon: p.horizon, price: p.priceAtPick })) });
  return h.slice(-MAX_HISTORY);
}

const indexFor = (quote) => BENCHMARKS[quote?.currency]?.symbol;


// The close `days` trading days after unix time `t`, with its time, or null if not there yet (a day
// counts once its session is over).
function closeAfter(quote, t, days, nowS) {
  const later = (quote?.daily ?? []).filter(([bt]) => bt > t && bt + sessionLength(quote) <= nowS);
  const bar = later[days - 1];
  return bar ? { t: bar[0], price: bar[1] } : null;
}

// One entry per scored pick: { createdAt, symbol, stance, horizon: key, ret, indexRet, right, beat }.
export function scorePicks(history, quotes, now = new Date()) {
  const out = [];
  const nowS = now.getTime() / 1000;
  for (const set of history ?? []) {
    const t0 = Date.parse(set.createdAt) / 1000;
    for (const p of set.picks) {
      const q = quotes[p.symbol];
      const iq = quotes[indexFor(q)];
      if (!q || !(p.price > 0)) continue;
      for (const h of HORIZONS) {
        const end = closeAfter(q, t0, h.days, nowS);
        if (!end) continue;
        const i0 = priceAt(iq, t0), i1 = priceAt(iq, end.t + sessionLength(q));
        const move = end.price / p.price - 1;
        const indexMove = i0 && i1 ? i1 / i0 - 1 : null;
        const dir = p.stance === 'short' ? -1 : 1;
        const ret = dir * move;
        out.push({
          createdAt: set.createdAt, symbol: p.symbol, stance: p.stance, horizon: h.key, ret,
          indexRet: indexMove, right: ret > 0, beat: indexMove == null ? null : dir * (move - indexMove) > 0,
        });
      }
    }
  }
  return out;
}

// { [horizon]: { n, right, beat, avgRet, avgIndex } } over scored picks (optionally only since `since`).
export function summarizeScores(scores, since = null) {
  const out = {};
  for (const h of HORIZONS) {
    const s = scores.filter((x) => x.horizon === h.key && (!since || x.createdAt >= since));
    const withIndex = s.filter((x) => x.indexRet != null);
    const avg = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : null);
    out[h.key] = {
      label: h.label, n: s.length, nIndex: withIndex.length,
      rightN: s.filter((x) => x.right).length, beatN: withIndex.filter((x) => x.beat).length,
      right: s.length ? s.filter((x) => x.right).length / s.length : null,
      beat: withIndex.length ? withIndex.filter((x) => x.beat).length / withIndex.length : null,
      avgRet: avg(s, (x) => x.ret),
      avgIndex: avg(withIndex, (x) => (x.stance === 'short' ? -x.indexRet : x.indexRet)), // what the same bet on the index made
    };
  }
  return out;
}
