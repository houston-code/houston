/**
 * The lsp_* tools: type-aware navigation through the language server covering a file
 * (definition, references, hover, symbols) and a rename that becomes an ordinary
 * apply_patch.
 *
 * Positions are given the way the model sees code: a 1-based line number (as read_file
 * prints it) and the symbol's text on that line, not a column it would have to count.
 *
 * Containment: every location a server returns is checked against the run's roots
 * (symlinks resolved, via resolveInRoots) and dropped, with a count, when it falls
 * outside them; a credential file's lines are never quoted (see isSensitivePath). A
 * rename touching anything outside the roots is refused whole.
 *
 * Built by a factory that tools.ts calls with its containment check and apply_patch,
 * so this module never imports tools.ts at runtime (tools.ts imports it).
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { ToolContext, ToolDef } from '../tools'
import type { LspClient, Location, Position, Range } from './client'
import { isSensitivePath } from '../sensitive-paths'
import { fromUri, toUri } from './uri'
import { objectSchema, rootsOf, str } from '../toolHelpers'

export const LSP_TOOL_NAMES = [
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_rename'
] as const

export const LSP_RENAME_NAME = 'lsp_rename'

/** What the tools need from the loop: the client covering a file (LspManager satisfies it). */
export interface LspToolAccess {
  clientFor(abs: string, roots: string[]): Promise<LspClient | null>
}

export interface LspToolDeps {
  resolveInRoots: (roots: string[], p: string) => string
  applyPatch: ToolDef
}

/** Most locations listed by references and symbols; the rest are counted. */
export const MAX_LOCATIONS = 100
const MAX_HOVER_CHARS = 4000
const MAX_LINE_CHARS = 200

const SYMBOL_KINDS = [
  '',
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum member',
  'struct',
  'event',
  'operator',
  'type parameter'
]

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

const POSITION_PROPS = {
  path: { type: 'string', description: 'File containing the symbol, relative to the project root.' },
  line: { type: 'integer', description: '1-based line number of the symbol, as read_file shows it.' },
  symbol: { type: 'string', description: 'The symbol as written on that line, e.g. "parseConfig".' },
  occurrence: {
    type: 'integer',
    description: 'Which occurrence of symbol on that line, when it appears more than once (default 1).'
  }
}

/** The 0-based LSP position of the `occurrence`th `symbol` on 1-based `line` of `text`. */
export function locateSymbol(text: string, line: number, symbol: string, occurrence = 1): Position {
  const lines = text.split(/\r?\n/)
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new Error(`Line ${line} is outside the file (it has ${lines.length} lines).`)
  }
  if (!symbol) throw new Error('A symbol is required.')
  const row = lines[line - 1]
  const hits: number[] = []
  // Prefer whole-word matches, so "id" doesn't land inside "width".
  const word = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g')
  for (const m of row.matchAll(word)) hits.push(m.index)
  if (hits.length === 0) {
    for (let i = row.indexOf(symbol); i >= 0; i = row.indexOf(symbol, i + 1)) hits.push(i)
  }
  if (hits.length === 0) {
    throw new Error(`"${symbol}" does not appear on line ${line}, which reads: ${row.trim().slice(0, MAX_LINE_CHARS)}`)
  }
  const n = occurrence ?? 1
  if (n < 1 || n > hits.length) {
    throw new Error(`"${symbol}" appears ${hits.length} time${hits.length === 1 ? '' : 's'} on line ${line}; occurrence ${n} is out of range.`)
  }
  return { line: line - 1, character: hits[n - 1] }
}

/** The client each call's `target` used, keyed by the call's args, for the missing-dependency note. */
const clientOfCall = new WeakMap<object, LspClient>()

