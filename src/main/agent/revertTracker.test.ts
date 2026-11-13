import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RevertTracker } from './revertTracker'

describe('RevertTracker', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('flags a write that restores an earlier version, including the original', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const f = join(dir, 'a.ts')
    const t = new RevertTracker()
    writeFileSync(f, 'one')
    await t.before(f)
    writeFileSync(f, 'two')
    expect(await t.after(f)).toBe(false)
    await t.before(f)
    writeFileSync(f, 'one')
    expect(await t.after(f)).toBe(true)
    await t.before(f)
    writeFileSync(f, 'three')
    expect(await t.after(f)).toBe(false)
  })

  it('treats a missing file as untracked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'revert-'))
    const t = new RevertTracker()
    await t.before(join(dir, 'nope'))
    expect(await t.after(join(dir, 'nope'))).toBe(false)
  })
})
