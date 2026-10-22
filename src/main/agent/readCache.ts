import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { ImageAttachment } from '@shared/images'
import type { DocumentAttachment } from '@shared/agent'
import { ASK_USER_NAME, type ToolKind } from './tools'

/**
 * Per-run content-addressed cache for repeated READ-ONLY tool calls.
 *
 * Weak models love the re-read pattern: read a file, do a little reasoning, then
 * read the *same* file again (often the identical `read_file`/`glob`/`search_files`
 * call) a few turns later. Re-executing those pure reads burns tokens, latency, and
 * dollars for a byte-identical result. This memoizes a read's result for the
 * lifetime of a single run so an identical repeat is served from memory instead of
 * hitting the filesystem again — while the renderer and persisted transcript still
 * show a normal tool call (the loop emits tool_start/tool_result on a hit too).
 *
 * CORRECTNESS is the whole game here. A file the agent edits mid-run changes on
 * disk, so a stale cached read would be flat-out wrong. The cache is therefore:
 *   - RUN-SCOPED: created per `startRun` and dropped when the run ends, so it never
 *     leaks across runs or conversations (a later run re-reads from disk).
 *   - INVALIDATED on every mutation within the run: a `write` tool touching a path
 *     drops the entries that depend on that path (and every tree-spanning read,
 *     since a search/glob result depends on the whole tree); a `shell` call clears
 *     the cache wholesale, because an arbitrary command can change any file.
 *   - REVALIDATED against the filesystem on every hit, because the agent is not the
 *     only writer. A user editing a file in their editor mid-run, a rebase, or a
 *     background build changes disk without any tool call for the cache to key off,
 *     so invalidation alone would serve that user their own pre-edit content. See
 *     {@link ReadCache.get}.
 * We deliberately prefer conservative invalidation (correctness) over hit-rate.
 *
 * Only genuinely pure reads are cached — an explicit allowlist of on-disk-state
 * deterministic tools (read_file/list_dir/search_files/glob/ast_grep). Never writes,
 * shell, network, MCP, `ask_user`, or stateful/non-deterministic reads like
 * `read_shell_output` or subagent spawns. See {@link isCacheableRead}.
 */

/** The memoized result of a read tool call — everything a tool_result carries. */
export interface CachedRead {
  output: string
  ok: boolean
  images: ImageAttachment[]
  documents: DocumentAttachment[]
}

/**
 * What a cached read depends on, so a later mutation can invalidate exactly the
 * entries it could have changed. `paths` are canonical (absolute, resolved) file
 * paths a read is scoped to (e.g. the single file `read_file` returned, or the
 * directory `list_dir` listed). `wholeTree` marks a read whose result depends on
 * the entire workspace (content/structural/glob search), so ANY write invalidates
 * it — a match could appear or vanish anywhere.
 */
export interface ReadDeps {
  paths: string[]
  wholeTree: boolean
}

/** Read tools whose result depends on the whole workspace tree, not one path. */
const TREE_SPANNING_READS = new Set(['search_files', 'glob', 'ast_grep'])

/**
 * The ONLY tools safe to memoize: genuinely pure reads whose result is a
 * deterministic function of on-disk state, so an identical repeat within a run
 * returns a byte-identical result. Note `kind==='read'` is NECESSARY BUT NOT
 * SUFFICIENT — the `read` kind here only means "no approval needed", not
 * "side-effect-free". Several read-kind tools are stateful or non-deterministic and
 * caching them would be flat-out wrong:
 *   - `read_shell_output` is a cursor-advancing poll — it returns output SINCE the
 *     last read, so replaying the first chunk makes a background-shell polling loop
 *     see the same stale output forever and hang.
 *   - `dispatch_agent` / `review_changes` spawn non-deterministic subagents; a hit
 *     would replay a stale report instead of re-running the work.
 *   - `git_status` / `git_diff` / `recall_history` / `pr_sweep` / `todo_write` / …
 *     reflect mutable external or session state the cache can't track to invalidate.
 * So the gate is an explicit ALLOWLIST, not the `read` kind. Anything not listed —
 * including any future read-kind tool — is never cached.
 */
const CACHEABLE_READS = new Set(['read_file', 'list_dir', 'search_files', 'glob', 'ast_grep'])

