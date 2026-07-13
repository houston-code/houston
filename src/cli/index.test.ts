import { describe, expect, it } from 'vitest'
import { nodeVersionError, selectRunMode } from './index'

describe('nodeVersionError', () => {
  it('returns null when the runtime is new enough', () => {
    expect(nodeVersionError('v22.0.0')).toBeNull()
    expect(nodeVersionError('v24.3.1')).toBeNull()
    expect(nodeVersionError('v22.22.3')).toBeNull()
  })

  it('reports an actionable error on an older runtime', () => {
    const err = nodeVersionError('v18.19.0')
    expect(err).not.toBeNull()
    expect(err).toContain('Node 22')
    expect(err).toContain('v18.19.0')
  })

  it('honors a custom minimum', () => {
    expect(nodeVersionError('v20.0.0', 22)).toContain('Node 22')
    expect(nodeVersionError('v20.0.0', 20)).toBeNull()
  })

  it('does not block on an unparseable version string', () => {
    expect(nodeVersionError('not-a-version')).toBeNull()
    expect(nodeVersionError('')).toBeNull()
  })
})

describe('selectRunMode', () => {
  const tty = (argv: string[]) => selectRunMode(argv, '/cwd', true)
  const piped = (argv: string[]) => selectRunMode(argv, '/cwd', false)

  it('runs interactive on explicit -i / --interactive / --tui, TTY or not', () => {
    expect(tty(['-i']).kind).toBe('tui')
    expect(piped(['--interactive']).kind).toBe('tui')
    expect(piped(['--tui']).kind).toBe('tui')
  })

  it('runs headless on -p, and -p wins even at a TTY', () => {
    expect(tty(['-p', 'do it']).kind).toBe('headless')
    expect(piped(['-p', 'do it']).kind).toBe('headless')
  })

  it('a bare invocation at a TTY defaults to interactive', () => {
    const mode = tty([])
    expect(mode.kind).toBe('tui')
    // Flags on a bare invocation are still honored in the defaulted interactive mode.
    expect(selectRunMode(['--model=gpt'], '/cwd', true)).toMatchObject({
      kind: 'tui',
      options: { model: 'gpt' }
    })
  })

  it('a bare invocation without a TTY falls to usage (no REPL to hang)', () => {
    expect(piped([]).kind).toBe('usage')
  })

  it('carries the resolved cwd into the interactive options', () => {
    expect(selectRunMode(['--cwd', '/proj'], '/cwd', true)).toMatchObject({
      kind: 'tui',
      options: { cwd: '/proj' }
    })
  })
})
