// "Ask the data": the owner's own questions, answered from ten years of the watchlist's prices (the same
// data and checks as the ten-year market memory, memory-long.js) or, after 6 months, from the AI funds'
// own graded ideas. Pure functions, no AI.
//
// 1. The question. An admin types it on the fund page (up to ASK.maxChars characters); the app sends it
//    through the passthrough command path as 'settings' with { fund: 'all', ask: text }, and
//    scripts/ai-fund.mjs reads it from the runner's event file, never from an environment value (the
//    Actions log is public). One cheap AI call (ai.js askSpec, strict tool) turns it into a spec in the
//    small language below, or says why this data can't answer it.
// 2. The spec is checked by code against a whitelist (validateSpec): a population, filters that are
//    enums (and symbols that must be on the watchlist), a horizon and an expectation. Nothing in a spec
//    is ever run or evaluated as code: the evaluator only compares its values with fixed lists.
//      population  big_moves (a one-day move of 4%+ and 2.5x the stock's usual daily move), ex_dividend,
//                  results_days (the first session trading on results), weekly_stock_sample (every
//                  stock, every week) or fund_ideas (the AI funds' own entries, pooled per market)
//      filters     market, symbols, direction, size, volume, vix, index_trend, results (APPLIES says
//                  which a population takes; one it doesn't take makes the question unanswerable)
//      horizon     the next day, week or month (21 trading days); the funds' ideas: a week or a month
//      expect      up, down (the price, beyond the market), continue, reverse (the day's move, the
//                  week's move against the index, the news or the idea keep going their way), or any
// 3. The answer (answerLong, answerIdeas): the matching cases' outcomes, beyond the market (beta times
//    the index) and the stock's usual drift, estimated as every lesson is (stats.js estimate: separate
//    bets, clustered by date) on 2016-2023 and checked on 2024 onwards with memory-long.js holdoutCheck,
//    unchanged. Confirmed: a pattern that held, the way the question expected; rejected: no reliable
//    pattern (a normal answer), one that didn't hold on the held-out years, or the opposite; not
//    enough data. A stock the ten-year build left out (Yahoo's broken prices) is named, with why. The
//    funds' ideas open only once the oldest frozen idea is ASK.ideaMonths months old, and are found on
//    the first two thirds of that time and checked on the rest.
// 4. When. The ten years of raw prices are only on the runner while the weekly build runs (or when
//    downloaded again for a question), and the questions are private, in the fund collection, loaded
//    after that step. So scripts/build-history.mjs answers them in a step after the AI fund step:
//    with the weekly download when it happened this run, else downloading the ten years again at most
//    once every ASK.retryHours hours while a question waits. An answer comes within a day. The log
//    shows counts only, never a question.
// The questions (c.questions, the newest ASK.keep) are kept with the funds: private with the private
// fund store, and left out of the public copy (scripts/public-fund.mjs keeps only how many). The AI funds
// never see them. Measured on today's 17 stocks, which survived and mostly won: tendencies, not laws.

import { holdoutCheck, vixLevel, HOLDOUT, LONG } from './memory-long.js';
import { labCases } from './factors.js';
import { GATE } from './stats.js';

export const ASK = { maxChars: 300, keep: 30, ideaMonths: 6, retryHours: 20, reasonMax: 200 };
export const POPULATIONS = ['big_moves', 'ex_dividend', 'results_days', 'weekly_stock_sample', 'fund_ideas'];
export const MARKET_VALUES = ['any', 'US', 'SGX'];
export const FILTERS = {
  direction: ['any', 'up', 'down'],
  size: ['any', 'under_5', '5_to_10', 'over_10'],
  volume: ['any', 'heavy', 'normal'],
  vix: ['any', 'calm', 'normal', 'stressed'],
  index_trend: ['any', 'above', 'below'],
  results: ['any', 'beat', 'miss'],
};
export const HORIZONS = { '1_day': 1, '1_week': 5, '1_month': 21 };
export const EXPECTS = ['up', 'down', 'continue', 'reverse', 'any'];
// The filters each population takes.
export const APPLIES = {
  big_moves: ['direction', 'size', 'volume', 'vix', 'index_trend'],
  ex_dividend: ['vix', 'index_trend'],
  results_days: ['results', 'vix', 'index_trend'],
  weekly_stock_sample: ['direction', 'size', 'volume', 'vix', 'index_trend'],
  fund_ideas: ['direction', 'volume', 'vix', 'index_trend'],
};
const SIZE = { under_5: [0, 0.05], '5_to_10': [0.05, 0.1], over_10: [0.1, Infinity] };
const DAY_MS = 86400000;

