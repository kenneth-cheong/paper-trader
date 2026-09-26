// Writes the copy of the AI funds that the public website serves (only when they aren't kept private,
// see scripts/fund-store.mjs). Your Tiger account's full list of positions (which may include holdings
// outside the funds) and Tiger's order numbers are left out; only a check of whether Tiger holds what
// the funds think they hold is kept.
// Usage: node scripts/public-fund.mjs <ai-fund.json> <output.json>

import { readFile, writeFile } from 'node:fs/promises';
import { reconcile } from '../fund.js';
import { loadFunds, reconcileAll } from '../funds.js';

const [src, dest] = process.argv.slice(2);
let c;
try { c = loadFunds(JSON.parse(await readFile(src, 'utf8'))); } catch { process.exit(0); }

c.brokerCheck = reconcileAll(c);
for (const fund of c.funds) {
  if (fund.broker) fund.broker = { time: fund.broker.time, accountType: fund.broker.accountType, error: fund.broker.error, check: reconcile(fund) };
  for (const o of fund.brokerOrders ?? []) delete o.tigerOrderId;
  delete fund.notified;
}
await writeFile(dest, JSON.stringify(c));
