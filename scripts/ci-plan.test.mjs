import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plan, outputs, isProseOnly, touchesAction, touchesCacheInputs, LEGS, FULL_CI_LABEL } from './ci-plan.mjs'

const code = ['src/main/loop.ts']
const prose = ['README.md', 'docs/SANDBOXING.md', 'website/index.html']

describe('ci-plan package legs', () => {
  it('packages only Linux on a plain PR', () => {
    expect(plan({ event: 'pull_request', files: code }).legs).toEqual(['linux-x64'])
  })

  it('runs every leg on a PR labelled full-ci', () => {
    expect(plan({ event: 'pull_request', labels: ['x', FULL_CI_LABEL], files: code }).legs).toEqual([
      'linux-x64',
      'mac-arm64',
      'mac-x64',
      'win-x64'
    ])
  })

  it('runs the native legs on a queue candidate, without Intel', () => {
    expect(plan({ event: 'merge_group', files: code }).legs).toEqual(['linux-x64', 'mac-arm64', 'win-x64'])
  })

  it('runs every leg, Intel included, nightly', () => {
    expect(plan({ event: 'schedule' }).legs).toEqual(['linux-x64', 'mac-arm64', 'mac-x64', 'win-x64'])
  })

  it('skips packaging for prose-only changes on a PR, even with full-ci, and on a queue candidate', () => {
    expect(plan({ event: 'pull_request', labels: [FULL_CI_LABEL], files: prose }).legs).toEqual([])
    expect(plan({ event: 'merge_group', files: prose }).legs).toEqual([])
  })

  it('packages as soon as one changed file is not prose', () => {
    expect(plan({ event: 'merge_group', files: [...prose, ...code] }).legs).toHaveLength(3)
  })

  it('falls back to the full matrix when the diff is unknown or empty', () => {
    expect(plan({ event: 'merge_group', files: null }).legs).toHaveLength(3)
    expect(plan({ event: 'merge_group', files: [] }).legs).toHaveLength(3)
    expect(plan({ event: 'pull_request', files: null }).legs).toEqual(['linux-x64'])
  })

  it('falls back to every leg on an event it does not know', () => {
    expect(plan({ event: 'workflow_dispatch', files: prose }).legs).toEqual([])
    expect(plan({ event: 'workflow_dispatch' }).legs).toHaveLength(4)
  })

  it('never packages on a push to main', () => {
    expect(plan({ event: 'push', files: code }).legs).toEqual([])
  })
})

describe('ci-plan prose classification', () => {
  it('treats named contributor docs, docs/*.md and website/ as prose', () => {
    for (const f of ['README.md', 'ROADMAP.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/RELEASING.md', 'website/public/og.png']) {
      expect(isProseOnly(f), f).toBe(true)
    }
  })

  it('never treats shipped or tested text as prose', () => {
    for (const f of [
      'docs/houston-guide.md',
      'CHANGELOG.md',
      'LICENSE',
      'NOTICE',
      'TRADEMARK.md',
      'THIRD-PARTY-NOTICES.md',
      'docs/diagram.png',
      'src/README.md',
      'package.json'
    ]) {
      expect(isProseOnly(f), f).toBe(false)
    }
  })
})

describe('ci-plan cache warming', () => {
  it('warms caches only when a push changes what they hold', () => {
    expect(plan({ event: 'push', files: ['package-lock.json', 'src/a.ts'] }).warmCaches).toBe(true)
    expect(plan({ event: 'push', files: ['.github/actions/setup-node/action.yml'] }).warmCaches).toBe(true)
    expect(plan({ event: 'push', files: code }).warmCaches).toBe(false)
  })

  it('warms when the push diff is unknown', () => {
    expect(plan({ event: 'push', files: null }).warmCaches).toBe(true)
  })

  it('leaves warming to the nightly package legs and never warms from a PR or queue run', () => {
    for (const event of ['schedule', 'pull_request', 'merge_group']) {
      expect(plan({ event, files: ['package-lock.json'] }).warmCaches, event).toBe(false)
    }
  })

  it('recognises each cache input', () => {
    for (const f of ['package-lock.json', '.nvmrc', 'electron-builder.yml']) expect(touchesCacheInputs([f]), f).toBe(true)
  })
})

