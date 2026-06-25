import { realpathSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseUnifiedDiff,
  untrackedToFileDiff,
  totalStat,
  type FileDiff,
  type WorkingTreeChanges
} from '@shared/workingTree'
import { runGitCapture } from './gitRead'

/** Cap how many untracked files we read so a junk-filled tree can't stall the UI. */
const MAX_UNTRACKED_FILES = 200

/** Per-file content cap; larger untracked files show a note instead of contents. */
const MAX_FILE_BYTES = 256_000

/** How many leading bytes to scan for a NUL when sniffing binary content. */
const BINARY_SNIFF_BYTES = 8000

const NOT_A_REPO: WorkingTreeChanges = {
  isRepo: false,
  branch: null,
  files: [],
  added: 0,
  removed: 0
}

/** True if the buffer looks binary (contains a NUL byte in its leading bytes). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Read one untracked file into a FileDiff (or a note for binary/oversized/unreadable). */
function readUntracked(root: string, rel: string): FileDiff {
  try {
    const full = join(root, rel)
    const size = statSync(full).size
    if (size > MAX_FILE_BYTES) {
      return untrackedToFileDiff(rel, null, { tooLargeKb: Math.round(size / 1024) })
    }
    const buf = readFileSync(full)
    if (looksBinary(buf)) return untrackedToFileDiff(rel, null, { binary: true })
    return untrackedToFileDiff(rel, buf.toString('utf8'))
  } catch {
    return untrackedToFileDiff(rel, null, { unreadable: true })
  }
}

/**
 * Collect every uncommitted change in the workspace's working tree — the diff of
 * tracked files vs HEAD (staged + unstaged) plus the contents of untracked,
 * non-ignored files — as a structured set for the Changes panel.
 *
 * Read-only and hardened (see {@link runGitCapture}); never throws. A non-repo or
 * unreadable workspace yields `isRepo: false`. Scope is the whole working tree,
 * not just the current chat's edits.
 */
export async function collectWorkingTreeChanges(workspace: string): Promise<WorkingTreeChanges> {
  if (!workspace) return NOT_A_REPO
  let root: string
  try {
    root = realpathSync(workspace)
  } catch {
    return NOT_A_REPO
  }

  const inside = await runGitCapture(['rev-parse', '--is-inside-work-tree'], root)
  if (!inside.ok || inside.stdout.trim() !== 'true') return NOT_A_REPO

  let branch: string | null = null
  const head = await runGitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (head.ok) branch = head.stdout.trim() || null

  // Tracked changes vs HEAD. On an unborn HEAD (no commits yet) this fails — the
  // untracked listing below then carries the whole change set.
  const diff = await runGitCapture(
    ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv'],
    root
  )
  const tracked = diff.ok ? parseUnifiedDiff(diff.stdout) : []

  // Untracked, non-ignored files. -z keeps paths with spaces/newlines intact.
  const others = await runGitCapture(['ls-files', '--others', '--exclude-standard', '-z'], root)
  const untrackedPaths = others.ok
    ? others.stdout.split('\0').map((p) => p.replace(/\r$/, '')).filter(Boolean)
    : []
  const truncated = untrackedPaths.length > MAX_UNTRACKED_FILES
  const untracked = untrackedPaths
    .slice(0, MAX_UNTRACKED_FILES)
    .map((rel) => readUntracked(root, rel))

  const files = [...tracked, ...untracked]
  const { added, removed } = totalStat(files)
  return { isRepo: true, branch, files, added, removed, ...(truncated ? { truncated: true } : {}) }
}
