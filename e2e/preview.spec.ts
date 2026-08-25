import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import electronPath from 'electron'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const ROOT = join(__dirname, '..')
const ART = process.env.PREVIEW_ART_DIR ?? mkdtempSync(join(tmpdir(), 'houston-preview-'))

function resolveLaunch(): { executablePath: string; args: string[] } {
  for (const dir of ['mac-arm64', 'mac', 'mac-universal']) {
    const bin = join(ROOT, 'release', dir, 'Houston.app', 'Contents', 'MacOS', 'Houston')
    if (existsSync(bin)) return { executablePath: bin, args: [] }
  }
  return {
    executablePath: electronPath as unknown as string,
    args: [join(ROOT, 'out', 'main', 'index.js')]
  }
}

// A tiny loopback dev server with a recognizable page, so a screenshot of the
// pane unambiguously proves the live page rendered (not just that a box exists).
function startFakeServer(label: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<!doctype html><meta charset=utf-8><body style="margin:0;background:#1e88e5;color:#fff;font:700 40px system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div id=probe>${label}</div></body>`
      )
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() })
    })
  })
}

// Inspect the native preview panes from the MAIN process — they're WebContents
// views overlaid on the window, invisible to a renderer-side screenshot.
async function inspectPanes(
  app: ElectronApplication
): Promise<Array<{ url: string; visible: unknown; bounds: unknown; png?: string }>> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    // contentView.children holds the overlaid WebContentsViews (+ maybe others).
    const kids = (win.contentView as unknown as { children: unknown[] }).children
    const out: Array<{ url: string; visible: unknown; bounds: unknown; png?: string }> = []
    for (const k of kids) {
      const v = k as {
        webContents?: { getURL(): string; capturePage(): Promise<{ toPNG(): Buffer }> }
        getVisible?: () => boolean
        getBounds?: () => unknown
      }
      if (!v.webContents) continue
      let png: string | undefined
      try {
        const img = await v.webContents.capturePage()
        png = img.toPNG().toString('base64')
      } catch {
        /* hidden views may not capture */
      }
      out.push({
        url: v.webContents.getURL(),
        visible: typeof v.getVisible === 'function' ? v.getVisible() : 'unknown',
        bounds: typeof v.getBounds === 'function' ? v.getBounds() : 'unknown',
        png
      })
    }
    return out
  })
}

test('preview dock renders a live dev server and enforces its limits', async () => {
  const { executablePath, args } = resolveLaunch()
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const real = await startFakeServer('HOUSTON PREVIEW OK')

  const app: ElectronApplication = await electron.launch({
    executablePath,
    args: [...args, `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()
    await expect(window.locator('.app')).toBeVisible()

    // 1. The Preview button toggles the right-side dock open.
    await window.getByRole('button', { name: /Preview/ }).click()
    await expect(window.locator('.preview-dock')).toBeVisible()
    await expect(window.locator('.preview-dock__empty')).toContainText('No running dev servers')
    console.log('STEP1 dock opened, empty state shown')

    // 2. Add the real server by URL → a pane appears for it.
    await window.getByLabel('Add a localhost URL to preview').fill(real.url)
    await window.getByRole('button', { name: 'Add', exact: true }).click()
    const host = real.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
    await expect(window.locator('.preview-pane__host', { hasText: host })).toBeVisible()
    console.log(`STEP2 added manual URL ${real.url}`)

    // 3. The live page actually rendered in the native view — capture from main.
    await window.waitForTimeout(1200) // let the WebContentsView load + paint
    const panes = await inspectPanes(app)
    console.log('STEP3 native panes:', panes.map((p) => ({ url: p.url, visible: p.visible })))
    const livePane = panes.find((p) => p.url === real.url)
    expect(livePane, 'a WebContentsView should be loading the server URL').toBeTruthy()
    expect(livePane!.png, 'the pane should have captured a rendered frame').toBeTruthy()
    writeFileSync(join(ART, 'pane-live.png'), Buffer.from(livePane!.png as string, 'base64'))
    await window.screenshot({ path: join(ART, 'dock-with-pane.png') })
    console.log(`STEP3 wrote ${join(ART, 'pane-live.png')} and dock-with-pane.png`)

    // 4. Reload + open-in-browser controls exist on the pane.
    await expect(window.getByLabel(`Reload ${host}`)).toBeVisible()
    await expect(window.getByLabel(`Open ${host} in browser`)).toBeVisible()
    console.log('STEP4 reload + open-in-browser controls present')

    // 5. Occlusion: opening Settings must hide the native views (they'd paint over it).
    // Open it via the same IPC the native menu uses, independent of button layout.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:openSettings')
    })
    await expect(window.locator('.modal[role="dialog"]')).toBeVisible()
    await window.waitForTimeout(400)
    const occluded = await inspectPanes(app)
    console.log('STEP5 with Settings open, pane visibility:', occluded.map((p) => p.visible))
    expect(occluded.find((p) => p.url === real.url)?.visible).toBe(false)
    // Close the modal (Esc) and let the views re-show.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)

    // 6. Cap to 3: add three more loopback URLs (4 total) → 3 panes + overflow note.
    for (const port of ['5051', '5052', '5053']) {
      await window.getByLabel('Add a localhost URL to preview').fill(`localhost:${port}`)
      await window.getByRole('button', { name: 'Add', exact: true }).click()
    }
    await expect(window.locator('.preview-pane')).toHaveCount(3)
    await expect(window.locator('.preview-dock__overflow')).toContainText('+1 more not shown (max 3)')
    console.log('STEP6 capped at 3 panes, overflow note shown')

    // 7. Invalid manual URL is rejected, not added.
    const input = window.getByLabel('Add a localhost URL to preview')
    await input.fill('https://example.com')
    await window.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(window.locator('.preview-pane')).toHaveCount(3) // unchanged
    console.log('STEP7 non-loopback URL rejected (aria-invalid), pane count unchanged')

    console.log('ARTIFACTS_DIR', ART)
  } finally {
    await app.close()
    real.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
