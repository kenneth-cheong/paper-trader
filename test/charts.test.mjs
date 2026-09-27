import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, niceStep, shareLabels, axisNum } from '../charts.js';

test('axis ticks are round numbers without floating-point dust', () => {
  assert.deepEqual(niceTicks(0, 0.3, 4), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(-0.27, 0.68, 4), [-0.25, 0, 0.25, 0.5]);
  assert.deepEqual(niceTicks(81993, 101334, 4), [85000, 90000, 95000, 100000]);
  assert.equal(niceStep(-0.27, 0.68, 4).decimals, 2);
  assert.equal(niceStep(0, 33, 4).decimals, 0);
});

test('shares of a whole add up to exactly 100%', () => {
  assert.deepEqual(shareLabels([31.04, 6.61, 62.45]), ['31.0%', '6.6%', '62.4%']);
  assert.deepEqual(shareLabels([1, 1, 1]), ['33.4%', '33.3%', '33.3%']);
});

test('axis numbers use a true minus sign and a thousands separator', () => {
  assert.equal(axisNum(-1234.5, 1), '−1,234.5');
  assert.equal(axisNum(100000), '100,000');
});
