import type { AttentionSound } from '@shared/notify'

/**
 * The attention sounds, synthesized with WebAudio rather than shipped as audio
 * files: two short, quiet sine notes each, so there is no asset to license or load.
 * "done" rises (a turn ended); "input" repeats one note (something is waiting on you).
 */

/** One note: frequency in Hz, start offset and length in seconds. */
export interface Note {
  freq: number
  at: number
  dur: number
}

export const SOUND_NOTES: Record<AttentionSound, Note[]> = {
  // C6 then G6: a soft rising "finished".
  done: [
    { freq: 1046.5, at: 0, dur: 0.12 },
    { freq: 1568, at: 0.11, dur: 0.18 }
  ],
  // A5 twice: a gentle "your turn" knock.
  input: [
    { freq: 880, at: 0, dur: 0.1 },
    { freq: 880, at: 0.16, dur: 0.14 }
  ]
}

/** Peak loudness, well under full scale so it never startles. */
const PEAK_GAIN = 0.12

/** Sounds closer together than this are one sound (a batch of approvals, say). */
export const MIN_GAP_MS = 1500

let ctx: AudioContext | null = null
let lastAt = -Infinity

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  return ctx
}

/**
 * Play an attention sound. Quietly does nothing where audio is unavailable, and
 * collapses sounds that arrive within {@link MIN_GAP_MS} of the last one into it.
 * Returns whether it played.
 */
export function playAttentionSound(sound: AttentionSound, now = Date.now()): boolean {
  if (now - lastAt < MIN_GAP_MS) return false
  const ac = audioContext()
  if (!ac) return false
  lastAt = now
  if (ac.state === 'suspended') void ac.resume().catch(() => {})
  const t0 = ac.currentTime + 0.01
  for (const n of SOUND_NOTES[sound]) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(n.freq, t0 + n.at)
    // A fast attack and an exponential release: no click at either end.
    gain.gain.setValueAtTime(0.0001, t0 + n.at)
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t0 + n.at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(t0 + n.at)
    osc.stop(t0 + n.at + n.dur + 0.02)
  }
  return true
}

/** Test seam: forget the shared context and the last play time. */
export function resetAttentionSoundForTest(): void {
  ctx = null
  lastAt = -Infinity
}
