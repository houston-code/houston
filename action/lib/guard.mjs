// What the action checks between Houston finishing and anything leaving the runner: that
// the run didn't rewrite the git configuration the action's own git commands will read,
// that nothing it is about to post or push contains a credential, and that text echoed to
// the job log can't act as a workflow command.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Git settings for every git command the action runs after the agent has had the
 * checkout. A fix-ci run edits files with `.git` in reach, so the action never runs a
 * hook the run could have planted, and the snapshot below refuses a changed config.
 */
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false']

/** The files under `.git` that change what a git command executes. */
function controlFiles(gitDir) {
  // The directories themselves too, so swapping one for a symlink shows up.
  const files = ['config', 'info', 'info/attributes', 'hooks']
  const walk = (rel) => {
    const abs = join(gitDir, rel)
    if (!lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) return
    for (const name of readdirSync(abs).sort()) {
      const sub = `${rel}/${name}`
      // lstat: a symlinked directory is recorded as a link, never followed.
      if (lstatSync(join(gitDir, sub)).isDirectory()) walk(sub)
      else files.push(sub)
    }
  }
  walk('hooks')
  return files
}

/** A file's sha256, a symlink's target, or `missing`. Never follows a link. */
function fingerprint(abs) {
  const st = lstatSync(abs, { throwIfNoEntry: false })
  if (!st) return 'missing'
  if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`
  if (!st.isFile()) return `special:${st.mode}`
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/** sha256 of each control file (or `missing`), keyed by its path under `.git`. */
export function snapshotGitControl(repoDir) {
  const gitDir = join(repoDir, '.git')
  if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${repoDir} is not a plain git checkout (no .git directory)`)
  }
  const snap = {}
  for (const rel of controlFiles(gitDir)) {
    snap[rel] = fingerprint(join(gitDir, rel))
  }
  return snap
}

/** The control files that differ between two snapshots, added and removed ones included. */
export function changedControlFiles(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => (before[k] ?? 'missing') !== (after[k] ?? 'missing')).sort()
}

/** Env var names that hold credentials, matching the CLI's own child-env filter. */
const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH)/i

/** The credential values in `env` (and any extras) worth refusing to publish. */
export function secretValues(env, extra = []) {
  const out = new Set()
  for (const [name, value] of Object.entries(env)) {
    if (name === 'SSH_AUTH_SOCK' || typeof value !== 'string') continue
    if (SECRET_NAME.test(name) && value.trim().length >= 8) out.add(value.trim())
  }
  for (const v of extra) if (typeof v === 'string' && v.trim().length >= 8) out.add(v.trim())
  return [...out]
}

/** True when `text` contains any of the secret values verbatim. */
export function containsSecret(text, secrets) {
  return secrets.some((s) => text.includes(s))
}

/**
 * Text from the run (tool names, error messages) made safe for the job log. The runner
 * reads a line starting with `::` as a workflow command, so every `::` is broken and line
 * breaks are flattened.
 */
export function logSafe(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/::/g, ': :')
    .slice(0, 2000)
}

/**
 * The fix branch for a failed run. Its name comes only from numbers in the event, and it
 * always sits under the prefix, so the push target can never be the default branch or the
 * branch that failed.
 */
export function fixBranchName(prefix, runId, attempt) {
  if (!/^[A-Za-z0-9._/-]+\/$/.test(prefix) || prefix.includes('..')) {
    throw new Error(`branch-prefix must be a plain path ending in "/", like houston/ (got ${JSON.stringify(prefix)})`)
  }
  return `${prefix}fix-ci-${runId}-${attempt}`
}

/** Refuse a push target that is the default branch or outside the fix prefix. */
export function assertPushTarget(branch, { prefix, defaultBranch, failedBranch }) {
  if (!branch.startsWith(prefix)) throw new Error(`refusing to push ${branch}: not under ${prefix}`)
  if (branch === defaultBranch || branch === failedBranch) throw new Error(`refusing to push to ${branch}`)
}

/** GitHub's comment limit is 65536 characters; leave room for the footer. */
export const MAX_BODY = 60000

export function capBody(text) {
  return text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY)}\n\n(truncated)`
}
