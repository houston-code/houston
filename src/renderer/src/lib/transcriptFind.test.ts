import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  MAX_FIND_MATCHES,
  collectMatchRanges,
  collectMatchRangesAcross,
  findMatches,
  scrollRangeIntoView
} from './transcriptFind'

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

  it('skips text hidden inside a collapsed <details>, but not its summary', () => {
    const el = root(
      '<details><summary>needle summary</summary><p>needle body</p></details>' +
        '<details open><summary>x</summary><p>needle open</p></details>'
    )
    const ranges = collectMatchRanges(el, 'needle')
    // The collapsed body is skipped; its summary + the open details' body still match.
    expect(ranges.map((r) => r.startContainer.parentElement?.textContent)).toEqual([
      'needle summary',
      'needle open'
    ])
  })
})

describe('scrollRangeIntoView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [false, 'smooth'],
    [true, 'auto']
  ])('centres the match, reduced motion %s scrolls with %s', (reduce, behavior) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query }))
    const el = root('<p>find me</p>')
    const p = el.querySelector('p')!
    const scrollIntoView = vi.fn()
    p.scrollIntoView = scrollIntoView
    scrollRangeIntoView(collectMatchRanges(el, 'me')[0])
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior })
  })
})

describe('collectMatchRangesAcross', () => {
  it('concatenates matches from every root in root order', () => {
    const a = root('<p>hit and hit</p>')
    const b = root('<p>hit</p>')
    expect(collectMatchRangesAcross([a, b], 'hit')).toHaveLength(3)
  })

  it('returns nothing for no roots or empty query', () => {
    const a = root('<p>hit</p>')
    expect(collectMatchRangesAcross([], 'hit')).toHaveLength(0)
    expect(collectMatchRangesAcross([a], '')).toHaveLength(0)
  })
})

describe('findMatches', () => {
  const el = (text: string): HTMLElement => {
    const d = document.createElement('div')
    d.textContent = text
    return d
  }

  it('stops at the cap and reports that there were more', () => {
    const { ranges, capped } = findMatches([el('ab '.repeat(MAX_FIND_MATCHES + 10))], 'ab')
    expect(ranges).toHaveLength(MAX_FIND_MATCHES)
    expect(capped).toBe(true)
  })

  it('does not report more when there are exactly as many as the cap', () => {
    const { ranges, capped } = findMatches([el('ab '.repeat(MAX_FIND_MATCHES))], 'ab')
    expect(ranges).toHaveLength(MAX_FIND_MATCHES)
    expect(capped).toBe(false)
  })

  it('counts the cap across roots, in root order', () => {
    const a = el('ab '.repeat(MAX_FIND_MATCHES - 1))
    const b = el('ab ab ab')
    const { ranges, capped } = findMatches([a, b], 'ab')
    expect(ranges).toHaveLength(MAX_FIND_MATCHES)
    expect(ranges[MAX_FIND_MATCHES - 1].startContainer.parentNode).toBe(b)
    expect(capped).toBe(true)
  })
})
