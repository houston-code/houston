import { describe, it, expect, afterEach } from 'vitest'
import { collectMatchRanges } from './transcriptFind'

function root(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('collectMatchRanges', () => {
  it('returns one range per case-insensitive match, in document order', () => {
    const el = root('<p>The fox and the FOX</p>')
    const ranges = collectMatchRanges(el, 'fox')
    expect(ranges).toHaveLength(2)
    expect(ranges[0].toString().toLowerCase()).toBe('fox')
    expect(ranges[0].startOffset).toBeLessThan(ranges[1].startOffset)
  })

  it('finds matches across multiple text nodes / elements', () => {
    const el = root('<p>hello</p><div><span>hello</span> world hello</div>')
    expect(collectMatchRanges(el, 'hello')).toHaveLength(3)
  })

  it('does not overlap matches', () => {
    const el = root('<p>aaaa</p>')
    // "aa" matches at offsets 0 and 2, not 1.
    const ranges = collectMatchRanges(el, 'aa')
    expect(ranges.map((r) => r.startOffset)).toEqual([0, 2])
  })

  it('returns nothing for an empty query or no match', () => {
    const el = root('<p>content</p>')
    expect(collectMatchRanges(el, '')).toHaveLength(0)
    expect(collectMatchRanges(el, 'zzz')).toHaveLength(0)
  })
})
