import { defineConfig } from '@playwright/test'

/**
 * End-to-end config for the Electron smoke test. There are no browser projects —
 * the suite drives the real app via Playwright's `_electron` launcher. It needs
 * the app built; `npm run test:e2e` builds first, then the spec prefers the
 * packaged app from `npm run dist` (in `release/`) and falls back to the
 * unpackaged `out/` bundle (see `e2e/smoke.spec.ts`).
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
