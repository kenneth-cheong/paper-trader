// Writes data/sample-prices.json: made-up prices the app falls back to (with a banner)
// until the real price job has run. Deterministic so the file only changes when this script does.
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const symbols = JSON.parse(await readFile(new URL('symbols.json', ROOT), 'utf8'));
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const quotes = {};
for (const { symbol, name, market } of symbols) {
  let p = market === 'SGX' ? 1 + rand() * 40 : 50 + rand() * 500;
  const history = [];
  for (let i = 0; i < 21; i++) history.push(Math.round((p *= 1 + (rand() - 0.5) * 0.04) * 100) / 100);
  quotes[symbol] = {
    name, market, currency: market === 'SGX' ? 'SGD' : 'USD',
    price: history.at(-1), prevClose: history.at(-2), time: '2026-01-02T08:00:00.000Z', history,
  };
}
await writeFile(new URL('data/sample-prices.json', ROOT),
  JSON.stringify({ sample: true, updatedAt: '2026-01-02T08:00:00.000Z', fx: { USDSGD: 1.3 }, quotes }, null, 1));
