import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeSync, openSync } from 'node:fs'
import { writeFileAtomicSync, writeFileAtomicStampedSync, writeFileAtomic, writeStringChunked } from './atomic-write'

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'houston-atomic-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('writeFileAtomicSync', () => {
  it('writes the content and leaves no temp file behind', () => {
    withDir((dir) => {
      const path = join(dir, 'settings.json')
      writeFileAtomicSync(path, '{"a":1}')
      expect(readFileSync(path, 'utf8')).toBe('{"a":1}')
      expect(readdirSync(dir)).toEqual(['settings.json'])
    })
  })

  it('overwrites an existing file', () => {
    withDir((dir) => {
      const path = join(dir, 'f')
      writeFileAtomicSync(path, 'one')
      writeFileAtomicSync(path, 'two')
      expect(readFileSync(path, 'utf8')).toBe('two')
      expect(readdirSync(dir)).toEqual(['f'])
    })
  })

  it('applies the requested mode', () => {
    withDir((dir) => {
      const path = join(dir, 'secret')
      writeFileAtomicSync(path, 'x', 0o600)
      // Low 9 permission bits; skip on platforms that do not report them (Windows).
      const mode = statSync(path).mode & 0o777
      if (process.platform !== 'win32') expect(mode).toBe(0o600)
    })
  })

  it('cleans up the temp file when the rename fails', () => {
    withDir((dir) => {
      // Renaming a file onto a non-empty directory fails; the temp must not linger.
      const target = join(dir, 'target')
      mkdirSync(target)
      writeFileSync(join(target, 'child'), 'keep')
      expect(() => writeFileAtomicSync(target, 'data')).toThrow()
      // Only the pre-existing directory remains — no stray *.tmp.
      expect(readdirSync(dir)).toEqual(['target'])
    })
  })
})

describe('writeStringChunked', () => {
  function roundTrip(data: string, chunkChars: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'houston-chunk-'))
    try {
      const path = join(dir, 'f.txt')
      const fd = openSync(path, 'w')
      try {
        writeStringChunked(fd, data, chunkChars)
      } finally {
        closeSync(fd)
      }
      return readFileSync(path, 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('writes text longer than one slice intact', () => {
    const data = Array.from({ length: 5000 }, (_, i) => `line ${i} héllo wörld 日本語`).join('\n')
    expect(roundTrip(data, 97)).toBe(data)
  })

  it('never splits a surrogate pair across slices', () => {
    // Every slice boundary of 3 characters lands inside an emoji somewhere in here.
    const data = 'a' + '😀b😀'.repeat(300) + '🎉'
    for (const size of [1, 2, 3, 4, 5]) expect(roundTrip(data, size)).toBe(data)
  })

  it('writes nothing for an empty string', () => {
    expect(roundTrip('', 8)).toBe('')
  })
})

describe('writeFileAtomicStampedSync', () => {
  it('writes a large file intact with its mode and a stamp that matches the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-stamped-'))
    try {
      const path = join(dir, 'chat.json')
      const data = JSON.stringify({ messages: Array.from({ length: 20000 }, (_, i) => ({ text: `message ${i} 😀` })) })
      expect(data.length).toBeGreaterThan(256 * 1024)
      const stamp = writeFileAtomicStampedSync(path, data, 0o600)
      expect(readFileSync(path, 'utf8')).toBe(data)
      const st = statSync(path)
      expect(stamp).toBe(`${st.ino}:${st.mtimeMs}:${st.size}`)
      if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('writeFileAtomic (async)', () => {
  it('writes the content and leaves no temp behind', async () => {
    await new Promise<void>((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'houston-atomic-'))
      writeFileAtomic(join(dir, 'f'), 'hi', 0o600)
        .then(() => {
          expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('hi')
          expect(readdirSync(dir)).toEqual(['f'])
          resolve()
        })
        .catch(reject)
        .finally(() => rmSync(dir, { recursive: true, force: true }))
    })
  })

  it('cleans up the temp on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-atomic-'))
    try {
      const target = join(dir, 'target')
      mkdirSync(target)
      writeFileSync(join(target, 'child'), 'keep')
      await expect(writeFileAtomic(target, 'data')).rejects.toThrow()
      expect(readdirSync(dir)).toEqual(['target'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
