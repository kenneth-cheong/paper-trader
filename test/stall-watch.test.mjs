import test from 'node:test';
import assert from 'node:assert/strict';
import { inWatchWindow, verdict } from '../scripts/stall-watch.mjs';

const at = (iso) => Date.parse(iso);
const run = (id, created, status, jobs = []) => ({ id, created_at: created, status, jobs });
const job = (name, completed, conclusion = 'success') => ({ name, completed_at: completed, conclusion });

test('the watch window: weekdays, 3 hours into each market\'s runs, never at weekends', () => {
  assert.equal(inWatchWindow(at('2026-11-02T02:59:00Z')), false); // Monday, SGX runs only 2 hours old
  assert.equal(inWatchWindow(at('2026-11-02T03:00:00Z')), true);
  assert.equal(inWatchWindow(at('2026-11-02T09:59:00Z')), true);
  assert.equal(inWatchWindow(at('2026-11-02T12:00:00Z')), false); // between the markets
  assert.equal(inWatchWindow(at('2026-11-02T15:00:00Z')), true);
  assert.equal(inWatchWindow(at('2026-11-02T22:00:00Z')), false);
  assert.equal(inWatchWindow(at('2026-10-31T05:00:00Z')), false); // Saturday
});

test('a recent finished update is running; none for 3 hours in the window is a stall', () => {
  const now = at('2026-11-02T05:00:00Z');
  assert.equal(verdict(now, [run(2, '2026-11-02T04:00:00Z', 'completed', [job('update', '2026-11-02T04:10:00Z'), job('deploy', '2026-11-02T04:11:00Z')])]).stalled, false);
  // the update finished but the deploy still waits: trading is fine
  assert.equal(verdict(now, [run(2, '2026-11-02T04:00:00Z', 'waiting', [job('update', '2026-11-02T04:10:00Z'), job('deploy', null, null)])]).stalled, false);
  assert.equal(verdict(now, [run(2, '2026-11-02T01:30:00Z', 'completed', [job('update', '2026-11-02T01:40:00Z')])]).stalled, true);
  assert.equal(verdict(now, []).stalled, true);
  assert.equal(verdict(now, [run(2, '2026-11-02T04:00:00Z', 'completed', [job('update', '2026-11-02T04:10:00Z', 'failure')])]).stalled, true);
  assert.equal(verdict(at('2026-10-31T05:00:00Z'), []).stalled, false); // weekend: nothing expected
});

test('only a run waiting over 2 hours is cancelled', () => {
  const now = at('2026-11-02T05:00:00Z');
  const v = verdict(now, [
    run(3, '2026-11-02T04:00:00Z', 'waiting'),
    run(2, '2026-10-06T09:45:01Z', 'waiting'),
    run(1, '2026-11-02T01:00:00Z', 'in_progress'),
  ]);
  assert.deepEqual(v.cancel, [2]);
});
