import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { MAX_MCP_MESSAGE_CHARS } from './sse-client'
import {
  flattenMcpContent,
  flattenMcpPromptMessages,
  flattenMcpResourceContents,
  type McpImageOptions
} from '@shared/mcp'
import { sanitizeChildEnv } from '../childEnv'
import { planStdioLaunch, type StdioLaunchDeps } from './stdio-launch'
import { signalProcessTree } from '../sandbox/shared'
import {
  initializeParams,
  negotiatedProtocolVersion,
  supportsElicitation,
  type McpProtocolVersion
} from './version'
import {
  ListRefresher,
  PendingRequests,
  cancelledNotification,
  handleServerMessage,
  keepAliveDuring,
  kindOf,
  mcpCancelledError,
  parseIncoming,
  type ElicitationWireResult,
  listAllPages,
  type ListedPages,
  type McpListKind
} from './protocol'
import {
  listenFilter,
  modernDiscoverError,
  readDiscoverResult,
  runWithInputs,
  withRequestMeta,
  type ClientDeclaration
} from './stateless'
import { followTask } from './tasks'
import { withTraceContext } from './trace'

/**
 * A minimal MCP client over the stdio transport: it spawns the server process and
 * speaks JSON-RPC 2.0 as newline-delimited JSON on stdin/stdout (the MCP stdio
 * framing). Enough to initialize, list tools, and call them — which covers the
 * common local servers (filesystem, git, etc.) without pulling in a heavy SDK.
 *
 * MCP servers are user-configured trusted commands; they run as normal child
 * processes (not in the Seatbelt sandbox). Their tool calls are still gated by
 * the agent's approval flow (kind "mcp" always prompts).
 */

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** A resource an MCP server exposes (addressed by uri), from `resources/list`. */
export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/**
 * HTTP 401 from a remote MCP server — the typed signal that the request lacked
 * (valid) credentials. The manager catches it to refresh an expired OAuth access
 * token and retry, or to tell the user the server needs an OAuth sign-in.
 */
export class McpUnauthorizedError extends Error {
  constructor(
    message: string,
    /** The response's WWW-Authenticate challenge, when present. */
    readonly wwwAuthenticate: string | null = null
  ) {
    super(message)
    this.name = 'McpUnauthorizedError'
  }
}

/** A prompt template an MCP server exposes, from `prompts/list`. */
export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/**
 * The transport-agnostic surface the manager uses. Implemented by McpClient
 * (stdio), McpHttpClient (streamable HTTP), and McpSseClient so the manager can
 * treat them uniformly once connected. The `tools`/`resources`/`prompts` lists
 * are kept current in place when the server sends `list_changed` notifications.
 */
export interface McpConnection {
  readonly tools: McpToolInfo[]
  /** Why entries of the last `tools/list` were dropped (see {@link parseMcpToolList}). */
  readonly droppedTools?: readonly string[]
  /** Lists the server sent more of than Houston reads, with why (see {@link listAllPages}). */
  readonly listNotes?: Readonly<Partial<Record<McpListKind, string>>>
  /** Resources the server exposes; empty when the server doesn't support them. */
  readonly resources: McpResourceInfo[]
  /** Prompt templates the server exposes; empty when it doesn't support them. */
  readonly prompts: McpPromptInfo[]
  readonly isClosed: boolean
  /**
   * Call a tool. An aborted `signal` (the run's Stop) rejects at once and sends the
   * server `notifications/cancelled`; the same holds for the two calls below. Image blocks in
   * the result go to `images.attachImage` when given (see flattenMcpContent).
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    images?: McpImageOptions,
    /** Hears a long call's status messages (a 2026-07-28 task), shown as its progress. */
    onStatus?: (message: string) => void
  ): Promise<string>
  /** Read a resource's contents by uri (flattened to text). */
  readResource(uri: string, signal?: AbortSignal): Promise<string>
  /** Fetch a prompt template by name (flattened to text). */
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string>
  close(): void
}

/** True if a server's initialize result declared the given capability. */
export function mcpCapable(initResult: unknown, capability: 'resources' | 'prompts'): boolean {
  if (!initResult || typeof initResult !== 'object') return false
  const caps = (initResult as { capabilities?: unknown }).capabilities
  return !!caps && typeof caps === 'object' && capability in (caps as object)
}

