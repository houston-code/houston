import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PreviewServer } from '@shared/preview'
import { chatToAutoOpen, useAutoOpenPreview } from './useAutoOpenPreview'

const server = (id: string, over: Partial<PreviewServer> = {}): PreviewServer => ({
  id,
  command: 'npm run dev',
  running: true,
  url: 'http://localhost:5173',
  conversationId: 'c1',
  ...over
})

describe('chatToAutoOpen', () => {
  it("opens the open chat's Preview once, for its first server with a URL", () => {
    const seen = new Set<string>()
    const opened = new Set<string>()
    expect(chatToAutoOpen([server('s1', { url: undefined })], 'c1', seen, opened)).toBeNull()
    expect(chatToAutoOpen([server('s1')], 'c1', seen, opened)).toBe('c1')
    // A second server in the same chat doesn't open it again.
    expect(chatToAutoOpen([server('s1'), server('s2')], 'c1', seen, opened)).toBeNull()
  })

  it("ignores another chat's servers, exited ones, and no open chat", () => {
    const seen = new Set<string>()
    const opened = new Set<string>()
    expect(chatToAutoOpen([server('s1', { conversationId: 'c2' })], 'c1', seen, opened)).toBeNull()
    expect(chatToAutoOpen([server('s2', { running: false })], 'c1', seen, opened)).toBeNull()
    expect(chatToAutoOpen([server('s3')], null, seen, opened)).toBeNull()
    // s3 was seen with no chat open, so switching to c1 later doesn't count it as new.
    expect(chatToAutoOpen([server('s3')], 'c1', seen, opened)).toBeNull()
  })
})

describe('useAutoOpenPreview', () => {
  it('skips servers already running when the window loads, then opens for a new one', () => {
    const open = vi.fn()
    const { rerender } = renderHook(({ list }) => useAutoOpenPreview(list, 'c1', true, open), {
      initialProps: { list: [server('old')] }
    })
    rerender({ list: [server('old')] })
    expect(open).not.toHaveBeenCalled()
    rerender({ list: [server('old'), server('new')] })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does nothing when turned off, and stays done for that chat', () => {
    const open = vi.fn()
    const { rerender } = renderHook(({ list, on }) => useAutoOpenPreview(list, 'c1', on, open), {
      initialProps: { list: [] as PreviewServer[], on: false }
    })
    rerender({ list: [server('a')], on: false })
    rerender({ list: [server('a'), server('b')], on: true })
    expect(open).not.toHaveBeenCalled()
  })
})
