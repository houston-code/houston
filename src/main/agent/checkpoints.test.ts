import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordOriginal,
  recordResult,
  restoreCheckpoint,
  reapplyCheckpoint,
  checkpointFileCount,
  getConversationCheckpoint,
  noteConversationRun,
  clearCheckpoints,
  flushCheckpoints,
  writeTargets,
  conversationForLatestRun
} from './checkpoints'
import { setUserDataDir, resetUserDataDir } from '../userData'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-cp-'))
})

afterEach(async () => {
  await flushCheckpoints()
  clearCheckpoints()
  resetUserDataDir()
  rmSync(ws, { recursive: true, force: true })
})

describe('checkpoints', () => {
  it('restores an edited file to its prior content', async () => {
    const f = join(ws, 'a.txt')
    writeFileSync(f, 'original')
    await recordOriginal('run1', [ws], 'a.txt')
    writeFileSync(f, 'modified by agent')
    await recordResult('run1', [ws], 'a.txt')
    expect(checkpointFileCount('run1')).toBe(1)

    const n = await restoreCheckpoint('run1')
    expect(n).toBe(1)
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('deletes a file the turn newly created', async () => {
    await recordOriginal('run2', [ws], 'new.txt')
    writeFileSync(join(ws, 'new.txt'), 'created by agent')
    await recordResult('run2', [ws], 'new.txt')

    const n = await restoreCheckpoint('run2')
    expect(n).toBe(1)
    expect(existsSync(join(ws, 'new.txt'))).toBe(false)
  })

  it('snapshots each path only once (keeps the earliest content)', async () => {
    const f = join(ws, 'b.txt')
    writeFileSync(f, 'v1')
    await recordOriginal('run3', [ws], 'b.txt')
    writeFileSync(f, 'v2')
    await recordOriginal('run3', [ws], 'b.txt') // second touch — should not overwrite the snapshot
    writeFileSync(f, 'v3')

    await restoreCheckpoint('run3')
    expect(readFileSync(f, 'utf8')).toBe('v1')
  })

  it('ignores paths that escape the allowed roots', async () => {
    await recordOriginal('run4', [ws], '../../etc/passwd')
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
      await recordOriginal('r', [ws], 'a.txt')
      writeFileSync(f, 'modified')
      await recordResult('r', [ws], 'a.txt')

      expect(await restoreCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')

      expect(await reapplyCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('modified')
    })

    it('re-creates a file that revert deleted', async () => {
      const f = join(ws, 'new.txt')
      await recordOriginal('r', [ws], 'new.txt')
      writeFileSync(f, 'created')
      await recordResult('r', [ws], 'new.txt')

      await restoreCheckpoint('r')
      expect(existsSync(f)).toBe(false)

      expect(await reapplyCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('created')
    })

    it('round-trips revert and redo repeatedly', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'v0')
      await recordOriginal('r', [ws], 'a.txt')
      writeFileSync(f, 'v1')
      await recordResult('r', [ws], 'a.txt')

      await restoreCheckpoint('r')
      await reapplyCheckpoint('r')
      await restoreCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('v0')
      await reapplyCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('v1')
    })

    it('does not consume the checkpoint on restore (so redo still works)', async () => {
      writeFileSync(join(ws, 'c.txt'), 'before')
      await recordOriginal('r', [ws], 'c.txt')
      writeFileSync(join(ws, 'c.txt'), 'after')
      await recordResult('r', [ws], 'c.txt')

      expect(await restoreCheckpoint('r')).toBe(1)
      expect(await restoreCheckpoint('r')).toBe(1) // still there, idempotent
      expect(await reapplyCheckpoint('r')).toBe(1)
    })

    it('skips files whose post-turn content was never captured (e.g. failed write)', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', [ws], 'a.txt')
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
      await recordResult('r', [ws], 'x.txt')
      expect(checkpointFileCount('r')).toBe(0)
    })

    it('skips redo (does not delete) when the post-write read fails', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', [ws], 'a.txt')
      writeFileSync(f, 'modified')
      // The file vanishes before we capture the result -> recordResult reads null.
      rmSync(f, { force: true })
      await recordResult('r', [ws], 'a.txt')

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
      await recordOriginal('r', [ws], 'sub/a.txt')
      writeFileSync(f, 'modified')
      await recordResult('r', [ws], 'sub/a.txt')

      // Simulate the directory disappearing before a revert.
      rmSync(join(ws, 'sub'), { recursive: true, force: true })
      expect(await restoreCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')
    })

    it('evicts the oldest checkpoints beyond the cap', async () => {
      // MAX_CHECKPOINTS is 50; create 51 distinct runs, each touching one file.
      for (let i = 0; i < 51; i++) {
        writeFileSync(join(ws, `f${i}.txt`), 'x')
        await recordOriginal(`run-${i}`, [ws], `f${i}.txt`)
      }
      // The oldest (run-0) should have been evicted; the newest retained.
      expect(checkpointFileCount('run-0')).toBe(0)
      expect(checkpointFileCount('run-50')).toBe(1)
    })

    it('re-hydrates an evicted run from disk instead of clobbering its earlier snapshot', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'houston-cp-ud-'))
      setUserDataDir(dir)
      try {
        // Run R snapshots file A, then that snapshot is flushed to disk.
        writeFileSync(join(ws, 'a.txt'), 'A-original')
        await recordOriginal('run-keep', [ws], 'a.txt')
        await flushCheckpoints()

        // Simulate the in-memory checkpoint being evicted while the disk snapshot lives
        // on (clearCheckpoints clears memory only), as happens once other runs push the
        // map past the cap.
        clearCheckpoints()
        expect(checkpointFileCount('run-keep')).toBe(0)

        // R now snapshots a SECOND file B. It must re-hydrate A from disk, not start a
        // fresh empty map and persist over A's snapshot.
        writeFileSync(join(ws, 'b.txt'), 'B-original')
        await recordOriginal('run-keep', [ws], 'b.txt')

        writeFileSync(join(ws, 'a.txt'), 'A-modified')
        writeFileSync(join(ws, 'b.txt'), 'B-modified')
        // Reverting restores BOTH files — A survived the eviction.
        expect(await restoreCheckpoint('run-keep')).toBe(2)
        expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('A-original')
        expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('B-original')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('getConversationCheckpoint (restore the revert/redo affordance on re-open)', () => {
    it('returns the latest run checkpoint with file count and reverted=false', async () => {
      noteConversationRun('conv1', 'run-a')
      writeFileSync(join(ws, 'a.txt'), 'original')
      await recordOriginal('run-a', [ws], 'a.txt')
      writeFileSync(join(ws, 'a.txt'), 'modified')
      await recordResult('run-a', [ws], 'a.txt')

      expect(await getConversationCheckpoint('conv1')).toEqual({
        runId: 'run-a',
        files: 1,
        reverted: false
      })
    })

    it('reflects reverted state across restore and reapply', async () => {
      noteConversationRun('conv1', 'run-a')
      writeFileSync(join(ws, 'a.txt'), 'original')
      await recordOriginal('run-a', [ws], 'a.txt')
      writeFileSync(join(ws, 'a.txt'), 'modified')
      await recordResult('run-a', [ws], 'a.txt')

      await restoreCheckpoint('run-a')
      expect((await getConversationCheckpoint('conv1'))?.reverted).toBe(true)
      await reapplyCheckpoint('run-a')
      expect((await getConversationCheckpoint('conv1'))?.reverted).toBe(false)
    })

    it('returns null for a conversation with no recorded run', async () => {
      expect(await getConversationCheckpoint('unknown')).toBeNull()
    })

    it('returns null when the latest run changed no files (nothing to revert)', async () => {
      noteConversationRun('conv1', 'run-empty')
      expect(await getConversationCheckpoint('conv1')).toBeNull()
    })

    it('tracks only the latest run — a newer no-op run hides an earlier revertable one', async () => {
      // run-a wrote a file (revertable)...
      noteConversationRun('conv1', 'run-a')
      writeFileSync(join(ws, 'a.txt'), 'original')
      await recordOriginal('run-a', [ws], 'a.txt')
      await recordResult('run-a', [ws], 'a.txt')
      expect(await getConversationCheckpoint('conv1')).not.toBeNull()

      // ...then run-b ran on the same conversation and touched nothing.
      noteConversationRun('conv1', 'run-b')
      expect(await getConversationCheckpoint('conv1')).toBeNull()
    })

    it('is cleared by clearCheckpoints', async () => {
      noteConversationRun('conv1', 'run-a')
      writeFileSync(join(ws, 'a.txt'), 'x')
      await recordOriginal('run-a', [ws], 'a.txt')
      await recordResult('run-a', [ws], 'a.txt')
      expect(await getConversationCheckpoint('conv1')).not.toBeNull()

      clearCheckpoints()
      expect(await getConversationCheckpoint('conv1')).toBeNull()
    })
  })

  describe('conversationForLatestRun (the IPC gate helper)', () => {
    it('returns the conversation while the run is its latest, null once superseded', async () => {
      noteConversationRun('conv1', 'run-a')
      expect(await conversationForLatestRun('run-a')).toBe('conv1')
      noteConversationRun('conv1', 'run-b')
      expect(await conversationForLatestRun('run-a')).toBeNull()
      expect(await conversationForLatestRun('run-b')).toBe('conv1')
    })

    it('returns null for an unknown runId', async () => {
      expect(await conversationForLatestRun('nope')).toBeNull()
    })
  })

  describe('writeTargets (which files a write-kind call touches)', () => {
    it('maps single-file tools to their path argument', () => {
      expect(writeTargets('write_file', { path: 'a.txt', content: 'x' })).toEqual([
        { path: 'a.txt', deleted: false }
      ])
      expect(writeTargets('edit_file', { path: 'b.ts', edits: [] })).toEqual([
        { path: 'b.ts', deleted: false }
      ])
    })

    it('returns nothing for write-kind tools with no file target', () => {
      expect(writeTargets('dispatch_writable_agent', { prompt: 'go' })).toEqual([])
      expect(writeTargets('write_file', {})).toEqual([])
    })

    it('maps every op in an apply_patch envelope, including both ends of a move', () => {
      const patch = [
        '*** Begin Patch',
        '*** Add File: added.txt',
        '+hello',
        '*** Update File: changed.txt',
        '@@',
        '-old',
        '+new',
        '*** Update File: from.txt',
        '*** Move to: to.txt',
        '@@',
        '-a',
        '+b',
        '*** Delete File: gone.txt',
        '*** End Patch'
      ].join('\n')
      expect(writeTargets('apply_patch', { patch })).toEqual([
        { path: 'added.txt', deleted: false },
        { path: 'changed.txt', deleted: false },
        { path: 'from.txt', deleted: true },
        { path: 'to.txt', deleted: false },
        { path: 'gone.txt', deleted: true }
      ])
    })

    it('returns nothing for a malformed patch (its execute() fails before writing)', () => {
      expect(writeTargets('apply_patch', { patch: 'not a patch' })).toEqual([])
      expect(writeTargets('apply_patch', {})).toEqual([])
    })
  })

  describe('deliberate deletes (apply_patch Delete File / a move source)', () => {
    it('revert restores a deleted file; redo re-deletes it', async () => {
      const f = join(ws, 'gone.txt')
      writeFileSync(f, 'doomed content')
      await recordOriginal('r', [ws], 'gone.txt')
      rmSync(f) // the patch deletes it
      await recordResult('r', [ws], 'gone.txt', { expectAbsent: true })

      expect(await restoreCheckpoint('r')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('doomed content')

      expect(await reapplyCheckpoint('r')).toBe(1)
      expect(existsSync(f)).toBe(false)
    })

    it('round-trips a move (source restored + target removed on revert, back on redo)', async () => {
      const from = join(ws, 'from.txt')
      writeFileSync(from, 'moving content')
      await recordOriginal('r', [ws], 'from.txt')
      await recordOriginal('r', [ws], 'to.txt')
      // The patch applies the move.
      rmSync(from)
      writeFileSync(join(ws, 'to.txt'), 'moving content')
      await recordResult('r', [ws], 'from.txt', { expectAbsent: true })
      await recordResult('r', [ws], 'to.txt')

      expect(await restoreCheckpoint('r')).toBe(2)
      expect(readFileSync(from, 'utf8')).toBe('moving content')
      expect(existsSync(join(ws, 'to.txt'))).toBe(false)

      expect(await reapplyCheckpoint('r')).toBe(2)
      expect(existsSync(from)).toBe(false)
      expect(readFileSync(join(ws, 'to.txt'), 'utf8')).toBe('moving content')
    })

    it('still skips redo when the file is unexpectedly missing (expectAbsent not set)', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('r', [ws], 'a.txt')
      rmSync(f) // vanished, but the tool did NOT mean to delete it
      await recordResult('r', [ws], 'a.txt')

      await restoreCheckpoint('r')
      expect(readFileSync(f, 'utf8')).toBe('original')
      expect(await reapplyCheckpoint('r')).toBe(0)
      expect(readFileSync(f, 'utf8')).toBe('original')
    })
  })

  describe('persistence (checkpoints survive a restart via userData/checkpoints)', () => {
    let dataDir: string

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'houston-cp-data-'))
      setUserDataDir(dataDir)
    })

    afterEach(async () => {
      await flushCheckpoints()
      clearCheckpoints()
      resetUserDataDir()
      rmSync(dataDir, { recursive: true, force: true })
    })

    /** Record one modified file under conv1/run-a and flush it to disk. */
    async function recordOneChange(): Promise<string> {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      noteConversationRun('conv1', 'run-a')
      await recordOriginal('run-a', [ws], 'a.txt')
      writeFileSync(f, 'modified')
      await recordResult('run-a', [ws], 'a.txt')
      await flushCheckpoints()
      return f
    }

    it('restores the affordance and the files after a "restart" (memory cleared)', async () => {
      const f = await recordOneChange()
      clearCheckpoints() // simulate the app restarting

      const cp = await getConversationCheckpoint('conv1')
      expect(cp).toEqual({ runId: 'run-a', files: 1, reverted: false })
      expect(await restoreCheckpoint('run-a')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')
      expect(await reapplyCheckpoint('run-a')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('modified')
    })

    it('persists the reverted flag across a restart', async () => {
      await recordOneChange()
      await restoreCheckpoint('run-a')
      await flushCheckpoints()
      clearCheckpoints()

      expect((await getConversationCheckpoint('conv1'))?.reverted).toBe(true)
      expect(await reapplyCheckpoint('run-a')).toBe(1)
    })

    it('writes checkpoint files with owner-only permissions', async () => {
      await recordOneChange()
      const dir = join(dataDir, 'checkpoints')
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(0o700)
        expect(statSync(join(dir, 'run-a.json')).mode & 0o777).toBe(0o600)
      }
    })

    it('never turns a runId into a path (traversal-shaped ids stay memory-only)', async () => {
      writeFileSync(join(ws, 'a.txt'), 'x')
      await recordOriginal('../escape', [ws], 'a.txt')
      await flushCheckpoints()
      // Works in memory, but nothing with that name was written anywhere on disk.
      expect(checkpointFileCount('../escape')).toBe(1)
      expect(existsSync(join(dataDir, 'escape.json'))).toBe(false)
      expect(existsSync(join(dataDir, 'checkpoints', 'escape.json'))).toBe(false)
      // And a traversal-shaped id is never used to READ a file either.
      expect(await restoreCheckpoint('../../etc/passwd')).toBe(0)
    })

    it('ignores a corrupt checkpoint file', async () => {
      await recordOneChange()
      await flushCheckpoints()
      writeFileSync(join(dataDir, 'checkpoints', 'run-a.json'), 'not json {{{')
      clearCheckpoints()

      expect(await getConversationCheckpoint('conv1')).toBeNull()
      expect(await restoreCheckpoint('run-a')).toBe(0)
    })

    it('drops persisted entries whose paths escape the recorded roots', async () => {
      await recordOneChange()
      await flushCheckpoints()
      const file = join(dataDir, 'checkpoints', 'run-a.json')
      const data = JSON.parse(readFileSync(file, 'utf8'))
      data.files.push({ path: '/etc/passwd', before: 'evil', after: 'evil', afterCaptured: true })
      writeFileSync(file, JSON.stringify(data))
      clearCheckpoints()

      // The tampered entry is dropped on load; the legitimate one survives.
      expect(await getConversationCheckpoint('conv1')).toEqual({
        runId: 'run-a',
        files: 1,
        reverted: false
      })
    })

    it('prunes the oldest run files beyond the cap', async () => {
      // MAX_CHECKPOINTS is 50; record 51 runs, each touching one file.
      for (let i = 0; i < 51; i++) {
        writeFileSync(join(ws, `f${i}.txt`), 'x')
        await recordOriginal(`run-${i}`, [ws], `f${i}.txt`)
      }
      await flushCheckpoints()
      const files = readdirSync(join(dataDir, 'checkpoints')).filter(
        (f) => f.endsWith('.json') && f !== 'index.json'
      )
      expect(files.length).toBeLessThanOrEqual(50)
      expect(files).toContain('run-50.json')
    })

    it('conversationForLatestRun answers from the disk index after a restart', async () => {
      await recordOneChange()
      clearCheckpoints() // simulate the app restarting

      expect(await conversationForLatestRun('run-a')).toBe('conv1')
      expect(await conversationForLatestRun('run-unknown')).toBeNull()
    })

    it('conversationForLatestRun rejects a run superseded in memory but not yet on disk', async () => {
      await recordOneChange()
      // A newer run replaces the entry in memory; its index write may still be queued.
      noteConversationRun('conv1', 'run-b')
      expect(await conversationForLatestRun('run-a')).toBeNull()
    })

    it('stays memory-only when no user-data directory is wired', async () => {
      resetUserDataDir()
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'original')
      await recordOriginal('run-x', [ws], 'a.txt')
      writeFileSync(f, 'modified')
      await recordResult('run-x', [ws], 'a.txt')
      await flushCheckpoints()

      expect(await restoreCheckpoint('run-x')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')
      expect(existsSync(join(dataDir, 'checkpoints'))).toBe(false)
    })
  })
})
