import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_GAP_MS, SOUND_NOTES, playAttentionSound, resetAttentionSoundForTest } from './attentionSound'

/** A recording stand-in for the WebAudio graph. */
function installAudio() {
  const started: number[] = []
  const freqs: number[] = []
  class FakeContext {
    currentTime = 0
    state = 'running'
    destination = {}
    resume = vi.fn(() => Promise.resolve())
    createOscillator() {
      return {
        type: '',
        frequency: { setValueAtTime: (f: number) => freqs.push(f) },
        connect: () => {},
        start: (t: number) => started.push(t),
        stop: () => {}
      }
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {}
      }
    }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  return { started, freqs }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetAttentionSoundForTest()
})

describe('playAttentionSound', () => {
  it("plays each sound's notes", () => {
    const a = installAudio()
    expect(playAttentionSound('done', 10_000)).toBe(true)
    expect(a.freqs).toEqual(SOUND_NOTES.done.map((n) => n.freq))
    expect(a.started).toHaveLength(SOUND_NOTES.done.length)
  })

  it('folds sounds that arrive close together into one', () => {
    const a = installAudio()
    expect(playAttentionSound('input', 10_000)).toBe(true)
    expect(playAttentionSound('input', 10_000 + MIN_GAP_MS - 1)).toBe(false)
    expect(playAttentionSound('done', 10_000 + MIN_GAP_MS)).toBe(true)
    expect(a.started).toHaveLength(SOUND_NOTES.input.length + SOUND_NOTES.done.length)
  })

  it('does nothing where WebAudio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(playAttentionSound('done', 10_000)).toBe(false)
  })

  it('keeps both sounds short and quiet enough not to startle', () => {
    for (const notes of Object.values(SOUND_NOTES)) {
      const end = Math.max(...notes.map((n) => n.at + n.dur))
      expect(end).toBeLessThan(0.5)
    }
  })
})
