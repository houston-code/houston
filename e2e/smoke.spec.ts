import { expect, test } from '@playwright/test'
import { launchApp } from './launch'

// Each test launches the packaged app when one is built (see e2e/launch.ts), so these
// exercise the real artifact in CI and the out/ bundle in fast local runs.

test('app boots and renders the UI', async () => {
  const { app, close } = await launchApp()

  try {
    const window = await app.firstWindow()

    // The window title is "Houston" — set both in index.html's <title> and on the
    // BrowserWindow (`title: APP_NAME`) in src/main/index.ts.
    await expect(window).toHaveTitle('Houston')

    // The app shell only mounts after the renderer has round-tripped to the main
    // process over IPC (settings + conversation list), so reaching `.app` proves
    // the whole main ↔ preload ↔ renderer bridge is wired — not just that a
    // BrowserWindow opened. (It renders a "Loading…" placeholder until then.)
    await expect(window.locator('.app')).toBeVisible()
  } finally {
    await close()
  }
})

test('integrated terminal opens and round-trips through a PTY', async () => {
  const { app, close } = await launchApp()

  try {
    const window = await app.firstWindow()
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

    // Close the tab before quitting. A live terminal counts as running work, so
    // quitting with one open raises the modal "Quit anyway?" confirmation (see
    // quit-confirm.ts), which nothing here would answer and app.close() would hang.
    await window.locator('.terminal-tab').first().getByRole('button', { name: /^Close / }).click()
    await expect(window.locator('.terminal-tab')).toHaveCount(0)
    // The close's kill is an async IPC invoke. Main handles one renderer's IPC in
    // order, so once a later invoke resolves the PTY is gone from the registry.
    // (`window` here is the Playwright page, so reach the preload bridge via globalThis.)
    const drained = await window.evaluate(() =>
      (
        globalThis as unknown as { api: { killTerminal(id: string): Promise<boolean> } }
      ).api.killTerminal('e2e-drain')
    )
    expect(drained).toBe(false)
  } finally {
    await close()
  }
})

test('⌘W is bound to a custom terminal-aware Close, not the default window close', async () => {
  const { app, close } = await launchApp()
  try {
    // Inspect the live application menu from the main process. The File → Close
    // item must carry ⌘W and our own click handler (role null) rather than the
    // built-in role:'close', which is what routes ⌘W to the active terminal tab
    // when focused and to the window otherwise. The menu is built once startup has
    // decrypted the credential store, so wait for it rather than reading it at launch.
    const readClose = () =>
      app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu()
        const file = menu?.items.find((i) => i.label === 'File')
        const item = file?.submenu?.items.find((i) => i.label === 'Close')
        return item ? { accelerator: item.accelerator, role: item.role ?? null } : null
      })
    await expect.poll(readClose).not.toBeNull()
    const close = await readClose()
    expect(close?.accelerator).toBe('CmdOrCtrl+W')
    expect(close?.role).toBeNull()
  } finally {
    await close()
  }
})

test('forces slim auto-hiding overlay scrollbars regardless of the OS setting', async () => {
  const { app, close } = await launchApp()

  try {
    const window = await app.firstWindow()
    await expect(window.locator('.app')).toBeVisible()

    // Main process pins the scroller style to overlay via the app's own
    // AppleShowScrollBars default, so a machine set to "Always" (which draws the
    // chunky, non-hiding ~15px legacy bar) still gets the slim auto-hiding one.
    const scrollBars = await app.evaluate(({ systemPreferences }) =>
      systemPreferences.getUserDefault('AppleShowScrollBars', 'string')
    )
    expect(scrollBars).toBe('WhenScrolling')

    // And it takes effect in the renderer: an overflow:auto box gets an overlay
    // scrollbar that reserves no layout width — never the chunky legacy bar.
    const barWidth = await window.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;top:-9999px;width:120px;height:120px;overflow-y:scroll'
      const inner = document.createElement('div')
      inner.style.height = '400px'
      probe.appendChild(inner)
      document.body.appendChild(probe)
      const w = probe.offsetWidth - probe.clientWidth
      probe.remove()
      return w
    })
    expect(barWidth).toBeLessThan(15)
  } finally {
    await close()
  }
})

test('sidebar collapses to a rail and expands again', async () => {
  const { app, close } = await launchApp()

  try {
    const window = await app.firstWindow()
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
    await close()
  }
})
