import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

// In Node, importing `electron` yields the path to the executable, but its
// published types describe the in-process API — cast to use it as the launcher.
const EXECUTABLE = electronPath as unknown as string

// The built main entry (`package.json#main`), relative to this file at `e2e/`.
const MAIN_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

test('app boots and renders the UI', async () => {
  const app: ElectronApplication = await electron.launch({
    executablePath: EXECUTABLE,
    args: [MAIN_ENTRY]
  })

  try {
    const window = await app.firstWindow()

    // The OS window title comes from index.html (no code overrides it).
    await expect(window).toHaveTitle('Houston')

    // The app shell only mounts after the renderer has round-tripped to the main
    // process over IPC (settings + conversation list), so reaching `.app` proves
    // the whole main ↔ preload ↔ renderer bridge is wired — not just that a
    // BrowserWindow opened. (It renders a "Loading…" placeholder until then.)
    await expect(window.locator('.app')).toBeVisible()
  } finally {
    await app.close()
  }
})
