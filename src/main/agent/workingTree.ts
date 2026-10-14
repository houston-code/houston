import { realpathSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  parseUnifiedDiff,
  untrackedToFileDiff,
  totalStat,
  type FileDiff,
  type WorkingTreeChanges
} from '@shared/workingTree'
import { classifyRemoteUrl, type RepoShipState } from '@shared/shipAction'
import { runGitCapture, captureTry, uncommittedDiffBase } from './gitRead'

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

  // symbolic-ref names the branch even when unborn (no commits yet) and fails
  // only on a detached HEAD, where `rev-parse --abbrev-ref` would say "HEAD".
  let branch: string | null = null
  const head = await runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  if (head.ok) branch = head.stdout.trim() || null

  // Tracked changes (staged + unstaged) vs HEAD, or vs the empty tree on an
  // unborn HEAD (no commits yet) so staged files still show.
  const base = await uncommittedDiffBase(captureTry(root))
  const diff = await runGitCapture(
    ['diff', base, '--no-color', '--no-ext-diff', '--no-textconv'],
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
  const ship = await collectShipState(root)
  return {
    isRepo: true,
    branch,
    files,
    added,
    removed,
    ship,
    ...(truncated ? { truncated: true } : {})
  }
}

/**
 * Whether HEAD has a commit and which remote changes would ship to, so the UI can
 * offer "Publish to GitHub" in a fresh repo instead of a "Create PR" that can only
 * fail. Prefers `origin`, else the first remote. Only the remote's name and host
 * class are returned; the URL stays in this process because it can carry a token.
 */
export async function collectShipState(
  root: string,
  githubHosts: readonly string[] = knownGithubHosts()
): Promise<RepoShipState> {
  const [head, remotes] = await Promise.all([
    runGitCapture(['rev-parse', '--verify', '--quiet', 'HEAD'], root),
    runGitCapture(['remote'], root)
  ])
  const hasCommits = head.ok && head.stdout.trim() !== ''
  const names = remotes.ok
    ? remotes.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : []
  const name = names.includes('origin') ? 'origin' : names[0]
  if (!name) return { hasCommits, remote: null }
  const url = await runGitCapture(['remote', 'get-url', name], root)
  const host = url.ok ? classifyRemoteUrl(url.stdout, githubHosts) : 'other'
  return { hasCommits, remote: { name, host } }
}

/** Where `gh` keeps `hosts.yml`, following gh's own config-dir lookup order. */
export function ghHostsFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, 'hosts.yml')
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh', 'hosts.yml')
  if (platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI', 'hosts.yml')
  return join(home, '.config', 'gh', 'hosts.yml')
}

/**
 * Hosts `gh` can open pull requests on beyond github.com: the GitHub Enterprise
 * Server hosts it is signed in to (the top-level keys of its `hosts.yml`) plus
 * `GH_HOST`. Without these an Enterprise remote would be offered "Commit & push"
 * instead of "Create PR", although `gh` handles it fine. Only host names are
 * read; tokens in the file are never touched beyond the line scan. Best-effort:
 * an unreadable file just means no extra hosts.
 */
export function knownGithubHosts(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string | null = readTextOrNull
): string[] {
  const hosts = new Set<string>()
  if (env.GH_HOST) hosts.add(env.GH_HOST.trim().toLowerCase())
  const yml = readFile(ghHostsFile(env))
  if (yml) {
    for (const line of yml.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9.-]*):\s*$/.exec(line)
      if (m) hosts.add(m[1].toLowerCase())
    }
  }
  hosts.delete('')
  return [...hosts]
}

function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
