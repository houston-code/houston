import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { ConversationWorktree, WorktreeRemoval } from '@shared/agent'
import { isSafeGitRef, suggestBranch } from '@shared/git'
import { createWorktree, getRepoInfo, removeWorktree, runGit, type GitRun } from './agent/worktree'
import { stripControlChars } from './tui-wrap'

/**
 * `houston -w [name]`: a terminal session that starts in a fresh git worktree.
 *
 * The worktree is made by the same helper the desktop app's new-worktree chats and
 * the agent's `spawn_session` use (`createWorktree`), so it lands in the same place
 * (`<repo>/.houston/worktrees/<slug>`) on a branch named the same way (a generated
 * `swift-otter-78dj6e` unless one is given). The conversation records it like any
 * other worktree chat, so the desktop app shows and cleans it up the same way.
 *
 * What happens to it afterwards differs by client: an interactive session removes an
 * unused one on exit and asks about one with work in it; a one-shot run keeps it.
 * Nothing here ever removes a worktree on a signal.
 */

/** A worktree started for this session, with the commit it branched from. */
export interface SessionWorktree extends ConversationWorktree {
  /** The commit the branch started at (the folder's HEAD when the session began). */
  base: string
}

/** The worktree record a conversation keeps (without the session-only base). */
export function conversationWorktree(wt: SessionWorktree): ConversationWorktree {
  return { path: wt.path, branch: wt.branch, repoRoot: wt.repoRoot }
}

export type SessionWorktreeSetup =
  | { ok: true; worktree: SessionWorktree }
  /** `code` is the exit code: 2 for a usage problem (no repository, a taken name), else 1. */
  | { ok: false; error: string; code: 1 | 2 }

/**
 * Create the session's worktree from `cwd`'s current HEAD. Refuses, with a usage
 * error, a folder outside a git repository, a branch name that is taken or unusable,
 * and a repository with no commit to branch from. `exec` runs git (hardened, no
 * shell); injectable for tests along with the name generator.
 */
export async function createSessionWorktree(
  cwd: string,
  name: string | undefined,
  deps: { exec?: GitRun; newName?: () => string } = {}
): Promise<SessionWorktreeSetup> {
  const exec = deps.exec ?? runGit
  const branch = name?.trim() || (deps.newName ?? suggestBranch)()
  if (!isSafeGitRef(branch)) {
    return { ok: false, code: 2, error: `--worktree: "${branch}" is not a usable branch name` }
  }
  const repo = await getRepoInfo(cwd, exec)
  if (!repo.exists) return { ok: false, code: 2, error: `--worktree: ${cwd} does not exist` }
  if (!repo.isRepo) {
    return {
      ok: false,
      code: 2,
      error: `--worktree needs a git repository, and ${cwd} is not inside one. Run houston without -w here, or git init first.`
    }
  }
  if (repo.branches.includes(branch)) {
    return {
      ok: false,
      code: 2,
      error: `--worktree: a branch named "${branch}" already exists. Pick another name, or pass -w alone for a generated one.`
    }
  }
  // The branch starts at this folder's HEAD (which may be a linked worktree on its
  // own branch), not the main checkout's: "from where I am" is what -w means.
  let base: string
  try {
    base = (await exec(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd)).trim()
  } catch {
    base = ''
  }
  if (!/^[0-9a-f]{7,64}$/.test(base)) {
    return {
      ok: false,
      code: 2,
      error: '--worktree: this repository has no commits yet, so there is nothing to branch from. Make a first commit, then try again.'
    }
  }
  try {
    const wt = await createWorktree({ workspace: cwd, branch, base }, exec)
    // git reports paths with forward slashes on Windows; store them the platform's way so
    // they match the folder the session runs in and the chats that record it.
    return { ok: true, worktree: { ...wt, path: resolvePath(wt.path), repoRoot: resolvePath(wt.repoRoot), base } }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // A name taken between the check and the create (or a ref git won't take) is
    // still the caller's to fix.
    const taken = /already exists/i.test(message)
    return {
      ok: false,
      code: taken ? 2 : 1,
      error: `--worktree: couldn't create the worktree: ${message.replace(/^(fatal|error):\s*/i, '').trim()}`
    }
  }
}

/** What is in a session worktree that removing it would lose. */
export interface WorktreeWork {
  /** Uncommitted changes or untracked files. */
  dirty: boolean
  /** Commits on its branch beyond the commit it started from. */
  commits: number
}

/** Read what the worktree holds, or null when it is gone or git can't say (then: keep it). */
export async function worktreeWork(
  wt: SessionWorktree,
  exec: GitRun = runGit,
  exists: (p: string) => boolean = existsSync
): Promise<WorktreeWork | null> {
  if (!exists(wt.path) || !isSafeGitRef(wt.branch)) return null
  try {
    const status = await exec(['status', '--porcelain'], wt.path)
    // Fully qualified, so the branch can never be read as an option. HEAD too: commits
    // made on a detached HEAD (or another branch checked out there) are on no ref the
    // branch would show, and removing the checkout would lose them.
    const count = (await exec(['rev-list', '--count', `${wt.base}..refs/heads/${wt.branch}`, 'HEAD'], wt.path)).trim()
    const commits = Number.parseInt(count, 10)
    if (!Number.isFinite(commits)) return null
    return { dirty: status.trim() !== '', commits }
  } catch {
    return null
  }
}

/** Quote a path for a shell command line when it needs it. Pure. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The command that reopens the session in its worktree. Pure. */
export function comeBackCommand(path: string, conversationId: string | null): string {
  const p = shellQuote(path)
  return conversationId ? `houston --resume ${conversationId} -C ${p}` : `houston -C ${p}`
}

