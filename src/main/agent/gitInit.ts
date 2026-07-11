import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import type { GitInitResult } from '@shared/git'
import { GIT_ENV, GIT_HARDENING } from './gitRead'

function runGit(args: string[], cwd: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 10_000, maxBuffer: 1_000_000, windowsHide: true },
      (err, _stdout, stderr) => resolve({ ok: !err, stderr: (stderr || '').trim() })
    )
  })
}

/**
 * Initialize a git repository in `workspace` so its contents become visible in the
 * Changes panel and can be reviewed / committed / turned into a PR. A bare `git init`
 * is enough — the working-tree collector already treats an unborn HEAD's untracked
 * files as the whole change set, so no initial commit is made here (the user reviews
 * first). Idempotent: an existing repo is left untouched and reported as such.
 *
 * The workspace path comes from the app's own conversation record, not user free-text,
 * but we still validate it resolves to a real directory before touching it.
 */
export async function initGitRepo(workspace: string): Promise<GitInitResult> {
  if (!workspace || typeof workspace !== 'string') {
    return { ok: false, error: 'No workspace to initialize.' }
  }

  let root: string
  try {
    root = realpathSync(workspace)
    if (!statSync(root).isDirectory()) return { ok: false, error: 'Workspace is not a directory.' }
  } catch {
    return { ok: false, error: 'Workspace directory does not exist.' }
  }

  // Idempotent: never re-init a directory that is already inside a work tree (which
  // could be the workspace itself or a parent repo) — that would be surprising and,
  // for a nested path, could create a repo inside another one.
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root)
  if (inside.ok) return { ok: true, alreadyRepo: true }

  const init = await runGit(['init'], root)
  if (!init.ok) return { ok: false, error: init.stderr || 'git init failed.' }
  return { ok: true }
}