// What the page shows for each status (and, for a rejection, its reason).
export const STATUS_LABELS = {
  reading: ['reading your question', ''], waiting: ['waiting for the data', ''], confirmed: ['confirmed', 'up'], pattern: ['a pattern that held', 'up'],
  'no-pattern': ['no reliable pattern', ''], 'didnt-hold': ['didn\'t hold on the held-out years', ''], opposite: ['rejected: the opposite held', 'down'],
  'not-enough': ['not enough data', ''], 'cant-answer': ['can\'t answer with this data', ''],
};
export const statusLabel = (q) => STATUS_LABELS[q.status === 'rejected' ? q.verdict : q.status === 'confirmed' && q.spec?.expect === 'any' ? 'pattern' : q.status] ?? [q.status, ''];

const clip = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const pct = (x, d = 1) => { const v = Math.abs(x * 100) < 0.5 * 10 ** -d ? 0 : x; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(d)}%`; };
// "a 93% chance", or "over a 99% chance" rather than a rounded 100%
const chance = (p) => (p >= 0.995 ? 'over a 99% chance' : `a ${Math.round(p * 100)}% chance`);
const listWords = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
// "2016–23", or "2025" for one year
const span = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? a.slice(0, 4) : `${a.slice(0, 4)}–${b.slice(2, 4)}`);

// ---------- the spec ----------

// The spec the AI's answer (ai.js ASK_TOOL's input) stands for, checked against the whitelist:
// { ok: true, spec, note? } or { ok: false, reason } (the AI's own reason when it said the data can't
// answer it). `symbols`: symbols.json. Index funds aren't stocks here.
export function validateSpec(raw, symbols) {
  const no = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object') return no('The question couldn\'t be turned into a query.');
  if (raw.answerable === false || raw.population === 'none') return no(clip(raw.reason, ASK.reasonMax) || 'It asks about something this data doesn\'t hold.');
  const population = raw.population;
  if (!POPULATIONS.includes(population)) return no('It doesn\'t fit any of the kinds of days this data can look at.');
  const listed = new Map((symbols ?? []).filter((s) => !s.etf).map((s) => [s.symbol, s]));
  // a lone symbol given as a string is that symbol (not "every stock"); anything else that isn't a list is refused
  if (raw.symbols != null && !Array.isArray(raw.symbols) && typeof raw.symbols !== 'string') return no('The stocks it names couldn\'t be read.');
  const given = raw.symbols == null ? [] : [raw.symbols].flat();
  const syms = [...new Set(given.map((x) => clip(x, 12).toUpperCase()).filter(Boolean))];
  const unknown = syms.filter((s) => !listed.has(s));
  if (unknown.length) return no(`${listWords(unknown.slice(0, 4))} ${unknown.length === 1 ? 'isn\'t a stock' : 'aren\'t stocks'} on the watchlist, so there are no prices for ${unknown.length === 1 ? 'it' : 'them'}.`);
  let market = MARKET_VALUES.includes(raw.market) ? raw.market : null;
  if (!market) return no('It names a market other than US or SGX.');
  const theirs = [...new Set(syms.map((s) => listed.get(s).market))];
  if (market !== 'any' && theirs.some((m) => m !== market)) return no(`It names stocks outside the ${market} market it asks about.`);
  if (theirs.length === 1) market = theirs[0];
  const spec = { population, market, symbols: syms };
  for (const [key, values] of Object.entries(FILTERS)) {
    const v = raw[key] ?? 'any';
    if (!values.includes(v)) return no(`It asks for a ${FILTER_WORDS[key]} this data doesn't have.`);
    if (v !== 'any' && !APPLIES[population].includes(key)) return no(`A ${FILTER_WORDS[key]} doesn't apply to ${POP_WORDS[population]}.`);
    spec[key] = v;
  }
  // own keys only: HORIZONS.constructor and the like are inherited, not horizons
  let horizon = typeof raw.horizon === 'string' && Object.hasOwn(HORIZONS, raw.horizon) ? HORIZONS[raw.horizon] : [1, 5, 21].includes(raw.horizon) ? raw.horizon : null;
  if (!horizon) return no('It asks about a time span other than the next day, week or month.');
  let note = null;
  if (population === 'fund_ideas' && horizon === 1) { horizon = 5; note = 'The funds\' ideas are graded a week and a month after them, so this is answered over a week.'; }
  spec.horizon = horizon;
  if (!EXPECTS.includes(raw.expect)) return no('It expects something other than a rise, a fall, a continuation or a reversal.');
  if (population === 'ex_dividend' && ['continue', 'reverse'].includes(raw.expect)) return no('An ex-dividend date has no move of its own to continue or reverse: ask whether the price rises or falls after it.');
  spec.expect = raw.expect;
  return note ? { ok: true, spec, note } : { ok: true, spec };
}

