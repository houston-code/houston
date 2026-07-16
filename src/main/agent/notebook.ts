/**
 * Jupyter notebook (`.ipynb`) support: reading a notebook as cells, and editing one
 * cell without disturbing the rest of the document.
 *
 * A notebook is JSON, so the generic file tools nominally "work" on one — and that
 * is exactly the problem. `read_file` on a notebook returns a wall of JSON in which
 * a two-line function is split across a `"source": ["def f():\n", "    return 1"]`
 * array, interleaved with base64 image outputs and execution metadata; the code the
 * agent came for is a rounding error in the token count. Editing is worse: matching
 * a string against that file means matching JSON-escaped source, and one imprecise
 * `edit_file` corrupts the document into something Jupyter will not open.
 *
 * So notebooks get their own read rendering ({@link renderNotebook}) and their own
 * structured edit ({@link editNotebook}), both pure over parsed JSON and fully unit
 * tested. The two are designed as a pair: the read view numbers cells `[1]`, `[2]`,
 * … and `notebook_edit` addresses cells by that same 1-based number, so what the
 * agent sees is what it can name.
 *
 * Only nbformat 4 is handled — it has been the format since 2015 and the wild is
 * effectively all v4. A v3 or unversioned file is rejected with a message pointing
 * at `jupyter nbconvert` rather than being silently misparsed.
 */

/** A single notebook cell, narrowed to the fields the read/edit surface uses. */
export interface NotebookCell {
  cell_type: string
  /** Jupyter stores source as a line array, but a plain string is legal and occurs. */
  source: string[] | string
  outputs?: unknown[]
  execution_count?: number | null
  [key: string]: unknown
}

/** A parsed notebook. Unknown top-level keys are preserved so an edit round-trips. */
export interface Notebook {
  cells: NotebookCell[]
  nbformat: number
  nbformat_minor?: number
  [key: string]: unknown
}

/** Cell kinds Jupyter defines. `raw` is passed through but has no outputs. */
export const CELL_TYPES = ['code', 'markdown', 'raw']

/** Whether a path names a Jupyter notebook. */
export function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith('.ipynb')
}

/**
 * Parse notebook JSON, throwing a message aimed at the agent (it is surfaced as a
 * failed tool call) rather than a raw JSON.parse error. Validates only what the
 * read/edit surface actually relies on: v4, and a `cells` array of objects.
 */
export function parseNotebook(text: string): Notebook {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not valid JSON, so it cannot be read as a notebook: ${(e as Error).message}`, {
      cause: e
    })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Not a notebook: the top level of an .ipynb file must be a JSON object.')
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.cells)) {
    throw new Error('Not a notebook: missing a top-level "cells" array.')
  }
  const nbformat = typeof obj.nbformat === 'number' ? obj.nbformat : 0
  if (nbformat !== 4) {
    throw new Error(
      `Unsupported notebook format ${nbformat || '(missing)'}: only nbformat 4 is supported. Convert it first with "jupyter nbconvert --to notebook".`
    )
  }
  for (const [i, cell] of obj.cells.entries()) {
    if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
      throw new Error(`Malformed notebook: cell ${i + 1} is not an object.`)
    }
  }
  return obj as unknown as Notebook
}

/** A cell's source as one string, collapsing Jupyter's line-array representation. */
export function cellSource(cell: NotebookCell): string {
  if (typeof cell.source === 'string') return cell.source
  return Array.isArray(cell.source) ? cell.source.join('') : ''
}

/**
 * Split source back into Jupyter's line-array form: every line keeps its trailing
 * newline except the last, and a source ending in a newline does not gain a
 * trailing empty element. Writing this shape (rather than one long string) is what
 * keeps a notebook's git diff line-oriented, which is the convention every other
 * tool in the ecosystem writes.
 */
export function toSourceLines(source: string): string[] {
  if (source === '') return []
  const parts = source.split('\n')
  const lines = parts.map((p, i) => (i === parts.length - 1 ? p : `${p}\n`))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** One output rendered to text, or null when it carries nothing worth showing. */
function renderOutput(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  const text = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')

  switch (o.output_type) {
    case 'stream': {
      const body = text(o.text).trimEnd()
      return body ? `${o.name === 'stderr' ? 'stderr' : 'stdout'}: ${body}` : null
    }
    case 'execute_result':
    case 'display_data': {
      const data = (o.data ?? {}) as Record<string, unknown>
      const plain = text(data['text/plain']).trimEnd()
      if (plain) return plain
      // A plot or table with no text/plain fallback: name the media rather than
      // dumping base64 the model cannot use anyway.
      const media = Object.keys(data).filter((k) => k !== 'text/plain')
      return media.length > 0 ? `[${media.join(', ')} output]` : null
    }
    case 'error': {
      const name = typeof o.ename === 'string' ? o.ename : 'Error'
      const value = typeof o.evalue === 'string' ? o.evalue : ''
      // The traceback is the useful part of a failure, but it is ANSI-coloured and
      // often dozens of frames; the head carries the diagnosis.
      const tb = Array.isArray(o.traceback) ? stripAnsi(o.traceback.join('\n')).trimEnd() : ''
      const head = `${name}: ${value}`.trim()
      return tb ? `${head}\n${tb}` : head
    }
    default:
      return null
  }
}

/**
 * Strip ANSI SGR escapes, which Jupyter embeds throughout error tracebacks. The ESC
 * byte is part of the pattern on purpose: without it this would also eat bracketed
 * literals like "[0m" out of ordinary text.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Indent a block so multi-line output reads as subordinate to its cell. */
function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n')
}

/**
 * Render a notebook as numbered cells for `read_file`.
 *
 * Cell numbers are 1-based and are the same handles `notebook_edit` takes. Outputs
 * are included but summarized: a stream or text result is shown, an image or plot is
 * named rather than dumped as base64, and an error shows its type, message, and
 * traceback. `maxOutputChars` bounds any single output so one runaway cell cannot
 * crowd out the notebook's actual code.
 */
export function renderNotebook(
  nb: Notebook,
  opts: { path: string; maxOutputChars?: number } = { path: '' }
): string {
  const maxOutput = opts.maxOutputChars ?? 2000
  const counts = new Map<string, number>()
  for (const c of nb.cells) counts.set(c.cell_type, (counts.get(c.cell_type) ?? 0) + 1)
  const summary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${n} ${type}`)
    .join(', ')

  const version = `nbformat ${nb.nbformat}${typeof nb.nbformat_minor === 'number' ? `.${nb.nbformat_minor}` : ''}`
  const header =
    nb.cells.length === 0
      ? `[notebook: ${opts.path} — no cells, ${version}]`
      : `[notebook: ${opts.path} — ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'} (${summary}), ${version}. Cell numbers below are the "cell" argument to notebook_edit.]`

  const body = nb.cells.map((cell, i) => {
    const n = i + 1
    const exec =
      cell.cell_type === 'code'
        ? typeof cell.execution_count === 'number'
          ? ` (executed ${cell.execution_count})`
          : ' (unexecuted)'
        : ''
    const src = cellSource(cell)
    const rendered = src === '' ? '[empty cell]' : src.trimEnd()
    const outputs = (cell.outputs ?? [])
      .map(renderOutput)
      .filter((o): o is string => o !== null && o !== '')
      .map((o) => (o.length > maxOutput ? `${o.slice(0, maxOutput)}\n[output truncated]` : o))
    const outBlock =
      outputs.length > 0 ? `\n${indent(outputs.join('\n'), '  | ')}` : ''
    return `[${n}] ${cell.cell_type}${exec}\n${rendered}${outBlock}`
  })

  return [header, ...body].join('\n\n')
}

