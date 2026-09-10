import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The suite browses as real profiles, so the auth gate stamps their activity columns on every
  // request. Snapshot them before the run and put them back after it — see tests/activity.ts.
  globalSetup: './tests/activity.setup.ts',
  globalTeardown: './tests/activity.teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
  },
});