const FILTER_WORDS = { direction: 'direction', size: 'size of move', volume: 'volume condition', vix: 'VIX level', index_trend: 'index trend', results: 'results outcome' };
const POP_WORDS = {
  big_moves: 'big one-day moves', ex_dividend: 'ex-dividend dates', results_days: 'results days',
  weekly_stock_sample: 'ordinary weeks', fund_ideas: 'the funds\' own ideas',
};

// The spec in plain words, as the page shows it under the question ("Read as: …").
export function describeSpec(spec) {
  if (!spec) return '';
  const who = spec.symbols?.length ? listWords(spec.symbols) : spec.market === 'any' ? 'the watchlist\'s stocks' : `${spec.market} stocks`;
  const dir = spec.direction;
  const size = spec.size !== 'any' ? { under_5: ' of under 5%', '5_to_10': ' of 5–10%', over_10: ' of over 10%' }[spec.size] : '';
  let subject;
  if (spec.population === 'big_moves') subject = `Big one-day ${dir === 'up' ? 'jumps' : dir === 'down' ? 'drops' : 'moves'}${size} (at least 4% and 2.5 times the usual daily move) in ${who}`;
  else if (spec.population === 'ex_dividend') subject = `Ex-dividend dates of ${who}`;
  else if (spec.population === 'results_days') subject = `Results ${spec.results === 'beat' ? 'that beat (a positive surprise, else a strong first day)' : spec.results === 'miss' ? 'that missed (a negative surprise, else a weak first day)' : 'days'} of ${who}`;
  else if (spec.population === 'weekly_stock_sample') subject = `${dir === 'up' ? 'Weeks that beat the index' : dir === 'down' ? 'Weeks that lagged the index' : 'Every week'}${size ? `, with a move${size}` : ''}, for ${who}`;
  else subject = `The AI funds' ${dir === 'up' ? 'buys' : dir === 'down' ? 'shorts' : 'ideas'} in ${spec.symbols?.length ? listWords(spec.symbols) : spec.market === 'any' ? 'either market' : `${spec.market} stocks`}`;
  const when = [
    spec.volume === 'heavy' ? 'on heavy volume (2x the usual or more)' : spec.volume === 'normal' ? 'on ordinary volume' : '',
    spec.vix !== 'any' ? `with the VIX ${spec.vix} (${{ calm: 'under 16', normal: '16 to 25', stressed: 'over 25' }[spec.vix]})` : '',
    spec.index_trend !== 'any' ? `with the index ${spec.index_trend} its 200-day average` : '',
  ].filter(Boolean);
  const over = { 1: 'the next trading day', 5: 'the next week', 21: 'the next month (21 trading days)' }[spec.horizon];
  const expect = {
    up: 'expecting the price to rise, beyond the market', down: 'expecting the price to fall, beyond the market',
    continue: spec.population === 'fund_ideas' ? 'expecting the ideas to work' : spec.population === 'results_days' ? 'expecting the stock to keep going the way the news went' : 'expecting the move to continue',
    reverse: spec.population === 'fund_ideas' ? 'expecting the ideas to go against them' : spec.population === 'results_days' ? 'expecting the first reaction to reverse' : 'expecting the move to reverse',
    any: 'with no direction expected',
  }[spec.expect];
  return `${subject}${when.length ? `, ${listWords(when)}` : ''}: ${over}, ${expect}.`;
}

