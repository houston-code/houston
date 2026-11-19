import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { ChatMessage, Provider } from '@shared/agent'
import {
  cleanCommitMessage,
  parsePrView,
  type BranchSync,
  type GitActionResult,
  type PrLookup
} from '@shared/gitActions'
import { workingTreeToText, type WorkingTreeChanges } from '@shared/workingTree'
import { collectSecrets, getProvider, getSettings } from '../agentHost'
import { peekConversation } from '../conversations'
import { createProvider } from '../providers'
import { GIT_ENV, hardenedGitArgs, runGitCapture, scopedConfig } from './gitRead'
import { ghAuthedHosts, ghRepoEnv, ghRepoKey, resolveGh, runGh, type GhExec } from './github'
import { gitExecutable } from './gitBinary'
import { redactSecrets } from './redact'
import { providerStreamError, withProviderRetry } from './retry'
import { isSensitivePath } from './sensitive-paths'
import { titleRequestOptions } from './title'
import { collectWorkingTreeChanges } from './workingTree'

/**
 * Git and GitHub actions the desktop app runs itself, without an agent turn: commit
 * every change, push the branch, suggest a commit message, and look up the branch's
 * pull request. The user clicks each one.
 *
 * Git runs on the host, outside the sandbox, in a repository the agent may have
 * written to. So it runs through the hardened runner (no hooks, no repository filter
 * drivers, no fsmonitor) with argument arrays only, and a commit or push is refused
 * outright when the repository's own config names a command git would run for it
 * (a signing program, an ssh command, a credential helper, an include that could add
 * one): those are exactly what a planted `.git/config` would use. A push also goes
 * only to a network remote, never to a repository on this machine, whose receiving
 * git would run that repository's own hooks (see {@link pushTargetProblem}).
 */

/** Config keys a commit or push can make git run a command from. Lowercase. */
const COMMIT_PUSH_EXEC_KEYS: RegExp[] = [
  /^gpg\.(.+\.)?program$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^core\.(sshcommand|askpass|gitproxy|editor)$/,
  /^credential\.(.+\.)?helper$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
  /^trailer\..+\.(command|cmd)$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
  // Run by a push to list the refs a local remote's alternates already have.
  /^core\.alternaterefscommand$/,
  // A remote helper by name (git-remote-<vcs>), whatever the URL says.
  /^remote\..+\.vcs$/,
  // Push every submodule too, each with its own config and remotes, none of which the
  // checks here read. Also switched off on the command line (see WRITE_HARDENING).
  /^push\.recursesubmodules$/,
  /^submodule\.recurse$/
]

/**
 * Extra `-c` overrides for a commit or push, on top of the read hardening. They win
 * over the user's own config too: a push from the Changes panel pushes this one
 * repository and nothing else, so no submodule is pushed with config Houston never
 * checked, and no alternate-refs command runs. Local file transports are refused
 * here as well, behind the push-URL check in {@link pushBranch}, so a remote that
 * resolves to a folder on this computer fails even if that check were to miss it.
 */
const WRITE_HARDENING = [
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'submodule.recurse=false',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'protocol.file.allow=never'
]

const TRUSTED_SCOPES = new Set(['global', 'system', 'command'])

/**
 * Keys from the repository's own config (not the user's global or system config)
 * that would let a commit or push run a command. Parses
 * `git config --show-scope -z --list` (records `scope NUL key LF value NUL`), or the
 * same records {@link scopedConfig} builds on git older than 2.26. Pure.
 */
