// Writes the copy of the AI fund that the public website serves. Your Tiger account's full list of
// positions (which may include holdings outside the fund) and Tiger's order numbers are left out;
// only a check of whether Tiger holds what the fund thinks it holds is kept.
// Usage: node scripts/public-fund.mjs <ai-fund.json> <output.json>

import { readFile, writeFile } from 'node:fs/promises';

const [src, dest] = process.argv.slice(2);
let fund;
try { fund = JSON.parse(await readFile(src, 'utf8')); } catch { process.exit(0); }

export function reconcile(f) {
  const tiger = f.broker?.positions;
  if (!Array.isArray(tiger) || f.broker?.error) return null;
  const held = Object.fromEntries(tiger.map((p) => [p.symbol, Number(p.qty) || 0]));
  const tigerName = (s) => (s.endsWith('.SI') ? s.slice(0, -3) : s.replace('-', '.'));
  const mismatches = [];
  for (const [symbol, pos] of Object.entries(f.portfolio?.positions ?? {})) {
    const t = held[tigerName(symbol)] ?? 0;
    // Tiger may hold more than the fund (your own shares), but never less, and on the same side.
    if (pos.qty > 0 ? t < pos.qty : t > pos.qty) mismatches.push({ symbol, fund: pos.qty, tiger: t });
  }
  return { checkedAt: f.broker.time, ok: mismatches.length === 0, mismatches };
}

if (fund.broker) {
  const check = reconcile(fund);
  fund.broker = { time: fund.broker.time, accountType: fund.broker.accountType, error: fund.broker.error, check };
}
for (const o of fund.brokerOrders ?? []) delete o.tigerOrderId;
await writeFile(dest, JSON.stringify(fund));
