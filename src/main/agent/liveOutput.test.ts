import { describe, expect, it, vi } from 'vitest'
import { createLiveOutput, KEEP_CHARS, liveTail, SHOWN_CHARS, SHOWN_LINES, THROTTLE_MS } from './liveOutput'

/** A hand-driven clock. */
function fakeClock() {
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  return {
    clock: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn }
        timers.push(t)
        return t
      },
      clearTimer: (t: unknown) => {
        const i = timers.indexOf(t as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      }
    },
    advance(ms: number) {
      now += ms
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    }
  }
}

describe('liveTail', () => {
  it('keeps short output whole', () => {
    expect(liveTail('a\nb\n')).toBe('a\nb\n')
  })
  it('keeps the last lines, and cuts a long buffer where a line starts', () => {
    const many = Array.from({ length: SHOWN_LINES + 50 }, (_, i) => `line ${i}`).join('\n')
    const tail = liveTail(many)
    expect(tail.split('\n')).toHaveLength(SHOWN_LINES)
    expect(tail.endsWith(`line ${SHOWN_LINES + 49}`)).toBe(true)
    const wide = 'x'.repeat(SHOWN_CHARS) + '\nlast'
    expect(liveTail(`head\n${wide}`).length).toBeLessThanOrEqual(SHOWN_CHARS)
  })
})

describe('createLiveOutput', () => {
  it('sends the first chunk at once, then at most one update per interval', () => {
    const f = fakeClock()
    const send = vi.fn()
    const sink = createLiveOutput(send, (t) => t, f.clock)
    sink.push('a')
    expect(send).toHaveBeenLastCalledWith('a')
    sink.push('b')
    sink.push('c')
    expect(send).toHaveBeenCalledTimes(1)
    f.advance(THROTTLE_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('abc')
  })

  it('redacts the kept buffer whole, so a secret split across chunks is caught', () => {
    const f = fakeClock()
    const send = vi.fn()
    const redact = (t: string): string => t.replaceAll('hunter2-secret', '[redacted]')
    const sink = createLiveOutput(send, redact, f.clock)
    sink.push('pw=hunter2')
    f.advance(THROTTLE_MS)
    sink.push('-secret\n')
    f.advance(THROTTLE_MS)
    expect(send).toHaveBeenLastCalledWith('pw=[redacted]\n')
    for (const [arg] of send.mock.calls.slice(1)) expect(arg).not.toContain('hunter2-secret')
  })

  it('keeps memory bounded however much is printed', () => {
    const f = fakeClock()
    const sent: string[] = []
    let longest = 0
    const sink = createLiveOutput((t) => sent.push(t), (t) => {
      longest = Math.max(longest, t.length)
      return t
    }, f.clock)
    for (let i = 0; i < 2000; i++) {
      sink.push(`${'y'.repeat(100)}\n`)
      f.advance(THROTTLE_MS)
    }
    expect(longest).toBeLessThanOrEqual(KEEP_CHARS)
    expect(Math.max(...sent.map((s) => s.length))).toBeLessThanOrEqual(SHOWN_CHARS)
  })

  it('sends nothing after close, even an update that was waiting', () => {
    const f = fakeClock()
    const send = vi.fn()
    const sink = createLiveOutput(send, (t) => t, f.clock)
    sink.push('a')
    sink.push('b')
    sink.close()
    f.advance(THROTTLE_MS * 2)
    sink.push('c')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('never lets a failing send reach the command', () => {
    const sink = createLiveOutput(() => {
      throw new Error('window gone')
    }, (t) => t, fakeClock().clock)
    expect(() => sink.push('a')).not.toThrow()
  })
})