export function riskyRepoConfig(output: string): string[] {
  const keys: string[] = []
  const fields = output.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i].trim()
    const key = fields[i + 1].split('\n')[0].toLowerCase()
    if (TRUSTED_SCOPES.has(scope)) continue
    if (COMMIT_PUSH_EXEC_KEYS.some((re) => re.test(key)) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** Run a git command that writes (commit, push), hardened, with a longer timeout. */
function runGitWrite(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = GIT_ENV
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return hardenedGitArgs(cwd).then(
    (hardening) =>
      new Promise((resolve) => {
        execFile(
          gitExecutable(env),
          [...hardening, ...WRITE_HARDENING, '--no-pager', ...args],
          { cwd, env, timeout: timeoutMs, maxBuffer: 4_000_000, windowsHide: true },
          (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        )
      }),
    (e: Error) => ({ ok: false, stdout: '', stderr: e.message })
  )
}

/** git's first meaningful error line, for the UI. */
function gitError(stderr: string, fallback: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('hint:'))
  return (line ?? fallback).replace(/^(fatal|error):\s*/i, '').slice(0, 300)
}

export interface GitActionDeps {
  /** Whether `workspace` is a project the app already knows (see ipc.ts). */
  knownWorkspace: (workspace: string) => boolean
}

/** The repository root for a known workspace, or an error result. */
async function repoRoot(workspace: unknown, deps: GitActionDeps): Promise<string | GitActionResult> {
  if (typeof workspace !== 'string' || !workspace || !deps.knownWorkspace(workspace)) {
    return { ok: false, error: 'Unknown project folder.' }
  }
  let root: string
  try {
    root = realpathSync(workspace)
  } catch {
    return { ok: false, error: 'That folder no longer exists.' }
  }
  const inside = await runGitCapture(['rev-parse', '--is-inside-work-tree'], root)
  if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, error: 'This folder is not a git repository.' }
  return root
}

/**
 * Filter drivers the repository's own config defines (`filter.<name>.clean`, `.smudge`,
 * `.process`), by name, from the same listing as {@link riskyRepoConfig}. A commit
 * can't run them (they are switched off for every host git, see gitRead.ts), and
 * staging without them would store the files unfiltered: a git-crypt or transcrypt
 * repository would get its secrets committed in plain text. Pure.
 */
