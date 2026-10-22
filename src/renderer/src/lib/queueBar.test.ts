import { describe, expect, it } from 'vitest'
import type { QueuedInputMeta } from '@shared/queue'
import { queueBarLabel } from './queueBar'

const q = (text: string, steer = false): QueuedInputMeta => ({ id: text, text, imageCount: 0, ...(steer ? { steer } : {}) })

describe('queueBarLabel', () => {
  it('counts follow-ups waiting for the run to end', () => {
    expect(queueBarLabel([q('a'), q('b')], true)).toBe('2 queued · sent when this run finishes')
  })

  // A steer shows here until it lands, so it can't look like it vanished.
  it('counts steers waiting for the next step apart from follow-ups', () => {
    expect(queueBarLabel([q('a', true)], true)).toBe('1 steering · the agent reads it before its next step')
    expect(queueBarLabel([q('a', true), q('b', true)], true)).toBe(
      '2 steering · the agent reads them before its next step'
    )
    expect(queueBarLabel([q('a', true), q('b')], true)).toBe(
      '1 steering, 1 queued · steers land before the next step, the rest after this run'
    )
  })

  it('offers to send or clear what a stopped run left behind', () => {
    expect(queueBarLabel([q('a'), q('b')], false)).toBe('2 queued · the run stopped: send them now or clear them')
  })
})
