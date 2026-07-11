import { describe, expect, it, vi } from 'vitest'
import type { SandboxRunResult } from '../sandbox'
import {
  DEFAULT_VERIFY_MAX_PASSES,
  resolveVerifyMaxPasses,
  runVerification,
  shouldVerify,
  verifyFailureMessage,
  type VerifyGateState
} from './verify-gate'

const state = (over: Partial<VerifyGateState> = {}): VerifyGateState => ({
  enabled: true,
  command: 'npm run typecheck',
  filesModified: true,
  passesRun: 0,
  maxPasses: 1,
  policy: 'auto-edit',
  ...over
})

describe('shouldVerify', () => {
  it('runs when enabled, configured, files changed, and budget remains', () => {
    expect(shouldVerify(state())).toBe(true)
  })
  it('is inert when disabled', () => {
    expect(shouldVerify(state({ enabled: false }))).toBe(false)
  })
  it('is inert with no configured command (never runs an unset command)', () => {
    expect(shouldVerify(state({ command: undefined }))).toBe(false)
    expect(shouldVerify(state({ command: '   ' }))).toBe(false)
  })
  it('skips when no files were modified', () => {
    expect(shouldVerify(state({ filesModified: false }))).toBe(false)
  })
  it('stops once the bounded pass budget is spent', () => {
    expect(shouldVerify(state({ passesRun: 1, maxPasses: 1 }))).toBe(false)
    expect(shouldVerify(state({ passesRun: 2, maxPasses: 2 }))).toBe(false)
  })
  it('never runs in Plan mode — Plan runs nothing, even after a prior edit', () => {
    expect(shouldVerify(state({ policy: 'plan' }))).toBe(false)
  })
})

describe('resolveVerifyMaxPasses', () => {
  it('defaults for invalid input and clamps to [1,3]', () => {
    expect(resolveVerifyMaxPasses()).toBe(DEFAULT_VERIFY_MAX_PASSES)
    expect(resolveVerifyMaxPasses(0)).toBe(1)
    expect(resolveVerifyMaxPasses(2)).toBe(2)
    expect(resolveVerifyMaxPasses(99)).toBe(3)
    expect(resolveVerifyMaxPasses(Number.NaN)).toBe(DEFAULT_VERIFY_MAX_PASSES)
  })
})

describe('verifyFailureMessage', () => {
  it('embeds the command and output and asks the model to fix', () => {
    const msg = verifyFailureMessage('npm test', 'FAIL src/x.test.ts')
    expect(msg).toContain('npm test')
    expect(msg).toContain('FAIL src/x.test.ts')
    expect(msg).toMatch(/fix the problems/i)
  })
})

const result = (over: Partial<SandboxRunResult> = {}): SandboxRunResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  sandboxed: true,
  ...over
})

describe('runVerification', () => {
  it('reports passed on exit 0', async () => {
    const run = vi.fn(async () => result({ stdout: 'ok', exitCode: 0 }))
    const r = await runVerification({
      command: 'npm run typecheck',
      workspace: '/ws',
      allowNetwork: false,
      run
    })
    expect(r.passed).toBe(true)
    expect(r.aborted).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    // Runs in the workspace with the given network posture.
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/ws', workspace: '/ws', allowNetwork: false })
    )
  })

  it('reports failed on a non-zero exit and surfaces combined output', async () => {
    const run = vi.fn(async () =>
      result({ stdout: 'building', stderr: 'TS2322: type error', exitCode: 2 })
    )
    const r = await runVerification({ command: 'x', workspace: '/ws', allowNetwork: false, run })
    expect(r.passed).toBe(false)
    expect(r.output).toContain('TS2322: type error')
    expect(r.output).toContain('building')
  })

  it('treats a timeout as a failure and notes it', async () => {
    const run = vi.fn(async () => result({ exitCode: null, timedOut: true }))
    const r = await runVerification({ command: 'x', workspace: '/ws', allowNetwork: false, run })
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/timed out/i)
  })

  it('reports aborted when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const run = vi.fn(async () => result())
    const r = await runVerification({
      command: 'x',
      workspace: '/ws',
      allowNetwork: false,
      signal: ac.signal,
      run
    })
    expect(r.aborted).toBe(true)
    expect(r.passed).toBe(false)
  })

  it('never throws when the runner throws — surfaces as a failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn ENOENT')
    })
    const r = await runVerification({ command: 'x', workspace: '/ws', allowNetwork: false, run })
    expect(r.passed).toBe(false)
    expect(r.aborted).toBe(false)
    expect(r.output).toMatch(/spawn ENOENT/)
  })
})