/** How a keep-or-remove answer reads: removal only when asked for by name. Pure. */
export function parseKeepOrRemove(answer: string | null): 'keep' | 'remove' {
  const a = (answer ?? '').trim().toLowerCase()
  return a === 'r' || a === 'remove' ? 'remove' : 'keep'
}

/** Whether the second confirmation was given: the word itself, nothing shorter. Pure. */
export function confirmsRemoval(answer: string | null): boolean {
  return (answer ?? '').trim().toLowerCase() === 'remove'
}

/** A description of the work in a worktree, for the keep-or-remove question. Pure. */
export function describeWork(work: WorktreeWork): string {
  const parts: string[] = []
  if (work.commits > 0) parts.push(`${work.commits} commit${work.commits === 1 ? '' : 's'}`)
  if (work.dirty) parts.push('uncommitted changes')
  return parts.join(' and ')
}

export interface FinishWorktreeDeps {
  out: (s: string) => void
  /** Ask a question and read the answer (null on end of input: the worktree is kept). */
  ask: (prompt: string) => Promise<string | null>
  /** Dim styling for status lines. Defaults to none. */
  dim?: (s: string) => string
  /** The session's last chat, for the come-back command. */
  conversationId: string | null
  /** Point the chats that used the worktree back at the repository, once it is removed. */
  detach: (wt: ConversationWorktree) => void
  exec?: GitRun
  exists?: (p: string) => boolean
  remove?: (wt: ConversationWorktree, opts: { force?: boolean; branch?: 'safe' | 'force' }) => Promise<WorktreeRemoval>
}

/**
 * End an interactive session that started in its own worktree. An unused one (no
 * changes, no commits beyond where it started) is removed with its branch, since it
 * holds nothing. One with work in it is kept unless the user asks to remove it, and
 * uncommitted work goes only after a second, typed confirmation; commits survive a
 * removal on their branch. A kept worktree gets the command that comes back to it.
 */
export async function finishSessionWorktree(
  wt: SessionWorktree,
  deps: FinishWorktreeDeps
): Promise<'removed' | 'kept'> {
  const dim = deps.dim ?? ((s: string) => s)
  const remove = deps.remove ?? ((w, opts) => removeWorktree(w, opts))
  const shown = stripControlChars(wt.path)
  const kept = (): 'kept' => {
    deps.out(dim(`· kept the worktree at ${shown} (branch ${wt.branch})\n`))
    deps.out(dim(`  come back with: ${stripControlChars(comeBackCommand(wt.path, deps.conversationId))}\n`))
    return 'kept'
  }
  const removed = (res: WorktreeRemoval, what: string): 'removed' | 'kept' => {
    if (!res.removed) {
      if (res.message) deps.out(dim(`· ${stripControlChars(res.message)}\n`))
      return kept()
    }
    deps.detach(conversationWorktree(wt))
    deps.out(dim(`· ${what}\n`))
    if (res.message) deps.out(dim(`· ${stripControlChars(res.message)}\n`))
    return 'removed'
  }

  const work = await worktreeWork(wt, deps.exec, deps.exists)
  if (!work) {
    if ((deps.exists ?? existsSync)(wt.path)) return kept()
    return 'removed' // already gone: nothing to keep or remove
  }
  if (!work.dirty && work.commits === 0) {
    // Nothing of its own: the checkout and the branch both go. The checkout removal
    // still refuses a dirty tree, so a change made since the check is never lost.
    return removed(await remove(wt, { branch: 'force' }), `removed the unused worktree ${shown} and its branch ${wt.branch}`)
  }

  deps.out(`\nThe worktree at ${shown} (branch ${wt.branch}) has ${describeWork(work)}.\n`)
  const choice = parseKeepOrRemove(await deps.ask('Keep it or remove it? [K/r] '))
  if (choice === 'keep') return kept()
  if (work.dirty) {
    const confirm = await deps.ask(
      'Removing it deletes the uncommitted changes for good. Type "remove" to confirm, anything else keeps it: '
    )
    if (!confirmsRemoval(confirm)) return kept()
    return removed(
      await remove(wt, { force: true, branch: 'safe' }),
      `removed the worktree ${shown} and its uncommitted changes`
    )
  }
  // Only commits: the checkout goes, the branch keeps them unless they are merged.
  return removed(await remove(wt, {}), `removed the worktree ${shown}`)
}

/**
 * The folder a `--resume <id>` session should open in: the chat's worktree when it
 * has one that still exists and the session isn't already there, else null. Pure
 * apart from the existence probe.
 */
export function resumeWorktreeFolder(
  conv: { worktree?: ConversationWorktree } | null | undefined,
  cwd: string,
  exists: (p: string) => boolean = existsSync
): string | null {
  const path = conv?.worktree?.path
  if (!path || !exists(path)) return null
  return resolvePath(cwd) === resolvePath(path) ? null : path
}

/**
 * The folder a `--resume <id>` session should open in when the chat has no worktree
 * of its own: the folder it was saved in, when that still exists and the session isn't
 * already there, else null (the chat then opens where `houston` was started). Pure
 * apart from the existence probe.
 */
export function resumeChatFolder(
  conv: { workspace?: string; worktree?: ConversationWorktree } | null | undefined,
  cwd: string,
  exists: (p: string) => boolean = existsSync
): string | null {
  const path = conv?.workspace
  if (!path || conv?.worktree || !exists(path)) return null
  return resolvePath(cwd) === resolvePath(path) ? null : path
}
