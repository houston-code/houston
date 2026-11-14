import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  symlinkSync,
  utimesSync
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
  conversationForLatestRun,
  _setCheckpointMemoryBudget,
  _setCheckpointDiskBudget,
  _setRunSnapshotBudget,
  revertRunsGuarded
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

  it('keeps every file when several are snapshotted at once for a new run', async () => {
    const names = ['p.txt', 'q.txt', 'r.txt']
    for (const n of names) writeFileSync(join(ws, n), `${n} original`)
    await Promise.all(names.map((n) => recordOriginal('run-parallel', [ws], n)))
    expect(checkpointFileCount('run-parallel')).toBe(3)
    for (const n of names) writeFileSync(join(ws, n), 'changed')
    expect(await restoreCheckpoint('run-parallel')).toBe(3)
    for (const n of names) expect(readFileSync(join(ws, n), 'utf8')).toBe(`${n} original`)
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

  it('restores a binary file byte for byte, not as decoded text', async () => {
    // Bytes that are not valid UTF-8: decoding them as text and writing that back
    // replaced each bad sequence and corrupted the file the revert was meant to save.
    const f = join(ws, 'logo.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28])
    writeFileSync(f, bytes)
    await recordOriginal('run-bin', [ws], 'logo.png')
    rmSync(f)
    await recordResult('run-bin', [ws], 'logo.png', { expectAbsent: true })

    expect(await restoreCheckpoint('run-bin')).toBe(1)
    expect(readFileSync(f).equals(bytes)).toBe(true)
    expect(await reapplyCheckpoint('run-bin')).toBe(1)
    expect(existsSync(f)).toBe(false)
  })

  it('redoes a write that produced binary content byte for byte', async () => {
    const f = join(ws, 'data.bin')
    const after = Buffer.from([0x00, 0xfe, 0xff, 0x80])
    writeFileSync(f, 'text before')
    await recordOriginal('run-bin2', [ws], 'data.bin')
    writeFileSync(f, after)
    await recordResult('run-bin2', [ws], 'data.bin')

    await restoreCheckpoint('run-bin2')
    expect(readFileSync(f, 'utf8')).toBe('text before')
    await reapplyCheckpoint('run-bin2')
    expect(readFileSync(f).equals(after)).toBe(true)
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
      // MAX_CHECKPOINTS is 50; create 51 distinct runs, each snapshotting one file.
      // Eviction is keyed by run, not by path, so every run snapshots the SAME file.
      // Creating a fresh file per run made this the test most exposed to Windows CI
      // runners' temp-disk stalls, where each new file can cost ~100ms (it once took
      // 5.3s against a ~100ms norm and hit the 5s timeout).
      writeFileSync(join(ws, 'f.txt'), 'x')
      for (let i = 0; i < 51; i++) {
        await recordOriginal(`run-${i}`, [ws], 'f.txt')
      }
      // Only the oldest (run-0) should have been evicted; the 50 newest retained.
      expect(checkpointFileCount('run-0')).toBe(0)
      expect(checkpointFileCount('run-1')).toBe(1)
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

    it('keeps binary snapshots intact across a restart, and text as text on disk', async () => {
      const bin = join(ws, 'img.bin')
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80])
      writeFileSync(bin, bytes)
      writeFileSync(join(ws, 'a.txt'), 'plain text\n')
      noteConversationRun('conv1', 'run-b')
      await recordOriginal('run-b', [ws], 'img.bin')
      await recordOriginal('run-b', [ws], 'a.txt')
      rmSync(bin)
      writeFileSync(join(ws, 'a.txt'), 'changed\n')
      await recordResult('run-b', [ws], 'img.bin', { expectAbsent: true })
      await recordResult('run-b', [ws], 'a.txt')
      await flushCheckpoints()

      const saved = JSON.parse(readFileSync(join(dataDir, 'checkpoints', 'run-b.json'), 'utf8'))
      const textEntry = saved.files.find((e: { path: string }) => e.path.endsWith('a.txt'))
      expect(textEntry.before).toBe('plain text\n')
      expect(textEntry).not.toHaveProperty('beforeEncoding')

      clearCheckpoints() // simulate the app restarting
      expect(await restoreCheckpoint('run-b')).toBe(2)
      expect(readFileSync(bin).equals(bytes)).toBe(true)
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('plain text\n')
    })

    it('still loads a checkpoint written before binary snapshots (schema version 1)', async () => {
      const f = join(ws, 'a.txt')
      writeFileSync(f, 'modified')
      mkdirSync(join(dataDir, 'checkpoints'), { recursive: true })
      writeFileSync(
        join(dataDir, 'checkpoints', 'run-v1.json'),
        JSON.stringify({
          version: 1,
          runId: 'run-v1',
          roots: [ws],
          reverted: false,
          files: [{ path: f, before: 'original', after: 'modified', afterCaptured: true }]
        })
      )
      expect(await restoreCheckpoint('run-v1')).toBe(1)
      expect(readFileSync(f, 'utf8')).toBe('original')
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
      // MAX_DISK_CHECKPOINTS is 200; record 201 runs, each snapshotting the same one file
      // (see the in-memory eviction test: the per-run checkpoint files are the disk
      // writes under test here, a fresh workspace file per run is not).
      writeFileSync(join(ws, 'f.txt'), 'x')
      for (let i = 0; i < 201; i++) {
        await recordOriginal(`run-${i}`, [ws], 'f.txt')
      }
      await flushCheckpoints()
      const files = readdirSync(join(dataDir, 'checkpoints')).filter(
        (f) => f.endsWith('.json') && f !== 'index.json'
      )
      expect(files).toHaveLength(200)
      expect(files).toContain('run-200.json')
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

  // POSIX-only: Windows symlink creation needs elevated privileges in CI.
  describe.skipIf(process.platform === 'win32')('apply-time containment', () => {
    it('refuses to restore through a parent-dir symlink planted after the snapshot', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'houston-cp-outside-'))
      try {
        // Snapshot a file inside a subdir: before='original', after='agent'.
        mkdirSync(join(ws, 'sub'))
        writeFileSync(join(ws, 'sub', 'x.txt'), 'original')
        await recordOriginal('run-sym', [ws], 'sub/x.txt')
        writeFileSync(join(ws, 'sub', 'x.txt'), 'agent')
        await recordResult('run-sym', [ws], 'sub/x.txt')

        // The agent swaps the subdir for a symlink pointing OUTSIDE the workspace
        // (what a sandboxed `ln -s` would do), so the stored path now resolves out.
        rmSync(join(ws, 'sub'), { recursive: true, force: true })
        symlinkSync(outside, join(ws, 'sub'), 'dir')

        // Restore must skip the escaping path, writing nothing into `outside`.
        expect(await restoreCheckpoint('run-sym')).toBe(0)
        expect(existsSync(join(outside, 'x.txt'))).toBe(false)

        // And redo must not write the agent content through the symlink either.
        expect(await reapplyCheckpoint('run-sym')).toBe(0)
        expect(existsSync(join(outside, 'x.txt'))).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('still restores a path that stays within the roots', async () => {
      mkdirSync(join(ws, 'keep'))
      writeFileSync(join(ws, 'keep', 'y.txt'), 'original')
      await recordOriginal('run-ok', [ws], 'keep/y.txt')
      writeFileSync(join(ws, 'keep', 'y.txt'), 'agent')
      await recordResult('run-ok', [ws], 'keep/y.txt')

      expect(await restoreCheckpoint('run-ok')).toBe(1)
      expect(readFileSync(join(ws, 'keep', 'y.txt'), 'utf8')).toBe('original')
    })
  })
})

describe('checkpoint memory budget', () => {
  let dataDir: string
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'houston-cp-data-'))
    setUserDataDir(dataDir)
  })
  afterEach(() => {
    _setCheckpointMemoryBudget(null)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('evicts older runs past the budget, and still reverts them from disk', async () => {
    // The budget is checked as each run's checkpoint is created; run-a's snapshots
    // (45 characters) are already over it when run-b starts.
    _setCheckpointMemoryBudget(40)
    const a = join(ws, 'a.txt')
    const b = join(ws, 'b.txt')
    writeFileSync(a, 'a'.repeat(20))
    writeFileSync(b, 'b'.repeat(20))
    await recordOriginal('run-a', [ws], 'a.txt')
    writeFileSync(a, 'A'.repeat(25))
    await recordResult('run-a', [ws], 'a.txt')
    await flushCheckpoints()
    await recordOriginal('run-b', [ws], 'b.txt')
    writeFileSync(b, 'B'.repeat(25))
    await recordResult('run-b', [ws], 'b.txt')
    // run-a was evicted from memory to admit run-b...
    expect(checkpointFileCount('run-a')).toBe(0)
    expect(checkpointFileCount('run-b')).toBe(1)
    // ...and is read back from disk when it is needed.
    expect(await restoreCheckpoint('run-a')).toBe(1)
    expect(readFileSync(a, 'utf8')).toBe('a'.repeat(20))
    expect(await restoreCheckpoint('run-b')).toBe(1)
    expect(readFileSync(b, 'utf8')).toBe('b'.repeat(20))
  })

  it('records the result of a run evicted mid-run, so its rewind still restores the file', async () => {
    _setCheckpointMemoryBudget(40)
    const a = join(ws, 'a.txt')
    const b = join(ws, 'b.txt')
    writeFileSync(a, 'a'.repeat(50))
    writeFileSync(b, 'b')
    await recordOriginal('run-a', [ws], 'a.txt')
    await flushCheckpoints()
    // Another run starts while run-a is still writing, and evicts it to make room.
    await recordOriginal('run-b', [ws], 'b.txt')
    expect(checkpointFileCount('run-a')).toBe(0)
    writeFileSync(a, 'A'.repeat(50))
    await recordResult('run-a', [ws], 'a.txt')
    await flushCheckpoints()
    expect(await revertRunsGuarded([{ runId: 'run-a', turn: 0, at: 0, files: true }])).toMatchObject({
      restored: 1,
      conflicts: []
    })
    expect(readFileSync(a, 'utf8')).toBe('a'.repeat(50))
  })

  it('never evicts a run while a record call for it is still in flight', async () => {
    _setCheckpointMemoryBudget(40)
    const a = join(ws, 'a.txt')
    const b = join(ws, 'b.txt')
    const c = join(ws, 'c.txt')
    writeFileSync(a, 'a'.repeat(50))
    writeFileSync(b, 'b')
    writeFileSync(c, 'c')
    await recordOriginal('run-a', [ws], 'a.txt')
    await flushCheckpoints()
    // run-a snapshots a second file while run-b's new checkpoint is being admitted:
    // evicting run-a mid-call would drop c.txt's snapshot.
    await Promise.all([recordOriginal('run-a', [ws], 'c.txt'), recordOriginal('run-b', [ws], 'b.txt')])
    writeFileSync(c, 'C')
    await recordResult('run-a', [ws], 'c.txt')
    await flushCheckpoints()
    const r = await revertRunsGuarded([{ runId: 'run-a', turn: 0, at: 0, files: true }])
    expect(r).toMatchObject({ restored: 1, conflicts: [] })
    expect(readFileSync(c, 'utf8')).toBe('c')
  })
})

describe('checkpoint storage byte caps', () => {
  let dataDir: string
  const cpDir = (): string => join(dataDir, 'checkpoints')
  const runFiles = (): string[] =>
    readdirSync(cpDir()).filter((f) => f.endsWith('.json') && f !== 'index.json')
  const diskBytes = (): number => runFiles().reduce((n, f) => n + statSync(join(cpDir(), f)).size, 0)

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'houston-cp-data-'))
    setUserDataDir(dataDir)
  })
  afterEach(() => {
    _setCheckpointDiskBudget(null)
    _setRunSnapshotBudget(null)
    rmSync(dataDir, { recursive: true, force: true })
  })

  let clock = 0
  /**
   * Record one run snapshotting a fresh 2 KB file, and wait for its file to land. Its
   * mtime is then set a second after the previous run's, so oldest-first is exact
   * (runs recorded in the same millisecond would otherwise tie).
   */
  async function bigRun(runId: string): Promise<void> {
    writeFileSync(join(ws, `${runId}.txt`), runId.padEnd(2_000, 'x'))
    await recordOriginal(runId, [ws], `${runId}.txt`)
    await flushCheckpoints()
    const t = new Date(1_700_000_000_000 + ++clock * 1_000)
    utimesSync(join(cpDir(), `${runId}.json`), t, t)
  }

  it('prunes the oldest run files once their total size passes the disk budget', async () => {
    _setCheckpointDiskBudget(5_000)
    for (let i = 0; i < 6; i++) await bigRun(`run-${i}`)
    const files = runFiles()
    // Each run file is a little over 2 KB, so only the newest two fit.
    expect(files.length).toBeLessThan(6)
    expect(files).toContain('run-5.json')
    expect(files).not.toContain('run-0.json')
    expect(diskBytes()).toBeLessThanOrEqual(5_000)
    // The newest run is kept and still reverts.
    expect(await restoreCheckpoint('run-5')).toBe(1)
  })

  it("never prunes a conversation's current run to make room", async () => {
    _setCheckpointDiskBudget(5_000)
    // conv1's run starts first, so it is the oldest file, and is still the chat's latest run.
    noteConversationRun('conv1', 'run-live')
    await bigRun('run-live')
    for (let i = 0; i < 4; i++) await bigRun(`run-${i}`)
    expect(runFiles()).toContain('run-live.json')
    expect(runFiles()).toContain('run-3.json')
    expect(runFiles()).not.toContain('run-0.json')
    // Evicted from memory or not, it still reverts from disk.
    clearCheckpoints()
    writeFileSync(join(ws, 'run-live.txt'), 'changed')
    expect(await restoreCheckpoint('run-live')).toBe(1)
    expect(readFileSync(join(ws, 'run-live.txt'), 'utf8')).toBe('run-live'.padEnd(2_000, 'x'))
  })

  it('leaves out a file that would take one run past its snapshot budget', async () => {
    _setRunSnapshotBudget(150)
    writeFileSync(join(ws, 'a.txt'), 'a'.repeat(100))
    writeFileSync(join(ws, 'b.txt'), 'b'.repeat(100))
    await recordOriginal('run-a', [ws], 'a.txt')
    await recordOriginal('run-a', [ws], 'b.txt')
    expect(checkpointFileCount('run-a')).toBe(1)

    // The post-write content counts too: past the budget, redo skips the file.
    writeFileSync(join(ws, 'a.txt'), 'A'.repeat(100))
    await recordResult('run-a', [ws], 'a.txt')
    expect(await restoreCheckpoint('run-a')).toBe(1)
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a'.repeat(100))
    expect(await reapplyCheckpoint('run-a')).toBe(0)
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('a'.repeat(100))
  })
})
