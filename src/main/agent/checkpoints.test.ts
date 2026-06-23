import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordOriginal,
  recordResult,
  restoreCheckpoint,
  reapplyCheckpoint,
  checkpointFileCount,
  clearCheckpoints
} from './checkpoints'

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
    await recordResult('run1', ws, 'a.txt')
    expect(checkpointFileCount('run1')).toBe(1)

    const n = await restoreCheckpoint('run1')
    expect(n).toBe(1)
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('deletes a file the turn newly created', async () => {
    await recordOriginal('run2', ws, 'new.txt')
    writeFileSync(join(ws, 'new.txt'), 'created by agent')
    await recordResult('run2', ws, 'new.txt')

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

  it('returns 0 for an unknown run', async () => {
    expect(await restoreCheckpoint('nope')).toBe(0)
    expect(await reapplyCheckpoint('nope')).toBe(0)
  })

  describe('redo', () => {
    it('re-applies an edit after a revert', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', ws, 'a.txt')
      writeFileSync(f, 'modified')
      await recordResult('r', ws, 'a.txt')

      expect(await restoreCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')

      expect(await reapplyCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('modified')
    })

    it('re-creates a file that revert deleted', async () => {
      const f = join(ws, 'new.txt')
      await recordOriginal('r', ws, 'new.txt')
      writeFileSync(f, 'created')
      await recordResult('r', ws, 'new.txt')

      await restoreCheckpoint('r')
      expect(existsSync(f)).toBe(false)

      expect(await reapplyCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('created')
    })

    it('round-trips revert and redo repeatedly', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'v0')
      await recordOriginal('r', ws, 'a.txt')
      writeFileSync(f, 'v1')
      await recordResult('r', ws, 'a.txt')

      await restoreCheckpoint('r')
      await reapplyCheckpoint('r')
      await restoreCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('v0')
      await reapplyCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('v1')
    })

    it('does not consume the checkpoint on restore (so redo still works)', async () => {
      writeFileSync(join(ws, 'c.txt'), 'before')
      await recordOriginal('r', ws, 'c.txt')
      writeFileSync(join(ws, 'c.txt'), 'after')
      await recordResult('r', ws, 'c.txt')

      expect(await restoreCheckpoint('r')).toBe(1)
      expect(await restoreCheckpoint('r')).toBe(1) // still there, idempotent
      expect(await reapplyCheckpoint('r')).toBe(1)
    })

    it('skips files whose post-turn content was never captured (e.g. failed write)', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', ws, 'a.txt')
      // write "fails" -> recordResult never called -> afterCaptured stays false

      await restoreCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('original')

      // redo must not touch the file (and must not delete it via a phantom null-after)
      expect(await reapplyCheckpoint('r')).toBe(0)
      expect(readFileSync(f, 'utf8')).toBe('original')
    })

    it('recordResult is a no-op when the file was never snapshotted', async () => {
      // No recordOriginal first (e.g. path escaped / oversized).
      writeFileSync(join(ws, 'x.txt'), 'hi')
      await recordResult('r', ws, 'x.txt')
      expect(checkpointFileCount('r')).toBe(0)
    })

    it('skips redo (does not delete) when the post-write read fails', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', ws, 'a.txt')
      writeFileSync(f, 'modified')
      // The file vanishes before we capture the result -> recordResult reads null.
      rmSync(f, { force: true })
      await recordResult('r', ws, 'a.txt')

      await restoreCheckpoint('r') // restores the original
      expect(readFileSync(f, 'utf8')).toBe('original')
      // Redo must skip the file, not delete it via a phantom null-after.
      expect(await reapplyCheckpoint('r')).toBe(0)
      expect(readFileSync(f, 'utf8')).toBe('original')
    })
  })

  describe('robustness', () => {
    it('re-creates parent directories when restoring', async () => {
      mkdirSync(join(ws, 'sub'))
      const f = join(ws, 'sub', 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', ws, 'sub/a.txt')
      writeFileSync(f, 'modified')
      await recordResult('r', ws, 'sub/a.txt')

      // Simulate the directory disappearing before a revert.
      rmSync(join(ws, 'sub'), { recursive: true, force: true })
      expect(await restoreCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')
    })

    it('evicts the oldest checkpoints beyond the cap', async () => {
      // MAX_CHECKPOINTS is 50; create 51 distinct runs, each touching one file.
      for (let i = 0; i < 51; i++) {
        writeFileSync(join(ws, `f${i}.txt`), 'x')
        await recordOriginal(`run-${i}`, ws, `f${i}.txt`)
      }
      // The oldest (run-0) should have been evicted; the newest retained.
      expect(checkpointFileCount('run-0')).toBe(0)
      expect(checkpointFileCount('run-50')).toBe(1)
    })
  })
})
