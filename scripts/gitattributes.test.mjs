import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

// Vite strips a shebang with /^#!.*\n/, which misses "\r\n". A script checked out with
// CRLF on Windows then fails to parse when Vitest's globalSetup imports it, so every
// tracked file with a shebang has to be checked out with LF.
describe('.gitattributes', () => {
  it('checks every shebang script out with LF line endings', () => {
    const files = git('grep', '-l', '^#!').split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    const attrs = git('check-attr', 'eol', '--', ...files)
    const notLf = attrs.split('\n').filter(Boolean).filter((line) => !line.endsWith(': eol: lf'))
    expect(notLf).toEqual([])
  })
})
