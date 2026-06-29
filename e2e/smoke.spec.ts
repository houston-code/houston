import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { acceptLegalGate } from './helpers'

const ROOT = join(__dirname, '..')

/**
 * Decide what to launch. Prefer the packaged app from `npm run dist` (in
 * `release/`): it runs the real artifact — the asar archive, bundled resources
 * (e.g. the vendored ripgrep), and the `app.isPackaged` code paths. Fall back to
 * the unpackaged `out/` bundle from `npm run build` for fast local runs. CI
 * builds with `npm run dist`, so it always smoke-tests the packaged app.
 */
function resolveLaunch(): { executablePath: string; args: string[]; mode: string } {
  for (const dir of ['mac-arm64', 'mac', 'mac-universal']) {
    const bin = join(ROOT, 'release', dir, 'Houston.app', 'Contents', 'MacOS', 'Houston')
    if (existsSync(bin)) return { executablePath: bin, args: [], mode: `packaged (${dir})` }
  }
  // In Node, importing `electron` yields the path to the executable, but its
  // published types describe the in-process API — cast to use it as the launcher.
  return {
    executablePath: electronPath as unknown as string,
    args: [join(ROOT, 'out', 'main', 'index.js')],
    mode: 'unpackaged (out/)'
  }
}

test('app boots and renders the UI', async () => {
  const { executablePath, args, mode } = resolveLaunch()
  test.info().annotations.push({ type: 'launch-mode', description: mode })

  // Isolate userData: this test accepts the first-run legal gate, which persists
  // `legalAcceptedVersion`. Without isolation that write lands in the developer's
  // REAL profile, so the gate never shows for them again. Use a throwaway dir.
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const app: ElectronApplication = await electron.launch({
    executablePath,
    args: [...args, `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()

    // The window title is "Houston" — set both in index.html's <title> and on the
    // BrowserWindow (`title: APP_NAME`) in src/main/index.ts.
    await expect(window).toHaveTitle('Houston')

    // First launch shows the legal-acceptance gate before the app shell mounts.
    await acceptLegalGate(window)

    // The app shell only mounts after the renderer has round-tripped to the main
    // process over IPC (settings + conversation list), so reaching `.app` proves
    // the whole main ↔ preload ↔ renderer bridge is wired — not just that a
    // BrowserWindow opened. (It renders a "Loading…" placeholder until then.)
    await expect(window.locator('.app')).toBeVisible()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('integrated terminal opens and round-trips through a PTY', async () => {
  const { executablePath, args, mode } = resolveLaunch()
  test.info().annotations.push({ type: 'launch-mode', description: mode })

  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const app: ElectronApplication = await electron.launch({
    executablePath,
    args: [...args, `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()
    await acceptLegalGate(window)
    await expect(window.locator('.app')).toBeVisible()

    // Open the terminal from the top-right titlebar action. This is also the real
    // test that node-pty loaded under Electron's ABI — a mismatch would have
    // crashed the app on boot (terminal.ts imports node-pty at module load).
    await window.getByRole('button', { name: 'Terminal', exact: true }).click()

    // A tab and the xterm surface mount.
    await expect(window.locator('.terminal-tab').first()).toBeVisible()
    await expect(window.locator('.terminal-view .xterm')).toBeVisible()

    // Focus the terminal and type. The PTY echoes input back, so seeing the text
    // rendered proves the renderer ↔ main ↔ node-pty pipe works end to end.
    await window.locator('.terminal-view').click()
    await window.keyboard.type('echo PTYOK')
    await expect(window.locator('.terminal-dock')).toContainText('PTYOK')

    // Hide the panel and reopen it — the session and its scrollback must survive
    // (the dock stays mounted, hidden via CSS, rather than being torn down).
    await window.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(window.locator('.terminal-view .xterm')).toBeHidden()
    await window.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(window.locator('.terminal-view .xterm')).toBeVisible()
    await expect(window.locator('.terminal-dock')).toContainText('PTYOK')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('⌘W is bound to a custom terminal-aware Close, not the default window close', async () => {
  const { executablePath, args, mode } = resolveLaunch()
  test.info().annotations.push({ type: 'launch-mode', description: mode })

  const app: ElectronApplication = await electron.launch({ executablePath, args })
  try {
    // Inspect the live application menu from the main process. The File → Close
    // item must carry ⌘W and our own click handler (role null) rather than the
    // built-in role:'close', which is what routes ⌘W to the active terminal tab
    // when focused and to the window otherwise.
    const close = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const file = menu?.items.find((i) => i.label === 'File')
      const item = file?.submenu?.items.find((i) => i.label === 'Close')
      return item ? { accelerator: item.accelerator, role: item.role ?? null } : null
    })
    expect(close).not.toBeNull()
    expect(close?.accelerator).toBe('CmdOrCtrl+W')
    expect(close?.role).toBeNull()
  } finally {
    await app.close()
  }
})

test('sidebar collapses to a rail and expands again', async () => {
  const { executablePath, args, mode } = resolveLaunch()
  test.info().annotations.push({ type: 'launch-mode', description: mode })

  // Isolate userData so toggling collapse persists into a throwaway dir instead
  // of the developer's real settings, and so the app starts in the known default
  // (expanded) state regardless of local config.
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const app: ElectronApplication = await electron.launch({
    executablePath,
    args: [...args, `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()
    await acceptLegalGate(window)
    await expect(window.locator('.app')).toBeVisible()

    // Expanded by default: the drag handle and the collapse toggle are present.
    const resizer = window.locator('[role="separator"][aria-label="Resize sidebar"]')
    await expect(resizer).toBeVisible()
    const collapse = window.getByRole('button', { name: 'Collapse sidebar' })
    await expect(collapse).toBeVisible()

    // Collapse → the rail's expand control appears and the drag handle is gone.
    await collapse.click()
    const expand = window.getByRole('button', { name: 'Expand sidebar' })
    await expect(expand).toBeVisible()
    await expect(resizer).toHaveCount(0)

    // Expand again → back to the full sidebar with the drag handle.
    await expand.click()
    await expect(window.locator('[role="separator"][aria-label="Resize sidebar"]')).toBeVisible()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
