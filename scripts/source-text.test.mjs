import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tracked source and prose must be plain text.
 *
 * A raw NUL byte anywhere in a file makes it binary to the tools contributors search
 * with: `grep` reports nothing at all rather than its matches, ripgrep stops at the
 * byte, and `file` calls it `data`. The failure is silent, so a search returns "no
 * matches" instead of an error and the reader believes it.
 *
 * Two files had one (a NUL field separator in a dedupe key, and a control-character
 * test fixture), which made the permission matcher, one of the files most worth
 * searching, invisible to grep. Both now write the escape instead of the byte, which
 * is identical at runtime and keeps the source greppable. This test keeps it that way.
 */

/** Extensions whose contents are source or prose, and so must never hold a NUL. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.sh',
  '.txt'
])

const trackedTextFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    // -z separates paths with NUL; build it rather than embedding the byte, so this
    // file passes its own check.
    .split(String.fromCharCode(0))
    .filter((p) => p !== '' && TEXT_EXTENSIONS.has(extname(p)))

describe('tracked text files', () => {
  it('contain no raw NUL bytes', () => {
    const offenders = trackedTextFiles().filter((p) => readFileSync(p).includes(0))
    expect(offenders).toEqual([])
  })

  it('scans a meaningful number of files', () => {
    // Guard the guard: a broken `git ls-files` (wrong cwd, no repo) would otherwise
    // pass by scanning nothing at all.
    expect(trackedTextFiles().length).toBeGreaterThan(100)
  })
})
