import { describe, expect, it, vi } from 'vitest'
import { upgradeHint, type InstallMethod } from '../main/install-method'
import type { UpdateCheckResult } from '../main/update-check'
import { runUpdateCommand, upgradeSteps, type UpdateCliDeps } from './update'

const NEWER: UpdateCheckResult = { status: 'newer', update: { latest: '0.13.0', url: 'https://houstoncode.ai/#download', headline: 'Faster.' } }

function harness(method: InstallMethod, result: UpdateCheckResult = NEWER, runCode = 0, version = '0.12.0') {
  const out: string[] = []
  const err: string[] = []
  const run = vi.fn(async () => runCode)
  const deps: UpdateCliDeps = {
    version,
    method,
    hint: upgradeHint(method),
    check: async () => result,
    run,
    out: (s) => void out.push(s),
    err: (s) => void err.push(s)
  }
  return { out, err, run, go: (...args: string[]) => runUpdateCommand(args, deps) }
}

describe('upgradeSteps', () => {
  it('runs exactly the command the notice prints, word for word', () => {
    for (const method of ['npm', 'bun', 'homebrew'] as const) {
      const steps = upgradeSteps(method)!
      expect(steps.map((s) => [s.program, ...s.args].join(' ')).join(' && ')).toBe(upgradeHint(method).fix)
    }
  })

  it('runs nothing for installs a package manager does not own, and never sudo', () => {
    for (const method of ['aur', 'install-script', 'source', 'desktop', 'download'] as const) {
      expect(upgradeSteps(method)).toBeNull()
    }
    for (const method of ['npm', 'bun', 'homebrew'] as const) {
      expect(upgradeSteps(method)!.some((s) => s.program === 'sudo' || s.args.includes('sudo'))).toBe(false)
    }
  })
})

describe('houston update', () => {
  it('prints the upgrade command for this install, and runs nothing without --yes', async () => {
    const h = harness('homebrew')
    expect(await h.go()).toBe(0)
    expect(h.out.join('')).toBe('Houston 0.13.0 is available (you have 0.12.0). Faster.\nUpdate with: brew update && brew upgrade houston\n')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('runs each step with --yes for npm, bun and Homebrew', async () => {
    const h = harness('homebrew')
    expect(await h.go('--yes')).toBe(0)
    expect(h.run.mock.calls).toEqual([[{ program: 'brew', args: ['update'] }], [{ program: 'brew', args: ['upgrade', 'houston'] }]])
    expect(h.out.join('')).toContain('$ brew upgrade houston')
    expect(h.out.join('')).toContain('Updated.')
  })

  it('stops at a failing step with exit 1, pointing away from sudo', async () => {
    const h = harness('npm', NEWER, 243)
    expect(await h.go('--yes')).toBe(1)
    expect(h.err.join('')).toContain('npm exited with 243')
    expect(h.err.join('')).toContain('rather than running it with sudo')
  })

  it('only prints the command for installs it should not upgrade itself, even with --yes', async () => {
    for (const method of ['install-script', 'aur', 'source', 'download'] as const) {
      const h = harness(method)
      expect(await h.go('--yes')).toBe(0)
      expect(h.run).not.toHaveBeenCalled()
      const line = upgradeHint(method).line
      expect(h.out.join('')).toContain(`${line.charAt(0).toUpperCase()}${line.slice(1)}\n`)
      expect(h.out.join('')).toContain('follow the line above')
    }
  })

  it('does nothing when this is already the latest release', async () => {
    const h = harness('npm', { status: 'current', latest: '0.12.0' })
    expect(await h.go('--yes')).toBe(0)
    expect(h.out.join('')).toBe('Houston 0.12.0 is the latest release.\n')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('still offers (and with --yes runs) the upgrade when the feed does not answer', async () => {
    const h = harness('npm', { status: 'unknown' })
    expect(await h.go()).toBe(0)
    expect(h.out.join('')).toContain("Couldn't reach the release feed")
    expect(h.out.join('')).toContain('npm i -g @houston-code/cli@latest')
    const yes = harness('npm', { status: 'unknown' })
    expect(await yes.go('--yes')).toBe(0)
    expect(yes.run).toHaveBeenCalledTimes(1)
  })

  it('says a development build has nothing to compare', async () => {
    const h = harness('source', { status: 'unknown' }, 0, 'dev')
    await h.go()
    expect(h.out.join('')).toContain('development build')
    expect(h.out.join('')).toContain('git pull && npm run build:cli')
  })

  it('rejects anything but --yes with exit 2', async () => {
    const h = harness('npm')
    expect(await h.go('-y')).toBe(2)
    expect(await h.go('now')).toBe(2)
    expect(h.err.join('')).toContain('update takes no argument "now"')
  })

  it('reports a program that cannot start as exit 1', async () => {
    const h = harness('bun')
    h.run.mockRejectedValueOnce(new Error('spawn bun ENOENT'))
    expect(await h.go('--yes')).toBe(1)
    expect(h.err.join('')).toContain("couldn't run bun: spawn bun ENOENT")
  })
})
