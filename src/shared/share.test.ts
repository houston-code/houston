import { describe, expect, it } from 'vitest'
import { SHARE_MESSAGE, SHARE_URL, shareEmailUrl } from './share'

describe('share invite', () => {
  it('links the plain site URL, with no tracking parameters', () => {
    expect(SHARE_URL).toBe('https://houstoncode.ai')
    expect(SHARE_MESSAGE).toContain(SHARE_URL)
    expect(SHARE_MESSAGE).not.toMatch(/[?&](ref|utm_)/)
  })

  it('keeps customer-facing copy free of em dashes', () => {
    expect(SHARE_MESSAGE).not.toContain('—')
  })

  it('builds a mailto link with the invite encoded into the body', () => {
    const url = new URL(shareEmailUrl())
    expect(url.protocol).toBe('mailto:')
    expect(url.searchParams.get('subject')).toBe('Try Houston')
    expect(url.searchParams.get('body')).toBe(SHARE_MESSAGE)
  })
})
