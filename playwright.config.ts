import { defineConfig } from '@playwright/test'

/**
 * End-to-end config for the Electron smoke test. There are no browser projects —
 * the suite drives the real app via Playwright's `_electron` launcher, so it
 * needs the bundle in `out/` (run `npm run build` first; `npm run test:e2e`
 * does this for you).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
