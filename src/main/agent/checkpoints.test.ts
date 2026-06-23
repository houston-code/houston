import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordOriginal, restoreCheckpoint, checkpointFileCount, clearCheckpoints } from './checkpoints'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-cp-'))
})

afterEach(() => {
  clearCheckpoints()
  rmSync(ws, { recursive: true, force: true })
})

describe('checkpoints', () => {
  it('restores an edited file to its prior content', async () => {
    const f = join(ws, 'a.txt')
    writeFileSync(f, 'original')
    await recordOriginal('run1', ws, 'a.txt')
    writeFileSync(f, 'modified by agent')
    expect(checkpointFileCount('run1')).toBe(1)

    const n = await restoreCheckpoint('run1')
    expect(n).toBe(1)
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('deletes a file the turn newly created', async () => {
    await recordOriginal('run2', ws, 'new.txt')
    writeFileSync(join(ws, 'new.txt'), 'created by agent')

    const n = await restoreCheckpoint('run2')
    expect(n).toBe(1)
    expect(existsSync(join(ws, 'new.txt'))).toBe(false)
  })

  it('snapshots each path only once (keeps the earliest content)', async () => {
    const f = join(ws, 'b.txt')
    writeFileSync(f, 'v1')
    await recordOriginal('run3', ws, 'b.txt')
    writeFileSync(f, 'v2')
    await recordOriginal('run3', ws, 'b.txt') // second touch — should not overwrite the snapshot
    writeFileSync(f, 'v3')

    await restoreCheckpoint('run3')
    expect(readFileSync(f, 'utf8')).toBe('v1')
  })

  it('ignores paths that escape the workspace', async () => {
    await recordOriginal('run4', ws, '../../etc/passwd')
    expect(checkpointFileCount('run4')).toBe(0)
  })

  it('consumes the checkpoint after a restore', async () => {
    writeFileSync(join(ws, 'c.txt'), 'x')
    await recordOriginal('run5', ws, 'c.txt')
    expect(await restoreCheckpoint('run5')).toBe(1)
    expect(await restoreCheckpoint('run5')).toBe(0)
  })

  it('returns 0 for an unknown run', async () => {
    expect(await restoreCheckpoint('nope')).toBe(0)
  })
})
