import { describe, expect, it } from 'vitest'
import { MAX_MOCKUP_VARIANTS, parseMockupArgs, parseMockupArgsSafe, parseVariantList, parseVariantListSafe } from './mockup'

describe('parseMockupArgs', () => {
  it('defaults to one desktop, light render', () => {
    expect(parseMockupArgs({ file: 'mockups/settings.html' })).toEqual({
      file: 'mockups/settings.html',
      variants: [{ label: 'Desktop, light', width: 1280, height: 800, colorScheme: 'light', mobile: false, fullPage: false }]
    })
  })

  it('expands preset strings, with and without a color scheme', () => {
    const { variants } = parseMockupArgs({ file: 'a.html', variants: ['mobile-dark', 'Tablet', 'desktop-light'] })
    expect(variants.map((v) => [v.label, v.width, v.height, v.colorScheme, v.mobile])).toEqual([
      ['Mobile, dark', 390, 844, 'dark', true],
      ['Tablet, light', 768, 1024, 'light', true],
      ['Desktop, light', 1280, 800, 'light', false]
    ])
  })

  it('takes objects with a preset, custom size, query, label, and full page', () => {
    const { variants } = parseMockupArgs({
      file: 'a.htm',
      fullPage: true,
      variants: [
        { preset: 'mobile', colorScheme: 'dark', query: '?state=empty' },
        { width: 1440, height: 900, label: '  Wide   empty ', fullPage: false },
        { width: 1024 }
      ]
    })
    expect(variants[0]).toEqual({
      label: 'Mobile, dark ?state=empty',
      width: 390,
      height: 844,
      colorScheme: 'dark',
      mobile: true,
      fullPage: true,
      query: '?state=empty'
    })
    expect(variants[1]).toMatchObject({ label: 'Wide empty', width: 1440, height: 900, fullPage: false, mobile: false })
    expect(variants[2]).toMatchObject({ label: '1024×800, light', width: 1024, height: 800 })
  })

  it('rejects what it cannot render, with messages the model can act on', () => {
    expect(() => parseMockupArgs({})).toThrow('file must be a non-empty string')
    expect(() => parseMockupArgs({ file: 'shot.png' })).toThrow('.html or .htm')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [] })).toThrow('non-empty array')
    expect(() => parseMockupArgs({ file: 'a.html', variants: ['watch'] })).toThrow('variants[0] must be a preset')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ preset: 'tv' }] })).toThrow('variants[0].preset')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ width: 50 }] })).toThrow('from 200 to 2560')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ height: 1.5 }] })).toThrow('whole number')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ colorScheme: 'sepia' }] })).toThrow('"light" or "dark"')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ query: 'state=x' }] })).toThrow('start with "?" or "#"')
    expect(() => parseMockupArgs({ file: 'a.html', variants: [{ query: '?a b' }] })).toThrow('no spaces')
    expect(() => parseMockupArgs({ file: 'a.html', fullPage: 'yes' })).toThrow('fullPage must be true or false')
  })

  it('caps the number of variants per call', () => {
    const variants = Array.from({ length: MAX_MOCKUP_VARIANTS + 1 }, () => 'desktop')
    expect(() => parseMockupArgs({ file: 'a.html', variants })).toThrow(`at most ${MAX_MOCKUP_VARIANTS}`)
  })

  it('has a safe variant for display code', () => {
    expect(parseMockupArgsSafe(undefined)).toBeNull()
    expect(parseMockupArgsSafe({ file: 'x.png' })).toBeNull()
    expect(parseMockupArgsSafe({ file: 'x.html' })?.variants).toHaveLength(1)
  })
})

describe('parseVariantList', () => {
  it('refuses a per-variant query where the URL carries its own', () => {
    expect(() => parseVariantList([{ query: '?a' }], { fullPage: false, allowQuery: false })).toThrow('put it in the URL')
    expect(parseVariantList([{ query: '?a' }], { fullPage: false, allowQuery: true })[0].query).toBe('?a')
  })

  it('applies the full-page default to every variant that does not set it', () => {
    const vs = parseVariantList(['desktop', { preset: 'mobile', fullPage: false }], { fullPage: true, allowQuery: false })
    expect(vs.map((v) => v.fullPage)).toEqual([true, false])
  })

  it('has a safe variant that treats a missing list as none', () => {
    expect(parseVariantListSafe(undefined, { fullPage: false, allowQuery: false })).toBeNull()
    expect(parseVariantListSafe(['tv'], { fullPage: false, allowQuery: false })).toBeNull()
    expect(parseVariantListSafe(['mobile'], { fullPage: false, allowQuery: false })).toHaveLength(1)
  })
})
