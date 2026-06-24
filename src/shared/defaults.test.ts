import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHELL_OUTPUT_MAX_BYTES,
  defaultSettings,
  resolveShellOutputBudget
} from './defaults'

describe('resolveShellOutputBudget', () => {
  it('uses the default when unset', () => {
    expect(resolveShellOutputBudget({})).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })

  it('honours a positive override', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 8000 })).toBe(8000)
  })

  it('floors a fractional override', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 8000.9 })).toBe(8000)
  })

  it('falls back to the default for 0 or negative (which would truncate everything)', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 0 })).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: -5 })).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })
})

describe('defaultSettings', () => {
  it('seeds the shell-output budget', () => {
    expect(defaultSettings().shellOutputMaxBytes).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })
})
