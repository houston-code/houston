import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLastSeenVersion, writeLastSeenVersion } from './update-state'

// The module imports `electron` only for app.getPath in the default-path helper;
// every test here passes an explicit path, so a minimal stub is enough.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const dirs: string[] = []
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'houston-update-state-'))
  dirs.push(dir)
  return join(dir, 'update-state.json')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('update-state', () => {
  it('round-trips the last-seen version', () => {
    const path = tempFile()
    writeLastSeenVersion('1.2.3', path)
    expect(readLastSeenVersion(path)).toBe('1.2.3')
  })

  it('returns null when the file is missing (fresh install)', () => {
    expect(readLastSeenVersion(tempFile())).toBeNull()
  })

  it('returns null when the file is corrupt', () => {
    const path = tempFile()
    writeFileSync(path, 'not json', 'utf8')
    expect(readLastSeenVersion(path)).toBeNull()
  })

  it('overwrites an earlier recorded version', () => {
    const path = tempFile()
    writeLastSeenVersion('0.1.0', path)
    writeLastSeenVersion('0.2.0', path)
    expect(readLastSeenVersion(path)).toBe('0.2.0')
  })
})
