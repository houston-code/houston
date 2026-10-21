import { expect, test } from '@playwright/test'
import { launchApp } from './launch'

/**
 * The model picker is a custom listbox (not a native <select>) precisely so it can be
 * positioned: the control bar sits at the bottom of the window, so the menu must open
 * *upward* and stay fully on-screen rather than spilling off the bottom edge. This is
 * layout-dependent, so it can't be checked under jsdom — it needs the real app.
 */
test('model picker opens upward, fully on-screen, in advanced-first order', async () => {
  const { app, close } = await launchApp()
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.app')).toBeVisible()

    // The trigger's title is a dynamic tooltip (the selected model name), so match on
    // its stable listbox-combobox role instead.
    const trigger = page.locator('[role="combobox"][aria-haspopup="listbox"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.locator('[role="listbox"]')).toBeVisible()

    const info = await page.evaluate(() => {
      // The popover (search field + list) is what scrolls and what must stay on-screen.
      const menu = document.querySelector('.model-menu') as HTMLElement
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

    // Advanced-first ordering, regardless of stored order. Names are the lowercase model
    // id (so a curated model reads the same as one added via the provider's Fetch), e.g.
    // "gpt-6.1-sol", "claude-opus-5.5". Anchor on families and tiers rather than exact
    // ids, since the curated seed is refreshed as each line moves: within GPT, the newest
    // version leads and the efficient luna tier trails the flagship tiers.
    const gpt = info.options.filter((o) => o.startsWith('gpt-'))
    expect(gpt.length).toBeGreaterThan(0)
    expect(gpt.findIndex((o) => o.includes('luna'))).toBe(gpt.length - 1)
    // Claude families in capability order: Fable, then Opus, Sonnet, Haiku.
    const claude = ['claude-fable', 'claude-opus', 'claude-sonnet', 'claude-haiku'].map((f) =>
      info.options.findIndex((o) => o.startsWith(f))
    )
    for (const idx of claude) expect(idx).toBeGreaterThanOrEqual(0)
    expect(claude).toEqual([...claude].sort((a, b) => a - b))
    // Every model is annotated with its context window ("200k", "1M") — asserted across
    // the whole list, since any one model's number moves with the seed.
    for (const o of info.options) expect(o).toMatch(/\b\d+(\.\d+)?[kM]\b/)
  } finally {
    await close()
  }
})
