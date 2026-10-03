import { beforeEach, describe, expect, it, vi } from 'vitest'

const popup = vi.fn()
const buildFromTemplate = vi.fn((_t: unknown) => ({ popup }))
const writeText = vi.fn()
const showMessageBox = vi.fn()
const openExternal = vi.fn()

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (t: unknown) => buildFromTemplate(t) },
  clipboard: { writeText: (t: string) => writeText(t) },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...a) },
  shell: { openExternal: (u: string) => openExternal(u) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))
vi.mock('./logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { shareHouston, shareHoustonVia, shareHoustonFromMenu, shareMenuTemplate, usesShareSheet } =
  await import('./share')
const { SHARE_BLURB, SHARE_MESSAGE, SHARE_URL } = await import('@shared/share')

const win = {} as Electron.BrowserWindow

beforeEach(() => {
  vi.clearAllMocks()
})

describe('shareHouston', () => {
  it('uses the native share sheet only on macOS', () => {
    expect(usesShareSheet('darwin')).toBe(true)
    expect(usesShareSheet('win32')).toBe(false)
    expect(usesShareSheet('linux')).toBe(false)
  })

  it('opens the macOS share menu at the given point without touching the clipboard', () => {
    expect(shareHouston(win, { x: 10.4, y: 20.6 }, 'darwin')).toBe('sheet')
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(popup).toHaveBeenCalledWith({ window: win, x: 10, y: 21 })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('leads the macOS menu with Copy invite, then the system share services', () => {
    const [copy, sep, via] = shareMenuTemplate()
    expect(copy.label).toBe('Copy invite')
    ;(copy.click as () => void)()
    expect(writeText).toHaveBeenCalledWith(SHARE_MESSAGE)
    expect(sep.type).toBe('separator')
    expect(via.role).toBe('shareMenu')
    expect(via.sharingItem).toEqual({ texts: [SHARE_BLURB], urls: [SHARE_URL] })
  })

  it('pops the macOS sheet at the cursor when no point is given', () => {
    shareHouston(win, undefined, 'darwin')
    expect(popup).toHaveBeenCalledWith({ window: win })
  })

  it.each(['win32', 'linux'] as const)('copies the invite on %s', (platform) => {
    expect(shareHouston(win, { x: 1, y: 2 }, platform)).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(SHARE_MESSAGE)
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('falls back to copying on macOS when there is no window to anchor the sheet', () => {
    expect(shareHouston(null, undefined, 'darwin')).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(SHARE_MESSAGE)
  })
})

describe('shareHoustonVia', () => {
  it('copies the invite again', () => {
    expect(shareHoustonVia('copy')).toBe(true)
    expect(writeText).toHaveBeenCalledWith(SHARE_MESSAGE)
  })

  it('opens the fixed mailto link', () => {
    expect(shareHoustonVia('email')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^mailto:\?subject=Try%20Houston&body=/))
  })

  it('refuses anything that is not a known target', () => {
    expect(shareHoustonVia('https://evil.example' as never)).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('shareHoustonFromMenu', () => {
  it('confirms the copy and offers email when there is no share sheet', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      showMessageBox.mockResolvedValueOnce({ response: 1 })
      await shareHoustonFromMenu()
      expect(writeText).toHaveBeenCalledWith(SHARE_MESSAGE)
      expect(showMessageBox.mock.calls[0][0].buttons).toEqual(['Done', 'Send by email'])
      expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^mailto:/))

      showMessageBox.mockResolvedValueOnce({ response: 0 })
      openExternal.mockClear()
      await shareHoustonFromMenu()
      expect(openExternal).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
