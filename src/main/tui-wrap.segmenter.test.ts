import { describe, it, expect } from 'vitest'

// Building a grapheme segmenter loads the break data (about 9 ms), so tui-wrap makes
// its one on first use rather than when the module loads at start-up. Its own file: the
// module has to load fresh, after the counting stand-in is in place.
const RealSegmenter = Intl.Segmenter
const intl = Intl as { Segmenter: typeof Intl.Segmenter }
let built = 0
intl.Segmenter = class extends RealSegmenter {
  constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
    super(...args)
    built++
  }
}

describe('the grapheme segmenter', () => {
  it('is built on first use, not when the module loads, and only once', async () => {
    const wrap = await import('./tui-wrap')
    expect(built).toBe(0)
    expect(wrap.visibleWidth('plain ASCII text')).toBe(16)
    expect(built).toBe(0)
    expect(wrap.visibleWidth('日本')).toBe(4)
    expect(wrap.visibleWidth('👍🏽')).toBe(2)
    expect(built).toBe(1)
    intl.Segmenter = RealSegmenter
  })
})
