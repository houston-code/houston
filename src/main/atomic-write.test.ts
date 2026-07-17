import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync, writeFileAtomic } from './atomic-write'

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
