// Exchange trading hours, by the clock. Exchange holidays aren't known, so a holiday looks "open"
// but simply has no new prices.

export const MARKETS = {
  SGX: { tz: 'Asia/Singapore', currency: 'SGD', sessions: [[9 * 60, 12 * 60], [13 * 60, 17 * 60]], label: 'SGX' },
  US: { tz: 'America/New_York', currency: 'USD', sessions: [[9 * 60 + 30, 16 * 60]], label: 'US' },
};

export const marketForCurrency = (ccy) => Object.keys(MARKETS).find((m) => MARKETS[m].currency === ccy);

function localClock(market, now) {
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

export const sessionMinutes = (market) => MARKETS[market].sessions.reduce((s, [a, b]) => s + b - a, 0);
