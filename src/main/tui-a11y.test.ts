import { describe, it, expect } from 'vitest'
import { envFlag, resolveAccessibility } from './tui-a11y'

describe('envFlag', () => {
  it('reads the usual truthy spellings, any case', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) expect(envFlag(v)).toBe(true)
  })
  it('treats anything else, unset included, as off', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) expect(envFlag(v)).toBe(false)
  })
})

describe('resolveAccessibility', () => {
  it('turns reduced motion on from the env var or the setting', () => {
    expect(resolveAccessibility({}, {}).reduceMotion).toBe(false)
    expect(resolveAccessibility({ HOUSTON_REDUCE_MOTION: '1' }, {}).reduceMotion).toBe(true)
    expect(resolveAccessibility({}, { reduceMotion: true }).reduceMotion).toBe(true)
    expect(resolveAccessibility({ HOUSTON_REDUCE_MOTION: '0' }, { reduceMotion: false }).reduceMotion).toBe(false)
  })
})
