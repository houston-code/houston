import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeEmptyDirContained,
  removeFileContained,
  setContainedWriteRaceHookForTests,
  writeFileContained
} from './safeWrite'

// Symlinks need privileges on Windows, and O_NOFOLLOW does not exist there.
const posix = process.platform === 'win32' ? describe.skip : describe

let ws: string
let outside: string

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-safewrite-ws-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-safewrite-out-')))
})

afterEach(() => {
  setContainedWriteRaceHookForTests(null)
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** Move `ws/<rel>` aside and put a symlink to `target` in its place (the attacker's swap). */
function swapForSymlink(rel: string, target: string): void {
  renameSync(join(ws, rel), join(ws, `${rel}.moved`))
  symlinkSync(target, join(ws, rel))
}

/** Arm the race hook to perform `swap` once, the first time `op` fires. */
function swapOnce(op: string, swap: () => void): void {
  let done = false
  setContainedWriteRaceHookForTests((o) => {
    if (done || o !== op) return
    done = true
    swap()
  })
}

describe('writeFileContained: ordinary paths', () => {
  it('creates a file and every missing parent directory, reporting the ones it made', () => {
    const created: string[] = []
    writeFileContained([ws], join(ws, 'a/b/c.txt'), 'hi', { createdDirs: created })
    expect(readFileSync(join(ws, 'a/b/c.txt'), 'utf8')).toBe('hi')
    expect(created).toEqual([join(ws, 'a'), join(ws, 'a/b')])
  })

  it('replaces an existing file in place, keeping its mode and inode', () => {
    const p = join(ws, 'run.sh')
    writeFileSync(p, 'old old old')
    chmodSync(p, 0o755)
    const ino = statSync(p).ino
    writeFileContained([ws], p, 'new')
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(statSync(p).mode & 0o777).toBe(0o755)
    expect(statSync(p).ino).toBe(ino)
  })

  it('applies an explicit mode through the fd', () => {
    writeFileContained([ws], join(ws, 'x.sh'), 'x', { mode: 0o100750 })
    if (process.platform !== 'win32') expect(statSync(join(ws, 'x.sh')).mode & 0o777).toBe(0o750)
  })

  it('writes binary buffers byte for byte', () => {
    const bytes = Buffer.from([0, 1, 0xff, 0xfe, 0x80])
    writeFileContained([ws], join(ws, 'b.bin'), bytes)
    expect(readFileSync(join(ws, 'b.bin')).equals(bytes)).toBe(true)
  })

  it('refuses a directory at the target', () => {
    mkdirSync(join(ws, 'd'))
    expect(() => writeFileContained([ws], join(ws, 'd'), 'x')).toThrow(/EISDIR/)
  })

  it('fails with ENOENT instead of creating parents when createDirs is false', () => {
    expect(() => writeFileContained([ws], join(ws, 'no/x.txt'), 'x', { createDirs: false })).toThrow(/ENOENT/)
    expect(existsSync(join(ws, 'no'))).toBe(false)
  })

  it('keeps a read-only file read-only (the write fails, as a plain write would)', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const p = join(ws, 'ro.txt')
    writeFileSync(p, 'keep')
    chmodSync(p, 0o444)
    expect(() => writeFileContained([ws], p, 'x')).toThrow(/EACCES|EPERM/)
    expect(readFileSync(p, 'utf8')).toBe('keep')
  })

  it('refuses a path outside every root', () => {
    expect(() => writeFileContained([ws], join(outside, 'x.txt'), 'x')).toThrow(/symlink/)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })
})

posix('writeFileContained: symlinks already in place', () => {
  it('follows an in-root symlink at the file to its target', () => {
    writeFileSync(join(ws, 'real.txt'), 'old')
    symlinkSync(join(ws, 'real.txt'), join(ws, 'link.txt'))
    writeFileContained([ws], join(ws, 'link.txt'), 'new')
    expect(readFileSync(join(ws, 'real.txt'), 'utf8')).toBe('new')
  })

  it('writes through an in-root symlinked folder', () => {
    mkdirSync(join(ws, 'real'))
    symlinkSync(join(ws, 'real'), join(ws, 'alias'))
    writeFileContained([ws], join(ws, 'alias/x.txt'), 'x')
    expect(readFileSync(join(ws, 'real/x.txt'), 'utf8')).toBe('x')
  })

  it('refuses a symlink at the file whose target is outside', () => {
    writeFileSync(join(outside, 'secret'), 'SECRET')
    symlinkSync(join(outside, 'secret'), join(ws, 'link'))
    expect(() => writeFileContained([ws], join(ws, 'link'), 'PWNED')).toThrow(/symlink/)
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('SECRET')
  })

  it('refuses any symlinked file when followSymlink is false', () => {
    writeFileSync(join(ws, 'real.txt'), 'old')
    symlinkSync(join(ws, 'real.txt'), join(ws, 'link.txt'))
    expect(() => writeFileContained([ws], join(ws, 'link.txt'), 'new', { followSymlink: false })).toThrow(
      /symlink/
    )
    expect(readFileSync(join(ws, 'real.txt'), 'utf8')).toBe('old')
  })

  it('refuses a dangling symlinked folder pointing outside, creating nothing there', () => {
    symlinkSync(join(outside, 'nodir'), join(ws, 'dangling'))
    expect(() => writeFileContained([ws], join(ws, 'dangling/x.txt'), 'x')).toThrow()
    expect(existsSync(join(outside, 'nodir'))).toBe(false)
  })

  it('stops a symlink loop at the final component', () => {
    symlinkSync(join(ws, 'b'), join(ws, 'a'))
    symlinkSync(join(ws, 'a'), join(ws, 'b'))
    expect(() => writeFileContained([ws], join(ws, 'a'), 'x')).toThrow(/ELOOP/)
  })
})

posix('writeFileContained: a symlink swapped in after the caller checked (the race)', () => {
  beforeEach(() => {
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub/a.txt'), 'inside')
    // The outside directory holds the same names, so a write that escaped would land
    // on (and clobber) these.
    writeFileSync(join(outside, 'a.txt'), 'OUTSIDE')
  })

  it('refuses to overwrite a file once its folder is swapped (before the operation)', () => {
    swapOnce('write', () => swapForSymlink('sub', outside))
    expect(() => writeFileContained([ws], join(ws, 'sub/a.txt'), 'PWNED')).toThrow(/symlink/)
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE')
  })

  it('refuses to create a file once its folder is swapped (before the operation)', () => {
    swapOnce('write', () => swapForSymlink('sub', outside))
    expect(() => writeFileContained([ws], join(ws, 'sub/new.txt'), 'PWNED')).toThrow(/symlink/)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  it('refuses to create nested folders under a swapped folder', () => {
    swapOnce('write', () => swapForSymlink('sub', outside))
    expect(() => writeFileContained([ws], join(ws, 'sub/x/y/z.txt'), 'PWNED')).toThrow(/symlink/)
    expect(readdirSync(outside)).toEqual(['a.txt'])
  })

  it('overwrites nothing when the folder is swapped right before the open (fd check)', () => {
    // The existing file is opened WITHOUT O_TRUNC, so the redirected open into the
    // outside folder damages nothing; the fd check then refuses to write.
    swapOnce('open', () => swapForSymlink('sub', outside))
    expect(() => writeFileContained([ws], join(ws, 'sub/a.txt'), 'PWNED')).toThrow(/symlink/)
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE')
  })

  it('removes the empty file a redirected create made, writing nothing to it', () => {
    swapOnce('open', () => swapForSymlink('sub', outside))
    expect(() => writeFileContained([ws], join(ws, 'sub/new.txt'), 'PWNED')).toThrow(/symlink/)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  it('refuses a symlink swapped in at the file itself right before the open (O_NOFOLLOW)', () => {
    swapOnce('open', () => swapForSymlink('sub/a.txt', join(outside, 'a.txt')))
    expect(() => writeFileContained([ws], join(ws, 'sub/a.txt'), 'PWNED')).toThrow(/symlink/)
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE')
  })

  it('refuses a symlink swapped in where a new file was about to be created (O_EXCL)', () => {
    swapOnce('open', () => symlinkSync(join(outside, 'planted.txt'), join(ws, 'sub/new.txt')))
    expect(() => writeFileContained([ws], join(ws, 'sub/new.txt'), 'PWNED')).toThrow(/symlink/)
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
  })
})

posix('removeFileContained', () => {
  it('removes a file, and is a no-op for a missing file or parent', () => {
    writeFileSync(join(ws, 'x'), 'x')
    removeFileContained([ws], join(ws, 'x'))
    expect(existsSync(join(ws, 'x'))).toBe(false)
    expect(() => removeFileContained([ws], join(ws, 'x'))).not.toThrow()
    expect(() => removeFileContained([ws], join(ws, 'no/such/x'))).not.toThrow()
  })

  it('removes a symlink as a link, never its target', () => {
    writeFileSync(join(outside, 'target'), 'KEEP')
    symlinkSync(join(outside, 'target'), join(ws, 'link'))
    removeFileContained([ws], join(ws, 'link'))
    expect(existsSync(join(ws, 'link'))).toBe(false)
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('KEEP')
  })

  it('refuses a directory', () => {
    mkdirSync(join(ws, 'd'))
    expect(() => removeFileContained([ws], join(ws, 'd'))).toThrow(/EISDIR/)
    expect(existsSync(join(ws, 'd'))).toBe(true)
  })

  it('removes nothing outside once its folder is swapped for a symlink', () => {
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub/a.txt'), 'inside')
    writeFileSync(join(outside, 'a.txt'), 'OUTSIDE')
    swapOnce('remove', () => swapForSymlink('sub', outside))
    expect(() => removeFileContained([ws], join(ws, 'sub/a.txt'))).toThrow(/symlink/)
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('OUTSIDE')
  })
})

posix('removeEmptyDirContained', () => {
  it('removes an empty directory but leaves a non-empty one', () => {
    mkdirSync(join(ws, 'e'))
    mkdirSync(join(ws, 'f'))
    writeFileSync(join(ws, 'f/keep'), 'k')
    expect(removeEmptyDirContained([ws], join(ws, 'e'))).toBe(true)
    expect(removeEmptyDirContained([ws], join(ws, 'f'))).toBe(false)
    expect(existsSync(join(ws, 'e'))).toBe(false)
    expect(existsSync(join(ws, 'f/keep'))).toBe(true)
  })

  it('never removes a root, or a directory reached through a swapped folder', () => {
    expect(removeEmptyDirContained([ws], ws)).toBe(false)
    mkdirSync(join(ws, 'sub'))
    mkdirSync(join(outside, 'empty'))
    swapOnce('rmdir', () => swapForSymlink('sub', outside))
    expect(removeEmptyDirContained([ws], join(ws, 'sub/empty'))).toBe(false)
    expect(existsSync(join(outside, 'empty'))).toBe(true)
  })

  it('does not remove a symlink to a directory', () => {
    mkdirSync(join(ws, 'real'))
    symlinkSync(join(ws, 'real'), join(ws, 'alias'))
    expect(removeEmptyDirContained([ws], join(ws, 'alias'))).toBe(false)
    expect(existsSync(join(ws, 'alias'))).toBe(true)
  })
})

