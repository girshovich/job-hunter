/**
 * The gate's ceiling must be changeable while work is already queued.
 *
 * This is the regression guard for APIlimits.md §4.3.0: the obvious implementation — keep `p-limit`
 * and assign `limiter.concurrency` — compiles, throws nothing, and does nothing. `p-limit@3.1.0`
 * has no such setter, and v4 (which does) is pure ESM while this project is CommonJS.
 *
 * Both cases below act on a **live gate with a non-empty queue**. A test that rebuilt the gate
 * between limit changes would pass against the broken implementation and prove nothing.
 *
 * No browser: this is pure module behaviour, run under the project's existing test runner.
 */

import { test, expect } from '@playwright/test';
import { apifyGate, apifyOutstandingCount } from '../src/pipeline/providers/apifyGate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tracker() {
  const s = { started: 0, active: 0, peak: 0 };
  const task = async () => {
    s.started++; s.active++; s.peak = Math.max(s.peak, s.active);
    await sleep(120);
    s.active--;
  };
  return { s, task };
}

test('raising the ceiling admits already-queued work without a restart', async () => {
  const { s, task } = tracker();
  const token = `raise-${Date.now()}`;

  const queued = Array.from({ length: 8 }, () => apifyGate(token, 2, task));
  await sleep(20);
  expect(s.started).toBe(2);
  expect(apifyOutstandingCount(token)).toBe(8);

  apifyGate(token, 6, task);        // same gate, new ceiling, six calls still parked
  await sleep(20);
  expect(s.started).toBe(6);        // the four parked waiters were admitted at once

  await Promise.all(queued);
  await sleep(250);
  expect(s.peak).toBeLessThanOrEqual(6);
});

test('lowering the ceiling never interrupts running work and admits nothing new', async () => {
  const { s, task } = tracker();
  const token = `lower-${Date.now()}`;

  const queued = Array.from({ length: 6 }, () => apifyGate(token, 5, task));
  await sleep(20);
  expect(s.active).toBe(5);

  apifyGate(token, 1, task);        // drop the ceiling under five in-flight calls
  await sleep(20);
  expect(s.active).toBe(5);         // nothing killed
  expect(s.started).toBe(5);        // and nothing new admitted

  await Promise.all(queued);
  await sleep(450);
  expect(s.peak).toBe(5);           // the pre-existing wave, never more
});