/**
 * Whether a tool call is safe to serve from / store in the read cache. True only for
 * the pure, on-disk-state-deterministic reads in {@link CACHEABLE_READS}. `_kind` is
 * taken for call-site parity with the dispatch predicates but is deliberately NOT the
 * gate — a `read` kind means "no approval needed", not "side-effect-free" (see the
 * allowlist rationale above). Writes, shell, network, MCP, and stateful or
 * non-deterministic reads are all excluded.
 */
export function isCacheableRead(name: string, _kind: ToolKind): boolean {
  return name !== ASK_USER_NAME && CACHEABLE_READS.has(name)
}

/**
 * Canonical, stable string for a tool call's arguments so that `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same cache key. Object keys are sorted recursively;
 * arrays keep their order (semantically meaningful for e.g. multi_edit). Values
 * that JSON can't represent are dropped by JSON.stringify, which is fine — reads
 * only carry JSON-representable args.
 */
export function canonicalArgs(args: Record<string, unknown>): string {
  return stableStringify(args)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  // Drop keys whose value is `undefined` so an explicit `{a:1,b:undefined}` keys
  // identically to `{a:1}` — JSON omits undefined-valued keys, and semantically an
  // absent optional arg and one passed as undefined are the same call. (Without
  // this, stableStringify(undefined) yields 'null', splitting the two into distinct
  // cache entries and silently losing the hit.)
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** The cache key for a read call: tool name + canonical args. */
export function cacheKey(name: string, args: Record<string, unknown>): string {
  return `${name} ${canonicalArgs(args)}`
}

/**
 * A file's identity at a moment in time — what we compare to decide whether a
 * cached read still reflects disk. `null` means the path did not exist, which is
 * itself a meaningful state to compare (a `list_dir` of a since-deleted directory
 * must not stay cached).
 */
export type PathStamp = { mtimeMs: number; size: number } | null

/** Stat one canonical absolute path, resolving to `null` when it does not exist. */
export type StatPath = (abs: string) => Promise<PathStamp>

/**
 * The real filesystem {@link StatPath}. Size is carried alongside mtime because
 * mtime granularity is coarser than an edit can be: a filesystem that stamps whole
 * seconds (or a tool that preserves mtime) can land a change the timestamp alone
 * misses, and a differently-sized file is then still caught. Same-size, same-mtime
 * rewrites remain undetectable by stat — hashing every read to close that is not
 * worth what it costs on large files.
 */
export const statPath: StatPath = async (abs) => {
  try {
    const st = await fs.stat(abs)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    // A missing path is a legitimate state, not an error: stamping it as `null` is
    // what makes "file appeared" and "file vanished" register as staleness.
    return null
  }
}

/** Whether two stamps describe the same file state (both absent counts as same). */
function sameStamp(a: PathStamp, b: PathStamp): boolean {
  if (a === null || b === null) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * How long a tree-spanning read (`search_files`/`glob`/`ast_grep`) may be served
 * from cache before it must re-run.
 *
 * Scoped reads revalidate exactly: one `stat` of the path they read is cheap and
 * conclusive. A search has no such handle — its result depends on every file in the
 * tree, including files that did NOT match (an external edit can create a match
 * anywhere), so the only exact revalidation is a full tree walk, which costs about
 * what re-running the search costs. Rather than pay that to save nothing, or pin a
 * possibly-stale result for the whole run, tree reads get a bounded staleness
 * window: long enough to absorb the same search repeated a turn or two later, short
 * enough that an edit made in an editor is picked up while the user is still looking
 * at it.
 */
export const TREE_READ_TTL_MS = 30_000

interface Entry {
  result: CachedRead
  deps: ReadDeps
  /** Stamp of each `deps.paths` entry when stored, positionally parallel to it. */
  stamps: PathStamp[]
  /** When this entry was stored, for the {@link TREE_READ_TTL_MS} window. */
  storedAt: number
}

/**
 * A run-scoped read cache. One instance per `startRun`; passed to the tool-dispatch
 * sites which consult {@link get} before executing and {@link set} the result after,
 * and call {@link invalidatePaths} / {@link invalidateAll} when a mutation occurs.
 *
 * `stat` and `now` are injected so the cache stays a pure unit under test; the loop
 * passes {@link statPath} and `Date.now`.
 */
export class ReadCache {
  private readonly entries = new Map<string, Entry>()
  private readonly stat: StatPath
  private readonly now: () => number
  private readonly treeTtlMs: number

  constructor(opts: { stat: StatPath; now?: () => number; treeTtlMs?: number }) {
    this.stat = opts.stat
    this.now = opts.now ?? Date.now
    this.treeTtlMs = opts.treeTtlMs ?? TREE_READ_TTL_MS
  }

  /**
   * A previously-cached result for this exact call, or undefined on a miss.
   *
   * Revalidates before serving: an entry whose files changed on disk since it was
   * stored is dropped and reported as a miss, so the caller re-reads. This is what
   * catches writers the cache never saw — the user editing in their editor, a git
   * operation, a background build — as opposed to {@link invalidatePaths}, which
   * only knows about the agent's own tool calls.
   */
  async get(name: string, args: Record<string, unknown>): Promise<CachedRead | undefined> {
    const key = cacheKey(name, args)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (await this.isStale(entry)) {
      this.entries.delete(key)
      return undefined
    }
    return entry.result
  }

  /**
   * Whether an entry no longer reflects disk. A tree-spanning read can't be checked
   * exactly, so it expires on the {@link TREE_READ_TTL_MS} window instead; a scoped
   * read is stale when any path it depends on has a different stamp than at store
   * time (including having been created or deleted).
   */
  private async isStale(entry: Entry): Promise<boolean> {
    if (entry.deps.wholeTree) return this.now() - entry.storedAt >= this.treeTtlMs
    const fresh = await Promise.all(entry.deps.paths.map((p) => this.stat(p)))
    return fresh.some((f, i) => !sameStamp(f, entry.stamps[i]))
  }

  /**
   * Memoize a read's result. `deps` records what the result depends on so a later
   * write can invalidate it precisely, and each dep path is stamped so a hit can be
   * revalidated against disk. Failed reads (`ok:false`) are NOT cached — an error is
   * often transient (a race with a concurrent write, a not-yet-created file) and
   * re-reading is cheap and safer than pinning a stale failure.
   *
   * The stamp is taken AFTER the read returned, so a write landing mid-read stamps
   * the post-write file against pre-write content. That entry would then look fresh.
   * The window is sub-millisecond and the next mutation invalidates it anyway, but
   * it is the reason stamping is not a substitute for {@link invalidatePaths}.
   */
  async set(
    name: string,
    args: Record<string, unknown>,
    result: CachedRead,
    deps: ReadDeps
  ): Promise<void> {
    if (!result.ok) return
    const stamps = await Promise.all(deps.paths.map((p) => this.stat(p)))
    this.entries.set(cacheKey(name, args), { result, deps, stamps, storedAt: this.now() })
  }

  /**
   * Invalidate every entry that could have been changed by a write touching any of
   * `paths` (canonical absolute paths). An entry is dropped when it reads one of
   * those paths, when it lists a directory that contains (or is contained by) one,
   * or when it is a tree-spanning read (a search/glob whose matches can shift with
   * any file change). Paths are compared as path-prefix segments so writing
   * `/w/src/a.ts` invalidates a `list_dir` of `/w/src` and vice-versa.
   */
  invalidatePaths(paths: string[]): void {
    if (paths.length === 0) return
    for (const [key, entry] of this.entries) {
      if (entry.deps.wholeTree || entry.deps.paths.some((p) => pathsOverlap(p, paths))) {
        this.entries.delete(key)
      }
    }
  }

  /** Drop everything. Used after a shell call, which can change arbitrary files. */
  invalidateAll(): void {
    this.entries.clear()
  }

  /** Current entry count — for tests/observability. */
  get size(): number {
    return this.entries.size
  }
}

/** Whether `p` overlaps any path in `others`: equal, ancestor, or descendant. */
function pathsOverlap(p: string, others: string[]): boolean {
  return others.some((o) => p === o || isPathPrefix(p, o) || isPathPrefix(o, p))
}

/**
 * Whether `prefix` is a path-segment prefix of `full` (e.g. /a/b is a prefix of /a/b/c).
 * Both separators count: the paths come from `resolveInRoots`, which spells them with
 * `\\` on Windows, where a `/`-only check never matched and a write under a listed
 * directory left that listing cached. Elsewhere a `\\` can only over-invalidate.
 */
function isPathPrefix(prefix: string, full: string): boolean {
  return ['/', '\\'].some((s) => full.startsWith(prefix.endsWith(s) ? prefix : `${prefix}${s}`))
}

/**
 * Compute what a read call's result depends on, for precise invalidation. For a
 * scoped read (`read_file`, `list_dir`) the dependency is the resolved path it was
 * given; for a tree-spanning search (`search_files`, `glob`, `ast_grep`) it's the
 * whole tree. `resolvePath` maps the call's `path` argument to a canonical absolute
 * path (the loop passes tools.ts's `resolveInRoots`); a resolution failure (e.g. a
 * bad path) falls back to a whole-tree dependency so we never under-invalidate.
 */
export function readDeps(
  name: string,
  args: Record<string, unknown>,
  resolvePath: (rel: string) => string
): ReadDeps {
  if (TREE_SPANNING_READS.has(name)) return { paths: [], wholeTree: true }
  const rel = typeof args.path === 'string' ? args.path : ''
  // list_dir defaults to '.', read_file requires a path; either way an empty or
  // missing path means "the workspace root", which we treat as whole-tree.
  if (rel === '' || rel === '.') return { paths: [], wholeTree: true }
  try {
    return { paths: [resolvePath(rel)], wholeTree: false }
  } catch {
    return { paths: [], wholeTree: true }
  }
}

/**
 * Canonical absolute paths a WRITE call mutates, for {@link ReadCache.invalidatePaths}.
 * `write_file`/`edit_file`/`multi_edit` carry a single `path`; `apply_patch` can
 * touch several files, extracted via `patchPaths`. `resolvePath` maps each to a
 * canonical absolute path. If nothing can be resolved (an unrecognized write or a
 * malformed patch) the caller should fall back to {@link ReadCache.invalidateAll}
 * — see {@link writeTouchesUnknownPaths}.
 */
export function writePaths(
  name: string,
  args: Record<string, unknown>,
  resolvePath: (rel: string) => string,
  patchPaths: (patch: string) => string[]
): string[] {
  const rels: string[] = []
  if (typeof args.path === 'string' && args.path) rels.push(args.path)
  if (name === 'apply_patch' && typeof args.patch === 'string') {
    for (const p of patchPaths(args.patch)) rels.push(p)
  }
  const out: string[] = []
  for (const rel of rels) {
    try {
      out.push(resolvePath(rel))
    } catch {
      // A path that won't resolve can't be intersected against read deps; the
      // caller invalidates broadly instead (see writeTouchesUnknownPaths).
    }
  }
  return out
}

/**
 * Whether a write call's mutated paths can't be determined (so the cache must be
 * cleared wholesale to stay correct). True when we resolved zero paths from a call
 * that nonetheless wrote something — e.g. a malformed `apply_patch`, or a write
 * whose path escaped the roots. Conservative: when unsure, invalidate everything.
 */
export function writeTouchesUnknownPaths(resolved: string[]): boolean {
  return resolved.length === 0
}

/**
 * The bytes' identity for {@link FileReadTracker}: a SHA-256 digest. Content, not a
 * stat stamp, because the question is whether the file still says what the agent
 * last saw, and a rewrite can keep both size and mtime (a whole-second filesystem,
 * a tool that preserves mtime) while a `touch` or a no-op save changes mtime alone.
 */
export function contentDigest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('base64')
}

/** {@link contentDigest} of a file, read in chunks so a large one is never held in memory. */
export async function fileDigest(abs: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('base64')
}

/** Why a write was refused: never read here, or changed on disk since. */
export type StaleWriteReason = 'unread' | 'changed'

/**
 * Which files the agent has seen, and what they said when it last did, so a write
 * can be refused when it would land on content the agent never saw.
 *
 * `read_file` records the file it returned and every successful write records what
 * it left on disk. Before overwriting or editing an existing file, the write tools
 * ask {@link check}: a file that was never recorded has not been read, and one whose
 * bytes no longer match the record was changed by someone else (the user in their
 * editor, a shell command, a formatter, a subagent), so the agent's picture of it
 * is out of date. Either way the model is told to read it again first.
 *
 * Bounded: past `maxEntries` the oldest record is dropped, which only means that
 * file must be read again before the next write.
 */
export class FileReadTracker {
  private readonly seen = new Map<string, string>()
  private readonly maxEntries: number

  constructor(opts: { seed?: Iterable<[string, string]>; maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 1024
    for (const [abs, digest] of opts.seed ?? []) this.remember(abs, digest)
  }

  /** Record that `abs` was read and held `data`. */
  noteRead(abs: string, data: Buffer | string): void {
    this.remember(abs, contentDigest(data))
  }

  /** Record that `abs` was read, by the {@link contentDigest} of what it held. */
  noteReadDigest(abs: string, digest: string): void {
    this.remember(abs, digest)
  }

  /** Record that this run wrote `data` to `abs`. */
  noteWrite(abs: string, data: Buffer | string): void {
    this.remember(abs, contentDigest(data))
  }

  /** Drop the record for `abs` (it was deleted, or its state is unknown). */
  forget(abs: string): void {
    this.seen.delete(abs)
  }

  /**
   * Re-record `abs` from disk if it is tracked. For changes made on the agent's
   * behalf right after its own write (a PostToolUse hook, format-on-save): the agent
   * did not see them, but they are not someone else's edits to protect, and
   * refusing the next edit over a reformat would only cost a pointless re-read.
   */
  async refresh(abs: string): Promise<void> {
    if (!this.seen.has(abs)) return
    try {
      this.remember(abs, contentDigest(await fs.readFile(abs)))
    } catch {
      this.seen.delete(abs)
    }
  }

  /**
   * Whether writing over `abs`, which currently holds `current`, would land on
   * content the agent has not seen: `'unread'` when it was never recorded,
   * `'changed'` when its bytes differ from the record, `null` when the write is
   * safe.
   */
  check(abs: string, current: Buffer | string): StaleWriteReason | null {
    const digest = this.seen.get(abs)
    if (digest === undefined) return 'unread'
    return digest === contentDigest(current) ? null : 'changed'
  }

  /** Whether `abs` has a record. */
  has(abs: string): boolean {
    return this.seen.has(abs)
  }

  /** Keep only the records for paths in `keep`. */
  retainOnly(keep: ReadonlySet<string>): void {
    for (const abs of [...this.seen.keys()]) if (!keep.has(abs)) this.seen.delete(abs)
  }

  /** Current record count, for tests. */
  get size(): number {
    return this.seen.size
  }

  private remember(abs: string, digest: string): void {
    // Re-inserting moves the path to the young end, so eviction drops the stalest.
    this.seen.delete(abs)
    this.seen.set(abs, digest)
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }
}

/** Conversations whose read records are kept between runs; older ones are dropped. */
const MAX_TRACKED_CONVERSATIONS = 64

const conversationTrackers = new Map<string, FileReadTracker>()

/**
 * The read tracker a run starts with.
 *
 * A run is one turn, and the files a model read on an earlier turn of the same
 * conversation are still in its context, so the records carry across turns: a
 * follow-up edit to an unchanged file needs no re-read, while one the user changed
 * between turns is caught by the content check. Only records whose read or write is
 * still in the history the model is shown survive (`visiblePaths`), so a rewound,
 * cleared, or compacted-away read no longer counts as seen. Like "Allow for run"
 * consent, this is in-memory only: a fresh launch starts with nothing read. A run
 * with no conversation (headless) gets a tracker of its own.
 */
export function fileTrackerForRun(
  conversationId: string | undefined,
  visiblePaths: ReadonlySet<string>
): FileReadTracker {
  if (!conversationId) return new FileReadTracker()
  const tracker = conversationTrackers.get(conversationId) ?? new FileReadTracker()
  tracker.retainOnly(visiblePaths)
  conversationTrackers.delete(conversationId)
  conversationTrackers.set(conversationId, tracker)
  if (conversationTrackers.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = conversationTrackers.keys().next().value
    if (oldest !== undefined) conversationTrackers.delete(oldest)
  }
  return tracker
}

/** Tools whose call shows the model a file, or leaves on disk content it wrote. */
const FILE_SEEING_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch'])

/**
 * Canonical paths the given history's file tools read or wrote, for
 * {@link fileTrackerForRun}. `resolvePath` and `patchPaths` are the same mappers
 * {@link writePaths} takes; a path that no longer resolves is skipped.
 */
export function pathsSeenInHistory(
  messages: readonly { toolCalls?: { name: string; arguments: Record<string, unknown> }[] }[],
  resolvePath: (rel: string) => string,
  patchPaths: (patch: string) => string[]
): Set<string> {
  const out = new Set<string>()
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      if (!FILE_SEEING_TOOLS.has(call.name)) continue
      for (const abs of writePaths(call.name, call.arguments, resolvePath, patchPaths)) out.add(abs)
    }
  }
  return out
}
