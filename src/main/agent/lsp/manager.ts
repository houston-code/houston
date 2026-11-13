/**
 * Which language servers are running, for which workspace, and when they stop. One
 * server runs per (server, roots) pair: started lazily the first time a file it covers
 * needs it, reused across turns and runs in that workspace, and stopped after it sits
 * idle, on app quit, or when a terminal client exits.
 *
 * Servers run through the same sandbox as the post-edit checkers in diagnostics.ts:
 * no network, writes confined to the roots. A server can execute project code (a
 * TypeScript plugin named in tsconfig, a Rust build script), so on a host where the
 * sandbox can't confine it, servers stay off unless the user turned them on explicitly.
 */
import type { ChildProcess } from 'node:child_process'
import { sep } from 'node:path'
import { resolveInRoots } from '../tools'
import { shellQuote } from '../format'
import { backendShellSyntax, isSandboxed, spawnSandboxedEx } from '../../sandbox'
import type { LanguageServerStatus, LspServerConfig } from '@shared/types'
import { LspClient, type LspSpawn } from './client'
import { depCacheReport, lspDepCaches, missingDepsHint } from './depCaches'
import {
  resolveServer,
  rootUsesLanguage,
  serverRegistry,
  specForFile,
  type LspServerSpec,
  type ResolvedServer,
  type ResolveOptions
} from './servers'

/** The settings that steer language servers. */
export interface LspSettings {
  /** Unset: on when the sandbox confines servers. true: on even unconfined. false: off. */
  lspEnabled?: boolean
  lspServers?: LspServerConfig[]
}

/** How long an unused server keeps running. */
export const IDLE_TIMEOUT_MS = 10 * 60_000
/**
 * Most language servers running at once. Servers are per folder, so every worktree
 * chat that edits a covered file starts its own, and a TypeScript server can hold
 * hundreds of megabytes. Past this, starting one stops the least recently used.
 */
export const MAX_LIVE_SERVERS = 4
/** A server that crashes this many times inside the window is not restarted again. */
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 5 * 60_000
/** How often a server missing dependencies looks again for them in the cache. */
export const DEPS_RECHECK_MS = 15_000

/** The missing-dependency note for a built-in server in this workspace, or null. */
function defaultDepsHint(spec: LspServerSpec, roots: string[]): string | null {
  return spec.user ? null : missingDepsHint(depCacheReport(spec.id, roots))
}

/** Launch a server under the host sandbox with no network, reading the user's dependency caches. */
export const sandboxedSpawn: LspSpawn = (server: ResolvedServer, roots: string[]): ChildProcess => {
  // Git Bash (the Windows sandbox shell) reads a forward-slash path as a path.
  const exe = process.platform === 'win32' ? server.path.replace(/\\/g, '/') : server.path
  const command = [exe, ...server.args]
    .map(shellQuote)
    .join(' ')
  return spawnSandboxedEx({
    command,
    cwd: roots[0],
    workspace: roots[0],
    roots,
    allowNetwork: false,
    envOverrides: lspDepCaches().env
  }).child
}

interface Entry {
  client: LspClient
  key: string
  /** The workspace roots this server was started for. */
  roots: string[]
  /** When it was last asked for, for choosing which server to stop at the cap. */
  lastUsed: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** A shell command ran since the open documents were last re-read from disk. */
  stale: boolean
  /** When the missing dependencies were last looked for (only while some are missing). */
  depsCheckedAt: number
}

export interface LspManagerDeps {
  spawn?: LspSpawn
  /** Whether the host sandbox confines servers (default: the active backend). */
  sandboxed?: () => boolean
  /** Whether servers can be launched at all (default: false under the cmd.exe fallback). */
  launchable?: () => boolean
  /** Environment read for the `HOUSTON_LSP=off` kill switch (default: process.env). */
  env?: NodeJS.ProcessEnv
  resolve?: ResolveOptions
  idleTimeoutMs?: number
  /** Most servers running at once (default: MAX_LIVE_SERVERS). */
  maxServers?: number
  initTimeoutMs?: number
  requestTimeoutMs?: number
  now?: () => number
  /** The note for dependencies a server can't see (default: checks the Go and Cargo caches). */
  depsHint?: (spec: LspServerSpec, roots: string[]) => string | null
}

