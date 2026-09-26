// Writes the copy of the AI fund that the public website serves. Your Tiger account's full list of
// positions (which may include holdings outside the fund) and Tiger's order numbers are left out;
// only a check of whether Tiger holds what the fund thinks it holds is kept.
// Usage: node scripts/public-fund.mjs <ai-fund.json> <output.json>

import { readFile, writeFile } from 'node:fs/promises';
import { reconcile } from '../fund.js';

const [src, dest] = process.argv.slice(2);
let fund;
try { fund = JSON.parse(await readFile(src, 'utf8')); } catch { process.exit(0); }

if (fund.broker) {
  const check = reconcile(fund);
  fund.broker = { time: fund.broker.time, accountType: fund.broker.accountType, error: fund.broker.error, check };
}
for (const o of fund.brokerOrders ?? []) delete o.tigerOrderId;
await writeFile(dest, JSON.stringify(fund));
