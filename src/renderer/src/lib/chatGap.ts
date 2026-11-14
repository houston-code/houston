import { useLayoutEffect, type RefObject } from 'react'
import { SIDEBAR_DEFAULT_WIDTH } from './sidebar'

/**
 * The chat column's side gutter (`--chat-gap`) for the width the column actually
 * has. The stylesheet's window-width breakpoints (1400/1200/1024/820/640) assume only
 * the sidebar takes room; with a side panel or side chat open, or a wider sidebar,
 * that left wide gutters around a narrow column. These are the same steps, read off
 * the column instead: each window breakpoint less the default sidebar. With the
 * sidebar at its default width and no panel open the result matches the stylesheet.
 */
const STEPS: { upTo: number; gap: number }[] = [
  { upTo: 640 - SIDEBAR_DEFAULT_WIDTH, gap: 24 },
  { upTo: 820 - SIDEBAR_DEFAULT_WIDTH, gap: 36 },
  { upTo: 1024 - SIDEBAR_DEFAULT_WIDTH, gap: 56 },
  { upTo: 1200 - SIDEBAR_DEFAULT_WIDTH, gap: 80 },
  { upTo: 1400 - SIDEBAR_DEFAULT_WIDTH, gap: 104 }
]

export function chatGapFor(columnWidth: number): number {
  for (const s of STEPS) if (columnWidth <= s.upTo) return s.gap
  return 128
}

/**
 * Keep `--chat-gap` on the chat column in step with its width as panels open and
 * close. `mounted` says the column is in the page (it isn't on the loading screen).
 */
export function useChatGap(ref: RefObject<HTMLElement | null>, mounted: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = (width: number): void => el.style.setProperty('--chat-gap', `${chatGapFor(width)}px`)
    apply(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) apply(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, mounted])
}
