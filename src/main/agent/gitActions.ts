import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { ChatMessage, Provider } from '@shared/agent'
import {
  cleanCommitMessage,
  parsePrView,
  type BranchSync,
  type GitActionResult,
  type PrLookup
} from '@shared/gitActions'
import { workingTreeToText } from '@shared/workingTree'
import { getProvider, getSettings } from '../agentHost'
import { peekConversation } from '../conversations'
import { createProvider } from '../providers'
import { GIT_ENV, hardenedGitArgs, runGitCapture } from './gitRead'
import { ghAuthedHosts, ghRepoEnv, ghRepoKey, resolveGh, runGh, type GhExec } from './github'
import { providerStreamError, withProviderRetry } from './retry'
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
 * one): those are exactly what a planted `.git/config` would use.
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
  /^url\..+\.(insteadof|pushinsteadof)$/
]

const TRUSTED_SCOPES = new Set(['global', 'system', 'command'])

/**
 * Keys from the repository's own config (not the user's global or system config)
 * that would let a commit or push run a command. Parses
 * `git config --show-scope -z --list` (records `scope NUL key LF value NUL`). Pure.
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
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return hardenedGitArgs(cwd).then(
    (hardening) =>
      new Promise((resolve) => {
        execFile(
          'git',
          [...hardening, '--no-pager', ...args],
          { cwd, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 4_000_000, windowsHide: true },
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

/** Refuse when the repository's own config would run a command for a commit or push. */
async function guardRepoConfig(root: string): Promise<GitActionResult | null> {
  const r = await runGitCapture(['config', '--show-scope', '-z', '--list'], root)
  const risky = riskyRepoConfig(r.stdout)
  if (risky.length === 0) return null
  return {
    ok: false,
    error: `This repository's own git config sets ${risky.join(', ')}, which can run a command, so Houston won't commit or push here. Use a terminal, or remove the setting.`
  }
}

/** Stage every change in the repository and commit it with `message`. */
export async function commitAll(workspace: unknown, message: unknown, deps: GitActionDeps): Promise<GitActionResult> {
  const text = cleanCommitMessage(message)
  if (!text) return { ok: false, error: 'Write a commit message first.' }
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return root
  const blocked = await guardRepoConfig(root)
  if (blocked) return blocked
  const add = await runGitWrite(['add', '--all'], root, 60_000)
  if (!add.ok) return { ok: false, error: gitError(add.stderr, 'Could not stage the changes.') }
  // --no-verify is implied by the hardening (no hooks); --cleanup=strip drops comment lines.
  const commit = await runGitWrite(['commit', '--quiet', '--cleanup=strip', '-m', text], root, 60_000)
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
  } else if (branch) {
    const c = await runGitCapture(['rev-list', '--count', 'HEAD'], root)
    ahead = c.ok ? Number(c.stdout.trim()) || 0 : 0
  }
  return { branch, upstream, ahead, remote }
}

/** Branch status for a known workspace (null outside a repository). */
export async function branchSyncFor(workspace: unknown, deps: GitActionDeps): Promise<BranchSync | null> {
  const root = await repoRoot(workspace, deps)
  return typeof root === 'string' ? branchSync(root) : null
}

/**
 * Push the current branch: to its upstream, or for a first push to the repository's
 * remote (`origin` when there is one) as `HEAD`, setting the upstream.
 */
export async function pushBranch(workspace: unknown, deps: GitActionDeps): Promise<GitActionResult> {
  const root = await repoRoot(workspace, deps)
  if (typeof root !== 'string') return root
  const blocked = await guardRepoConfig(root)
  if (blocked) return blocked
  const sync = await branchSync(root)
  if (!sync.branch) return { ok: false, error: 'Check out a branch before pushing.' }
  if (!sync.upstream && !sync.remote) return { ok: false, error: 'This repository has no remote to push to.' }
  const args = sync.upstream ? ['push', '--quiet'] : ['push', '--quiet', '--set-upstream', sync.remote!, 'HEAD']
  const r = await runGitWrite(args, root, 120_000)
  if (!r.ok) return { ok: false, error: gitError(r.stderr, 'The push failed.') }
  return { ok: true, detail: sync.upstream ?? `${sync.remote}/${sync.branch}` }
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
          messages: commitMessageRequest(workingTreeToText(changes)),
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
