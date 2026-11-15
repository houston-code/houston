import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLastSeenVersion, takeTerminalWhatsNew, writeLastSeenVersion } from './update-state'

// The module reads the userData seam only in the default-path helper; every test
// here passes an explicit path, so a minimal stub is enough.
vi.mock('./userData', () => ({ getUserDataDir: () => tmpdir() }))

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

describe("the terminal's own record", () => {
  it("keeps the app's and the terminal's versions apart in one file", () => {
    const path = tempFile()
    writeLastSeenVersion('1.0.0', path)
    writeLastSeenVersion('0.9.0', path, 'lastSeenTerminalVersion')
    expect(readLastSeenVersion(path)).toBe('1.0.0')
    expect(readLastSeenVersion(path, 'lastSeenTerminalVersion')).toBe('0.9.0')
    writeLastSeenVersion('1.1.0', path)
    expect(readLastSeenVersion(path, 'lastSeenTerminalVersion')).toBe('0.9.0')
  })

  it('shows the highlights once after an upgrade, never on a first run', () => {
    const path = tempFile()
    // First run: nothing recorded, so nothing shows, but the version is recorded.
    expect(takeTerminalWhatsNew('1.0.0', path, () => 'Adds a thing.')).toBeNull()
    expect(readLastSeenVersion(path, 'lastSeenTerminalVersion')).toBe('1.0.0')
    expect(takeTerminalWhatsNew('1.1.0', path, () => 'Adds a thing.')).toEqual({ version: '1.1.0', highlights: 'Adds a thing.' })
    // Once: the next launch of the same version shows nothing.
    expect(takeTerminalWhatsNew('1.1.0', path, () => 'Adds a thing.')).toBeNull()
    // The app's record is untouched, so its own popup still shows.
    expect(readLastSeenVersion(path)).toBeNull()
  })

  it('shows nothing for a version with no bundled highlights', () => {
    const path = tempFile()
    writeLastSeenVersion('1.0.0', path, 'lastSeenTerminalVersion')
    expect(takeTerminalWhatsNew('1.1.0', path, () => null)).toBeNull()
    expect(readLastSeenVersion(path, 'lastSeenTerminalVersion')).toBe('1.1.0')
  })

  it('treats a corrupt file as a first run', () => {
    const path = tempFile()
    writeFileSync(path, '[1,2]', 'utf8')
    expect(takeTerminalWhatsNew('1.1.0', path, () => 'x')).toBeNull()
    expect(readLastSeenVersion(path, 'lastSeenTerminalVersion')).toBe('1.1.0')
  })
})