describe('ci-plan action e2e', () => {
  const action = ['action/cli-release.json']

  it('runs on a PR or queue candidate that touches the action, even with no packaging', () => {
    expect(plan({ event: 'pull_request', files: [...code, ...action] }).actionE2e).toBe(true)
    expect(plan({ event: 'merge_group', files: action }).actionE2e).toBe(true)
    expect(plan({ event: 'pull_request', files: [...prose, ...action] })).toMatchObject({ legs: ['linux-x64'], actionE2e: true })
  })

  it('skips a change that cannot affect the action', () => {
    expect(plan({ event: 'pull_request', files: code }).actionE2e).toBe(false)
    expect(plan({ event: 'merge_group', files: prose }).actionE2e).toBe(false)
  })

  it('runs nightly and whenever the diff is unknown, never on push', () => {
    expect(plan({ event: 'schedule' }).actionE2e).toBe(true)
    expect(plan({ event: 'pull_request', files: null }).actionE2e).toBe(true)
    expect(plan({ event: 'workflow_dispatch' }).actionE2e).toBe(true)
    expect(plan({ event: 'push', files: action }).actionE2e).toBe(false)
  })

  it('counts the action, its signing key, and its test workflow', () => {
    for (const f of ['action/lib/run.mjs', 'action/test/fixtures/v0.10.0/SHA256SUMS', 'houston-signing-key.asc', '.github/workflows/action-test.yml']) {
      expect(touchesAction([f]), f).toBe(true)
    }
    for (const f of ['actions.md', 'src/main/action.ts', '.github/actions/setup-node/action.yml', 'scripts/pin-action.mjs']) {
      expect(touchesAction([f]), f).toBe(false)
    }
  })
})

describe('ci-plan output', () => {
  it('emits GITHUB_OUTPUT lines with a matrix of the legs', () => {
    const out = outputs({ legs: ['linux-x64', 'mac-arm64'], actionE2e: true, warmCaches: false })
    const lines = Object.fromEntries(out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    expect(lines.package).toBe('true')
    expect(lines['warm-caches']).toBe('false')
    expect(lines['action-e2e']).toBe('true')
    expect(JSON.parse(lines['package-matrix'])).toEqual({ include: [LEGS['linux-x64'], LEGS['mac-arm64']] })
  })

  it('reports no packaging with an empty matrix', () => {
    expect(outputs({ legs: [], actionE2e: false, warmCaches: true })).toBe(
      'package=false\npackage-matrix={"include":[]}\naction-e2e=false\nwarm-caches=true'
    )
  })

  it('keeps the runner labels the release workflows build on', () => {
    expect(Object.values(LEGS).map((l) => l.os)).toEqual(['ubuntu-22.04', 'macos-15', 'macos-15-intel', 'windows-2025'])
  })

  it('runs as a CLI from env, falling back safely on a bad label list or missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-plan-'))
    const list = join(dir, 'files.txt')
    writeFileSync(list, 'README.md\nwebsite/index.html\n')
    const run = (env) =>
      execFileSync(process.execPath, ['scripts/ci-plan.mjs'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
    expect(run({ EVENT: 'merge_group', FILES_FROM: list })).toContain('package=false')
    expect(run({ EVENT: 'merge_group', FILES_FROM: list })).toContain('action-e2e=false')
    expect(run({ EVENT: 'merge_group', FILES_FROM: join(dir, 'missing') })).toContain('action-e2e=true')
    expect(run({ EVENT: 'merge_group', FILES_FROM: join(dir, 'missing') })).toContain('package=true')
    expect(run({ EVENT: 'pull_request', LABELS: 'not json', FILES_FROM: '' })).toContain('"target":"linux-x64"')
    expect(run({ EVENT: 'merge_group', LABELS: 'null' })).toContain('"target":"win-x64"')
  })
})