/** The file named by the call, its text, the client covering it (synced), and the position. */
async function target(
  deps: LspToolDeps,
  args: Record<string, unknown>,
  ctx: ToolContext,
  needPosition: boolean
): Promise<{ abs: string; rel: string; client: LspClient; position: Position | null }> {
  const rel = str(args, 'path')
  const roots = rootsOf(ctx)
  const abs = deps.resolveInRoots(roots, rel)
  if (!ctx.lsp) throw new Error('Language servers are not available here. Use search_files or ast_grep instead.')
  const client = await ctx.lsp.clientFor(abs, roots)
  if (!client) {
    throw new Error(`No language server is running for ${rel}. Use search_files or ast_grep instead.`)
  }
  clientOfCall.set(args, client)
  const text = await fs.readFile(abs, 'utf8')
  await client.sync(abs, text)
  const position = needPosition ? locateSymbol(text, int(args, 'line') ?? 0, str(args, 'symbol'), int(args, 'occurrence')) : null
  return { abs, rel, client, position }
}

/** How a path is shown: relative to the workspace when inside it. */
function display(abs: string, ctx: ToolContext): string {
  const rel = relative(ctx.workspace, abs)
  // A parent-directory step, not any name starting with dots (`..generated.ts` is inside).
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  return rel && !outside ? rel : abs
}

/** Whether `abs` is inside the roots (symlinks resolved), the check every returned path passes. */
function contained(deps: LspToolDeps, roots: string[], abs: string): boolean {
  try {
    deps.resolveInRoots(roots, abs)
    return true
  } catch {
    return false
  }
}

/** Normalize the shapes definition/references can answer with into plain locations. */
function toLocations(result: unknown): Location[] {
  if (!result) return []
  const list = Array.isArray(result) ? result : [result]
  const out: Location[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.uri === 'string' && o.range) out.push({ uri: o.uri, range: o.range as Range })
    else if (typeof o.targetUri === 'string') {
      out.push({ uri: o.targetUri, range: (o.targetSelectionRange ?? o.targetRange) as Range })
    }
  }
  return out
}

/** Whether a location's line is an import (or require) binding rather than a declaration. */
async function isImportLine(loc: Location): Promise<boolean> {
  const abs = fromUri(loc.uri)
  if (!abs || !loc.range?.start) return false
  try {
    const line = (await fs.readFile(abs, 'utf8')).split(/\r?\n/)[loc.range.start.line] ?? ''
    return /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s*from\b|(?:const|let|var)\s.*\brequire\s*\()/.test(line)
  } catch {
    return false
  }
}

/**
 * Some servers (TypeScript's among them) answer "definition" on an imported name with
 * the import that binds it. The agent wants the declaration, so ask again from the
 * binding, up to two hops, keeping the last answer that moved.
 */
async function followImports(
  client: LspClient,
  locations: Location[],
  origin: { textDocument: { uri: string }; position: Position; symbol: string }
): Promise<Location[]> {
  let cur = locations
  for (let hop = 0; hop < 2; hop++) {
    if (cur.length !== 1 || !(await isImportLine(cur[0]))) return cur
    // One character into the name: at its first character some servers resolve the
    // token before it instead.
    const { start, end } = cur[0].range
    const inside = end && end.line === start.line && end.character > start.character + 1
    const position = inside ? { line: start.line, character: start.character + 1 } : start
    const next = toLocations(
      await client.request('textDocument/definition', { textDocument: { uri: cur[0].uri }, position }).catch(() => null)
    )
    const same = next.length === 1 && next[0].uri === cur[0].uri && next[0].range.start.line === cur[0].range.start.line
    if (next.length === 0 || same) return typeDefinitionFallback(client, cur, origin)
    cur = next
  }
  return cur
}

/**
 * Last resort when the binding resolves only to itself (TypeScript does this for some
 * mixed `type` imports): the type definition, but only when it lands on a line that
 * names the symbol, which a function or class has and a variable (whose type
 * definition is its type) does not.
 */
async function typeDefinitionFallback(
  client: LspClient,
  cur: Location[],
  origin: { textDocument: { uri: string }; position: Position; symbol: string }
): Promise<Location[]> {
  const typed = toLocations(
    await client.request('textDocument/typeDefinition', { textDocument: origin.textDocument, position: origin.position }).catch(() => null)
  )
  if (typed.length !== 1 || (await isImportLine(typed[0]))) return cur
  const abs = fromUri(typed[0].uri)
  const line = abs ? ((await fs.readFile(abs, 'utf8').catch(() => '')).split(/\r?\n/)[typed[0].range.start.line] ?? '') : ''
  return line.includes(origin.symbol) ? typed : cur
}

