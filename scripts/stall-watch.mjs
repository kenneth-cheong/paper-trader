// Watches the Update prices, AI picks and AI fund workflow for a stall: no update job finishing for 3
// hours in the middle of a trading window. From 6 to 31 Oct 2026 one run sat 'waiting' on the
// github-pages environment, every later run was dropped unstarted, and nothing said so, because the
// alerts come from inside those runs. This runs on its own (stall-watch.yml) and:
//   - cancels a run that has been waiting on an environment for over 2 hours (nothing runs while it waits);
//   - opens an issue (GitHub emails and notifies the owner) when the update job has stalled, and sends
//     a Telegram message too when that's set up; once the job runs again, it closes the issue.
// Usage: node scripts/stall-watch.mjs
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER; optional TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID. Prints only run ids and times: no fund content.

import { pathToFileURL } from 'node:url';

export const STALL_HOURS = 3;
export const WAITING_CANCEL_HOURS = 2;
export const ISSUE_TITLE = 'AI fund stalled';
const HOUR = 3600e3;

// Whether `now` is far enough into a window where prices.yml runs every 15 minutes (weekdays, UTC
// 01:00-09:45 for SGX and 13:30-21:45 for the US) that the last 3 hours must hold a finished update:
// from 03:00 to 10:00 and from 15:00 to 22:00.
export function inWatchWindow(now) {
  const d = new Date(now), day = d.getUTCDay(), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return false;
  return (h >= 3 && h < 10) || (h >= 15 && h < 22);
}

// runs: newest first, each { id, status, created_at, html_url, jobs: [{ name, status, conclusion, completed_at }] }.
// Returns what to do: { stalled, lastOk (ms or null), cancel: [run ids] }.
export function verdict(now, runs) {
  const done = runs.flatMap((r) => r.jobs)
    .filter((j) => (j.name === 'update' || j.name === 'deploy') && j.conclusion === 'success' && j.completed_at)
    .map((j) => Date.parse(j.completed_at));
  const lastOk = done.length ? Math.max(...done) : null;
  const cancel = runs.filter((r) => r.status === 'waiting' && now - Date.parse(r.created_at) > WAITING_CANCEL_HOURS * HOUR).map((r) => r.id);
  const stalled = inWatchWindow(now) && (lastOk == null || now - lastOk > STALL_HOURS * HOUR);
  return { stalled, lastOk, cancel };
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_OWNER: owner } = process.env;
  const gh = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: HTTP ${res.status}`);
    return res.status === 204 || res.status === 202 ? null : res.json();
  };
  const now = Date.now();
  const since = new Date(now - 8 * HOUR).toISOString();
  const { workflow_runs: list } = await gh(`/actions/workflows/prices.yml/runs?per_page=40&created=>=${since}`);
  // a run stuck since long before the 8-hour look-back still holds the queue, so add those too
  const { workflow_runs: waiting } = await gh('/actions/workflows/prices.yml/runs?per_page=20&status=waiting');
  const byId = new Map([...list, ...waiting].map((r) => [r.id, r]));
  const runs = [];
  for (const r of [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    runs.push({ ...r, jobs: r.status === 'completed' || r.status === 'in_progress' || r.status === 'waiting' ? (await gh(`/actions/runs/${r.id}/jobs`)).jobs : [] });
  }
  const v = verdict(now, runs);
  for (const id of v.cancel) {
    await gh(`/actions/runs/${id}/cancel`, { method: 'POST' }).catch(() => gh(`/actions/runs/${id}/force-cancel`, { method: 'POST' }));
    console.log(`Cancelled run ${id}: it had waited on an environment for over ${WAITING_CANCEL_HOURS} hours.`);
  }
  const last = v.lastOk ? new Date(v.lastOk).toISOString().replace(/:\d\d\.\d+Z$/, 'Z') : 'not in the last 8 hours';
  console.log(`Last finished update: ${last}. ${v.stalled ? 'Stalled.' : inWatchWindow(now) ? 'Running.' : 'Outside the watch window.'}`);

  const open = (await gh('/issues?state=open&per_page=100')).filter((i) => !i.pull_request && i.title.startsWith(ISSUE_TITLE));
  if (v.stalled && !open.length) {
    const stuck = runs.filter((r) => r.status !== 'completed').map((r) => `- [${r.status} since ${r.created_at}](${r.html_url})`).join('\n') || '- none';
    await gh('/issues', { method: 'POST', body: JSON.stringify({
      title: `${ISSUE_TITLE}: no update since ${last}`,
      body: `@${owner} The *Update prices, AI picks and AI fund* job hasn't finished for over ${STALL_HOURS} hours while a market trades, so the AI funds aren't deciding or managing stops.\n\nRuns not finished:\n${stuck}\n\n${v.cancel.length ? `Cancelled ${v.cancel.length} run(s) stuck waiting on an environment. ` : ''}This issue closes itself once the job runs again (checked hourly by stall-watch.yml).`,
    }) });
    console.log('Opened an issue.');
    const { TELEGRAM_BOT_TOKEN: tg, TELEGRAM_CHAT_ID: chat } = process.env;
    if (tg && chat) {
      await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `⚠️ Paper Trader has stalled: no update since ${last}. See the repository's issues.` }) }).catch(() => {});
    }
  } else if (!v.stalled && v.lastOk && open.length) {
    for (const i of open) {
      await gh(`/issues/${i.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Running again: an update finished at ${last}.` }) });
      await gh(`/issues/${i.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    }
    console.log(`Closed ${open.length} issue(s): running again.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
