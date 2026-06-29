import { describe, expect, it } from 'vitest'
import {
  buildMessageWithContext,
  fenceLang,
  formatDiffContext,
  formatFileContext,
  formatFolderContext,
  formatLinkContext,
  humanBytes,
  looksBinary,
  normalizeLink,
  truncateUtf8,
  type ContextAttachment
} from './composerContext'

const att = (over: Partial<ContextAttachment>): ContextAttachment => ({
  id: 'x',
  kind: 'file',
  label: 'f',
  text: '',
  ...over
})

describe('looksBinary', () => {
  it('detects a NUL byte in the head', () => {
    expect(looksBinary(new Uint8Array([1, 2, 0, 3]))).toBe(true)
  })
  it('treats NUL-free bytes as text', () => {
    expect(looksBinary(new Uint8Array([104, 105]))).toBe(false)
  })
  it('only sniffs the leading bytes', () => {
    const buf = new Uint8Array(20).fill(65)
    buf[15] = 0
    expect(looksBinary(buf, 8)).toBe(false)
  })
})

describe('humanBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(humanBytes(800)).toBe('800 B')
    expect(humanBytes(2048)).toBe('2.0 KB')
    expect(humanBytes(1024 * 1024 * 3)).toBe('3.0 MB')
  })
})

describe('truncateUtf8', () => {
  it('returns the text unchanged when under the cap', () => {
    expect(truncateUtf8('hello', 100)).toEqual({ text: 'hello', truncated: false })
  })
  it('cuts without splitting a multi-byte codepoint', () => {
    const s = '😀😀😀' // 4 bytes each = 12 bytes
    const { text, truncated } = truncateUtf8(s, 6) // room for one emoji only
    expect(truncated).toBe(true)
    expect(text).toBe('😀')
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(6)
  })
})

describe('fenceLang', () => {
  it('maps known extensions and falls back to empty', () => {
    expect(fenceLang('a/b.ts')).toBe('ts')
    expect(fenceLang('script.py')).toBe('python')
    expect(fenceLang('notes.unknownext')).toBe('')
    expect(fenceLang('Makefile')).toBe('')
  })
})

describe('formatFileContext', () => {
  it('fences the contents with a language hint', () => {
    const out = formatFileContext('foo.ts', 'const x = 1')
    expect(out).toBe('File: foo.ts\n```ts\nconst x = 1\n```')
  })
  it('notes truncation', () => {
    expect(formatFileContext('a.txt', 'hi', { truncated: true })).toContain('File: a.txt (truncated)')
  })
  it('omits contents for binary and unreadable files', () => {
    expect(formatFileContext('a.bin', null, { binary: true })).toBe(
      'File: a.bin (binary file — contents omitted)'
    )
    expect(formatFileContext('a.txt', null)).toBe('File: a.txt (could not be read)')
  })
  it('lengthens the fence when the content contains a backtick run', () => {
    const out = formatFileContext('a.md', '```js\ncode\n```')
    expect(out.startsWith('File: a.md\n````')).toBe(true)
    expect(out.trimEnd().endsWith('````')).toBe(true)
  })
})

describe('formatFolderContext', () => {
  it('lists files under the path', () => {
    expect(formatFolderContext('/p', ['a.ts', 'b.ts'])).toBe('Folder: /p (2 files)\n- a.ts\n- b.ts')
  })
  it('notes a capped listing', () => {
    expect(formatFolderContext('/p', ['a'], { truncated: true })).toContain('showing first 1 files')
  })
  it('handles an empty folder', () => {
    expect(formatFolderContext('/p', [])).toBe('Folder: /p (0 files)')
  })
})

describe('formatDiffContext', () => {
  it('includes the branch, stat, and fenced diff', () => {
    const out = formatDiffContext('@@ -1 +1 @@\n-a\n+b', {
      branch: 'main',
      files: 1,
      added: 1,
      removed: 1
    })
    expect(out).toContain('Uncommitted changes on branch main (1 file, +1 −1):')
    expect(out).toContain('```diff\n@@ -1 +1 @@')
  })
  it('marks truncation', () => {
    expect(formatDiffContext('x', { truncated: true })).toContain('[truncated]')
  })
})

describe('formatLinkContext', () => {
  it('labels the url', () => {
    expect(formatLinkContext('https://x.com')).toBe('Link: https://x.com')
  })
})

describe('normalizeLink', () => {
  it('adds https:// when no scheme is present', () => {
    expect(normalizeLink('example.com/x')).toBe('https://example.com/x')
  })
  it('keeps an existing scheme', () => {
    expect(normalizeLink('http://x')).toBe('http://x')
    expect(normalizeLink('ftp://x')).toBe('ftp://x')
  })
  it('returns empty for blank input', () => {
    expect(normalizeLink('   ')).toBe('')
  })
})

describe('buildMessageWithContext', () => {
  it('returns just the trimmed text when there are no attachments', () => {
    expect(buildMessageWithContext('  hi  ', [])).toBe('hi')
  })
  it('appends context blocks after the text', () => {
    const out = buildMessageWithContext('look here', [att({ text: 'File: a\n```\nx\n```' })])
    expect(out).toBe('look here\n\nFile: a\n```\nx\n```')
  })
  it('returns only the blocks when the field is empty', () => {
    expect(buildMessageWithContext('', [att({ text: 'Link: https://x' })])).toBe('Link: https://x')
  })
  it('joins multiple blocks with a blank line and skips empty ones', () => {
    const out = buildMessageWithContext('q', [
      att({ id: '1', text: 'A' }),
      att({ id: '2', text: '   ' }),
      att({ id: '3', text: 'B' })
    ])
    expect(out).toBe('q\n\nA\n\nB')
  })
})
