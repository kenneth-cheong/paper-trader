// Keeps the AI fund's state private, in Supabase (see supabase/private-fund.sql), when the
// FUND_STATE_TOKEN secret is set. Without it, the state stays on the ai-state branch as before.
//
// Usage: node scripts/fund-store.mjs load <ai-fund.json>
//          Writes the fund to the file: the newer of Supabase's copy and the branch's (the branch
//          holds one only from before the move, or if a save to Supabase failed). Sets the step
//          outputs ok (false if Supabase couldn't be read: the fund must then not run, or it would
//          start from an old state) and private.
//        node scripts/fund-store.mjs save <ai-fund.json>
//          Saves the file to Supabase and, once saved, deletes it so it isn't committed to the
//          public branch. If saving fails after retries, the file is left to be committed there,
//          so no order sent to Tiger is ever forgotten.

import { readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

const [mode, file] = process.argv.slice(2);
const base = process.env.SUPABASE_URL || SUPABASE_URL; // overridable for testing
const token = process.env.FUND_STATE_TOKEN;
const output = async (values) => {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${lines}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(name, body) {
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try { message = JSON.parse(text).message ?? message; } catch { /* not JSON */ }
    throw new Error(`Supabase ${name}: HTTP ${res.status} ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

async function withRetries(fn) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (err) { last = err; await sleep(2000 * 2 ** i); }
  }
  throw last;
}

const readLocal = async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const savedAt = (f) => Date.parse(f?.savedAt ?? f?.history?.at(-1)?.[0] ?? 0) || 0;

if (!token) {
  await output({ ok: true, private: false });
  console.log('The AI fund is stored on the public ai-state branch (add FUND_STATE_TOKEN to keep it private).');
  process.exit(0);
}

if (mode === 'load') {
  const local = await readLocal();
  try {
    const remote = await withRetries(() => rpc('load_fund_state', { token }));
    const pick = remote && (!local || savedAt(remote) >= savedAt(local)) ? remote : local;
    if (pick) await writeFile(file, JSON.stringify(pick));
    await output({ ok: true, private: true });
    console.log(`The AI fund is private: loaded ${pick === remote ? 'from Supabase' : pick ? 'from the branch (moving it to Supabase)' : 'nothing (no fund yet)'}.`);
  } catch (err) {
    await output({ ok: false, private: true });
    console.log(`::error::Couldn't load the private AI fund, so it doesn't run this time: ${err.message}`);
  }
} else if (mode === 'save') {
  const fund = await readLocal();
  if (!fund) process.exit(0);
  fund.savedAt = new Date().toISOString();
  try {
    await withRetries(() => rpc('save_fund_state', { token, data: fund }));
    await rm(file);
    await output({ saved: true });
    console.log('Saved the AI fund privately to Supabase.');
  } catch (err) {
    await writeFile(file, JSON.stringify(fund));
    await output({ saved: false });
    console.log(`::warning::Couldn't save the AI fund to Supabase, so this run's copy goes on the ai-state branch instead: ${err.message}`);
  }
} else {
  throw new Error(`Unknown mode ${mode}`);
}