/** What {@link editNotebook} should do at the addressed cell. */
export type NotebookEditMode = 'replace' | 'insert' | 'delete'

export interface NotebookEdit {
  /** 1-based cell number, matching the numbers {@link renderNotebook} shows. */
  cell: number
  mode: NotebookEditMode
  /** New source, for replace/insert. */
  source?: string
  /** Cell kind for an insert; defaults to the kind of the cell it lands before. */
  cellType?: string
}

/**
 * Apply one structured edit to a parsed notebook, returning a new notebook. The
 * input is not mutated, and every field the edit does not concern — other cells,
 * their outputs, notebook metadata, unknown keys a Jupyter extension wrote — is
 * carried through untouched.
 *
 * Replacing a code cell's source clears its outputs and execution_count: the old
 * output was produced by code that no longer exists, and leaving it attached would
 * present a stale result as if it were the current one. Jupyter itself keeps such
 * outputs until re-run, but Jupyter has a human watching the cell go out of date.
 */
export function editNotebook(nb: Notebook, edit: NotebookEdit): Notebook {
  const cells = [...nb.cells]
  const n = edit.cell

  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid cell number ${edit.cell}: cells are numbered from 1.`)
  }

  if (edit.mode === 'insert') {
    // Insert is the one mode allowed to address one past the end — that is how a
    // cell gets appended to the notebook.
    if (n > cells.length + 1) {
      throw new Error(
        `Cannot insert at cell ${n}: the notebook has ${cells.length} cell${cells.length === 1 ? '' : 's'}, so the last insertable position is ${cells.length + 1}.`
      )
    }
    const source = edit.source ?? ''
    const cellType = edit.cellType ?? cells[n - 1]?.cell_type ?? 'code'
    if (!CELL_TYPES.includes(cellType)) {
      throw new Error(`Unknown cell_type "${cellType}": expected one of ${CELL_TYPES.join(', ')}.`)
    }
    const created: NotebookCell =
      cellType === 'code'
        ? { cell_type: 'code', metadata: {}, source: toSourceLines(source), outputs: [], execution_count: null }
        : { cell_type: cellType, metadata: {}, source: toSourceLines(source) }
    cells.splice(n - 1, 0, created)
    return { ...nb, cells }
  }

  if (n > cells.length) {
    throw new Error(
      `Cell ${n} does not exist: the notebook has ${cells.length} cell${cells.length === 1 ? '' : 's'}.`
    )
  }

  if (edit.mode === 'delete') {
    cells.splice(n - 1, 1)
    return { ...nb, cells }
  }

  const target = cells[n - 1]
  if (edit.source === undefined) {
    throw new Error('Replacing a cell requires "source".')
  }
  const updated: NotebookCell = { ...target, source: toSourceLines(edit.source) }
  if (edit.cellType !== undefined && edit.cellType !== target.cell_type) {
    if (!CELL_TYPES.includes(edit.cellType)) {
      throw new Error(`Unknown cell_type "${edit.cellType}": expected one of ${CELL_TYPES.join(', ')}.`)
    }
    updated.cell_type = edit.cellType
  }
  if (updated.cell_type === 'code') {
    // Source changed, so any recorded result is now from code that is gone.
    updated.outputs = []
    updated.execution_count = null
  } else {
    // A markdown/raw cell has no execution state to carry.
    delete updated.outputs
    delete updated.execution_count
  }
  cells[n - 1] = updated
  return { ...nb, cells }
}

/**
 * Serialize a notebook the way Jupyter writes one: 2-space indent and a trailing
 * newline. Matching the canonical formatting keeps an agent edit from showing up in
 * git as a whole-file reformat that buries the one cell that actually changed.
 */
export function serializeNotebook(nb: Notebook): string {
  return `${JSON.stringify(nb, null, 2)}\n`
}
