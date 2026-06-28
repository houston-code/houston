import { describe, it, expect, vi, beforeEach } from 'vitest'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('./logger', () => ({ log: { warn: vi.fn() } }))

import { isSafeExternalUrl, openExternalSafely } from './safeExternal'

beforeEach(() => openExternal.mockClear())

describe('isSafeExternalUrl', () => {
  it('allows web and mail schemes', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('https://example.com/x?y=1#z')).toBe(true)
    expect(isSafeExternalUrl('mailto:foo@bar.com')).toBe(true)
  })

  it('rejects dangerous / non-web schemes that openExternal would otherwise launch', () => {
    for (const u of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'smb://host/share',
      'vscode://file/etc/passwd',
      'data:text/html,<script>1</script>',
      'about:blank'
    ]) {
      expect(isSafeExternalUrl(u)).toBe(false)
    }
  })

  it('rejects unparseable, relative, and fragment URLs', () => {
    for (const u of ['', 'not a url', '/relative/path', '#anchor', '//evil.com']) {
      expect(isSafeExternalUrl(u)).toBe(false)
    }
  })
})

describe('openExternalSafely', () => {
  it('opens an allowed URL and reports true', () => {
    expect(openExternalSafely('https://example.com')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('drops a disallowed URL without opening it, and reports false', () => {
    expect(openExternalSafely('file:///etc/passwd')).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
