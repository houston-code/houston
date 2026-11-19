import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RevertTracker } from './revertTracker'

describe('RevertTracker', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  /** Write `content` through the tracker, as the loop does; true when it counts as a revert. */
  async function write(t: RevertTracker, f: string, content: string): Promise<boolean> {
    await t.before(f)
    writeFileSync(f, content)
    return t.after(f)
  }

  it('flags a write that restores a version the run wrote and moved past', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'a.ts')
    const t = new RevertTracker()
    writeFileSync(f, 'one')
    expect(await write(t, f, 'two')).toBe(false)
    expect(await write(t, f, 'three')).toBe(false)
    expect(await write(t, f, 'two')).toBe(true)
  })

  it('keeps flagging edits that go back and forth between two versions', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'a.ts')
    const t = new RevertTracker()
    writeFileSync(f, 'base')
    const flags: boolean[] = []
    for (const v of ['x = 1', 'x = 2', 'x = 1', 'x = 2', 'x = 1']) flags.push(await write(t, f, v))
    expect(flags).toEqual([false, false, true, true, true])
  })

  it('does not count putting the file back as the run found it', async () => {
    // Adding a debug print and taking it out again, twice: finishing a change, not a loop.
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'a.ts')
    const t = new RevertTracker()
    writeFileSync(f, 'code')
    expect(await write(t, f, 'code\nconsole.log(x)')).toBe(false)
    expect(await write(t, f, 'code')).toBe(false)
    expect(await write(t, f, 'code\nconsole.log(y)')).toBe(false)
    expect(await write(t, f, 'code')).toBe(false)
  })

  it('does not count a write that leaves the file as it was', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'a.ts')
    const t = new RevertTracker()
    writeFileSync(f, 'one')
    expect(await write(t, f, 'two')).toBe(false)
    expect(await write(t, f, 'two')).toBe(false)
    expect(await write(t, f, 'two')).toBe(false)
  })

  it('treats a file the run created like any other once it exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'new.ts')
    const t = new RevertTracker()
    expect(await write(t, f, 'one')).toBe(false)
    expect(await write(t, f, 'two')).toBe(false)
    expect(await write(t, f, 'one')).toBe(true)
  })

  it('treats a missing file as untracked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const t = new RevertTracker()
    await t.before(join(dir, 'nope'))
    expect(await t.after(join(dir, 'nope'))).toBe(false)
  })
})