// ---------- the answer ----------

// Whether a case passes the spec's filters.
function passes(spec, it) {
  if (spec.symbols?.length && !spec.symbols.includes(it.symbol)) return false;
  if (spec.direction !== 'any' && it.direction !== (spec.direction === 'up' ? 1 : -1)) return false;
  if (spec.size !== 'any') { const [lo, hi] = SIZE[spec.size]; const m = Math.abs(it.move ?? NaN); if (!(m >= lo && m < hi)) return false; }
  if (spec.volume !== 'any' && it.heavy !== (spec.volume === 'heavy')) return false;
  if (spec.vix !== 'any' && it.vix !== spec.vix) return false;
  if (spec.index_trend !== 'any' && it.trend !== spec.index_trend) return false;
  if (spec.results !== 'any' && it.tone !== (spec.results === 'beat' ? 'positive' : 'negative')) return false;
  return true;
}

// The measure the question asks about: the price's own move beyond the market (for up and down, or
// an open question whose cases all go one way), else the move in each case's direction (continue,
// reverse, or an open question about moves both ways). `wanted`: the sign the question expects.
function measured(spec, items) {
  const h = spec.horizon, key = `x${h}`;
  const price = ['up', 'down'].includes(spec.expect) || (spec.expect === 'any' && new Set(items.map((i) => i.direction)).size <= 1);
  const out = price ? items.map((it) => ({ ...it, [key]: it[key] == null ? null : it[key] * it.direction })) : items;
  const wanted = { up: 1, down: -1, continue: 1, reverse: -1, any: null }[spec.expect];
  return { items: out, price, wanted };
}

// What the numbers measure, in words: "the price moved +1.2%", "the move went on +0.4%".
function measureWords(spec, price, x, allDown) {
  if (price) return allDown && spec.expect === 'any' ? `the price moved ${pct(x)} (+ is a bounce back)` : `the price moved ${pct(x)}`;
  if (spec.population === 'fund_ideas') return `the ideas made ${pct(x)} in their direction`;
  // a move against the case's direction is said as a reversal, not as a negative move "in its direction"
  const size = pct(Math.abs(x)).replace(/^\+/, '');
  const back = pct(x).startsWith('−');
  if (spec.population === 'results_days') return back ? `the stock moved ${size} against the way the news went (it reversed)` : `the stock moved ${pct(x)} the way the news went`;
  if (spec.population === 'weekly_stock_sample') return back ? `the stock moved ${size} against the way its week against the index had gone (it reversed)` : `the stock moved ${pct(x)} the way its week against the index had gone`;
  return back ? `the price moved ${size} against the big move's direction (it reversed)` : `the price moved ${pct(x)} in the big move's direction`;
}

