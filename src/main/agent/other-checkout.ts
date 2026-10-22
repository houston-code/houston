import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Detect a shell that has wandered into a *different checkout of the same repository*:
 * the main worktree from a linked one, or a sibling linked worktree. Such a directory
 * looks exactly like the project (same files, same remote, same history), so an agent
 * that `cd`s there and runs `git log` or reads files takes another branch's state for
 * its own. Detected by comparing git common directories, read straight from the `.git`
 * entries on disk: no git process, so no repository config gets a chance to run.
 */

/** Ancestors walked looking for a `.git` entry before giving up. */
const MAX_WALK = 64

interface Checkout {
  /** The checkout's top-level directory (where its `.git` entry lives). */
  root: string
  /** The repository's shared git directory (the main worktree's `.git`). */
  commonDir: string
  /** True for the main worktree, false for a linked one. */
  main: boolean
}

async function realOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return resolve(p)
  }
}

/** The checkout containing `dir`, or null outside a git repository. Never throws. */
async function checkoutOf(dir: string): Promise<Checkout | null> {
  let cur = resolve(dir)
  for (let i = 0; i < MAX_WALK; i++) {
    const dotGit = join(cur, '.git')
    try {
      const st = await fs.stat(dotGit)
      if (st.isDirectory()) return { root: cur, commonDir: await realOr(dotGit), main: true }
      if (st.isFile()) {
        // A linked worktree: ".git" is a "gitdir: <repo>/.git/worktrees/<name>" pointer,
        // and that directory's "commondir" file names the shared git dir (relative to it).
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, 'utf8'))
        if (!m) return null
        const gitDir = isAbsolute(m[1]) ? m[1] : resolve(cur, m[1])
        let common = gitDir
        try {
          const rel = (await fs.readFile(join(gitDir, 'commondir'), 'utf8')).trim()
          if (rel) common = isAbsolute(rel) ? rel : resolve(gitDir, rel)
        } catch {
          // a submodule's gitdir has no commondir: it is its own repository
        }
        return { root: cur, commonDir: await realOr(common), main: false }
      }
    } catch {
      // no .git here, keep walking up
    }
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Where the shell ended up, when that is another checkout of the workspace's repository. */
export interface OtherCheckout {
  /** The other checkout's top-level directory. */
  root: string
  /** True when it is the repository's main worktree. */
  main: boolean
}

/**
 * Return the other checkout `cwd` sits in, or null when `cwd` is inside one of `roots`,
 * outside any repository, or in an unrelated one. Never throws.
 */
export async function otherCheckout(workspace: string, roots: string[], cwd: string): Promise<OtherCheckout | null> {
  const realCwd = await realOr(cwd)
  for (const r of roots) if (within(realCwd, await realOr(r))) return null
  const [here, there] = await Promise.all([checkoutOf(workspace), checkoutOf(realCwd)])
  if (!here || !there || here.commonDir !== there.commonDir) return null
  if ((await realOr(here.root)) === (await realOr(there.root))) return null
  return { root: there.root, main: there.main }
}

/** The run_shell note for a shell sitting in another checkout of the same repository. */
export function otherCheckoutHint(cwd: string, other: OtherCheckout, workspace: string): string {
  const which = other.main ? "the repository's main checkout" : 'another worktree of this repository'
  return (
    `[note: the shell is now in "${cwd}", inside ${which} ("${other.root}"), not this project ("${workspace}"). ` +
    `That checkout has its own branch and files, so git output and file reads there do not describe your branch, ` +
    `and edits there land in someone else's work. Run \`cd "${workspace}"\` before continuing.]`
  )
}
