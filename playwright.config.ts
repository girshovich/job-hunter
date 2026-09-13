import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The suite browses as real profiles, so the auth gate stamps their activity columns on every
  // request. Snapshot them before the run and put them back after it — see tests/activity.ts.
  globalSetup: './tests/activity.setup.ts',
  globalTeardown: './tests/activity.teardown.ts',
  // One worker, on purpose. Every spec here drives the **real** database and several of them assert
  // on global counters — the sidebar Matches badge above all — so two files running at once make a
  // spec fail on a row another spec is midway through creating. The whole suite is ~14s serial.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
  },
});