/** True if a server's initialize result declared the `resources` capability. */
export function mcpResourcesCapable(initResult: unknown): boolean {
  return mcpCapable(initResult, 'resources')
}

/** Parse a `prompts/list` result into prompt descriptors (drops malformed entries). */
export function parseMcpPromptList(result: unknown): McpPromptInfo[] {
  if (!result || typeof result !== 'object') return []
  const list = (result as { prompts?: unknown }).prompts
  if (!Array.isArray(list)) return []
  const out: McpPromptInfo[] = []
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const item = p as Record<string, unknown>
    if (typeof item.name !== 'string') continue
    const args = Array.isArray(item.arguments)
      ? (item.arguments as Array<Record<string, unknown>>)
          .filter((a) => a && typeof a.name === 'string')
          .map((a) => ({
            name: a.name as string,
            ...(typeof a.description === 'string' ? { description: a.description } : {}),
            ...(typeof a.required === 'boolean' ? { required: a.required } : {})
          }))
      : undefined
    out.push({
      name: item.name,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(args?.length ? { arguments: args } : {})
    })
  }
  return out
}

/**
 * Parse a `tools/list` result into tool descriptors. The list crosses a trust
 * boundary and one bad entry must not take the rest down with it: an entry that is
 * not an object, or has no non-empty string `name`, is dropped (and described in
 * `dropped`, when given, for the manager to report); a description that is a number
 * or boolean becomes its string, any other non-string one is left out; an
 * `inputSchema` that is not a plain object is left out (the manager normalizes the
 * rest, see tool-exposure.ts).
 */
export function parseMcpToolList(result: unknown, dropped?: string[]): McpToolInfo[] {
  if (!result || typeof result !== 'object') return []
  const list = (result as { tools?: unknown }).tools
  if (!Array.isArray(list)) return []
  const out: McpToolInfo[] = []
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      dropped?.push(`entry ${i + 1} is not a tool object (${t === null ? 'null' : Array.isArray(t) ? 'array' : typeof t})`)
      return
    }
    const item = t as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name) {
      dropped?.push(`entry ${i + 1} has no tool name`)
      return
    }
    const d = item.description
    const description =
      typeof d === 'string' ? d : typeof d === 'number' || typeof d === 'boolean' ? String(d) : undefined
    const schema = item.inputSchema
    out.push({
      name: item.name,
      ...(description !== undefined ? { description } : {}),
      ...(schema && typeof schema === 'object' && !Array.isArray(schema)
        ? { inputSchema: schema as Record<string, unknown> }
        : {})
    })
  })
  return out
}

/** Parse a `resources/list` result into resource descriptors (drops malformed entries). */
export function parseMcpResourceList(result: unknown): McpResourceInfo[] {
  if (!result || typeof result !== 'object') return []
  const list = (result as { resources?: unknown }).resources
  if (!Array.isArray(list)) return []
  const out: McpResourceInfo[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const item = r as Record<string, unknown>
    if (typeof item.uri !== 'string') continue
    out.push({
      uri: item.uri,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {})
    })
  }
  return out
}

const INIT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 120_000
/** Wait before reopening a `subscriptions/listen` stream the server ended. */
const RELISTEN_DELAY_MS = 1_000
/** stderr kept from a stdio server, so its exit can name the reason. */
const STDERR_TAIL_CHARS = 4_000
/** How long an exit waits for the rest of stderr before reporting without it. */
const STDERR_SETTLE_MS = 200
/** Longest stderr line quoted when a server exits. */
const MAX_EXIT_DETAIL_CHARS = 300

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    windowsVerbatimArguments?: boolean
    detached?: boolean
  }
) => ChildProcessWithoutNullStreams

/** How long a closed stdio server's process group gets to exit on SIGTERM before SIGKILL. */
export const MCP_KILL_GRACE_MS = 2_000

