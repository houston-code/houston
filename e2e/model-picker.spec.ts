import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const ROOT = join(__dirname, '..')

/**
 * The model picker is a custom listbox (not a native <select>) precisely so it can be
 * positioned: the control bar sits at the bottom of the window, so the menu must open
 * *upward* and stay fully on-screen rather than spilling off the bottom edge. This is
 * layout-dependent, so it can't be checked under jsdom — it needs the real app.
 */
test('model picker opens upward, fully on-screen, in advanced-first order', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'houston-e2e-'))
  const app: ElectronApplication = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [join(ROOT, 'out', 'main', 'index.js'), `--user-data-dir=${userDataDir}`]
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.app')).toBeVisible()

    const trigger = page.locator('[title="Model"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.locator('[role="listbox"]')).toBeVisible()

    const info = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]') as HTMLElement
      const trig = document.querySelector('[title="Model"]') as HTMLElement
      const opts = Array.from(menu.querySelectorAll('[role="option"]')) as HTMLElement[]
      return {
        innerHeight: window.innerHeight,
        menu: menu.getBoundingClientRect(),
        // scrollHeight === clientHeight means the whole list fits without scrolling.
        fitsWithoutScroll: menu.scrollHeight <= menu.clientHeight + 1,
        triggerTop: trig.getBoundingClientRect().top,
        options: opts.map((o) => o.innerText.replace(/\s+/g, ' ').trim())
      }
    })

    // Fully within the viewport — neither edge clipped.
    expect(info.menu.top).toBeGreaterThanOrEqual(0)
    expect(info.menu.bottom).toBeLessThanOrEqual(info.innerHeight + 1)
    // Opens upward: the menu sits entirely above its trigger.
    expect(info.menu.bottom).toBeLessThanOrEqual(info.triggerTop + 1)
    // The default model set fits without an internal scrollbar.
    expect(info.fitsWithoutScroll).toBe(true)

    // Advanced-first ordering: GPT-5 ahead of GPT-4o, regardless of stored order.
    const gpt5 = info.options.findIndex((o) => o.startsWith('GPT-5'))
    const gpt4o = info.options.findIndex((o) => o.startsWith('GPT-4o'))
    expect(gpt5).toBeGreaterThanOrEqual(0)
    expect(gpt5).toBeLessThan(gpt4o)
    // Same family grouped, newest version first: Opus 4.8 immediately before 4.7.
    const opus48 = info.options.findIndex((o) => o.startsWith('Claude Opus 4.8'))
    const opus47 = info.options.findIndex((o) => o.startsWith('Claude Opus 4.7'))
    expect(opus48).toBeGreaterThanOrEqual(0)
    expect(opus47).toBe(opus48 + 1)
    // Every model is annotated with its context window.
    expect(info.options.find((o) => o.startsWith('GPT-5'))).toContain('400k')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
