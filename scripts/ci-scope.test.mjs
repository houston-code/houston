import { describe, expect, it } from 'vitest'
import { isInertChange, isInertPath, INERT_FILES } from './ci-scope.mjs'

/**
 * A wrong answer here does not turn a check red — a job skipped by `if:` reports its
 * required check as a PASS, so a false "inert" lets an untested change merge. These
 * tests exist to make that failure mode expensive to introduce.
 */
describe('inert paths', () => {
  it('treats the marketing site as inert', () => {
    // eslint.config.mjs ignores website/**, no tsconfig includes it, and
    // electron-builder does not package it.
    expect(isInertPath('website/public/assets/app.js')).toBe(true)
    expect(isInertPath('website/public/index.html')).toBe(true)
    expect(isInertPath('website/public/assets/styles.css')).toBe(true)
    expect(isInertPath('website/README.md')).toBe(true)
  })

  it('does NOT treat website tooling as inert', () => {
    // The vitest `node` project includes website/tools/**/*.test.mjs, so these are code.
    expect(isInertPath('website/tools/build-legal.mjs')).toBe(false)
    expect(isInertPath('website/tools/build-legal.test.mjs')).toBe(false)
  })

  it('treats standalone prose as inert', () => {
    expect(isInertPath('README.md')).toBe(true)
    expect(isInertPath('CONTRIBUTING.md')).toBe(true)
    expect(isInertPath('AGENTS.md')).toBe(true)
    expect(isInertPath('docs/PRIVACY.md')).toBe(true)
    expect(isInertPath('.github/ISSUE_TEMPLATE/bug_report.yml')).toBe(true)
  })

  it('does NOT treat the agent guide as inert', () => {
    // docs/houston-guide.md is inlined into guide-content.ts and pinned by the agent
    // goldens — editing it changes the agent's behavior surface.
    expect(isInertPath('docs/houston-guide.md')).toBe(false)
  })

  it('does NOT treat generated or gated attribution files as inert', () => {
    // The test job regenerates and diffs the notices file; a hand edit must be caught.
    expect(isInertPath('THIRD-PARTY-NOTICES.md')).toBe(false)
    expect(isInertPath('LICENSE')).toBe(false)
    expect(isInertPath('NOTICE')).toBe(false)
  })

  it('does NOT treat source, config, or CI as inert', () => {
    for (const file of [
      'src/main/agent/loop.ts',
      'package.json',
      'package-lock.json',
      'eslint.config.mjs',
      'vitest.config.ts',
      'electron-builder.yml',
      '.github/workflows/ci.yml',
      'scripts/ci-scope.mjs',
      '.nvmrc'
    ]) {
      expect(isInertPath(file), file).toBe(false)
    }
  })

  it('rejects anything unrecognised rather than guessing', () => {
    // A new top-level file is code until someone says otherwise.
    expect(isInertPath('NEWFILE.md')).toBe(false)
    expect(isInertPath('docs/some-new-doc.md')).toBe(false)
    expect(isInertPath('')).toBe(false)
    expect(isInertPath(undefined)).toBe(false)
    expect(isInertPath(null)).toBe(false)
  })

  it('rejects paths that escape or arrive oddly normalized', () => {
    expect(isInertPath('../website/index.html')).toBe(false)
    expect(isInertPath('/website/index.html')).toBe(false)
    expect(isInertPath('website/../src/main/agent/loop.ts')).toBe(false)
  })
})

describe('inert changesets', () => {
  it('is inert only when every path is inert', () => {
    expect(isInertChange(['website/index.html', 'README.md'])).toBe(true)
    expect(isInertChange(['website/index.html', 'src/main/agent/loop.ts'])).toBe(false)
    expect(isInertChange(['src/main/agent/loop.ts'])).toBe(false)
  })

  it('one code file among many inert ones still runs everything', () => {
    const files = ['website/a.html', 'website/b.html', 'README.md', 'website/tools/build-legal.mjs']
    expect(isInertChange(files)).toBe(false)
  })

  it('treats an empty or unusable file list as "run everything"', () => {
    // A diff that failed to compute must never read as "nothing to do" — that would skip
    // every required check and report them all green.
    expect(isInertChange([])).toBe(false)
    expect(isInertChange(undefined)).toBe(false)
    expect(isInertChange(null)).toBe(false)
    expect(isInertChange('website/index.html')).toBe(false)
  })

  it('reproduces the case this was built for', () => {
    // PR #683 changed exactly one line of the hero copy and ran 4,729 tests plus a full
    // Electron package, none of which touch the file.
    expect(isInertChange(['website/public/assets/app.js'])).toBe(true)
  })
})

describe('the allowlist itself', () => {
  it('never lists a file that another job consumes', () => {
    // TRADEMARK.md is on this list because electron-builder `extraResources` packages it
    // and e2e/packaged-resources.spec.ts asserts it is inside the bundle. It reads like a
    // root doc, so it is exactly the kind of file someone would add to INERT_FILES.
    for (const consumed of [
      'THIRD-PARTY-NOTICES.md',
      'docs/houston-guide.md',
      'LICENSE',
      'NOTICE',
      'TRADEMARK.md'
    ]) {
      expect(INERT_FILES.has(consumed), consumed).toBe(false)
    }
  })
})
