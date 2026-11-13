import { promises as fs, realpathSync } from 'node:fs'
import {
  canRevertHunks,
  fileDiffFromTexts,
  fileDiffSignature,
  revertHunkText,
  type ChangeRevertRequest,
  type ChangeRevertResult,
  type ChatChanges
} from '@shared/changes'
import { totalStat, type FileDiff } from '@shared/workingTree'
import { changeCurrentState, conversationChangeBases, writeChangeState, type ChangeBase } from './checkpoints'
import { collectWorkingTreeChanges } from './workingTree'
import { runGitCapture } from './gitRead'
import { resolveInWorkspace } from './tools'
import { writeFileAtomic } from '../atomic-write'

/**
 * The Changes view's turn and chat scopes, and every revert it offers. Reverts run
 * only on the file the view listed and only while its diff is still what the view
 * showed ({@link fileDiffSignature}), so a revert never discards something the user
 * did not see. Paths come from the change lists this module builds itself, never
 * from the caller on their own authority, and git runs through the hardened runner
 * (no hooks, no repo-defined filters) with argument arrays only.
 */

const NOT_SHOWN = 'Changed outside the project, a symlink, or too large to show'

/** One checkpoint base's diff against the file now, or null when it is unchanged. */
async function baseDiff(b: ChangeBase): Promise<FileDiff | null> {
  const cur = await changeCurrentState(b.roots, b.abs)
  if (!cur) {
    return { path: b.display, status: 'modified', hunks: [], added: 0, removed: 0, binary: false, note: NOT_SHOWN }
  }
  if (cur.content === b.before && cur.binary === b.beforeBinary) return null
  if (cur.binary || b.beforeBinary) {
    const status = b.before === null ? 'added' : cur.content === null ? 'deleted' : 'modified'
    return { path: b.display, status, hunks: [], added: 0, removed: 0, binary: true, note: 'Binary file' }
  }
  return fileDiffFromTexts(b.display, b.before, cur.content)
}

/** What the chat's latest turn (`turn`) or all its turns (`chat`) changed, as diffs. */
export async function collectChatChanges(conversationId: string, scope: 'turn' | 'chat'): Promise<ChatChanges> {
  const { bases, unavailable } = await conversationChangeBases(conversationId, scope)
  const files: FileDiff[] = []
  for (const b of bases) {
    const d = await baseDiff(b)
    if (d) files.push(d)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, ...totalStat(files), unavailable }
}

export interface RevertDeps {
  /** Whether the chat has a run in progress (its turn would fight the revert). */
  runActive: (conversationId: string) => boolean
  /** Whether `workspace` is one the app knows (a recent project or a chat's folder). */
  knownWorkspace: (workspace: string) => boolean
}

const fail = (error: string): ChangeRevertResult => ({ ok: false, error })
const STALE = 'This file changed since the list was loaded. Refresh and try again.'

/** Revert a whole file or one hunk, in the scope the view showed it. */
export async function revertChange(req: ChangeRevertRequest, deps: RevertDeps): Promise<ChangeRevertResult> {
  if (!req || typeof req.path !== 'string' || !req.path || typeof req.signature !== 'string') {
    return fail('Invalid revert request.')
  }
  if (req.hunk !== undefined && !(Number.isSafeInteger(req.hunk) && req.hunk >= 0)) return fail('Invalid revert request.')
  try {
    if (req.scope === 'turn' || req.scope === 'chat') return await revertInChat(req, deps)
    if (req.scope === 'tree') return await revertInTree(req, deps)
    return fail('Invalid revert request.')
  } catch (e) {
    return fail(`Could not revert: ${(e as Error).message}`)
  }
}

async function revertInChat(req: ChangeRevertRequest, deps: RevertDeps): Promise<ChangeRevertResult> {
  const id = req.conversationId
  if (typeof id !== 'string' || !id) return fail('Invalid revert request.')
  if (deps.runActive(id)) return fail('Wait for the current run to finish.')
  const { bases } = await conversationChangeBases(id, req.scope === 'turn' ? 'turn' : 'chat')
  const base = bases.find((b) => b.display === req.path)
  if (!base) return fail(STALE)
  const diff = await baseDiff(base)
  if (!diff || fileDiffSignature(diff) !== req.signature) return fail(STALE)
  if (req.hunk === undefined) {
    const ok = await writeChangeState(base.roots, base.abs, base.before, base.beforeBinary)
    return ok ? { ok: true } : fail(NOT_SHOWN)
  }
  const hunk = diff.hunks[req.hunk]
  if (!hunk || !canRevertHunks(diff)) return fail('That change can only be reverted as a whole file.')
  const cur = await changeCurrentState(base.roots, base.abs)
  if (!cur || cur.content === null || cur.binary) return fail(STALE)
  const next = revertHunkText(cur.content, hunk)
  if (next === null) return fail(STALE)
  const ok = await writeChangeState(base.roots, base.abs, next)
  return ok ? { ok: true } : fail(NOT_SHOWN)
}

async function revertInTree(req: ChangeRevertRequest, deps: RevertDeps): Promise<ChangeRevertResult> {
  if (typeof req.workspace !== 'string' || !req.workspace || !deps.knownWorkspace(req.workspace)) {
    return fail('Unknown project folder.')
  }
  if (req.conversationId && deps.runActive(req.conversationId)) return fail('Wait for the current run to finish.')
  const root = realpathSync(req.workspace)
  const changes = await collectWorkingTreeChanges(root)
  if (!changes.isRepo) return fail('This folder is not a git repository.')
  const file = changes.files.find((f) => f.path === req.path)
  if (!file || fileDiffSignature(file) !== req.signature) return fail(STALE)
  // Every path named below comes from git's own listing and must still resolve
  // inside the workspace (a symlinked parent can't redirect the write).
  const abs = resolveInWorkspace(root, file.path)
  const oldAbs = file.oldPath ? resolveInWorkspace(root, file.oldPath) : null

  if (req.hunk !== undefined) {
    const hunk = file.hunks[req.hunk]
    if (!hunk || !canRevertHunks(file)) return fail('That change can only be reverted as a whole file.')
    const st = await fs.lstat(abs)
    if (!st.isFile()) return fail(NOT_SHOWN)
    const next = revertHunkText(await fs.readFile(abs, 'utf8'), hunk)
    if (next === null) return fail(STALE)
    await writeFileAtomic(abs, next, st.mode & 0o777)
    return { ok: true }
  }

  // --literal-pathspecs: a file named like pathspec magic (`:(glob)*`) names only itself.
  const git = async (args: string[]): Promise<void> => {
    const r = await runGitCapture(['--literal-pathspecs', ...args], root)
    if (!r.ok) throw new Error(r.stderr.trim().split('\n')[0] || `git ${args[0]} failed`)
  }
  const removeFile = async (p: string): Promise<void> => {
    // rm on a symlink removes the link itself, never its target; never a directory.
    const st = await fs.lstat(p).catch(() => null)
    if (st && !st.isDirectory()) await fs.rm(p, { force: true })
  }
  switch (file.status) {
    case 'untracked':
      await removeFile(abs)
      return { ok: true }
    case 'added':
      await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file.path])
      await removeFile(abs)
      return { ok: true }
    case 'renamed':
      if (file.oldPath && oldAbs) await git(['checkout', 'HEAD', '--', file.oldPath])
      await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file.path])
      await removeFile(abs)
      return { ok: true }
    case 'modified':
    case 'deleted':
      await git(['checkout', 'HEAD', '--', file.path])
      return { ok: true }
  }
}