/** `path:line:col  <line text>` rows for locations inside the roots, plus what was left out. */
async function formatLocations(
  deps: LspToolDeps,
  ctx: ToolContext,
  locations: Location[],
  max = MAX_LOCATIONS
): Promise<{ rows: string[]; outside: number; more: number }> {
  const roots = rootsOf(ctx)
  const seen = new Set<string>()
  const inside: { abs: string; range: Range }[] = []
  let outside = 0
  for (const loc of locations) {
    const abs = fromUri(loc.uri)
    if (!abs || !loc.range?.start || !contained(deps, roots, abs)) {
      outside++
      continue
    }
    const key = `${abs}:${loc.range.start.line}:${loc.range.start.character}`
    if (seen.has(key)) continue
    seen.add(key)
    inside.push({ abs, range: loc.range })
  }
  const shown = inside.slice(0, max)
  const texts = new Map<string, string[] | null>()
  const rows: string[] = []
  for (const { abs, range } of shown) {
    const shownPath = display(abs, ctx)
    if (!texts.has(abs)) {
      texts.set(abs, isSensitivePath(shownPath) ? null : await fs.readFile(abs, 'utf8').then((t) => t.split(/\r?\n/), () => null))
    }
    const lines = texts.get(abs)
    const where = `${shownPath}:${range.start.line + 1}:${range.start.character + 1}`
    const text = lines?.[range.start.line]?.trim()
    rows.push(text ? `${where}  ${text.slice(0, MAX_LINE_CHARS)}` : where)
  }
  return { rows, outside, more: inside.length - shown.length }
}

function trailer(outside: number, more: number): string {
  const notes: string[] = []
  if (more > 0) notes.push(`${more} more not shown`)
  if (outside > 0) notes.push(`${outside} outside the project not shown`)
  return notes.length ? `\n(${notes.join('; ')})` : ''
}

/** Flatten hover contents (MarkupContent, MarkedString, or a list of them) to text. */
export function hoverText(result: unknown): string {
  const contents = (result as { contents?: unknown } | null)?.contents
  const part = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (c && typeof c === 'object') {
      const o = c as { value?: unknown; language?: unknown }
      if (typeof o.value === 'string') return typeof o.language === 'string' ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value
    }
    return ''
  }
  const text = (Array.isArray(contents) ? contents.map(part) : [part(contents)]).filter(Boolean).join('\n\n').trim()
  return text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS)}…` : text
}

interface SymbolRow {
  name: string
  kind: string
  abs: string
  line: number
  container?: string
  depth: number
}

/** Flatten document symbols (hierarchical DocumentSymbol or flat SymbolInformation). */
function documentSymbolRows(result: unknown, abs: string): SymbolRow[] {
  const rows: SymbolRow[] = []
  const walk = (items: unknown[], depth: number): void => {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const kind = SYMBOL_KINDS[o.kind as number] ?? 'symbol'
      if (o.location && typeof o.location === 'object') {
        const loc = o.location as Location
        rows.push({
          name: String(o.name),
          kind,
          abs: fromUri(loc.uri) ?? abs,
          line: loc.range?.start.line ?? 0,
          ...(typeof o.containerName === 'string' && o.containerName ? { container: o.containerName } : {}),
          depth: 0
        })
      } else {
        const range = (o.selectionRange ?? o.range) as Range | undefined
        rows.push({ name: String(o.name), kind, abs, line: range?.start.line ?? 0, depth })
        if (Array.isArray(o.children)) walk(o.children, depth + 1)
      }
    }
  }
  if (Array.isArray(result)) walk(result, 0)
  return rows
}

// ---- Rename -----------------------------------------------------------------

interface TextEdit {
  range: Range
  newText: string
}

/** Every text edit in a WorkspaceEdit, by file. Refuses file creates, renames, and deletes. */
export function workspaceEditFiles(edit: unknown): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>()
  const add = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits)) return
    const abs = fromUri(uri)
    if (!abs) throw new Error(`The rename names a location Houston can't edit (${uri}).`)
    out.set(abs, [...(out.get(abs) ?? []), ...(edits as TextEdit[])])
  }
  const e = edit as { changes?: Record<string, unknown>; documentChanges?: unknown[] } | null
  if (!e) return out
  if (Array.isArray(e.documentChanges)) {
    for (const dc of e.documentChanges) {
      const o = dc as { kind?: string; textDocument?: { uri?: string }; edits?: unknown }
      if (o.kind) {
        throw new Error(`The rename would also ${o.kind} a file; only text edits can be applied. Rename the file separately.`)
      }
      if (o.textDocument?.uri) add(o.textDocument.uri, o.edits)
    }
  } else if (e.changes) {
    for (const [uri, edits] of Object.entries(e.changes)) add(uri, edits)
  }
  return out
}