/** One server's status for Settings and /doctor. */
export type LspServerStatus = LanguageServerStatus

export class LspManager {
  private readonly entries = new Map<string, Entry>()
  /**
   * Servers being set up (between deciding to start one and recording it), per key.
   * Making room can wait on stopping another server, and lsp_* calls run in parallel,
   * so without this two callers for one workspace would each start a server and the
   * one recorded second would orphan the first: never reused, and missed by killAll.
   */
  private readonly creating = new Map<string, Promise<Entry | null>>()
  /** Crash timestamps per key, for the restart budget. */
  private readonly crashes = new Map<string, number[]>()
  private settings: LspSettings = {}

  constructor(private readonly deps: LspManagerDeps = {}) {}

  configure(settings: LspSettings): void {
    this.settings = { lspEnabled: settings.lspEnabled, lspServers: settings.lspServers }
  }

  private registry(): LspServerSpec[] {
    return serverRegistry(this.settings.lspServers)
  }

  /** Why servers won't start on this host with these settings, or null when they may. */
  blockedReason(): 'disabled' | 'unsandboxed' | 'needs-git-bash' | null {
    // HOUSTON_LSP=off turns servers off for a process whatever the settings say (CI,
    // scripted runs, and the test suite, where a server installed on the developer's
    // machine must not change what a run reports).
    if (this.settings.lspEnabled === false || (this.deps.env ?? process.env).HOUSTON_LSP === 'off') return 'disabled'
    const launchable = this.deps.launchable ?? (() => backendShellSyntax() !== 'cmd')
    if (!launchable()) return 'needs-git-bash'
    if (this.settings.lspEnabled === true) return null
    return (this.deps.sandboxed ?? isSandboxed)() ? null : 'unsandboxed'
  }

  /** Whether servers may start at all on this host with these settings. */
  enabled(): boolean {
    return this.blockedReason() === null
  }

  private resolveOpts(roots: string[]): ResolveOptions {
    return { ...this.deps.resolve, roots }
  }

  /** The configured servers and whether each is installed (for Settings and /doctor). */
  statuses(roots: string[] = []): LspServerStatus[] {
    return this.registry().map((spec) => {
      const r = resolveServer(spec, this.resolveOpts(roots))
      return {
        id: spec.id,
        name: spec.name,
        languages: Object.keys(spec.languages),
        path: r?.path ?? null,
        ...(r ? { source: r.source } : {}),
        installHint: spec.installHint,
        user: spec.user === true
      }
    })
  }

  /**
   * The servers worth offering navigation tools for in this workspace: installed, and
   * the project looks like it uses the language. Empty when servers are disabled.
   */
  availableFor(roots: string[]): LspServerSpec[] {
    if (!this.enabled() || roots.length === 0) return []
    const exists = this.deps.resolve?.exists
    return this.registry().filter(
      (spec) =>
        roots.some((r) => rootUsesLanguage(spec, r, exists)) && resolveServer(spec, this.resolveOpts(roots)) !== null
    )
  }

  /** Whether some server would cover `abs` (installed and enabled), without starting it. */
  covers(abs: string, roots: string[]): boolean {
    if (!this.enabled()) return false
    const spec = specForFile(this.registry(), abs)
    return spec !== null && resolveServer(spec, this.resolveOpts(roots)) !== null
  }

  private keyFor(spec: LspServerSpec, roots: string[]): string {
    return `${spec.id}\0${roots.join('\0')}`
  }