// The answer from a check (memory-long.js holdoutCheck) on the measured cases: { status, verdict,
// text, numbers } for the question. `years`: { train, test } in words; `extra`: sentences after it.
function answerFrom(spec, check, { items, price, wanted, years, notes = [], extra = '', beyond }) {
  const h = spec.horizon, k = h / 5;
  const over = { 1: 'the next trading day', 5: 'the next week', 21: 'the next 21 trading days' }[h];
  const unit = h > 5 ? 'week' : 'date';
  const n = (e) => (e ? { bets: e.bets, clusters: e.clusters, mean: round(e.mean * k, 5), edge: round(e.edge * k, 5), lo: round(Math.min(e.lo, e.hi) * k, 5), hi: round(Math.max(e.lo, e.hi) * k, 5), p: e.p } : null);
  const train = n(check.train), test = n(check.test);
  const numbers = { cases: items.filter((x) => x[`x${h}`] != null).length, train, test, years, measure: price ? 'price' : 'direction' };
  const allDown = items.length && items.every((i) => i.direction < 0);
  const tail = [...notes, extra].filter(Boolean).join(' ');
  const done = (status, verdict, text) => ({ status, verdict, text: `${text}${tail ? ` ${tail}` : ''}`, numbers, agreed: check.status === 'held' ? true : check.status === 'didnt-hold' ? false : null });
  if (!numbers.cases) return done('not-enough', 'too-few', `Not enough data: no ${spec.horizon === 21 ? 'case with a month after it' : 'case'} matched the question in the data.`);
  if (check.status === 'too-few') {
    return done('not-enough', 'too-few', `Not enough data to check: ${plural(train?.bets ?? 0, 'separate bet')} in ${years.train} and ${plural(test?.bets ?? 0, 'bet')} in ${years.test}, from ${plural(numbers.cases, 'case')}; a check needs ${GATE.bets} and ${HOLDOUT.testBets}.`);
  }
  const found = `${years.train}: ${over}, ${measureWords(spec, price, train.edge, allDown)}, ${beyond} (likely ${pct(train.lo)} to ${pct(train.hi)}; ${plural(train.bets, 'separate bet')} on ${plural(train.clusters, `separate ${unit}`)}, from ${plural(numbers.cases, 'case')} in all)`;
  const held = `${years.test}, held out: ${pct(test.mean)} (${plural(test.bets, 'separate bet')})`;
  if (check.status === 'held') {
    if (wanted == null || wanted === check.train.sign) return done('confirmed', 'held', `${wanted == null ? 'A pattern that held.' : 'Yes.'} ${found}, ${chance(train.p)} of that sign. ${held}, which agreed.`);
    return done('rejected', 'opposite', `No: the opposite held. ${found}, ${chance(train.p)} of that sign. ${held}, which agreed.`);
  }
  if (check.status === 'didnt-hold') return done('rejected', 'didnt-hold', `Not reliably. ${found}, which looked like a pattern, but ${held}, which didn't agree.`);
  const why = train.p < HOLDOUT.p ? `under the ${Math.round(HOLDOUT.p * 100)}% chance of its sign a pattern needs` : `too small to matter (under ${(GATE.edge * 100).toFixed(1)}%)`;
  return done('rejected', 'no-pattern', `No reliable pattern. ${found}: ${why}. ${held}. Don't assume it either way.`);
}

