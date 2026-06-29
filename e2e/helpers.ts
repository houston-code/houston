import { type Page } from '@playwright/test'

/**
 * Houston's first launch shows a blocking legal-acceptance gate before the app
 * shell (`.app`) mounts. E2E tests run against fresh user-data dirs, so they
 * always hit it. Call this right after `firstWindow()` to accept the gate and
 * let the test reach the main UI. No-ops if a pre-accepted profile skips
 * straight to the app shell.
 */
export async function acceptLegalGate(window: Page): Promise<void> {
  // The renderer first shows "Loading…", then either the gate or the app shell.
  // Wait for whichever lands before deciding whether there's a gate to accept.
  await window.locator('.legal-gate__backdrop, .app').first().waitFor({ state: 'visible' })
  const agree = window.getByRole('button', { name: 'I Agree' })
  if (await agree.isVisible()) await agree.click()
}