  private touch(entry: Entry): void {
    entry.lastUsed = (this.deps.now ?? Date.now)()
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => void this.stopEntry(entry), this.deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS)
    entry.idleTimer.unref?.()
  }

  private crashBudgetSpent(key: string): boolean {
    const now = (this.deps.now ?? Date.now)()
    const recent = (this.crashes.get(key) ?? []).filter((t) => now - t < CRASH_WINDOW_MS)
    this.crashes.set(key, recent)
    return recent.length >= MAX_CRASHES
  }

  /**
   * The ready client for the server covering `abs`, starting it if needed. Null when
   * no server covers the file, servers are off, the file is outside the roots, the
   * server keeps crashing, or it failed to start. A server that died is restarted on
   * the next call, within the crash budget.
   */
  async clientFor(abs: string, roots: string[]): Promise<LspClient | null> {
    if (!this.enabled()) return null
    try {
      resolveInRoots(roots, abs)
    } catch {
      return null
    }
    const spec = specForFile(this.registry(), abs)
    if (!spec) return null
    return this.clientForSpec(spec, roots)
  }

  /** The ready client for `spec` in this workspace, starting it if needed. */
  async clientForSpec(spec: LspServerSpec, roots: string[]): Promise<LspClient | null> {
    if (!this.enabled()) return null
    const key = this.keyFor(spec, roots)
    let entry = this.entries.get(key)
    if (entry && (entry.client.state === 'dead' || entry.client.state === 'stopped')) {
      this.entries.delete(key)
      entry = undefined
    }
    if (entry?.client.missingDepsHint && this.depsArrived(entry, spec, roots)) {
      // The user fetched them. A server reads the module graph once, so start it afresh.
      await this.stopEntry(entry)
      entry = undefined
    }
    if (!entry) {
      let pending = this.creating.get(key)
      if (!pending) {
        const p = this.createEntry(spec, roots, key).finally(() => {
          if (this.creating.get(key) === p) this.creating.delete(key)
        })
        this.creating.set(key, p)
        pending = p
      }
      const created = await pending
      if (!created) return null
      entry = created
    }
    // The idle clock runs only once the server is up: armed before the start, a slow
    // start (a cold project load, a busy machine) could outlast it and be stopped
    // halfway through initializing.
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    try {
      await entry.client.start()
    } catch {
      return null
    }
    if (entry.client.state !== 'ready') return null
    this.touch(entry)
    if (entry.stale) {
      // Re-read what a shell command may have changed before anyone asks the server.
      entry.stale = false
      await entry.client.refreshAll().catch(() => {})
    }
    return entry.client
  }

  /** Make and record a client for `key` (not yet started), stopping another if at the cap. */
  private async createEntry(spec: LspServerSpec, roots: string[], key: string): Promise<Entry | null> {
    if (this.crashBudgetSpent(key)) return null
    const server = resolveServer(spec, this.resolveOpts(roots))
    if (!server) return null
    const client = new LspClient({
      server,
      roots,
      spawn: this.deps.spawn ?? sandboxedSpawn,
      initTimeoutMs: this.deps.initTimeoutMs,
      requestTimeoutMs: this.deps.requestTimeoutMs
    })
    client.missingDepsHint = (this.deps.depsHint ?? defaultDepsHint)(spec, roots)
    await this.makeRoom()
    const now = (this.deps.now ?? Date.now)()
    const created: Entry = { client, key, roots: [...roots], lastUsed: now, idleTimer: null, stale: false, depsCheckedAt: now }
    client.onDeath(() => {
      if (created.idleTimer) clearTimeout(created.idleTimer)
      if (this.entries.get(key) === created) this.entries.delete(key)
      const list = this.crashes.get(key) ?? []
      list.push((this.deps.now ?? Date.now)())
      this.crashes.set(key, list)
    })
    this.entries.set(key, created)
    return created
  }

  /** Whether a server that was missing dependencies would now find them all (looked at most every DEPS_RECHECK_MS). */
  private depsArrived(entry: Entry, spec: LspServerSpec, roots: string[]): boolean {
    const now = (this.deps.now ?? Date.now)()
    if (now - entry.depsCheckedAt < DEPS_RECHECK_MS) return false
    entry.depsCheckedAt = now
    return (this.deps.depsHint ?? defaultDepsHint)(spec, roots) === null
  }

  /** Running clients whose workspace is `roots`. */
  private running(roots: string[]): LspClient[] {
    const suffix = `\0${roots.join('\0')}`
    return [...this.entries.values()]
      .filter((e) => e.key.endsWith(suffix) && e.client.state === 'ready')
      .map((e) => e.client)
  }

  /**
   * The agent wrote (or deleted) `abs`: bring every running server that has it open up
   * to date, so its next answer is about the file as it is now.
   */
  async noteWrite(abs: string, roots: string[]): Promise<void> {
    for (const c of this.running(roots)) {
      try {
        await c.refreshFromDisk(abs)
      } catch {
        // Best effort: a failed sync only makes the server's view stale.
      }
    }
  }

  /**
   * The agent read `abs`: if the covering server is already running (an earlier edit or
   * lsp_* call started it), open the file there in the background. A file is read before
   * it is edited, so by the time the edit lands the server has published the file's
   * diagnostics, the baseline the edit is compared against. A read never starts a
   * server: a conversation that only reads shouldn't pay for loading a whole project.
   */
  async noteRead(abs: string, roots: string[]): Promise<void> {
    if (!this.enabled()) return
    const spec = specForFile(this.registry(), abs)
    if (!spec) return
    const entry = this.entries.get(this.keyFor(spec, roots))
    if (!entry || entry.client.state !== 'ready') return
    try {
      const c = await this.clientForSpec(spec, roots)
      await c?.sync(abs)
    } catch {
      // Warming is best effort.
    }
  }

  /**
   * A shell command ran and may have changed any file. Marks the running servers so their
   * open documents are re-read from disk the next time one is used (see clientForSpec),
   * rather than reading them all after every command.
   */
  noteShell(roots: string[]): void {
    const suffix = `\0${roots.join('\0')}`
    for (const e of this.entries.values()) if (e.key.endsWith(suffix)) e.stale = true
  }

  /** Stop least recently used servers until one more fits under the cap. */
  private async makeRoom(): Promise<void> {
    const max = Math.max(1, this.deps.maxServers ?? MAX_LIVE_SERVERS)
    while (this.entries.size >= max) {
      let oldest: Entry | null = null
      for (const e of this.entries.values()) if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e
      if (!oldest) return
      await this.stopEntry(oldest)
    }
  }

  /**
   * Stop every server started for `path` or a folder inside it. Called when a chat's
   * worktree is removed: its servers have nothing left to serve, and would otherwise
   * run until their idle timeout.
   */
  async stopForRoot(path: string): Promise<void> {
    const inside = (r: string): boolean => r === path || r.startsWith(path.endsWith(sep) ? path : path + sep)
    const gone = [...this.entries.values()].filter((e) => e.roots.some(inside))
    await Promise.all(gone.map((e) => this.stopEntry(e)))
  }

  private async stopEntry(entry: Entry): Promise<void> {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    await entry.client.stop()
  }

  /** Politely stop every server (terminal clients await this before exiting). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.stopEntry(e)))
  }

  /** Stop every server now, synchronously, by killing it (app quit, process exit). */
  killAll(): void {
    for (const e of this.entries.values()) {
      if (e.idleTimer) clearTimeout(e.idleTimer)
      e.client.kill()
    }
    this.entries.clear()
  }

  /** How many servers are running (tests, diagnostics). */
  runningCount(): number {
    return [...this.entries.values()].filter((e) => e.client.state === 'ready').length
  }
}

/** The process-wide manager every run shares. */
export const lspManager = new LspManager()
