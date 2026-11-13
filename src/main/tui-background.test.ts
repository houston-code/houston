import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  backgroundFromColorFgBg,
  backgroundFromRgb,
  detectTerminalBackground,
  parseOsc11
} from './tui-background'

describe('backgroundFromColorFgBg', () => {
  it('reads the last field as the background color index', () => {
    expect(backgroundFromColorFgBg('0;15')).toBe('light')
    expect(backgroundFromColorFgBg('0;7')).toBe('light')
    expect(backgroundFromColorFgBg('15;0')).toBe('dark')
    expect(backgroundFromColorFgBg('15;default;0')).toBe('dark')
  })

  it('is null when unset or unreadable', () => {
    expect(backgroundFromColorFgBg(undefined)).toBeNull()
    expect(backgroundFromColorFgBg('')).toBeNull()
    expect(backgroundFromColorFgBg('15;default')).toBeNull()
    expect(backgroundFromColorFgBg('0;200')).toBeNull()
  })
})

describe('parseOsc11', () => {
  it('reads 4, 2 and 1 hex digit replies, ended by BEL or ST', () => {
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff\x07')).toEqual({ r: 1, g: 1, b: 1 })
    expect(parseOsc11('\x1b]11;rgb:00/00/00\x1b\\')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseOsc11('noise\x1b]11;rgb:f/0/f\x07')).toEqual({ r: 1, g: 0, b: 1 })
  })

  it('is null for an incomplete or foreign reply', () => {
    expect(parseOsc11('\x1b]11;rgb:ffff/ffff/ffff')).toBeNull()
    expect(parseOsc11('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBeNull()
    expect(parseOsc11('hello')).toBeNull()
  })
})

describe('backgroundFromRgb', () => {
  it('calls light and dark backgrounds by luminance', () => {
    expect(backgroundFromRgb({ r: 1, g: 1, b: 1 })).toBe('light')
    expect(backgroundFromRgb({ r: 0.98, g: 0.97, b: 0.95 })).toBe('light')
    expect(backgroundFromRgb({ r: 0.04, g: 0.04, b: 0.05 })).toBe('dark')
    expect(backgroundFromRgb({ r: 0.16, g: 0.17, b: 0.2 })).toBe('dark')
  })
})

/** A fake TTY input that answers the query (or doesn't). */
function fakeStreams(answer: string | null) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, on: boolean) {
      input.isRaw = on
    }),
    isPaused: () => true,
    pause: vi.fn()
  })
  const output = {
    isTTY: true,
    write: vi.fn((s: string) => {
      if (answer !== null && s === '\x1b]11;?\x07') setTimeout(() => input.emit('data', Buffer.from(answer)), 1)
      return true
    })
  }
  return { input, output }
}

describe('detectTerminalBackground', () => {
  it('trusts COLORFGBG without querying the terminal', async () => {
    const s = fakeStreams('\x1b]11;rgb:0000/0000/0000\x07')
    expect(await detectTerminalBackground(s, { COLORFGBG: '0;15' })).toBe('light')
    expect(s.output.write).not.toHaveBeenCalled()
  })

  it('asks the terminal, then restores raw mode and the paused state', async () => {
    const s = fakeStreams('\x1b]11;rgb:fafa/f9f9/f6f6\x07')
    expect(await detectTerminalBackground(s, {})).toBe('light')
    expect(s.output.write).toHaveBeenCalledWith('\x1b]11;?\x07')
    expect(s.input.isRaw).toBe(false)
    expect(s.input.pause).toHaveBeenCalled()
    expect(s.input.listenerCount('data')).toBe(0)
  })

  it('gives up quietly when the terminal does not answer', async () => {
    const s = fakeStreams(null)
    expect(await detectTerminalBackground(s, {}, 20)).toBeNull()
    expect(s.input.listenerCount('data')).toBe(0)
    expect(s.input.isRaw).toBe(false)
  })

  it('does not query a non-TTY or a dumb terminal', async () => {
    const s = fakeStreams('\x1b]11;rgb:ffff/ffff/ffff\x07')
    expect(await detectTerminalBackground({ ...s, output: { ...s.output, isTTY: false } }, {})).toBeNull()
    expect(await detectTerminalBackground(s, { TERM: 'dumb' })).toBeNull()
    expect(s.output.write).not.toHaveBeenCalled()
  })
})
