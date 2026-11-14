import { defineConfig } from '@playwright/test'

/**
 * The memory soak (e2e/soak/): long, heavy sessions in the desktop app and the CLI
 * against a local scripted model, checked against per-platform memory budgets (see
 * e2e/soak/budgets.ts). Run by .github/workflows/memory-soak.yml, or locally with
 * `npm run test:soak`. It drives the unpackaged out/ bundle and out/cli, never the
 * installers. Not part of `npm run test:e2e`, whose files are *.spec.ts.
 */
export default defineConfig({
  testDir: './e2e/soak',
  testMatch: '*.soak.ts',
  fullyParallel: false,
  workers: 1,
  // A memory number is the result; a retry would only hide a regression that is flaky.
  retries: 0,
  reporter: 'list',
  timeout: 600_000,
  expect: { timeout: 30_000 }
})