/**
 * Process groups of stdio servers this process spawned that may still have live
 * members. On POSIX each server leads its own group (it is spawned detached, so a
 * launcher like `npx`, `uvx` or `sh -c` and whatever it starts can be stopped
 * together), which also means a terminal's Ctrl-C or Houston's own exit no longer
 * reaches them. So when this process exits, every group still listed is SIGKILLed.
 */
const liveGroups = new Set<number>()
let exitHookInstalled = false

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    // ESRCH: the group is empty. EPERM: not ours to signal. Nothing to stop either way.
    return false
  }
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // 'exit' handlers run synchronously, which process.kill is.
  process.once('exit', killLiveMcpGroups)
}

/**
 * SIGKILL every stdio server group still running (POSIX). Runs when this process
 * exits, so a server that was never closed, or that ignored the SIGTERM a quit's
 * disconnect sent it, doesn't outlive Houston in its own group.
 */
export function killLiveMcpGroups(): void {
  for (const g of liveGroups) killGroup(g)
  liveGroups.clear()
}

/**
 * Stop a stdio server and everything it started. POSIX: SIGTERM its process group,
 * then SIGKILL the group if anything in it is still running after the grace. Windows
 * has no process groups here: the tree is killed by parent pid (`taskkill /T /F`),
 * which is already forceful, so nothing is escalated.
 *
 * Once the server is known to have exited (`exited`), its pid is no longer its own: the
 * system may have handed it to any other process. Windows then gets no `taskkill`, and
 * POSIX signals the group only while it is still listed as having live members (a
 * group that still has members keeps its id).
 */