// A question on the ten years of prices: `data` is memory-long.js longCases. The answer ({ status,
// verdict, text, numbers, agreed }), or null when a market it needs had no prices this time (try
// again later). A market whose prices came back unusable (data.unusable) can't be tried again for a
// better result until the data changes: the answer says why, from the other market if there is one.
export function answerLong(spec, data) {
  const marketOf = (symbol) => (symbol.endsWith('.SI') ? 'SGX' : 'US');
  const asked = spec.market === 'any' ? ['US', 'SGX'] : [spec.market];
  const broken = asked.filter((m) => !data?.markets?.[m] && data?.unusable?.[m]);
  if (asked.some((m) => !data?.markets?.[m] && !broken.includes(m))) return null;
  const brokenNotes = broken.map((m) => `${data.unusable[m]}.`);
  const markets = asked.filter((m) => !broken.includes(m));
  const cant = (notes) => ({ status: 'cant-answer', verdict: 'left-out', text: `${notes.join(' ')} So there's nothing to answer this from.`, numbers: null, agreed: null });
  if (!markets.length) return cant(brokenNotes);
  const leftOut = (data.leftOut ?? []).filter((x) => !broken.includes(marketOf(x.symbol)) && (spec.symbols?.length ? spec.symbols.includes(x.symbol) : markets.includes(marketOf(x.symbol))));
  const notes = [...brokenNotes, ...leftOut.map((x) => `${x.symbol} isn't in the ten-year data: ${x.why}.`)];
  if (spec.symbols?.length && spec.symbols.every((s) => broken.includes(marketOf(s)) || leftOut.some((x) => x.symbol === s))) return cant(notes);
  const all = markets.flatMap((m) => data.markets[m]?.cases?.[spec.population] ?? []).filter((it) => passes(spec, it));
  const { items, price, wanted } = measured(spec, all);
  const h = spec.horizon;
  const trained = items.filter((x) => x[`x${h}`] != null && x[`end${h}`] && x[`end${h}`] <= HOLDOUT.trainTo).map((x) => x.date).sort();
  const years = { train: trained.length ? span(trained[0], HOLDOUT.trainTo) : `${(data.from ?? '2016').slice(0, 4)}–23`, test: span(HOLDOUT.testFrom, data.to ?? HOLDOUT.testFrom) };
  let extra = '';
  if (spec.population === 'ex_dividend') {
    const drops = all.map((x) => x.drop).filter(Number.isFinite).sort((a, b) => a - b);
    if (drops.length) extra = `On the ex-date itself the price fell by about ${Math.round(drops[drops.length >> 1] * 100)}% of the dividend, after the market's move (the middle of ${plural(drops.length, 'ex-date')}).`;
  }
  return answerFrom(spec, holdoutCheck(items, h), { items, price, wanted, years, notes, extra, beyond: 'beyond the market and the stock\'s usual drift' });
}

// The date `n` weekdays after ISO date `d`.
function addWeekdays(d, n) {
  let t = Date.parse(`${d}T12:00:00Z`);
  for (let k = 0; k < n;) { t += DAY_MS; if (![0, 6].includes(new Date(t).getUTCDay())) k++; }
  return new Date(t).toISOString().slice(0, 10);
}

// The funds' ideas as cases for a question: each market's entries (factors.js labCases: one per fund,
// stock and side per 5 trading days, with their factors at the time), with the week's and month's
// stock-specific edge after beta and fees (x5, x21) and the conditions from their factors.
// `gradedBy`: this run's graded ideas by fund id; `frozen(fund)`: a fund's frozen ideas otherwise.
export function ideaCases(funds, markets, { gradedBy = {}, frozen = () => [] } = {}) {
  const ccys = markets.map((m) => (m === 'SGX' ? 'SGD' : 'USD'));
  return (funds ?? []).filter((f) => ccys.includes(f.currency)).flatMap((f) => labCases(gradedBy[f.id] ?? frozen(f), f.id)).map((c) => {
    const date = dateOf(c.t);
    return {
      symbol: c.symbol, direction: c.direction, t: c.t, date, idio: c.idio, x5: c.x, x21: c.x21 ?? null, end5: addWeekdays(date, 5), end21: addWeekdays(date, 21),
      heavy: c.f.volume20 == null ? null : c.f.volume20 >= LONG.heavy, vix: c.f.vix == null ? null : vixLevel(c.f.vix),
      trend: c.f.index200 == null ? null : c.f.index200 >= 0 ? 'above' : 'below',
    };
  });
}

