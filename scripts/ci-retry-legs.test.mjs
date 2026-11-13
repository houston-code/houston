import { describe, it, expect } from 'vitest'
import { decide, neverStarted, outputs } from './ci-retry-legs.mjs'
import { LEGS } from './ci-plan.mjs'

const done = (name, conclusion, extra = {}) => ({
  name,
  status: 'completed',
  conclusion,
  runner_id: 12,
  runner_name: 'GitHub Actions 12',
  steps: [{ name: 'Set up job', conclusion: 'success' }],
  ...extra
})
const ok = (target) => done(`package (${target})`, 'success')
/** What the API returned for the macOS leg GitHub gave up on: cancelled, no runner, no steps. */
const unacquired = (target) => done(`package (${target})`, 'cancelled', { runner_id: 0, runner_name: '', steps: [] })

describe('ci-retry-legs neverStarted', () => {
  it('is true only for a cancelled job with no runner and no steps', () => {
    expect(neverStarted(unacquired('mac-arm64'))).toBe(true)
    expect(neverStarted({ conclusion: 'cancelled', runner_id: null, runner_name: null })).toBe(true)
    expect(neverStarted(done('package (mac-arm64)', 'cancelled'))).toBe(false)
    expect(neverStarted(done('package (mac-arm64)', 'cancelled', { steps: [] }))).toBe(false)
    expect(neverStarted(done('package (mac-arm64)', 'cancelled', { runner_id: 0, runner_name: '' }))).toBe(false)
    expect(neverStarted(done('package (mac-arm64)', 'failure', { runner_id: 0, runner_name: '', steps: [] }))).toBe(false)
  })
})

describe('ci-retry-legs decide', () => {
  it('retries the one leg that never got a runner', () => {
    const jobs = [done('test', 'success'), ok('linux-x64'), unacquired('mac-arm64'), ok('win-x64'), done('build', 'failure')]
    expect(decide(jobs).legs).toEqual(['mac-arm64'])
  })

  it('retries every leg that never got a runner', () => {
    expect(decide([ok('linux-x64'), unacquired('mac-arm64'), unacquired('mac-x64'), ok('win-x64')]).legs).toEqual([
      'mac-arm64',
      'mac-x64'
    ])
  })

  it('retries nothing when a leg that did start failed, even beside one that never started', () => {
    const verdict = decide([ok('linux-x64'), unacquired('mac-arm64'), done('package (win-x64)', 'failure')])
    expect(verdict.legs).toEqual([])
    expect(verdict.reason).toContain('win-x64 (failure)')
  })

  it('retries nothing when a leg was cancelled after it started', () => {
    expect(decide([ok('linux-x64'), done('package (mac-arm64)', 'cancelled')]).legs).toEqual([])
  })

  it('retries nothing when a leg timed out', () => {
    expect(decide([ok('linux-x64'), done('package (mac-arm64)', 'timed_out')]).legs).toEqual([])
  })

  it('retries nothing when every leg succeeded, or the run has none', () => {
    expect(decide([ok('linux-x64'), ok('mac-arm64')]).legs).toEqual([])
    expect(decide([done('test', 'success')]).legs).toEqual([])
    expect(decide([]).legs).toEqual([])
    expect(decide(undefined).legs).toEqual([])
  })

  it('retries nothing while a leg is still running', () => {
    const running = { name: 'package (win-x64)', status: 'in_progress', conclusion: null }
    expect(decide([unacquired('mac-arm64'), running]).legs).toEqual([])
  })

  it('never retries a retry, or a job that is not a package leg', () => {
    const retry = done('package-retry (mac-arm64)', 'cancelled', { runner_id: 0, runner_name: '', steps: [] })
    const other = done('warm-caches (mac-arm64)', 'cancelled', { runner_id: 0, runner_name: '', steps: [] })
    expect(decide([ok('linux-x64'), retry, other]).legs).toEqual([])
  })

  it('retries nothing for a leg the plan does not know', () => {
    expect(decide([unacquired('mac-arm64'), unacquired('solaris-sparc')]).legs).toEqual([])
    expect(decide([unacquired('constructor')]).legs).toEqual([])
  })
})

describe('ci-retry-legs outputs', () => {
  it('emits the retry flag and the same matrix entries the plan uses', () => {
    expect(outputs({ legs: ['mac-arm64'] })).toBe(
      `retry=true\nmatrix=${JSON.stringify({ include: [LEGS['mac-arm64']] })}`
    )
    expect(outputs({ legs: [] })).toBe('retry=false\nmatrix={"include":[]}')
  })
})
