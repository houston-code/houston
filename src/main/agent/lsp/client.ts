/**
 * One running language server: the process, the JSON-RPC session over its stdio, the
 * documents it has open (kept in sync with what is on disk), and the diagnostics it
 * has published. The manager (manager.ts) decides when to start, reuse, and stop
 * these; this file only drives a single server through its lifecycle:
 *
 *   start → initialize → initialized → (didOpen / didChange / didClose, requests) →
 *   shutdown → exit
 *
 * Positions follow LSP's default encoding, UTF-16 code units, which is what a
 * JavaScript string index already counts, so a `character` maps straight onto
 * `line.slice(...)`.
 */
import type { ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { killProcessTree } from '../../sandbox'
import { JsonRpcConnection } from './jsonrpc'
import { extKey, type ResolvedServer } from './servers'
import { fromUri, toUri } from './uri'

export { fromUri, toUri }

export interface Position {
  line: number
  character: number
}
export interface Range {
  start: Position
  end: Position
}
export interface Location {
  uri: string
  range: Range
}
export interface Diagnostic {
  range: Range
  /** 1 error, 2 warning, 3 information, 4 hint (absent is treated as error, per spec). */
  severity?: number
  code?: string | number
  source?: string
  message: string
}

/** What a client needs to launch its server process. */
export type LspSpawn = (server: ResolvedServer, roots: string[]) => ChildProcess

export interface LspClientOptions {
  server: ResolvedServer
  roots: string[]
  spawn: LspSpawn
  /** How long `initialize` may take (a cold server indexing a big project is slow). */
  initTimeoutMs?: number
  /** Default timeout for other requests. */
  requestTimeoutMs?: number
  /** Most documents kept open at once; the least recently used is closed past this. */
  maxOpenDocuments?: number
  /**
   * Kill the server and everything under it (default: the sandbox's killProcessTree,
   * a process-group kill on POSIX and `taskkill /T` on Windows, where killing only the
   * sandbox shell would leave the server running).
   */
  killTree?: (proc: ChildProcess) => void
  /** How long a server whose connection broke may take to exit before it is killed. */
  exitGraceMs?: number
}

interface OpenDoc {
  version: number
  text: string
  languageId: string
  /** The diagnostics publish count when this text was sent; a later publish is about it. */
  markAtSync: number
}

interface DiagEntry {
  diagnostics: Diagnostic[]
  /** The document version the server said these are for, when it says. */
  version?: number
  /** Increments with every publish for this uri. */
  seq: number
}

type Waiter = () => void

const DEFAULT_INIT_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OPEN = 50
const DEFAULT_EXIT_GRACE_MS = 2000
/**
 * The settle window for a publish that carries no document version. Such a publish
 * could be the server's verdict on the text from before the change, already in flight
 * when the change went out, so the window is long enough for the real one to follow
 * and supersede it.
 */
export const UNVERSIONED_SETTLE_MS = 1000

export type ClientState = 'idle' | 'starting' | 'ready' | 'dead' | 'stopped'

export class LspClient {
  state: ClientState = 'idle'
  /** Why the server died, when it did. */
  deathReason: string | null = null
  /** Recent stderr, kept for a crash report. */
  stderrTail = ''
  /** Why the server can't see some of the project's dependencies, when it can't (see depCaches.ts). */
  missingDepsHint: string | null = null
  private proc: ChildProcess | null = null
  private conn: JsonRpcConnection | null = null
  private starting: Promise<void> | null = null
  private readonly docs = new Map<string, OpenDoc>()
  private readonly diags = new Map<string, DiagEntry>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private capabilities: Record<string, unknown> = {}
  private readonly deathListeners: ((reason: string) => void)[] = []
  private exitGrace: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: LspClientOptions) {}

  get server(): ResolvedServer {
    return this.opts.server
  }

  get roots(): string[] {
    return this.opts.roots
  }

  get serverCapabilities(): Record<string, unknown> {
    return this.capabilities
  }

  onDeath(l: (reason: string) => void): void {
    this.deathListeners.push(l)
  }

  /** Spawn and initialize the server. Concurrent callers share the one start. */
  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.starting) return this.starting
    if (this.state === 'dead' || this.state === 'stopped') {
      return Promise.reject(new Error(`${this.server.spec.name} language server is not running`))
    }
    this.starting = this.doStart().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStart(): Promise<void> {
    this.state = 'starting'
    const proc = this.opts.spawn(this.server, this.roots)
    this.proc = proc
    if (!proc.stdout || !proc.stdin) {
      this.die('the server process has no stdio')
      throw new Error(this.deathReason ?? 'failed to start')
    }
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000)
    })
    proc.on('error', (e) => this.die(`failed to start: ${e.message}`))
    proc.on('exit', (code, signal) => this.die(`exited (${signal ?? `code ${code}`})`))
    const conn = new JsonRpcConnection(proc.stdout, proc.stdin)
    this.conn = conn
    conn.onClose((reason) => this.connectionLost(reason))
    conn.onNotification('textDocument/publishDiagnostics', (p) => this.onDiagnostics(p))
    // Servers report their own failures here rather than on stderr; keep them for a crash report.
    const keepLog = (p: unknown): void => {
      const m = (p as { message?: unknown })?.message
      if (typeof m === 'string') this.stderrTail = `${this.stderrTail}${m}\n`.slice(-2000)
    }
    conn.onNotification('window/logMessage', keepLog)
    conn.onNotification('window/showMessage', keepLog)
    // Servers ask the client for settings and to register capabilities and progress
    // tokens. Answer so they never block waiting on us.
    conn.onRequest('workspace/configuration', (p) => {
      const items = (p as { items?: { section?: string }[] })?.items ?? []
      return items.map((it) => (it.section ? this.settingFor(it.section) : null))
    })
    conn.onRequest('client/registerCapability', () => null)
    conn.onRequest('client/unregisterCapability', () => null)
    conn.onRequest('window/workDoneProgress/create', () => null)
    conn.onRequest('window/showMessageRequest', () => null)
    conn.onRequest('workspace/workspaceFolders', () => this.workspaceFolders())
    // Never let a server edit files behind the write gate.
    conn.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'not supported' }))

    const root = this.roots[0]
    try {
      const result = await conn.request<{ capabilities?: Record<string, unknown> }>(
        'initialize',
        {
          // Null, not our pid: servers poll the pid they're given with kill(pid, 0) and
          // exit when that fails, and the sandbox denies signals to processes outside it,
          // so every sandboxed server would quit within seconds. Houston stops its servers
          // itself (idle timeout, run and app exit), so the watchdog isn't needed.
          processId: null,
          clientInfo: { name: 'houston' },
          rootUri: toUri(root),
          rootPath: root,
          workspaceFolders: this.workspaceFolders(),
          initializationOptions: this.server.spec.initializationOptions ?? null,
          capabilities: CLIENT_CAPABILITIES
        },
        this.opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
      )
      this.capabilities = result?.capabilities ?? {}
      conn.notify('initialized', {})
      const settings = this.server.spec.settings
      if (settings) conn.notify('workspace/didChangeConfiguration', { settings })
    } catch (e) {
      this.die(`initialize failed: ${(e as Error).message}`)
      this.killProcess()
      throw e
    }
    if (this.state !== 'starting') throw new Error(this.deathReason ?? 'the server stopped while starting')
    this.state = 'ready'
  }

  private workspaceFolders(): { uri: string; name: string }[] {
    return this.roots.map((r) => ({ uri: toUri(r), name: r.split(/[\\/]/).pop() || r }))
  }

  private settingFor(section: string): unknown {
    const all = this.server.spec.settings
    if (!all) return null
    let cur: unknown = all
    for (const part of section.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part]
      } else {
        return null
      }
    }
    return cur
  }

  /**
   * The connection broke. A crashed server breaks it too: its output ends, or the next
   * write to it fails with EPIPE, and whether Node reports that or the exit first is
   * timing. So while the process is still up, give it a moment to exit and report that,
   * with its code or signal. One that stays up on a broken connection is of no use: it
   * is killed, and the connection's reason is what it died of.
   */
  private connectionLost(reason: string): void {
    if (this.state === 'dead' || this.state === 'stopped' || this.exitGrace) return
    const p = this.proc
    if (!p || p.exitCode !== null || p.signalCode !== null) return this.die(reason)
    this.exitGrace = setTimeout(() => {
      this.die(reason)
      this.killProcess()
    }, this.opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS)
    this.exitGrace.unref?.()
  }

  private die(reason: string): void {
    if (this.exitGrace) clearTimeout(this.exitGrace)
    this.exitGrace = null
    if (this.state === 'dead' || this.state === 'stopped') return
    this.state = 'dead'
    this.deathReason = reason
    this.conn?.close(reason)
    this.docs.clear()
    // Wake anyone waiting on diagnostics; they see no new publish and give up.
    for (const set of this.waiters.values()) for (const w of set) w()
    this.waiters.clear()
    for (const l of this.deathListeners) l(reason)
  }

  private killProcess(): void {
    const p = this.proc
    if (!p || p.exitCode !== null || p.signalCode !== null) return
    try {
      ;(this.opts.killTree ?? killProcessTree)(p)
    } catch {
      // Already gone.
    }
  }

  /** Stop at once, synchronously: kill the process without the shutdown handshake. */
  kill(): void {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    this.conn?.close('stopped')
    this.killProcess()
    this.docs.clear()
    for (const set of this.waiters.values()) for (const w of set) w()
    this.waiters.clear()
  }

  /** Polite shutdown (`shutdown` then `exit`), then kill whatever is left. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return
    const conn = this.conn
    const wasLive = this.state === 'ready' || this.state === 'starting'
    this.state = 'stopped'
    if (conn && wasLive && !conn.isClosed) {
      try {
        await conn.request('shutdown', null, 2000)
        conn.notify('exit', null)
      } catch {
        // Unresponsive: the kill below handles it.
      }
    }
    conn?.close('stopped')
    const p = this.proc
    if (p && p.exitCode === null && p.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.killProcess()
          resolve()
        }, 1000)
        p.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    this.docs.clear()
    for (const set of this.waiters.values()) for (const w of set) w()
    this.waiters.clear()
  }

  private onDiagnostics(p: unknown): void {
    const params = p as { uri?: string; version?: number; diagnostics?: Diagnostic[] }
    if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return
    const uri = normalizeUri(params.uri)
    const prev = this.diags.get(uri)
    this.diags.set(uri, {
      diagnostics: params.diagnostics,
      ...(typeof params.version === 'number' ? { version: params.version } : {}),
      seq: (prev?.seq ?? 0) + 1
    })
    const set = this.waiters.get(uri)
    if (set) for (const w of set) w()
  }

  private requireConn(): JsonRpcConnection {
    if (this.state !== 'ready' || !this.conn) {
      throw new Error(`${this.server.spec.name} language server is not running`)
    }
    return this.conn
  }

  languageIdFor(abs: string): string {
    return this.server.spec.languages[extKey(abs)] ?? extKey(abs)
  }

  isOpen(abs: string): boolean {
    return this.docs.has(toUri(abs))
  }

  /** The text the server currently holds for `abs`, when open. */
  openText(abs: string): string | undefined {
    return this.docs.get(toUri(abs))?.text
  }

  /**
   * Make the server hold `text` for `abs` (read from disk when omitted): open it, or
   * send a full-content change when the text differs from what it holds. Returns the
   * document version the server now has.
   */
  async sync(abs: string, text?: string): Promise<number> {
    const conn = this.requireConn()
    const uri = toUri(abs)
    const content = text ?? (await fs.readFile(abs, 'utf8'))
    const doc = this.docs.get(uri)
    if (!doc) {
      const fresh: OpenDoc = {
        version: 1,
        text: content,
        languageId: this.languageIdFor(abs),
        markAtSync: this.diags.get(uri)?.seq ?? 0
      }
      this.docs.set(uri, fresh)
      conn.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: fresh.languageId, version: fresh.version, text: content }
      })
      this.evictOpenDocs(uri)
      return fresh.version
    }
    // Re-insert so the map's order stays least-recently-used first.
    this.docs.delete(uri)
    this.docs.set(uri, doc)
    if (doc.text === content) return doc.version
    doc.version += 1
    doc.text = content
    doc.markAtSync = this.diags.get(uri)?.seq ?? 0
    conn.notify('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text: content }]
    })
    return doc.version
  }

  /** Re-read an open document from disk and send a change if it moved; close it if it's gone. */
  async refreshFromDisk(abs: string): Promise<void> {
    if (this.state !== 'ready' || !this.isOpen(abs)) return
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      this.close(abs)
      return
    }
    await this.sync(abs, text)
  }

  /** Re-sync every open document from disk (after a shell command that may have changed any file). */
  async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.docs.keys()].map((uri) => {
        const abs = fromUri(uri)
        return abs ? this.refreshFromDisk(abs) : undefined
      })
    )
  }

  close(abs: string): void {
    const uri = toUri(abs)
    if (!this.docs.delete(uri)) return
    this.diags.delete(uri)
    if (this.state === 'ready') this.conn?.notify('textDocument/didClose', { textDocument: { uri } })
  }

  private evictOpenDocs(keep: string): void {
    const max = this.opts.maxOpenDocuments ?? DEFAULT_MAX_OPEN
    for (const uri of this.docs.keys()) {
      if (this.docs.size <= max) break
      if (uri === keep) continue
      const abs = fromUri(uri)
      if (abs) this.close(abs)
      else this.docs.delete(uri)
    }
  }

  /** The diagnostics last published for `abs`, if any. */
  diagnostics(abs: string): Diagnostic[] | undefined {
    return this.diags.get(toUri(abs))?.diagnostics
  }

  /**
   * The diagnostics for the text the server holds now, or undefined when it hasn't
   * published since that text was sent (or the file isn't open).
   */
  currentDiagnostics(abs: string): Diagnostic[] | undefined {
    const uri = toUri(abs)
    const doc = this.docs.get(uri)
    const e = this.diags.get(uri)
    if (!doc || !e || e.seq <= doc.markAtSync) return undefined
    if (e.version !== undefined && e.version < doc.version) return undefined
    return e.diagnostics
  }

  /** A marker for "what has been published so far", to wait for something newer. */
  diagnosticsMark(abs: string): number {
    return this.diags.get(toUri(abs))?.seq ?? 0
  }

  /**
   * Wait until the server publishes diagnostics for `abs` newer than `mark` (for
   * `version`, when the server reports versions), then until it has been quiet for
   * `settleMs`, since servers often publish in stages. Resolves with the latest list,
   * or null when nothing new arrived within `timeoutMs` (or the server died).
   */
  waitForDiagnostics(
    abs: string,
    opts: { mark: number; version?: number; settleMs?: number; timeoutMs?: number }
  ): Promise<Diagnostic[] | null> {
    const uri = toUri(abs)
    const settleMs = opts.settleMs ?? 300
    const timeoutMs = opts.timeoutMs ?? 10_000
    return new Promise((resolve) => {
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let done = false
      const set = this.waiters.get(uri) ?? new Set<Waiter>()
      this.waiters.set(uri, set)
      const finish = (v: Diagnostic[] | null): void => {
        if (done) return
        done = true
        clearTimeout(overall)
        if (settleTimer) clearTimeout(settleTimer)
        set.delete(check)
        resolve(v)
      }
      const fresh = (): boolean => {
        const e = this.diags.get(uri)
        if (!e || e.seq <= opts.mark) return false
        // A publish tagged with an older version is about the text before our change.
        return opts.version === undefined || e.version === undefined || e.version >= opts.version
      }
      const check: Waiter = () => {
        if (this.state !== 'ready') return finish(fresh() ? (this.diags.get(uri)?.diagnostics ?? []) : null)
        if (!fresh()) return
        if (settleTimer) clearTimeout(settleTimer)
        const versioned = this.diags.get(uri)?.version !== undefined
        settleTimer = setTimeout(
          () => finish(this.diags.get(uri)?.diagnostics ?? []),
          versioned ? settleMs : Math.max(settleMs, UNVERSIONED_SETTLE_MS)
        )
      }
      const overall = setTimeout(() => finish(fresh() ? (this.diags.get(uri)?.diagnostics ?? []) : null), timeoutMs)
      set.add(check)
      check()
    })
  }

  /** Send a request; the caller has already synced the documents it names. */
  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.requireConn().request<T>(method, params, timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  }
}

/** Servers may percent-encode differently (`%3A` vs `:`); compare by the decoded path. */
function normalizeUri(uri: string): string {
  const abs = fromUri(uri)
  return abs ? toUri(abs) : uri
}

/** What Houston tells servers it supports: sync, diagnostics, and the navigation requests it sends. */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    symbol: { dynamicRegistration: false },
    workspaceEdit: { documentChanges: true, resourceOperations: [] }
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    rename: { dynamicRegistration: false, prepareSupport: true }
  },
  window: { workDoneProgress: false }
}
