import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { acceptLegalGate } from './helpers'

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
    await acceptLegalGate(page)
    await expect(page.locator('.app')).toBeVisible()

    // The trigger's title is a dynamic tooltip (the selected model name), so match on
    // its stable listbox-combobox role instead.
    const trigger = page.locator('[role="combobox"][aria-haspopup="listbox"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.locator('[role="listbox"]')).toBeVisible()

    const info = await page.evaluate(() => {
      const menu = document.querySelector('[role="listbox"]') as HTMLElement
      const trig = document.querySelector('[role="combobox"][aria-haspopup="listbox"]') as HTMLElement
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

    // Advanced-first ordering: the GPT-5 family ahead of the older o-series, regardless
    // of stored order. Names are the lowercase model id (so a curated model reads the
    // same as one added via the provider's Fetch), e.g. "gpt-5.6-sol", "claude-opus-4.8".
    // Anchor on families rather than a single id — the curated seed is refreshed as the
    // line moves, and a dropped id would read here as an ordering regression.
    const gpt5 = info.options.findIndex((o) => o.startsWith('gpt-5'))
    const oSeries = info.options.findIndex((o) => /^o\d/.test(o))
    expect(gpt5).toBeGreaterThanOrEqual(0)
    expect(oSeries).toBeGreaterThanOrEqual(0)
    expect(gpt5).toBeLessThan(oSeries)
    // Same family grouped, newest version first: opus 4.8 immediately before 4.7.
    const opus48 = info.options.findIndex((o) => o.startsWith('claude-opus-4.8'))
    const opus47 = info.options.findIndex((o) => o.startsWith('claude-opus-4.7'))
    expect(opus48).toBeGreaterThanOrEqual(0)
    expect(opus47).toBe(opus48 + 1)
    // Every model is annotated with its context window ("200k", "1M") — asserted across
    // the whole list, since any one model's number moves with the seed.
    for (const o of info.options) expect(o).toMatch(/\b\d+(\.\d+)?[kM]\b/)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