export function repoFilterDrivers(output: string): string[] {
  const names: string[] = []
  const fields = output.split('\0')
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (TRUSTED_SCOPES.has(fields[i].trim())) continue
    const m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(fields[i + 1].split('\n')[0])
    if (m && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

/**
 * Refuse when the repository's own config would run a command for a commit or push,
 * or (for a commit) defines a filter driver. Also refuses when the config can't be
 * listed in full: a cut-off listing could leave out exactly the key that matters.
 */
async function guardRepoConfig(root: string, op: 'commit' | 'push'): Promise<GitActionResult | null> {
  // The hardened capture, with its larger buffer and timeout; on git older than 2.26
  // scopedConfig lists the repository's own files instead of reading scopes.
  const hardening = hardenedGitArgs(root)
  const r = await scopedConfig(root, ['--list'], async (args) => {
    const c = await runGitCapture(['config', ...args], root, hardening)
    return { err: c.ok ? null : Object.assign(new Error(c.stderr), { code: c.code }), stdout: c.stdout, stderr: c.stderr }
  })
  if (r.err) {
    return { ok: false, error: `Could not read this repository's git config, so Houston won't ${op} here. Use a terminal.` }
  }
  const filters = op === 'commit' ? repoFilterDrivers(r.stdout) : []
  if (filters.length) {
    return {
      ok: false,
      error: `This repository defines its own git filter (${filters.join(', ')}), which Houston won't run, so it won't commit here. Use a terminal.`
    }
  }
  const risky = riskyRepoConfig(r.stdout)
  if (risky.length === 0) return null
  return {
    ok: false,
    error: `This repository's own git config sets ${risky.join(', ')}, which can run a command, so Houston won't commit or push here. Use a terminal, or remove the setting.`
  }
}

/** State files git leaves while a merge, rebase, cherry-pick, or revert is under way. */
const IN_PROGRESS_PATHS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * Refuse a commit while the repository is mid-merge (or rebase, cherry-pick, revert).
 * `git add --all` would stage conflicted files markers and all, past the unmerged-files
 * check `git commit` relies on, and the commit would conclude the operation with them.
 */
async function guardInProgress(root: string): Promise<GitActionResult | null> {
  const unmerged = await runGitCapture(['ls-files', '--unmerged', '-z'], root)
  if (!unmerged.ok || unmerged.stdout.length > 0) {
    return { ok: false, error: 'Resolve the merge conflicts first, then commit. Some files still have conflicts.' }
  }
  const paths = await runGitCapture(['rev-parse', ...IN_PROGRESS_PATHS.flatMap((p) => ['--git-path', p])], root)
  const lines = paths.ok ? paths.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  if (lines.length !== IN_PROGRESS_PATHS.length || lines.some((l) => existsSync(resolvePath(root, l)))) {
    return {
      ok: false,
      error: 'A merge, rebase, cherry-pick, or revert is in progress. Finish or abort it in a terminal, then commit here.'
    }
  }
  return null
}

/**
 * Stage every change under the project folder and commit it with `message`. The folder
 * may sit below the repository root (one package of a monorepo): the Changes list
 * shows only paths under it, so staging and committing are limited to it too (the
 * `.` pathspec, from the folder), and changes elsewhere in the repository, staged or
 * not, stay out of the commit.
 */
export async function commitAll(workspace: unknown, message: unknown, deps: GitActionDeps): Promise<GitActionResult> {
  const text = cleanCommitMessage(message)
  if (!text) return { ok: false, error: 'Write a commit message first.' }
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return root
  const blocked = (await guardRepoConfig(root, 'commit')) ?? (await guardInProgress(root))
  if (blocked) return blocked
  const add = await runGitWrite(['add', '--all', '--', '.'], root, 60_000)
  if (!add.ok) return { ok: false, error: gitError(add.stderr, 'Could not stage the changes.') }
  // --no-verify is implied by the hardening (no hooks). --cleanup=whitespace, as for
  // `git commit -m`: the message never went through an editor, so a `#123` line is
  // the user's text, not a comment. `-- .` commits only the folder's paths.
  const commit = await runGitWrite(['commit', '--quiet', '--cleanup=whitespace', '-m', text, '--', '.'], root, 60_000)
  if (!commit.ok) return { ok: false, error: gitError(commit.stderr || commit.stdout, 'The commit failed.') }
  const head = await runGitCapture(['rev-parse', '--short', 'HEAD'], root)
  return { ok: true, detail: head.ok ? head.stdout.trim() : undefined }
}

/** Where the branch stands against its upstream. Read-only. */
export async function branchSync(root: string): Promise<BranchSync> {
  const head = await runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  const branch = head.ok ? head.stdout.trim() || null : null
  const remotes = await runGitCapture(['remote'], root)
  const names = remotes.ok ? remotes.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  const remote = names.includes('origin') ? 'origin' : (names[0] ?? null)
  const up = await runGitCapture(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)
  const upstream = up.ok ? up.stdout.trim() || null : null
  let ahead = 0
  if (upstream) {
    const c = await runGitCapture(['rev-list', '--count', '@{upstream}..HEAD'], root)
    ahead = c.ok ? Number(c.stdout.trim()) || 0 : 0
  } else if (branch && remote) {
    // Not published yet: what a first push would send, the commits that no branch on
    // the remote already has. Counting all of HEAD would report the project's entire
    // history for a branch cut from main a moment ago.
    const c = await runGitCapture(['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`], root)
    ahead = c.ok ? Number(c.stdout.trim()) || 0 : 0
  }
  return { branch, upstream, ahead, remote }
}

/** Branch status for a known workspace (null outside a repository). */
export async function branchSyncFor(workspace: unknown, deps: GitActionDeps): Promise<BranchSync | null> {
  const root = await repoRoot(workspace, deps)
  return typeof root === 'string' ? branchSync(root) : null
}

/** A single git config value (any scope), or null when unset. */
async function configValue(root: string, key: string): Promise<string | null> {
  const r = await runGitCapture(['config', '--get', key], root)
  return r.ok ? r.stdout.trim() || null : null
}

/**
 * The environment for a push. GIT_TERMINAL_PROMPT=0 stops git's own prompts but not
 * ssh's (an unknown host key, a key passphrase), which read the controlling terminal
 * and would hang the push until its timeout. BatchMode makes ssh fail instead, unless
 * the user chose their own ssh command (the env vars or their own core.sshCommand;
 * a repository-level one is refused before this).
 */
export async function pushEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = GIT_ENV
  if (env.GIT_SSH_COMMAND || env.GIT_SSH || (await configValue(root, 'core.sshCommand'))) return GIT_ENV
  return { ...GIT_ENV, GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' }
}

/** {@link pushTargetProblem}'s reason for a remote that is a folder on this computer. */
const LOCAL_TARGET =
  'its URL is a folder on this computer, and a push there runs git in that folder with its own config and hooks'

/**
 * Why Houston won't push to `url`, or null when it is a network remote it will push
 * to. `url` is one line of `git remote get-url --push <remote>`: the URL git will
 * really use, after the user's own `insteadOf` / `pushInsteadOf` rewrites (the
 * repository's own are refused earlier). Pure.
 *
 * The push runs host git, outside the sandbox. To a network remote (https, ssh, git,
 * or a remote helper the user installed) the receiving end runs on another machine.
 * To a local repository, git itself starts `git-receive-pack` in that folder, on this
 * machine: it reads that repository's config and runs its hooks (`pre-receive`,
 * `update`, `post-receive`), and none of the hardening Houston gives its own git
 * reaches that process. A sandboxed agent can create such a repository anywhere it
 * may write, the workspace included, and point a remote at it, so one click on Push
 * would run whatever hook it planted. The same goes for the `ext::` and `fd::`
 * transports, which run a command or talk over an inherited descriptor, and for a
 * remote helper handed a local path.
 *
 * Read the way git reads a URL: `<scheme>://` is a URL; `<helper>::<address>` names a
 * remote helper; `host:path` with no `/` before the colon is scp-style ssh; anything
 * else is a local path. A one-letter host is read as a Windows drive (`C:\repo`), as
 * git on Windows reads it, on every platform: refusing is the safe reading.
 */
export function pushTargetProblem(url: string): string | null {
  const u = url.trim()
  if (!u) return 'it has no URL'
  const helper = /^([A-Za-z][A-Za-z0-9+.-]*)::(.*)$/s.exec(u)
  if (helper) {
    const name = helper[1].toLowerCase()
    if (name === 'ext' || name === 'fd') return `its URL uses git's ${name}:: transport, which talks to a program on this computer`
    return isLocalGitAddress(helper[2]) ? LOCAL_TARGET : null
  }
  return isLocalGitAddress(u) ? LOCAL_TARGET : null
}

/** Whether git reads `u` as a local path or a file:// URL. */
function isLocalGitAddress(u: string): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(u)
  if (scheme) return scheme[1].toLowerCase() === 'file'
  const colon = u.indexOf(':')
  if (colon <= 0) return true
  const slash = u.indexOf('/')
  if (slash !== -1 && slash < colon) return true
  // `C:\repo`, `C:/repo`, and `C:repo` are a Windows drive, not a host named C.
  return colon === 1 && /^[A-Za-z]$/.test(u[0])
}

/**
 * Refuse a push whose remote resolves to anything but a network remote (see
 * {@link pushTargetProblem}). Every push URL is checked: a remote can list several
 * `pushurl`s, and git pushes to each. The URL itself is never echoed back, since an
 * https one can carry a token.
 */
async function guardPushTarget(root: string, remote: string): Promise<GitActionResult | null> {
  const r = await runGitCapture(['remote', 'get-url', '--push', remote], root)
  const urls = r.ok ? r.stdout.split('\n').filter((l) => l.trim()) : []
  if (urls.length === 0) return { ok: false, error: `Could not read where the remote ${remote} pushes to.` }
  for (const url of urls) {
    const problem = pushTargetProblem(url)
    if (problem) {
      return {
        ok: false,
        error: `Houston won't push to ${remote}: ${problem}. Use a terminal to push there.`
      }
    }
  }
  return null
}

/** An attributes line assigning the LFS filter, as a JS regex and as git grep's ERE. */
const LFS_ATTR = /filter=lfs(\s|$)/m
const LFS_ATTR_ERE = 'filter=lfs([[:space:]]|$)'

/**
 * Refuse a push from a repository that uses Git LFS. git-lfs uploads the large files
 * only from its `pre-push` hook, and hooks never run for Houston's host git, so the
 * push would send pointers to objects the remote never gets. In use means a committed
 * `.gitattributes` (anywhere in HEAD's tree) or `info/attributes` names `filter=lfs`.
 * A check that fails refuses too.
 */
async function guardLfs(root: string): Promise<GitActionResult | null> {
  const refused: GitActionResult = {
    ok: false,
    error: "This repository uses Git LFS, whose upload Houston doesn't run, so it won't push here. Push from a terminal."
  }
  const unknown: GitActionResult = {
    ok: false,
    error: "Could not check whether this repository uses Git LFS, so Houston won't push here. Push from a terminal."
  }
  const info = await runGitCapture(['rev-parse', '--git-path', 'info/attributes'], root)
  if (!info.ok) return unknown
  try {
    if (LFS_ATTR.test(readFileSync(resolvePath(root, info.stdout.trim()), 'utf8'))) return refused
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return unknown
  }
  const head = await runGitCapture(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root)
  // No commit yet: nothing to push, and nothing to search.
  if (!head.ok) return null
  const grep = await runGitCapture(
    ['grep', '-q', '-I', '-E', '-e', LFS_ATTR_ERE, 'HEAD', '--', ':(top,glob)**/.gitattributes'],
    root
  )
  if (grep.ok) return refused
  // Exit 1 is "no match"; anything else is a failed search.
  return grep.code === 1 ? null : unknown
}

/**
 * Push the current branch to the same-named branch on its remote: the branch's push
 * remote or upstream remote, else the repository's remote (`origin` when there is
 * one). The refspec is always explicit, so a branch tracking a differently named one
 * (made with `git switch -c feat origin/main`) is published as `feat`, never pushed
 * onto `main` (what a bare push does under push.default=upstream) or refused (under
 * the default push.default=simple).
 */
export async function pushBranch(workspace: unknown, deps: GitActionDeps): Promise<GitActionResult> {
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return root
  const blocked = await guardRepoConfig(root, 'push')
  if (blocked) return blocked
  const sync = await branchSync(root)
  if (!sync.branch) return { ok: false, error: 'Check out a branch before pushing.' }
  const lfs = await guardLfs(root)
  if (lfs) return lfs
  const branch = sync.branch
  const remotes = await runGitCapture(['remote'], root)
  const names = remotes.ok ? remotes.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  // Only a configured remote's name, so a planted value can't pass as a push option.
  const known = (v: string | null): string | null => (v && names.includes(v) && !v.startsWith('-') ? v : null)
  const upstreamRemote = known(await configValue(root, `branch.${branch}.remote`))
  const remote =
    known(await configValue(root, `branch.${branch}.pushRemote`)) ??
    known(await configValue(root, 'remote.pushDefault')) ??
    upstreamRemote ??
    (sync.remote && !sync.remote.startsWith('-') ? sync.remote : null)
  if (!remote) return { ok: false, error: 'This repository has no remote to push to.' }
  const refused = await guardPushTarget(root, remote)
  if (refused) return refused
  const target = `refs/heads/${branch}`
  // Set the upstream when there is none, or when it is another branch on the remote
  // pushed to; a separate push remote (a fork) leaves the upstream alone.
  const setUpstream =
    !upstreamRemote ||
    (upstreamRemote === remote && (await configValue(root, `branch.${branch}.merge`)) !== target)
  const args = ['push', '--quiet', ...(setUpstream ? ['--set-upstream'] : []), remote, `HEAD:${target}`]
  const r = await runGitWrite(args, root, 120_000, await pushEnv(root))
  if (!r.ok) return { ok: false, error: gitError(r.stderr, 'The push failed.') }
  return { ok: true, detail: `${remote}/${branch}` }
}

// ---- Suggest a commit message (a side request, like a chat title) ----

const SUGGEST_TIMEOUT_MS = 30_000
/** Diff characters sent to the model: enough for the gist of a change set. */
const SUGGEST_DIFF_BUDGET = 12_000
const SUGGEST_MAX_TOKENS = 300

export const commitMessageSystemPrompt = `You write git commit messages. From the diff you are given, reply with only the commit message: a subject line in the imperative mood under 72 characters, then, only if it helps, a blank line and a short body of one to three lines saying what changed and why. No quotes, no markdown fences, no preamble.`

/** The request text for a commit message: the diff, clipped. Pure. */
export function commitMessageRequest(diffText: string): ChatMessage[] {
  const clipped =
    diffText.length > SUGGEST_DIFF_BUDGET ? `${diffText.slice(0, SUGGEST_DIFF_BUDGET)}\n… (diff shortened)` : diffText
  return [{ role: 'user', content: `Write the commit message for this change.\n\n${clipped}` }]
}

/**
 * The change set as text for the model, with what must not leave the machine taken
 * out: the contents of credential files (`.env`, private keys, as the agent's own
 * sensitive-read gate names them) replaced by a note, and secret-looking values and
 * the user's stored keys masked everywhere else.
 */
export function suggestionDiffText(changes: WorkingTreeChanges, knownSecrets: readonly string[] = collectSecrets()): string {
  const files = changes.files.map((f) =>
    isSensitivePath(f.path) || (f.oldPath !== undefined && isSensitivePath(f.oldPath))
      ? { ...f, hunks: [], note: 'Sensitive file, contents not shown' }
      : f
  )
  return redactSecrets(workingTreeToText({ ...changes, files }), knownSecrets)
}

/** Tidy a model's commit message: drop fences and wrapping quotes, cap it. Null when empty. Pure. */
export function sanitizeCommitMessage(raw: string): string | null {
  let t = raw.trim()
  t = t.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim()
  t = t.replace(/^(?:commit message)\s*:\s*/i, '').trim()
  t = t.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
  if (!t) return null
  return t.length > 2000 ? t.slice(0, 2000) : t
}

/**
 * Ask the chat's model (or the default one in a new chat) for a commit message for
 * every uncommitted change, the way a chat title is generated: no tools, a small
 * reply budget, a timeout. The diff goes to the same provider the chat already uses.
 */
export async function suggestCommitMessage(
  workspace: unknown,
  conversationId: unknown,
  deps: GitActionDeps,
  make: (providerId: string) => Provider | null = defaultProvider
): Promise<GitActionResult> {
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return root
  const changes = await collectWorkingTreeChanges(root)
  if (changes.files.length === 0) return { ok: false, error: 'There are no changes to describe.' }
  const conv = typeof conversationId === 'string' && conversationId ? peekConversation(conversationId) : null
  const selected = conv ? { providerId: conv.providerId, model: conv.model } : getSettings().selected
  if (!selected) return { ok: false, error: 'Choose a model first.' }
  const provider = make(selected.providerId)
  const config = getProvider(selected.providerId)
  if (!provider || !config) return { ok: false, error: 'The chat’s model is not available.' }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), SUGGEST_TIMEOUT_MS)
  try {
    const caps = config.models.find((m) => m.id === selected.model)?.caps
    const base = titleRequestOptions(config.kind, selected.model, caps)
    const request = { ...base, maxTokens: Math.max(base.maxTokens ?? 0, SUGGEST_MAX_TOKENS) }
    const text = await withProviderRetry(
      async () => {
        let acc = ''
        for await (const ev of provider.streamChat({
          model: selected.model,
          system: commitMessageSystemPrompt,
          messages: commitMessageRequest(suggestionDiffText(changes)),
          ...request,
          signal: abort.signal
        })) {
          if (ev.type === 'text') acc += ev.text
          else if (ev.type === 'error') throw providerStreamError(ev)
        }
        return acc
      },
      { signal: abort.signal, maxRetries: 2 }
    )
    const message = sanitizeCommitMessage(text)
    return message ? { ok: true, detail: message } : { ok: false, error: 'The model returned no message.' }
  } catch {
    return { ok: false, error: 'Could not get a suggestion from the model.' }
  } finally {
    clearTimeout(timer)
  }
}

function defaultProvider(providerId: string): Provider | null {
  const config = getProvider(providerId)
  if (!config) return null
  try {
    return createProvider(config)
  } catch {
    return null
  }
}

// ---- The branch's pull request (the composer chip) ----

export interface PrLookupDeps extends GitActionDeps {
  gh?: () => GhExec | null
  authedHosts?: () => Promise<string[]>
  repoKey?: (cwd: string) => Promise<string | null>
}

/**
 * The pull request for the workspace's current branch, read with `gh pr view`. Only
 * when gh is installed and signed in to some host, and the folder has a remote on a
 * host gh is signed in to; otherwise `unavailable`, and the chip stays hidden. Read
 * only; the repository is pinned the way the gh tools pin it.
 */
export async function lookupPr(workspace: unknown, deps: PrLookupDeps): Promise<PrLookup> {
  const exec = (deps.gh ?? defaultGh)()
  if (!exec) return { kind: 'unavailable' }
  if ((await (deps.authedHosts ?? (() => ghAuthedHosts()))()).length === 0) return { kind: 'unavailable' }
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return { kind: 'unavailable' }
  const head = await runGitCapture(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  const branch = head.ok ? head.stdout.trim() : ''
  if (!branch || branch.startsWith('-')) return { kind: 'none' }
  const repo = await (deps.repoKey ?? ghRepoKey)(root)
  if (!repo) return { kind: 'unavailable' }
  const r = await exec(
    ['pr', 'view', branch, '--json', 'number,title,state,isDraft,url,statusCheckRollup'],
    root,
    undefined,
    ghRepoEnv(repo)
  )
  if (!r.ok) {
    // "no pull requests found for branch" is the ordinary answer; anything else
    // (offline, signed out) also just hides the chip.
    return /no (open )?pull requests? found/i.test(r.stderr) ? { kind: 'none' } : { kind: 'unavailable' }
  }
  const pr = parsePrView(r.stdout)
  return pr ? { kind: 'pr', pr } : { kind: 'unavailable' }
}

function defaultGh(): GhExec | null {
  const path = resolveGh()
  return path ? runGh(path) : null
}
