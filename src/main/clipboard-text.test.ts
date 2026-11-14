import { describe, it, expect } from 'vitest'
import { clipboardTextWriter, writeClipboardText } from './clipboard-text'

describe('clipboardTextWriter', () => {
  it('uses the platform helper on a local session', () => {
    expect(clipboardTextWriter('darwin', {})?.cmd).toBe('pbcopy')
    expect(clipboardTextWriter('win32', {})?.cmd).toBe('clip.exe')
  })

  it('prefers wl-copy on Wayland, xclip on X11, and nothing without a display', () => {
    expect(clipboardTextWriter('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })?.cmd).toBe('wl-copy')
    expect(clipboardTextWriter('linux', { DISPLAY: ':0' })).toEqual({ cmd: 'xclip', args: ['-selection', 'clipboard', '-in'] })
    expect(clipboardTextWriter('linux', {})).toBeNull()
  })

  // A helper on the far side of SSH would fill the remote machine's clipboard.
  it('uses no helper over SSH', () => {
    expect(clipboardTextWriter('darwin', { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' })).toBeNull()
    expect(clipboardTextWriter('linux', { SSH_TTY: '/dev/pts/1', DISPLAY: ':0' })).toBeNull()
  })

  it('has nothing for other platforms', () => {
    expect(clipboardTextWriter('freebsd' as NodeJS.Platform, {})).toBeNull()
  })
})

describe('writeClipboardText', () => {
  it('reports false, without throwing, when there is no helper to use', () => {
    expect(writeClipboardText('x', 'linux', {})).toBe(false)
    expect(writeClipboardText('x', 'darwin', { SSH_CLIENT: '1 2 3' })).toBe(false)
  })
})