// A question on the funds' own ideas: open once the oldest frozen idea in its market(s) is
// ASK.ideaMonths months old; found on the first two thirds of the time since and checked on the rest.
export function answerIdeas(spec, { funds = [], gradedBy = {}, frozen = () => [], now = new Date() } = {}) {
  const markets = spec.market === 'any' ? ['US', 'SGX'] : [spec.market];
  const ccys = markets.map((m) => (m === 'SGX' ? 'SGD' : 'USD'));
  const firsts = funds.filter((f) => ccys.includes(f.currency)).map((f) => (Array.isArray(f.ideaLog) && f.ideaLog.length ? f.ideaLog[0][0] : null)).filter(Number.isFinite);
  const first = firsts.length ? Math.min(...firsts) * 1000 : null;
  const opens = first == null ? null : new Date(first + ASK.ideaMonths * 30.44 * DAY_MS);
  if (!opens || opens > now) {
    return {
      status: 'not-enough', verdict: 'too-early', numbers: null, agreed: null,
      text: `Not enough data yet: questions on the funds' own ideas open once their graded ideas go back ${ASK.ideaMonths} months${opens ? `, around ${opens.toISOString().slice(0, 10)}` : ' (none are graded a month on yet)'}. Ask again then.`,
    };
  }
  const trainTo = new Date(first + (now - first) * 2 / 3).toISOString().slice(0, 10);
  const testFrom = new Date(Date.parse(`${trainTo}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  const all = ideaCases(funds, markets, { gradedBy, frozen }).filter((it) => passes(spec, it));
  const { items, price, wanted } = measured(spec, all);
  const years = { train: `${new Date(first).toISOString().slice(0, 10)} to ${trainTo}`, test: `${testFrom} on` };
  return answerFrom(spec, holdoutCheck(items, spec.horizon, { trainTo, testFrom }), {
    items, price, wanted, years, beyond: 'against the market, after beta and fees',
    extra: 'Pooled across the market\'s funds, one case per fund, stock and side per 5 trading days: months of ideas, not years, so a first look.',
  });
}

// ---------- the questions ----------

// A question as the fund collection keeps it, from the owner's text, the AI's spec (ASK_TOOL's input,
// or null when it couldn't be read) and symbols.json: waiting for its answer, or can't be answered.
export function questionFrom(text, raw, symbols, now = new Date()) {
  const q = { id: `q${now.getTime().toString(36)}`, askedAt: now.toISOString(), text: clip(text, ASK.maxChars) };
  const v = validateSpec(raw, symbols);
  if (!v.ok) return { ...q, status: 'cant-answer', reason: v.reason, answeredAt: now.toISOString() };
  return { ...q, status: 'waiting', spec: v.spec, ...(v.note ? { note: v.note } : {}) };
}

// The list with `q` added, the newest ASK.keep kept.
export const addQuestion = (list, q) => [...(Array.isArray(list) ? list : []), q].slice(-ASK.keep);

// The questions waiting for the ten years of prices (every population but the funds' ideas).
export const waitingLong = (list) => (Array.isArray(list) ? list : []).filter((q) => q.status === 'waiting' && q.spec && q.spec.population !== 'fund_ideas');
export const waitingIdeas = (list) => (Array.isArray(list) ? list : []).filter((q) => q.status === 'waiting' && q.spec?.population === 'fund_ideas');

// Whether to answer the waiting questions now: when the ten years of raw prices are already on the
// runner (the weekly build ran this time), or none has been tried in the last ASK.retryHours hours
// (a download for them, which failed or came back short).
export function answerDue(list, { rawReady = false, now = new Date() } = {}) {
  const waiting = waitingLong(list);
  if (!waiting.length) return false;
  return rawReady || !waiting.some((q) => q.triedAt && now - Date.parse(q.triedAt) < ASK.retryHours * 3600000);
}

// A question with its answer: { ..., status, verdict, answer (the words), numbers, agreed, answeredAt }.
function settle(q, a, now) {
  Object.assign(q, { status: a.status, verdict: a.verdict, answer: a.text, numbers: a.numbers, agreed: a.agreed, answeredAt: now.toISOString() });
  delete q.triedAt;
}

// Answers the waiting questions in `list` (in place) from `data` (memory-long.js longCases). A question
// whose market had no prices this time is marked tried and waits. Returns { answered, waiting }.
export function answerWaiting(list, data, now = new Date()) {
  let answered = 0, waiting = 0;
  for (const q of waitingLong(list)) {
    const a = data ? answerLong(q.spec, data) : null;
    if (!a) { q.triedAt = now.toISOString(); waiting++; continue; }
    settle(q, a, now);
    answered++;
  }
  return { answered, waiting };
}

// Answers the waiting questions on the funds' own ideas (in place). Returns how many.
export function answerWaitingIdeas(list, opts = {}) {
  const now = opts.now ?? new Date();
  const qs = waitingIdeas(list);
  for (const q of qs) settle(q, answerIdeas(q.spec, opts), now);
  return qs.length;
}
