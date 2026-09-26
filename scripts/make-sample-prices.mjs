// Writes data/sample-prices.json: made-up prices the app falls back to (with a banner)
// until the real price job has run. Deterministic so the file only changes when this script does.
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const r2 = (n) => Math.round(n * 100) / 100;

// The last 252 weekdays up to Friday 2 Jan 2026, as UTC midnight timestamps.
const days = [];
for (let d = Date.UTC(2026, 0, 2); days.length < 252; d -= 86400000) {
  const wd = new Date(d).getUTCDay();
  if (wd !== 0 && wd !== 6) days.unshift(d / 1000);
}
const SESSION = { SGX: { open: 1 * 3600, bars: 32 }, US: { open: 14.5 * 3600, bars: 26 } }; // UTC open, 15-min bars

const quotes = {};
for (const { symbol, name, market } of symbols) {
  const { open, bars } = SESSION[market];
  let p = market === 'SGX' ? 2 + rand() * 40 : 50 + rand() * 500;
  const drift = (rand() - 0.45) * 0.002;
  const vol = 0.01 + rand() * 0.02;
  const daily = [];
  const intraday = [];
  days.forEach((day, i) => {
    const intradayDay = i >= days.length - 5;
    for (let b = 0; b < bars; b++) {
      p *= 1 + drift / bars + (rand() - 0.5) * 2 * vol / Math.sqrt(bars);
      if (intradayDay) intraday.push([day + open + b * 900, r2(p)]);
    }
    daily.push([day + open, r2(p)]);
  });
  quotes[symbol] = {
    name, market, currency: market === 'SGX' ? 'SGD' : 'USD',
    price: daily.at(-1)[1], prevClose: daily.at(-2)[1],
    time: new Date((days.at(-1) + open + bars * 900) * 1000).toISOString(),
    daily, intraday,
  };
}
await writeFile(new URL('data/sample-prices.json', ROOT),
  JSON.stringify({ sample: true, updatedAt: '2026-01-02T21:00:00.000Z', fx: { USDSGD: 1.3 }, quotes }));
