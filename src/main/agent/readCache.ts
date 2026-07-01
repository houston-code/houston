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

interface Entry {
  result: CachedRead
  deps: ReadDeps
}

/**
 * A run-scoped read cache. One instance per `startRun`; passed to the tool-dispatch
 * sites which consult {@link get} before executing and {@link set} the result after,
 * and call {@link invalidatePaths} / {@link invalidateAll} when a mutation occurs.
 */
export class ReadCache {
  private readonly entries = new Map<string, Entry>()

  /** A previously-cached result for this exact call, or undefined on a miss. */
  get(name: string, args: Record<string, unknown>): CachedRead | undefined {
    return this.entries.get(cacheKey(name, args))?.result
  }

  /**
   * Memoize a read's result. `deps` records what the result depends on so a later
   * write can invalidate it precisely. Failed reads (`ok:false`) are NOT cached —
   * an error is often transient (a race with a concurrent write, a not-yet-created
   * file) and re-reading is cheap and safer than pinning a stale failure.
   */
  set(
    name: string,
    args: Record<string, unknown>,
    result: CachedRead,
    deps: ReadDeps
  ): void {
    if (!result.ok) return
    this.entries.set(cacheKey(name, args), { result, deps })
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

/** Whether `prefix` is a path-segment prefix of `full` (e.g. /a/b is a prefix of /a/b/c). */
function isPathPrefix(prefix: string, full: string): boolean {
  return full.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
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
