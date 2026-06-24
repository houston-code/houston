import { describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
import { augmentPath, CappedOutput } from './sandbox'

describe('augmentPath', () => {
  const minimalPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

  it('appends Homebrew and ~/.local/bin when they exist', () => {
    const out = augmentPath({ PATH: minimalPath, HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).toContain('/opt/homebrew/sbin')
    expect(out).toContain('/Users/me/.local/bin')
  })

  it('preserves inherited entries first and does not duplicate them', () => {
    const out = augmentPath({ PATH: minimalPath }, () => true).split(delimiter)
    expect(out.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    expect(out.filter((d) => d === '/usr/bin')).toHaveLength(1) // /usr/bin is also a candidate
  })

  it('adds nothing when the extra dirs do not exist', () => {
    expect(augmentPath({ PATH: minimalPath }, () => false)).toBe(minimalPath)
  })

  it('builds a PATH from scratch when none is inherited', () => {
    const out = augmentPath({ HOME: '/Users/me' }, () => true).split(delimiter)
    expect(out).toContain('/opt/homebrew/bin')
    expect(out).not.toContain('') // no empty segments
  })

  it('omits ~/.local/bin when HOME is unset', () => {
    const out = augmentPath({ PATH: '/usr/bin' }, () => true)
    expect(out).not.toMatch(/\.local\/bin/)
  })
})

describe('CappedOutput', () => {
  const MARKER = /\n\[\.\.\. (\d+) bytes truncated \.\.\.\]\n/

  it('returns output verbatim when it fits the budget', () => {
    const cap = new CappedOutput(5, 5)
    cap.push(Buffer.from('hello'))
    expect(cap.toString()).toBe('hello')
    expect(cap.droppedBytes).toBe(0)
    expect(cap.toString()).not.toMatch(MARKER)
  })

  it('keeps head and tail contiguous (no marker) right at the budget edge', () => {
    const cap = new CappedOutput(3, 3)
    cap.push(Buffer.from('abcXYZ')) // exactly head+tail bytes
    expect(cap.toString()).toBe('abcXYZ')
    expect(cap.droppedBytes).toBe(0)
  })

  it('preserves BOTH ends with a truncation marker once over budget', () => {
    const cap = new CappedOutput(3, 3)
    cap.push(Buffer.from('abc' + 'M'.repeat(10) + 'xyz'))
    const out = cap.toString()
    expect(out.startsWith('abc')).toBe(true) // head survives
    expect(out.endsWith('xyz')).toBe(true) // tail survives
    expect(out).toMatch(MARKER)
    expect(cap.droppedBytes).toBe(10)
    expect(out).toContain('[... 10 bytes truncated ...]')
  })

  it('rolls the tail window across chunk boundaries, keeping the last bytes', () => {
    const cap = new CappedOutput(2, 4)
    // Head fills with "AB"; the rest streams in many small chunks. Only the last
    // 4 bytes of the post-head stream should remain in the tail.
    cap.push(Buffer.from('AB'))
    for (const ch of 'CDEFGHIJ') cap.push(Buffer.from(ch))
    const out = cap.toString()
    expect(out.startsWith('AB')).toBe(true)
    expect(out.endsWith('GHIJ')).toBe(true)
    expect(cap.droppedBytes).toBe('CDEF'.length) // C,D,E,F dropped between ends
  })

  it('keeps the trailing summary when fed more than 1 MB (default budget)', () => {
    const cap = new CappedOutput() // default 1 MB budget, split head/tail
    const head = 'compiling...\n'
    const tail = '\n5 failed, 120 passed'
    cap.push(Buffer.from(head))
    // > 1 MB of noise in the middle, in many chunks like a real stream.
    const filler = Buffer.from('x'.repeat(64 * 1024))
    for (let written = 0; written < 1_500_000; written += filler.length) cap.push(filler)
    cap.push(Buffer.from(tail))

    const out = cap.toString()
    expect(out.startsWith(head)).toBe(true) // command echo / early output survives
    expect(out.endsWith(tail)).toBe(true) // the actionable summary survives
    expect(out).toMatch(MARKER)
    // Retained output stays within the 1 MB budget (plus the short marker line).
    expect(out.length).toBeLessThanOrEqual(1_000_000 + 64)
    expect(cap.droppedBytes).toBeGreaterThan(0)
  })

  it('handles a single over-budget chunk by keeping its head and tail', () => {
    const cap = new CappedOutput(4, 4)
    cap.push(Buffer.from('HEAD' + '-'.repeat(20) + 'TAIL'))
    const out = cap.toString()
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.endsWith('TAIL')).toBe(true)
    expect(cap.droppedBytes).toBe(20)
  })
})
