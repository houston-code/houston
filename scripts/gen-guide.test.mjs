import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateGuide } from './gen-guide.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guidePath = resolve(root, 'docs/houston-guide.md')
const outPath = resolve(root, 'src/main/agent/guide-content.ts')

const literalOf = (out) => {
  const marker = 'export const HOUSTON_GUIDE = '
  return out.slice(out.indexOf(marker) + marker.length).trim()
}

// The mutating tests write to a temp `out` rather than the real generated file:
// other test files import guide-content.ts concurrently, and clobbering it
// mid-run would flake them.
describe('gen-guide (temp output)', () => {
  let dir
  let out

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gen-guide-'))
    out = join(dir, 'guide-content.ts')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the file when it does not exist yet (fresh clone)', () => {
    const result = generateGuide({ out })

    expect(result.written).toBe(true)
    expect(readFileSync(out, 'utf8')).toContain('export const HOUSTON_GUIDE =')
  })

  it('is a no-op write when the content is unchanged', () => {
    generateGuide({ out })
    const before = statSync(out).mtimeMs

    const second = generateGuide({ out })

    // An unconditional write would bump mtime on every Vitest start and retrigger
    // watch mode in a loop.
    expect(second.written).toBe(false)
    expect(statSync(out).mtimeMs).toBe(before)
  })

  it('rewrites the file when it is stale', () => {
    writeFileSync(out, '// clobbered\n')

    const result = generateGuide({ out })

    expect(result.written).toBe(true)
    expect(literalOf(readFileSync(out, 'utf8'))).not.toBe('"// clobbered"')
  })

  it('inlines the guide verbatim, escaping backticks and ${...} safely', () => {
    generateGuide({ out })

    // Round-trip through the emitted literal rather than eyeballing the escaping:
    // the guide is full of backticks and `${...}`-looking text.
    const md = readFileSync(guidePath, 'utf8').trim()
    expect(JSON.parse(literalOf(readFileSync(out, 'utf8')))).toBe(md)
  })

  it('round-trips a source full of the characters that break naive escaping', () => {
    const src = join(dir, 'guide.md')
    const nasty = 'A `backtick`, a ${expr}, a "quote", a \\backslash, and a \n newline.'
    writeFileSync(src, nasty)

    generateGuide({ src, out })

    expect(JSON.parse(literalOf(readFileSync(out, 'utf8')))).toBe(nasty.trim())
  })
})

describe('gen-guide (real output)', () => {
  it('has already produced a current guide-content.ts via globalSetup', () => {
    // Read-only: proves scripts/vitest-global-setup.mjs ran before collection.
    const md = readFileSync(guidePath, 'utf8').trim()
    expect(JSON.parse(literalOf(readFileSync(outPath, 'utf8')))).toBe(md)
  })

  it('marks the output as generated and uncommittable', () => {
    expect(readFileSync(outPath, 'utf8')).toContain('DO NOT EDIT BY HAND, DO NOT COMMIT')
  })
})

const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' })
const inGitRepo = () => {
  try {
    git(['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

describe.runIf(inGitRepo())('guide-content.ts stays untracked', () => {
  it('is not tracked by git', () => {
    // .gitignore does NOT protect a file that is already tracked, so it cannot
    // catch this on its own. A branch that predates the file's removal still
    // carries it, and resolving that modify/delete conflict the wrong way
    // re-adds it — silently restoring the ~37KB single-line conflict this whole
    // change exists to remove. Fail loudly instead.
    let tracked = true
    try {
      git(['ls-files', '--error-unmatch', 'src/main/agent/guide-content.ts'])
    } catch {
      tracked = false
    }
    expect(
      tracked,
      'src/main/agent/guide-content.ts is tracked again — it is generated. Run `git rm --cached src/main/agent/guide-content.ts`.'
    ).toBe(false)
  })
})
