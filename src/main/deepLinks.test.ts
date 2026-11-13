import { describe, expect, it, vi } from 'vitest'
import { folderDeepLink } from '@shared/deepLink'
import { createDeepLinkRouter, type DeepLinkDeps } from './deepLinks'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

function deps(over: Partial<DeepLinkDeps> = {}): DeepLinkDeps & { [K in keyof DeepLinkDeps]: DeepLinkDeps[K] } {
  return {
    focusWindow: vi.fn(),
    openFolder: vi.fn(),
    openChat: vi.fn(),
    openSettings: vi.fn(),
    resolveDirectory: vi.fn((p: string) => (p.startsWith('/exists') ? p.replace('/exists', '/real') : null)),
    isKnownFolder: vi.fn(() => false),
    conversationExists: vi.fn(() => true),
    confirmFolder: vi.fn(async () => true),
    warn: vi.fn(),
    log: vi.fn(),
    ...over
  }
}

describe('deep link router', () => {
  it('holds links until the window is ready, then delivers them in order', async () => {
    const d = deps({ isKnownFolder: () => true })
    const r = createDeepLinkRouter(d)
    await r.handle('houston://settings/tools')
    await r.handle(folderDeepLink('/exists/a'))
    expect(d.openSettings).not.toHaveBeenCalled()
    expect(d.focusWindow).toHaveBeenCalled()
    await r.markReady()
    expect(d.openSettings).toHaveBeenCalledWith('tools')
    expect(d.openFolder).toHaveBeenCalledWith('/real/a')
    expect((d.openSettings as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (d.openFolder as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    )
  })

  it('acts at once when ready, and holds again after the window goes away', async () => {
    const d = deps()
    const r = createDeepLinkRouter(d)
    await r.markReady()
    await r.handle(`houston://chat/${ID}`)
    expect(d.openChat).toHaveBeenCalledWith(ID)
    r.markNotReady()
    await r.handle('houston://settings')
    expect(d.openSettings).not.toHaveBeenCalled()
    await r.markReady()
    expect(d.openSettings).toHaveBeenCalledWith(undefined)
  })

  it('opens a known folder without asking', async () => {
    const d = deps({ isKnownFolder: () => true })
    const r = createDeepLinkRouter(d)
    await r.markReady()
    await r.handle(folderDeepLink('/exists/known'))
    expect(d.confirmFolder).not.toHaveBeenCalled()
    expect(d.openFolder).toHaveBeenCalledWith('/real/known')
  })

  it('asks before opening a folder it has not seen, checking the canonical path', async () => {
    const d = deps({ confirmFolder: vi.fn(async () => false) })
    const r = createDeepLinkRouter(d)
    await r.markReady()
    await r.handle(folderDeepLink('/exists/new'))
    expect(d.isKnownFolder).toHaveBeenCalledWith('/real/new')
    expect(d.confirmFolder).toHaveBeenCalledWith('/real/new')
    expect(d.openFolder).not.toHaveBeenCalled()
  })

  it('warns instead of opening a missing folder or chat', async () => {
    const d = deps({ conversationExists: () => false })
    const r = createDeepLinkRouter(d)
    await r.markReady()
    await r.handle(folderDeepLink('/gone'))
    await r.handle(`houston://chat/${ID}`)
    expect(d.warn).toHaveBeenCalledWith('That folder no longer exists.', '/gone')
    expect(d.warn).toHaveBeenCalledWith('That chat no longer exists.')
    expect(d.openFolder).not.toHaveBeenCalled()
    expect(d.openChat).not.toHaveBeenCalled()
  })

  it('ignores unsupported links without logging their contents', async () => {
    const d = deps()
    const r = createDeepLinkRouter(d)
    await r.markReady()
    await r.handle('houston://run?prompt=delete%20everything')
    expect(d.openFolder).not.toHaveBeenCalled()
    expect(d.openChat).not.toHaveBeenCalled()
    expect(d.openSettings).not.toHaveBeenCalled()
    const logged = (d.log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')
    expect(logged).not.toContain('delete')
  })

  it('keeps only the most recent links while the window loads', async () => {
    const d = deps()
    const r = createDeepLinkRouter(d)
    for (let i = 0; i < 20; i++) await r.handle('houston://settings')
    await r.markReady()
    expect(d.openSettings).toHaveBeenCalledTimes(8)
  })
})
