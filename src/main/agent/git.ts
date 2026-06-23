import { execFile } from 'node:child_process'

/**
 * Lightweight git awareness: at the start of a run we read the workspace's
 * current branch and working-tree status and fold a short summary into the system
 * prompt, so the agent knows what branch it's on and what's already modified
 * without having to run git itself. Read-only git commands, so they don't go
 * through the sandbox; never throws (a non-repo just yields no context).
 */

/** Max porcelain lines to include verbatim. */
const MAX_STATUS_LINES = 20

export type GitExec = (args: string[], cwd: string) => Promise<string>

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5000, maxBuffer: 1_000_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/** Format the branch + porcelain status into a compact prompt section. Pure. */
export function formatGitContext(branch: string | null, statusPorcelain: string): string {
  if (!branch) return ''
  const lines = statusPorcelain.split('\n').filter((l) => l.trim().length > 0)
  const summary =
    lines.length === 0
      ? 'working tree clean'
      : `${lines.length} uncommitted change${lines.length === 1 ? '' : 's'}`
  let out = `Git: on branch "${branch}" — ${summary}.`
  if (lines.length > 0) {
    const shown = lines.slice(0, MAX_STATUS_LINES).join('\n')
    out += `\nChanged files (git status --porcelain):\n${shown}`
    if (lines.length > MAX_STATUS_LINES) out += `\n… and ${lines.length - MAX_STATUS_LINES} more`
  }
  return out
}

/** Read the workspace's git context, or '' if it isn't a git repo. `exec` is injectable for tests. */
export async function gitContext(workspace: string, exec: GitExec = runGit): Promise<string> {
  let branch: string
  try {
    branch = (await exec(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)).trim()
  } catch {
    return '' // not a git repo (or git unavailable)
  }
  if (!branch) return ''
  let status = ''
  try {
    status = await exec(['status', '--porcelain'], workspace)
  } catch {
    // status failed (e.g. detached/edge state) — still report the branch.
  }
  return formatGitContext(branch, status)
}
