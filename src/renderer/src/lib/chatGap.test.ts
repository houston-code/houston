import { describe, expect, it } from 'vitest'
import { chatGapFor } from './chatGap'
import { SIDEBAR_DEFAULT_WIDTH } from './sidebar'

describe('chatGapFor', () => {
  it("matches the stylesheet's window breakpoints with the default sidebar and no panel", () => {
    const atWindow = (w: number): number => chatGapFor(w - SIDEBAR_DEFAULT_WIDTH)
    expect(atWindow(1600)).toBe(128)
    expect(atWindow(1401)).toBe(128)
    expect(atWindow(1400)).toBe(104)
    expect(atWindow(1201)).toBe(104)
    expect(atWindow(1200)).toBe(80)
    expect(atWindow(1024)).toBe(56)
    expect(atWindow(820)).toBe(36)
    expect(atWindow(640)).toBe(24)
  })

  it('narrows with the column when a side panel takes room', () => {
    // A 1280px window with the sidebar and a 420px side panel leaves ~612px: the
    // gutter a 1024px window gets, not the 104px the window width alone would give.
    expect(chatGapFor(1280 - SIDEBAR_DEFAULT_WIDTH - 420)).toBe(56)
  })
})