/** Offset of each line's start in `body` (LF line endings). */
function lineStarts(body: string): number[] {
  const starts = [0]
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') starts.push(i + 1)
  return starts
}

/** Apply LSP text edits to LF-normalized `body` (CRLF counts as one line break, as LSP does). */
export function applyTextEdits(body: string, edits: TextEdit[]): string {
  const starts = lineStarts(body)
  const offset = (p: Position): number => {
    if (p.line >= starts.length) return body.length
    const lineEnd = p.line + 1 < starts.length ? starts[p.line + 1] - 1 : body.length
    return Math.min(starts[p.line] + p.character, lineEnd)
  }
  const sorted = edits
    .map((e) => ({ from: offset(e.range.start), to: offset(e.range.end), text: e.newText.replace(/\r\n/g, '\n') }))
    .sort((a, b) => b.from - a.from || b.to - a.to)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].to > sorted[i - 1].from) throw new Error('The language server returned overlapping edits.')
  }
  let out = body
  for (const e of sorted) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

/** Exact-match occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++
  return n
}

const HUNK_CONTEXT = 3

/**
 * apply_patch hunks turning `before` into `after` for the given edits. Edits whose
 * lines sit close together share a hunk; each hunk carries context lines so its
 * removed text is unique where it applies (apply_patch locates hunks by text and
 * applies them in order). The result is checked by replaying it; when replay doesn't
 * reproduce `after`, it falls back to one hunk spanning every changed line.
 */
