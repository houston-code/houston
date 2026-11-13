import { createHash } from 'node:crypto'
import { realpathSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  parseUnifiedDiff,
  untrackedToFileDiff,
  totalStat,
  type FileDiff,
  type WorkingTreeChanges,
  type WorkingTreeStats
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
  const root = await workTreeRoot(workspace)
  if (!root) return NOT_A_REPO

  const branch = await currentBranch(root)

  // Tracked changes (staged + unstaged) vs HEAD, or vs the empty tree on an
  // unborn HEAD (no commits yet) so staged files still show.
  const base = await uncommittedDiffBase(captureTry(root))
  const diff = await runGitCapture(
    ['diff', base, '--no-color', '--no-ext-diff', '--no-textconv'],
    root
  )
  const tracked = diff.ok ? parseUnifiedDiff(diff.stdout) : []

  const untrackedPaths = await listUntracked(root)
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

/** Cap on how many changed paths a fingerprint stats, so a huge dirty tree stays cheap. */
const MAX_FINGERPRINT_PATHS = 5_000

/**
 * A cheap fingerprint of the working tree's uncommitted state: HEAD's commit, the
 * `git status` listing (tracked changes and untracked, non-ignored files), and the
 * size and modification time of every listed path. Two fingerprints differ when a
 * command edited, created, deleted, staged, or committed a file between them,
 * including a further edit to a file that was already dirty. Ignored files don't
 * count. Null outside a git work tree or when git fails, so a caller can't mistake
 * "unknown" for "unchanged".
 *
 * Read-only and hardened (see {@link runGitCapture}); never throws.
 */
export async function workingTreeFingerprint(workspace: string): Promise<string | null> {
  const root = await workTreeRoot(workspace)
  if (!root) return null
  const [head, status] = await Promise.all([
    runGitCapture(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root),
    runGitCapture(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
  ])
  if (!status.ok) return null
  const hash = createHash('sha256')
  hash.update(head.ok ? head.stdout.trim() : 'unborn')
  hash.update('\0')
  hash.update(status.stdout)
  const parts = status.stdout.split('\0')
  let statted = 0
  for (let i = 0; i < parts.length && statted < MAX_FINGERPRINT_PATHS; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    // A rename or copy record is followed by its source path as one more field.
    if (entry[0] === 'R' || entry[0] === 'C') i++
    const rel = entry.slice(3)
    statted++
    try {
      const st = statSync(join(root, rel))
      hash.update(`\0${rel}\0${st.size}\0${st.mtimeMs}`)
    } catch {
      hash.update(`\0${rel}\0missing`)
    }
  }
  return hash.digest('hex')
}

/** The workspace's real path when it is inside a git work tree, else null. */
async function workTreeRoot(workspace: string): Promise<string | null> {
  if (!workspace) return null
  let root: string
  try {
    root = realpathSync(workspace)
  } catch {
    return null
  }
  const inside = await runGitCapture(['rev-parse', '--is-inside-work-tree'], root)
  return inside.ok && inside.stdout.trim() === 'true' ? root : null
}

/**
 * The checked-out branch, or null on a detached HEAD. symbolic-ref names the branch
 * even when unborn (no commits yet) and fails only on a detached HEAD, where
 * `rev-parse --abbrev-ref` would say "HEAD".
 */
async function currentBranch(root: string): Promise<string | null> {
  const head = await runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  return head.ok ? head.stdout.trim() || null : null
}

/** Untracked, non-ignored paths. -z keeps paths with spaces/newlines intact. */
async function listUntracked(root: string): Promise<string[]> {
  const others = await runGitCapture(['ls-files', '--others', '--exclude-standard', '-z'], root)
  return others.ok
    ? others.stdout.split('\0').map((p) => p.replace(/\r$/, '')).filter(Boolean)
    : []
}

/**
 * Sum a `git diff --numstat -z` listing. Each changed file is one record,
 * `added\tremoved\tpath`, or for a rename or copy `added\tremoved\t` followed by
 * the old and new paths as two more NUL-terminated fields. A binary file reads
 * `-\t-` and counts as zero lines, as it does in the parsed diff.
 */
export function sumNumstat(out: string): { files: number; added: number; removed: number } {
  const parts = out.split('\0')
  let files = 0
  let added = 0
  let removed = 0
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i])
    if (!m) continue
    if (m[3] === '') i += 2 // a rename or copy: skip its old and new path fields
    files++
    if (m[1] !== '-') added += Number(m[1])
    if (m[2] !== '-') removed += Number(m[2])
  }
  return { files, added, removed }
}

/**
 * The counts behind the Changes badge (file count, added and removed lines, ship
 * state): the numbers {@link collectWorkingTreeChanges} yields for the same tree,
 * without building or shipping the full diff. Tracked files are summed from
 * `git diff --numstat` rather than a parsed patch; untracked files are counted
 * exactly as the full path counts them, under the same file cap.
 */
export async function collectWorkingTreeStats(workspace: string): Promise<WorkingTreeStats> {
  const root = await workTreeRoot(workspace)
  if (!root) return { isRepo: false, branch: null, fileCount: 0, added: 0, removed: 0 }

  const base = await uncommittedDiffBase(captureTry(root))
  const [branch, diff, untrackedPaths, ship] = await Promise.all([
    currentBranch(root),
    runGitCapture(
      ['diff', base, '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv'],
      root
    ),
    listUntracked(root),
    collectShipState(root)
  ])
  const tracked = diff.ok ? sumNumstat(diff.stdout) : { files: 0, added: 0, removed: 0 }
  const untracked = untrackedPaths.slice(0, MAX_UNTRACKED_FILES)
  let added = tracked.added
  for (const rel of untracked) added += readUntracked(root, rel).added
  return {
    isRepo: true,
    branch,
    fileCount: tracked.files + untracked.length,
    added,
    removed: tracked.removed,
    ship
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