function stopServerTree(child: ChildProcessWithoutNullStreams, grouped: boolean, exited: boolean): void {
  const pid = child.pid
  if (pid === undefined || !grouped) {
    try {
      child.kill()
    } catch {
      // already gone
    }
    return
  }
  if (process.platform === 'win32') {
    if (!exited) signalProcessTree(child, 'SIGTERM')
    return
  }
  if ((exited && !liveGroups.has(pid)) || !groupAlive(pid)) {
    liveGroups.delete(pid)
    return
  }
  signalProcessTree(child, 'SIGTERM')
  const timer = setTimeout(() => {
    if (liveGroups.has(pid) && groupAlive(pid)) killGroup(pid)
    liveGroups.delete(pid)
  }, MCP_KILL_GRACE_MS)
  timer.unref?.()
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new PendingRequests()
  /** The unfinished line so far, in pieces: joined once its newline arrives. */
  private partial: string[] = []
  private partialChars = 0
  private readonly decoder = new StringDecoder('utf8')
  /** The end of what the server wrote to stderr, to say why it exited. */
  private stderrTail = ''
  private readonly stderrDecoder = new StringDecoder('utf8')
  private closed = false
  /** Whether the server is a real process whose tree close() should stop. */
  private grouped = false
  /** Set once close() has signalled the server, so a second close() is a no-op. */
  private stopped = false
  /** Set when the server process exited: its pid may belong to another process now. */
  private exited = false
  /** Capabilities the server declared at initialize (gates list re-fetches). */
  private capable: Record<McpListKind, boolean> = { tools: true, resources: false, prompts: false }
  private readonly refresher = new ListRefresher({
    isClosed: () => this.closed,
    capable: (kind) => this.capable[kind],
    fetch: (kind) => this.refreshList(kind)
  })
  tools: McpToolInfo[] = []
  droppedTools: string[] = []
  listNotes: Partial<Record<McpListKind, string>> = {}
  resources: McpResourceInfo[] = []
  prompts: McpPromptInfo[] = []

  constructor(
    private readonly spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn,
    /** Platform/fs overrides for resolving the command (tests). */
    private readonly launchDeps: StdioLaunchDeps = {}
  ) {}

  /** True once the process exited, errored, or the client was closed. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Answers `elicitation/create`; its presence declares the capability. */
  /** The version agreed at initialize; set once the handshake answers. */
  private protocolVersion?: McpProtocolVersion
  /** The server speaks 2026-07-28 (see handshake): requests carry `_meta`, no initialize. */
  private modern = false
  /** The id of the open `subscriptions/listen` request (2026-07-28 only). */
  private listenId?: number
  private onElicit?: (params: unknown) => Promise<ElicitationWireResult>

  /** Spawn the server, perform the initialize handshake, and list its tools. */
  async connect(opts: {
    command: string
    args?: string[]
    env?: NodeJS.ProcessEnv
    cwd?: string
    onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  }): Promise<void> {
    this.onElicit = opts.onElicit
    // Strip the launching shell's credential-bearing vars so a malicious or
    // compromised MCP server can't harvest ambient secrets (AWS keys, GH_TOKEN,
    // *_API_KEY, …) on startup. A server that legitimately needs a token still
    // gets it: `opts.env` (from McpServerConfig.env) is applied AFTER the strip.
    const env = { ...sanitizeChildEnv(), ...opts.env }
    // On Windows an `npx`-style command is a .cmd shim that spawn can't run directly.
    // A test's fake spawn starts no executable, so there is nothing on disk to
    // resolve: it is planned only when the test asks for a platform explicitly.
    const realSpawn = this.spawnFn === (nodeSpawn as unknown as SpawnFn)
    const launch =
      realSpawn || this.launchDeps.platform
        ? planStdioLaunch(opts.command, opts.args ?? [], env, { cwd: opts.cwd, ...this.launchDeps })
        : { command: opts.command, args: opts.args ?? [] }
    // POSIX: its own process group, so close() can stop what a launcher started too.
    // Not on Windows, where detached would open a console window; the tree is killed
    // by parent pid there instead.
    const detached = process.platform !== 'win32'
    const child = this.spawnFn(launch.command, launch.args, {
      env,
      cwd: opts.cwd,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(detached ? { detached: true } : {})
    })
    this.child = child
    // Only a real process (with a pid) is tracked; test fakes have none.
    this.grouped = child.pid !== undefined
    if (detached && child.pid !== undefined) trackGroup(child.pid)
    child.stdout.on('data', (c: Buffer) => this.onData(c))
    // Read stderr even though nothing needs it while the server runs: an unread pipe
    // fills (64 KB or so), and a server that logs to stderr, as the spec lets it, then
    // blocks on its next write and stops answering, so every call times out. Only the
    // tail is kept, to explain an exit.
    child.stderr?.on('data', (c: Buffer) => {
      this.stderrTail = (this.stderrTail + this.stderrDecoder.write(c)).slice(-STDERR_TAIL_CHARS)
    })
    // A write to a server that has gone away fails with EPIPE, which Node reports as an
    // 'error' event on stdin. Unheard, it surfaces as an uncaught exception (the
    // standalone CLI exits on those), so treat it like the process exiting.
    child.stdin.on('error', (e: Error) => this.failAll(`MCP server stopped reading input: ${e.message}`))
    // 'exit' can arrive before the last of stderr has been read, so give the stream a
    // moment to end before quoting it (bounded: a grandchild may hold the pipe open).
    let stderrEnded = false
    child.stderr?.once('end', () => (stderrEnded = true))
    child.on('exit', () => {
      this.exited = true
      // A server that exited on its own and left nothing behind needs no stop at quit.
      if (detached && child.pid !== undefined && !groupAlive(child.pid)) liveGroups.delete(child.pid)
      // Closed at once, so a new request fails fast; in-flight ones settle with the reason.
      this.closed = true
      const fail = (): void => this.failAll(`MCP server process exited${this.lastStderrLine()}`)
      if (stderrEnded || !child.stderr) return fail()
      const timer = setTimeout(fail, STDERR_SETTLE_MS)
      child.stderr.once('end', () => {
        clearTimeout(timer)
        fail()
      })
    })
    child.on('error', (e: Error) => this.failAll(`MCP server failed to start: ${e.message}`))

    const init = await this.handshake()

    const listed = await this.fetchList('tools')
    this.setTools(listed)

    // Only ask for resources/prompts when the server declared the capability —
    // avoids an unsupported-method error (or a hang) against servers without them.
    this.capable.resources = mcpCapable(init, 'resources')
    this.capable.prompts = mcpCapable(init, 'prompts')
    if (this.capable.resources) {
      try {
        this.resources = parseMcpResourceList(
          await this.fetchList('resources')
        )
      } catch {
        this.resources = []
      }
    }
    if (this.capable.prompts) {
      try {
        this.prompts = parseMcpPromptList(await this.fetchList('prompts'))
      } catch {
        this.prompts = []
      }
    }
    if (this.modern) this.listen()
  }

  /**
   * Learn which era the server is, and set up for it. A 2026-07-28 server answers
   * `server/discover` and needs no handshake; an older one answers `initialize`. stdio
   * gives no status code to tell them apart, and an older server may never answer a
   * request it doesn't know, so both go out at once, discovery first: whichever the
   * server answers decides. A server answering both is treated as 2026-07-28. One that
   * answers discovery with the revision's own errors is modern and is not asked to
   * initialize instead (UnsupportedProtocolVersion fails the connection). Returns what
   * the server declared (its capabilities are read from it).
   */
  private async handshake(): Promise<unknown> {
    const decl = this.declaration()
    const stopDiscover = new AbortController()
    let discovered: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined
    const discover = this.request('server/discover', withRequestMeta({}, decl), INIT_TIMEOUT_MS, {
      signal: stopDiscover.signal,
      quietCancel: true
    }).then(
      (value) => (discovered = { ok: true, value }),
      (error) => (discovered = { ok: false, error })
    )
    const init = this.request('initialize', initializeParams({ elicitation: !!this.onElicit }), INIT_TIMEOUT_MS)
    // Neither may go unheard: the one that loses is settled (or ignored) on its own.
    void init.catch(() => {})
    const readDiscovered = (): unknown | null | undefined => {
      if (!discovered) return undefined
      if (discovered.ok) return readDiscoverResult(discovered.value) ? discovered.value : null
      const modern = modernDiscoverError(discovered.error)
      if (modern) throw modern
      return null
    }
    const settledInit = await Promise.race([
      init.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      ),
      discover.then(() => null)
    ])
    if (settledInit === null) {
      // Discovery answered first.
      const modern = readDiscovered()
      if (modern) return this.becomeModern(modern)
      return this.finishLegacy(await init)
    }
    // initialize answered first. A server's replies come in order, so a discovery it
    // answered before initialize has been read already; give the line handler a turn.
    await new Promise((r) => setImmediate(r))
    if (!settledInit.ok) {
      // A 2026-07-28 server rejects initialize: its discovery answer decides.
      await discover
      const modern = readDiscovered()
      if (modern) return this.becomeModern(modern)
      throw settledInit.error
    }
    const modern = readDiscovered()
    if (modern) return this.becomeModern(modern)
    stopDiscover.abort()
    return this.finishLegacy(settledInit.value)
  }

  /** Speak 2026-07-28 from now on: every request carries its `_meta`, and no handshake follows. */
  private becomeModern(discovered: unknown): unknown {
    this.modern = true
    return discovered
  }

  /** Finish the `initialize` handshake with an older server. */
  private finishLegacy(init: unknown): unknown {
    this.protocolVersion = negotiatedProtocolVersion(init)
    // A server that negotiated down to a version without elicitation never gets
    // an elicitation answer: its requests fall through to the -32601 decline.
    if (!supportsElicitation(this.protocolVersion)) this.onElicit = undefined
    this.notify('notifications/initialized', {})
    return init
  }

  /** What each 2026-07-28 request declares about this client. */
  private declaration(): ClientDeclaration {
    return { elicitation: !!this.onElicit, tasks: true }
  }

  /**
   * Send a request that may need input on a 2026-07-28 server (see runWithInputs). An
   * older server's request goes out once, as before.
   */
  private requestWithInputs(
    method: string,
    params: Record<string, unknown>,
    opts: { progress?: boolean; signal?: AbortSignal; tasks?: boolean; onStatus?: (message: string) => void } = {}
  ): Promise<unknown> {
    const { tasks, onStatus, ...sendOpts } = opts
    if (!this.modern) return this.request(method, params, CALL_TIMEOUT_MS, sendOpts)
    return runWithInputs((p) => this.request(method, p, CALL_TIMEOUT_MS, sendOpts), params, {
      method,
      onElicit: this.onElicit,
      signal: opts.signal,
      // A long call may come back as a task (the Tasks extension): follow it to its result.
      ...(tasks
        ? {
            onTask: (created: unknown) =>
              followTask(created, method, {
                request: (m, p) =>
                  this.request(m, p, CALL_TIMEOUT_MS, m === 'tasks/get' ? { signal: opts.signal } : {}),
                signal: opts.signal,
                onElicit: this.onElicit,
                onStatus
              })
          }
        : {})
    })
  }

  /**
   * Open the 2026-07-28 change-notification stream (`subscriptions/listen`) for the
   * lists the server declared. On stdio it is a request that stays pending: its
   * notifications arrive on the shared channel and drive the same re-fetches as before.
   * When the server ends it cleanly it is reopened; an error ends listening.
   */
  private listen(): void {
    if (this.closed || !this.modern) return
    const id = this.nextId++
    this.listenId = id
    try {
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: withRequestMeta({ notifications: listenFilter(this.capable) }, this.declaration())
      })
    } catch {
      // A broken pipe surfaces via 'exit'/'error'.
    }
  }

  /** The listen request was answered: a clean end is reopened, an error is not. */
  private onListenEnded(msg: { error?: unknown }): void {
    this.listenId = undefined
    if (msg.error || this.closed) return
    const timer = setTimeout(() => this.listen(), RELISTEN_DELAY_MS)
    timer.unref?.()
  }

  /** Call a tool and return its flattened text result. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    images?: McpImageOptions,
    onStatus?: (message: string) => void
  ): Promise<string> {
    const res = (await this.requestWithInputs('tools/call', { name, arguments: args ?? {} }, { progress: true, signal, tasks: true, onStatus })) as {
      content?: unknown
      isError?: boolean
    }
    const text = flattenMcpContent(res?.content, images)
    return res?.isError ? `${text}\n[the MCP tool reported an error]`.trim() : text || '[no output]'
  }

  /** Read a resource's contents by uri, flattened to text. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const res = await this.requestWithInputs('resources/read', { uri }, { signal })
    return flattenMcpResourceContents(res) || '[no content]'
  }

  /** Fetch a prompt template by name, flattened to text. */
  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const res = await this.requestWithInputs('prompts/get', { name, arguments: args ?? {} }, { signal })
    return flattenMcpPromptMessages(res) || '[no content]'
  }

  /** Fetch a whole list, every page (see listAllPages), noting when it was cut short. */
  private async fetchList(kind: McpListKind): Promise<ListedPages> {
    const listed = await listAllPages((params) => this.request(`${kind}/list`, params, INIT_TIMEOUT_MS), kind)
    if (listed.truncated) this.listNotes[kind] = listed.truncated
    else delete this.listNotes[kind]
    return listed
  }

  /** Take a `tools/list` result, keeping only well-formed tools (see parseMcpToolList). */
  private setTools(listed: unknown): void {
    const dropped: string[] = []
    this.tools = parseMcpToolList(listed, dropped)
    this.droppedTools = dropped
  }

  close(): void {
    if (this.listenId !== undefined && !this.closed) {
      // Ending a stdio subscription is a cancel of its listen request.
      try {
        this.send(cancelledNotification(this.listenId))
      } catch {
        // The process is being stopped anyway.
      }
      this.listenId = undefined
    }
    this.closed = true
    this.failAll('MCP client closed')
    if (!this.child || this.stopped) return
    this.stopped = true
    stopServerTree(this.child, this.grouped, this.exited)
  }

  // ---- transport internals ----

  private onData(chunk: Buffer): void {
    // Decoded as a stream: a multibyte character split across two pipe chunks would
    // otherwise decode as two replacement characters, corrupting the message text.
    const text = this.decoder.write(chunk)
    // Only the new text is searched for a newline, and a long line's pieces are joined
    // once, when it ends. Appending to one buffer and searching it from the start on
    // every chunk made a large message cost time proportional to its size squared.
    let from = 0
    let nl: number
    while ((nl = text.indexOf('\n', from)) >= 0) {
      const piece = text.slice(from, nl)
      const line = (this.partial.length ? this.partial.join('') + piece : piece).trim()
      this.partial = []
      this.partialChars = 0
      from = nl + 1
      if (line) this.handleLine(line)
    }
    if (from < text.length) {
      const rest = text.slice(from)
      this.partial.push(rest)
      this.partialChars += rest.length
      if (this.partialChars > MAX_MCP_MESSAGE_CHARS) {
        // A server that never ends its message is broken; don't buffer it without limit.
        this.partial = []
        this.partialChars = 0
        this.failAll(`MCP server sent a message larger than ${MAX_MCP_MESSAGE_CHARS / 1024 / 1024} MB`)
        this.close()
      }
    }
  }

  /** Process one newline-delimited JSON-RPC message. Exposed for testing. */
  handleLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return // ignore non-JSON noise
    }
    const msg = parseIncoming(raw)
    if (!msg) return
    if (kindOf(msg) === 'response') {
      if (this.listenId !== undefined && msg.id === this.listenId) return this.onListenEnded(msg)
      this.pending.settle(msg.id as number | string, msg)
      return
    }
    handleServerMessage(msg, {
      send: (payload) => {
        try {
          this.send(payload)
        } catch {
          // Replying is best-effort; a broken pipe surfaces via 'exit'/'error'.
        }
      },
      onListChanged: (kind) => this.refresher.schedule(kind),
      touchProgress: (token) => this.pending.touch(token),
      ...(this.onElicit
        ? { onElicit: (p: unknown) => keepAliveDuring(this.pending, () => this.onElicit!(p)) }
        : {})
    })
  }

  /** Re-fetch one changed list in place (driven by the ListRefresher). */
  private async refreshList(kind: McpListKind): Promise<void> {
    if (kind === 'tools') {
      const listed = await this.fetchList('tools')
      if (Array.isArray(listed?.tools)) this.setTools(listed)
    } else if (kind === 'resources') {
      this.resources = parseMcpResourceList(await this.fetchList('resources'))
    } else {
      this.prompts = parseMcpPromptList(await this.fetchList('prompts'))
    }
  }

  private send(obj: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { progress?: boolean; signal?: AbortSignal; quietCancel?: boolean } = {}
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'))
    // Stopped before it went out: nothing to send, and nothing to cancel.
    if (opts.signal?.aborted) return Promise.reject(mcpCancelledError(method))
    const id = this.nextId++
    // Ask for progress on long calls: a server that reports it keeps the call's
    // inactivity clock (see PendingRequests) from expiring mid-work.
    const withProgress = opts.progress
      ? {
          ...(params as Record<string, unknown>),
          _meta: { ...((params as { _meta?: Record<string, unknown> })?._meta ?? {}), progressToken: id }
        }
      : params
    // A 2026-07-28 server reads the version and capabilities from every request.
    const sent = this.modern ? withRequestMeta(withProgress, this.declaration()) : withProgress
    const result = this.pending.wait(id, method, timeoutMs, undefined, {
      signal: opts.signal,
      onCancel: () => {
        // quietCancel: a request withdrawn locally (an unneeded discovery) is not
        // announced, since an older server has not been initialized yet.
        if (!this.closed && !opts.quietCancel) this.send(cancelledNotification(id))
      }
    })
    try {
      this.send({ jsonrpc: '2.0', id, method, params: withTraceContext(sent) })
    } catch (e) {
      // A synchronous write failure (e.g. EPIPE on a closing pipe) must settle the
      // pending entry + timers; reject does both.
      this.pending.reject(id, e as Error)
    }
    return result
  }

  /** `: <the server's last stderr line>` for an exit message, or '' when it wrote none. */
  private lastStderrLine(): string {
    const last = this.stderrTail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    // The server's own text lands in the UI, the log, and the terminal: no control characters.
    // eslint-disable-next-line no-control-regex
    const line = (last ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
    if (!line) return ''
    return `: ${line.length > MAX_EXIT_DETAIL_CHARS ? `${line.slice(0, MAX_EXIT_DETAIL_CHARS - 1)}…` : line}`
  }

  private failAll(message: string): void {
    // A process that exited/errored (or an explicit close) can never answer again —
    // mark the client closed so later request()s reject immediately instead of
    // hanging until the call timeout on a dead server.
    this.closed = true
    this.pending.failAll(message)
  }
}