export function renameHunks(before: string, after: string, edits: TextEdit[]): string[] {
  const oldLines = before.split('\n')
  const spans = edits
    .map((e) => [e.range.start.line, e.range.end.line] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const clusters: [number, number][] = []
  for (const [a, b] of spans) {
    const last = clusters[clusters.length - 1]
    if (last && a <= last[1] + 2 * HUNK_CONTEXT + 1) last[1] = Math.max(last[1], b)
    else clusters.push([a, b])
  }
  const editsIn = (a: number, b: number): TextEdit[] => edits.filter((e) => e.range.start.line >= a && e.range.end.line <= b)
  const hunkFor = (a: number, b: number, ctxLines: number): { old: string[]; neu: string[] } => {
    const from = Math.max(0, a - ctxLines)
    const to = Math.min(oldLines.length - 1, b + ctxLines)
    const oldBlock = oldLines.slice(from, to + 1)
    // Re-base this cluster's edits onto its own block and apply them there.
    const local = editsIn(a, b).map((e) => ({
      newText: e.newText,
      range: {
        start: { line: e.range.start.line - from, character: e.range.start.character },
        end: { line: e.range.end.line - from, character: e.range.end.character }
      }
    }))
    return { old: oldBlock, neu: applyTextEdits(oldBlock.join('\n'), local).split('\n') }
  }
  const render = (h: { old: string[]; neu: string[] }): string => {
    const lines = ['@@']
    // A minimal line diff: common prefix and suffix as context, the middle replaced.
    let p = 0
    while (p < h.old.length && p < h.neu.length && h.old[p] === h.neu[p]) p++
    let s = 0
    while (s < h.old.length - p && s < h.neu.length - p && h.old[h.old.length - 1 - s] === h.neu[h.neu.length - 1 - s]) s++
    for (const l of h.old.slice(0, p)) lines.push(` ${l}`)
    for (const l of h.old.slice(p, h.old.length - s)) lines.push(`-${l}`)
    for (const l of h.neu.slice(p, h.neu.length - s)) lines.push(`+${l}`)
    for (const l of h.old.slice(h.old.length - s)) lines.push(` ${l}`)
    return lines.join('\n')
  }
  const replay = (hunks: { old: string[]; neu: string[] }[]): string | null => {
    let cur = before
    for (const h of hunks) {
      const o = h.old.join('\n')
      if (count(cur, o) !== 1) return null
      cur = cur.replace(o, () => h.neu.join('\n'))
    }
    return cur
  }
  const hunks = clusters.map(([a, b]) => {
    let h = hunkFor(a, b, HUNK_CONTEXT)
    for (let c = HUNK_CONTEXT + 1; count(before, h.old.join('\n')) > 1 && c < oldLines.length; c *= 2) h = hunkFor(a, b, c)
    return h
  })
  if (replay(hunks) === after) return hunks.map(render)
  // Fallback: one hunk from the first changed line to the last, widened until unique.
  const a = clusters[0][0]
  const b = clusters[clusters.length - 1][1]
  let one = hunkFor(a, b, HUNK_CONTEXT)
  for (let c = HUNK_CONTEXT + 1; count(before, one.old.join('\n')) > 1 && c < oldLines.length; c *= 2) one = hunkFor(a, b, c)
  if (replay([one]) !== after) one = hunkFor(0, oldLines.length - 1, 0)
  return [render(one)]
}

export interface RenamePlan {
  /** An apply_patch envelope with every edit. */
  patch: string
  /** One line for the result: what was renamed, how many edits in how many files. */
  summary: string
  files: number
  edits: number
}

/** Ask the server for the rename and turn its WorkspaceEdit into an apply_patch envelope. */
async function planRename(deps: LspToolDeps, args: Record<string, unknown>, ctx: ToolContext): Promise<RenamePlan> {
  const newName = str(args, 'new_name')
  if (!newName.trim()) throw new Error('new_name is required.')
  const { abs, client, position } = await target(deps, args, ctx, true)
  const textDocument = { uri: toUri(abs) }
  const provider = client.serverCapabilities.renameProvider as { prepareProvider?: boolean } | boolean | undefined
  if (!provider) throw new Error(`The ${client.server.spec.name} language server can't rename symbols.`)
  if (typeof provider === 'object' && provider.prepareProvider) {
    const ok = await client.request<unknown>('textDocument/prepareRename', { textDocument, position })
    if (!ok) throw new Error(`"${str(args, 'symbol')}" can't be renamed at that position.`)
  }
  const edit = await client.request<unknown>('textDocument/rename', { textDocument, position, newName })
  const files = workspaceEditFiles(edit)
  if (files.size === 0) throw new Error('The language server found nothing to rename there.')
  const roots = rootsOf(ctx)
  const outside = [...files.keys()].filter((f) => !contained(deps, roots, f))
  if (outside.length) {
    throw new Error(
      `Refused: the rename would also edit ${outside.length} file${outside.length === 1 ? '' : 's'} outside the project (${outside
        .slice(0, 3)
        .join(', ')}${outside.length > 3 ? ', …' : ''}). Nothing was changed.`
    )
  }
  const blocks: string[] = []
  let total = 0
  for (const [file, edits] of files) {
    if (edits.length === 0) continue
    const before = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const after = applyTextEdits(before, edits)
    if (after === before) continue
    total += edits.length
    blocks.push(`*** Update File: ${display(file, ctx)}\n${renameHunks(before, after, edits).join('\n')}`)
  }
  if (blocks.length === 0) throw new Error('The rename changes nothing.')
  const summary = `Renamed "${str(args, 'symbol')}" to "${newName}": ${total} edit${total === 1 ? '' : 's'} in ${blocks.length} file${blocks.length === 1 ? '' : 's'}.`
  return { patch: `*** Begin Patch\n${blocks.join('\n')}\n*** End Patch`, summary, files: blocks.length, edits: total }
}

// ---- The tools --------------------------------------------------------------


export function makeLspTools(deps: LspToolDeps): ToolDef[] {
  const definition: ToolDef = {
    kind: 'read',
    summarize: (a) => `Definition of ${str(a, 'symbol')} (${str(a, 'path')}:${int(a, 'line') ?? '?'})`,
    schema: {
      name: 'lsp_definition',
      description:
        "Find where a symbol is defined, using the project's language server (type-aware: follows imports, re-exports, and overloads that text search can't). Give the file, the 1-based line, and the symbol as written there.",
      parameters: objectSchema(POSITION_PROPS, ['path', 'line', 'symbol'])
    },
    async execute(args, ctx) {
      const { abs, client, position } = await target(deps, args, ctx, true)
      const textDocument = { uri: toUri(abs) }
      const locations = await followImports(
        client,
        toLocations(await client.request('textDocument/definition', { textDocument, position })),
        { textDocument, position: position!, symbol: str(args, 'symbol') }
      )
      const { rows, outside, more } = await formatLocations(deps, ctx, locations)
      if (rows.length === 0) {
        return outside
          ? `"${str(args, 'symbol')}" is defined outside the project (${outside} location${outside === 1 ? '' : 's'}, not shown).`
          : `No definition found for "${str(args, 'symbol')}".`
      }
      return `${rows.join('\n')}${trailer(outside, more)}`
    }
  }

  const references: ToolDef = {
    kind: 'read',
    summarize: (a) => `References to ${str(a, 'symbol')} (${str(a, 'path')}:${int(a, 'line') ?? '?'})`,
    schema: {
      name: 'lsp_references',
      description:
        "List every reference to a symbol across the project, using the language server (only real uses of this symbol, not same-named text). Give the file, the 1-based line, and the symbol as written there.",
      parameters: objectSchema(
        {
          ...POSITION_PROPS,
          include_declaration: { type: 'boolean', description: 'Also list the declaration itself (default true).' }
        },
        ['path', 'line', 'symbol']
      )
    },
    async execute(args, ctx) {
      const { abs, client, position } = await target(deps, args, ctx, true)
      const result = await client.request('textDocument/references', {
        textDocument: { uri: toUri(abs) },
        position,
        context: { includeDeclaration: args.include_declaration !== false }
      })
      const locations = toLocations(result)
      const { rows, outside, more } = await formatLocations(deps, ctx, locations)
      if (rows.length === 0) return `No references found for "${str(args, 'symbol')}".${trailer(outside, 0)}`
      const n = rows.length + more
      return `${n} reference${n === 1 ? '' : 's'}:\n${rows.join('\n')}${trailer(outside, more)}`
    }
  }

  const hover: ToolDef = {
    kind: 'read',
    summarize: (a) => `Type of ${str(a, 'symbol')} (${str(a, 'path')}:${int(a, 'line') ?? '?'})`,
    schema: {
      name: 'lsp_hover',
      description:
        "Show a symbol's type, signature, and documentation from the language server, as an editor's hover would. Give the file, the 1-based line, and the symbol as written there.",
      parameters: objectSchema(POSITION_PROPS, ['path', 'line', 'symbol'])
    },
    async execute(args, ctx) {
      const { abs, client, position } = await target(deps, args, ctx, true)
      const result = await client.request('textDocument/hover', { textDocument: { uri: toUri(abs) }, position })
      return hoverText(result) || `No type information for "${str(args, 'symbol')}".`
    }
  }

  const documentSymbols: ToolDef = {
    kind: 'read',
    summarize: (a) => `Symbols in ${str(a, 'path')}`,
    schema: {
      name: 'lsp_document_symbols',
      description:
        'Outline a file: its classes, functions, methods, and other symbols with their line numbers, from the language server.',
      parameters: objectSchema({ path: POSITION_PROPS.path }, ['path'])
    },
    async execute(args, ctx) {
      const { abs, rel, client } = await target(deps, args, ctx, false)
      const result = await client.request('textDocument/documentSymbol', { textDocument: { uri: toUri(abs) } })
      const rows = documentSymbolRows(result, abs)
      if (rows.length === 0) return `No symbols found in ${rel}.`
      const shown = rows.slice(0, MAX_LOCATIONS * 2)
      const body = shown
        .map((r) => `${'  '.repeat(r.depth)}${r.kind} ${r.name}  (line ${r.line + 1})${r.container ? ` in ${r.container}` : ''}`)
        .join('\n')
      return `${body}${rows.length > shown.length ? `\n(${rows.length - shown.length} more not shown)` : ''}`
    }
  }

  const workspaceSymbols: ToolDef = {
    kind: 'read',
    summarize: (a) => `Find symbol "${str(a, 'query')}"`,
    schema: {
      name: 'lsp_workspace_symbols',
      description:
        'Find symbols (classes, functions, types, ...) by name across the project, from the language server. Give a file in the part of the project to search: the server searches the project that file belongs to.',
      parameters: objectSchema(
        {
          query: { type: 'string', description: 'The name or part of it, e.g. "parseConfig".' },
          path: { type: 'string', description: 'Any file in the language to search, relative to the project root.' }
        },
        ['query', 'path']
      )
    },
    async execute(args, ctx) {
      const { client } = await target(deps, args, ctx, false)
      const result = await client.request<unknown[] | null>('workspace/symbol', { query: str(args, 'query') })
      const roots = rootsOf(ctx)
      const rows: string[] = []
      let outside = 0
      for (const it of result ?? []) {
        const o = it as { name?: string; kind?: number; containerName?: string; location?: { uri?: string; range?: Range } }
        const abs = o.location?.uri ? fromUri(o.location.uri) : null
        if (!abs || !contained(deps, roots, abs)) {
          outside++
          continue
        }
        const line = o.location?.range ? `:${o.location.range.start.line + 1}` : ''
        rows.push(
          `${SYMBOL_KINDS[o.kind ?? 0] || 'symbol'} ${o.name}  ${display(abs, ctx)}${line}${o.containerName ? `  in ${o.containerName}` : ''}`
        )
      }
      if (rows.length === 0) return `No symbols match "${str(args, 'query')}".${trailer(outside, 0)}`
      const shown = rows.slice(0, MAX_LOCATIONS)
      return `${shown.join('\n')}${trailer(outside, rows.length - shown.length)}`
    }
  }

  const rename: ToolDef = {
    kind: 'write',
    summarize: (a) => `Rename ${str(a, 'symbol')} to ${str(a, 'new_name')}`,
    schema: {
      name: LSP_RENAME_NAME,
      description:
        'Rename a symbol everywhere it is used, using the language server (a semantic rename: only this symbol, across files, including imports). Give the file, the 1-based line, and the symbol as written there, plus the new name. The edits are applied as one apply_patch, with the same approval and checkpoint (undo) as any patch.',
      parameters: objectSchema(
        { ...POSITION_PROPS, new_name: { type: 'string', description: 'The new name.' } },
        ['path', 'line', 'symbol', 'new_name']
      )
    },
    // The loop runs the rename as the apply_patch this returns, so it passes the same
    // gate as any patch: permission rules per file, sensitive-file prompts, approval
    // with a diff preview, checkpoints, and root containment.
    async materialize(args, ctx) {
      const plan = await planRename(deps, args, ctx)
      return { name: deps.applyPatch.schema.name, arguments: { patch: plan.patch }, note: plan.summary }
    },
    // Hosts that drive tools directly (no loop) still get the same edit applied.
    async execute(args, ctx) {
      const plan = await planRename(deps, args, ctx)
      const applied = await deps.applyPatch.execute({ patch: plan.patch }, ctx)
      return `${plan.summary} ${applied}`
    }
  }

  return [...[definition, references, hover, documentSymbols, workspaceSymbols].map(withMissingDepsNote), rename]
}

/**
 * A read tool whose result also carries the server's missing-dependency note, so an
 * empty or partial answer isn't taken as the whole truth about the code.
 */
function withMissingDepsNote(tool: ToolDef): ToolDef {
  const run = tool.execute.bind(tool)
  return {
    ...tool,
    async execute(args, ctx) {
      const out = await run(args, ctx)
      const hint = clientOfCall.get(args)?.missingDepsHint
      return hint ? `${out}\n\n(note: ${hint})` : out
    }
  }
}
