// Exchange trading hours. The clock alone can't know about public holidays or early closes, so
// tradingStatus() also checks that today's prices are actually arriving: a market counts as open
// only when it's within its hours AND its latest price is from today's session and recent.

export const MARKETS = {
  SGX: { tz: 'Asia/Singapore', currency: 'SGD', sessions: [[9 * 60, 12 * 60], [13 * 60, 17 * 60]], label: 'SGX' },
  US: { tz: 'America/New_York', currency: 'USD', sessions: [[9 * 60 + 30, 16 * 60]], label: 'US' },
};

export const marketForCurrency = (ccy) => Object.keys(MARKETS).find((m) => MARKETS[m].currency === ccy);

export function localClock(market, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: MARKETS[market].tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun', mins: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function isOpen(market, now = new Date()) {
  const { weekend, mins } = localClock(market, now);
  return !weekend && MARKETS[market].sessions.some(([a, b]) => mins >= a && mins < b);
}

// Minutes since the day's first session opened (null when closed).
export function minutesSinceOpen(market, now = new Date()) {
  if (!isOpen(market, now)) return null;
  return localClock(market, now).mins - MARKETS[market].sessions[0][0];
}

// The first trading day whose prices can react to news released on local `date` (YYYY-MM-DD, in the
// market's own time zone) at local minute `mins`: that day if it came out on a weekday before the
// close, otherwise the next weekday. Public holidays aren't known here; a day without a session
// simply maps to the next day that has prices.
export function sessionDateAfter(market, date, mins = 0) {
  const close = MARKETS[market].sessions.at(-1)[1];
  let d = Date.parse(`${date}T00:00:00Z`);
  const weekend = (x) => [0, 6].includes(new Date(x).getUTCDay());
  if (mins >= close || weekend(d)) do d += 86400000; while (weekend(d));
  return new Date(d).toISOString().slice(0, 10);
}

// The same for news released at an actual moment (a Date, or an ISO time with its offset), e.g. US
// results out at 16:05 New York time count from the next day's session.
export function sessionDateFor(market, when) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: MARKETS[market].tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(when)).map((p) => [p.type, p.value]));
  return sessionDateAfter(market, `${parts.year}-${parts.month}-${parts.day}`, Number(parts.hour) * 60 + Number(parts.minute));
}

// The market's own calendar date (YYYY-MM-DD) at `now`.
export const marketDate = (market, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS[market].tz }).format(now);

// Trading days (weekdays) after date `a` up to and including date `b` (YYYY-MM-DD): 0 for the same
// day, 1 for the next weekday, negative when `b` is earlier. Public holidays aren't known.
export function tradingDaysBetween(a, b) {
  const [from, to, sign] = a <= b ? [a, b, 1] : [b, a, -1];
  let n = 0;
  for (let d = Date.parse(`${from}T00:00:00Z`) + 86400000; d <= Date.parse(`${to}T00:00:00Z`); d += 86400000) {
    if (![0, 6].includes(new Date(d).getUTCDay())) n++;
  }
  return sign * n;
}

export const sessionMinutes = (market) => MARKETS[market].sessions.reduce((s, [a, b]) => s + b - a, 0);

// How old the newest price may be while a market still counts as trading. Covers Yahoo's delay on
// SGX quotes, the 15-minute price schedule and GitHub starting scheduled runs late.
export const FRESH_MINUTES = 75;

function latestQuoteTime(market, quotes = {}) {
  let latest = null;
  for (const q of Object.values(quotes)) {
    if (q.market !== market || q.stale || !q.time) continue;
    const t = Date.parse(q.time);
    if (latest == null || t > latest) latest = t;
  }
  return latest;
}

// 'open'       within hours and today's prices are coming in: orders fill now
// 'closed'     outside trading hours or a weekend
// 'no-trading' within hours, but no prices today although the feed is up: a holiday or early close
// 'waiting'    within hours, but today's prices haven't arrived yet (just after the open, or the
//              price feed itself is behind). Treated as not trading until they do.
export function tradingStatus(market, prices, now = new Date()) {
  const { weekend, mins } = localClock(market, now);
  const sessions = MARKETS[market].sessions;
  if (weekend || !sessions.some(([a, b]) => mins >= a && mins < b)) return 'closed';
  const openedAt = now.getTime() - (mins - sessions[0][0]) * 60000;
  const latest = latestQuoteTime(market, prices?.quotes);
  const fresh = FRESH_MINUTES * 60000;
  if (latest != null && latest >= openedAt - 60000 && now - latest <= fresh) return 'open';
  // Only call it a holiday when this market's prices were fetched fine and simply haven't moved.
  const feedUp = latest != null && prices?.updatedAt && now - Date.parse(prices.updatedAt) <= 30 * 60000;
  if (feedUp && now - openedAt > fresh) return 'no-trading';
  return 'waiting';
}

export const STATUS_LABELS = {
  open: 'open',
  closed: 'closed',
  'no-trading': 'closed today (holiday or early close)',
  waiting: 'opening, waiting for prices',
};
