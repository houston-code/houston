import { parseMarkdown, type Block, type Inline, type ListItem } from '@shared/markdown'
import type { Painter } from './tui'
import { wrapAnsi, visibleWidth } from './tui-wrap'

/**
 * Render markdown to ANSI for the terminal, reusing the same parser the GUI uses
 * (`@shared/markdown`) so the two clients agree on structure. Output is plain text
 * + SGR color only — no cursor control — so it stays append-only (flicker-free).
 *
 * Streaming: markdown can't be rendered a token at a time (a heading isn't a
 * heading until its line ends; a table needs all its rows to align), so
 * `MarkdownStream` buffers deltas and emits whole blocks as they finalize at
 * blank-line boundaries, holding the trailing incomplete block until `flush()`.
 */

export interface MarkdownOpts {
  paint: Painter
  /** Wrap width in columns. 0 disables wrapping. */
  width?: number
  /** Optional code highlighter (lang, code) → ANSI; plain text when omitted. */
  highlight?: (lang: string, code: string) => string
}

export function renderMarkdownAnsi(src: string, opts: MarkdownOpts): string {
  return renderBlocks(parseMarkdown(src), opts, 0)
}

function renderBlocks(blocks: Block[], opts: MarkdownOpts, depth: number): string {
  return blocks
    .map((b) => renderBlock(b, opts, depth))
    .filter((s) => s.length > 0)
    .join('\n')
}

function renderBlock(b: Block, opts: MarkdownOpts, depth: number): string {
  const { paint } = opts
  const width = opts.width ?? 0
  const wrap = (s: string, indent = 0): string =>
    width > 0 ? indentLines(wrapAnsi(s, Math.max(1, width - indent)), indent) : s
  switch (b.type) {
    case 'heading': {
      const text = renderInline(b.children, paint)
      return paint(`${'#'.repeat(b.level)} ${text}`, 'bold', 'cyan')
    }
    case 'paragraph':
      return wrap(renderInline(b.children, paint))
    case 'code': {
      const body = opts.highlight ? opts.highlight(b.lang, b.value) : b.value
      const gutter = paint('│ ', 'dim')
      const lines = body.replace(/\n$/, '').split('\n')
      const label = b.lang ? paint(`${b.lang}`, 'dim') : ''
      const head = label ? `${paint('┌', 'dim')} ${label}\n` : ''
      return head + lines.map((l) => `${gutter}${l}`).join('\n')
    }
    case 'list':
      return b.items
        .map((item, i) => renderListItem(item, b.ordered, b.start + i, opts, depth))
        .join('\n')
    case 'blockquote': {
      const inner = renderBlocks(b.children, { ...opts, width: width > 2 ? width - 2 : width }, depth)
      return inner
        .split('\n')
        .map((l) => `${paint('│', 'dim')} ${l}`)
        .join('\n')
    }
    case 'hr':
      return paint('─'.repeat(width > 0 ? Math.min(width, 40) : 40), 'dim')
    case 'table':
      return renderTable(b, paint)
  }
}

function renderListItem(
  item: ListItem,
  ordered: boolean,
  index: number,
  opts: MarkdownOpts,
  depth: number
): string {
  const marker = ordered ? `${index}.` : '•'
  const bullet = opts.paint(marker, 'cyan')
  const body = renderBlocks(item.blocks, opts, depth + 1)
  const pad = ' '.repeat(marker.length + 1)
  // First line gets the bullet; continuation lines align under the text.
  const lines = body.split('\n')
  return lines.map((l, i) => (i === 0 ? `${'  '.repeat(depth)}${bullet} ${l}` : `${'  '.repeat(depth)}${pad}${l}`)).join('\n')
}

function renderTable(
  b: Extract<Block, { type: 'table' }>,
  paint: Painter
): string {
  const cells = [b.header, ...b.rows].map((row) => row.map((c) => renderInline(c, paint)))
  const cols = Math.max(0, ...cells.map((r) => r.length))
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...cells.map((r) => visibleWidth(r[c] ?? '')))
  }
  const fmtRow = (row: string[]): string =>
    row.map((cell, c) => padVisible(cell ?? '', widths[c], b.align[c])).join(paint(' │ ', 'dim'))
  const sep = paint(widths.map((w) => '─'.repeat(w)).join('─┼─'), 'dim')
  const [header, ...rows] = cells
  return [paint(fmtRow(header), 'bold'), sep, ...rows.map(fmtRow)].join('\n')
}

// ---- inline -----------------------------------------------------------------

export function renderInline(nodes: Inline[], paint: Painter): string {
  return nodes.map((n) => renderInlineNode(n, paint)).join('')
}

function renderInlineNode(n: Inline, paint: Painter): string {
  switch (n.type) {
    case 'text':
      return n.value
    case 'strong':
      return paint(renderInline(n.children, paint), 'bold')
    case 'em':
      return paint(renderInline(n.children, paint), 'yellow')
    case 'del':
      return paint(renderInline(n.children, paint), 'dim')
    case 'code':
      return paint(n.value, 'green')
    case 'link': {
      const text = renderInline(n.children, paint)
      return `${text} ${paint(`(${n.href})`, 'dim')}`
    }
    case 'br':
      return '\n'
  }
}

// ---- helpers ----------------------------------------------------------------

function padVisible(s: string, width: number, align: 'left' | 'right' | 'center' | null): string {
  const gap = Math.max(0, width - visibleWidth(s))
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + s + ' '.repeat(gap - left)
  }
  return s + ' '.repeat(gap)
}

function indentLines(s: string, n: number): string {
  if (n <= 0) return s
  const pad = ' '.repeat(n)
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}

/**
 * Split a growing markdown buffer into the largest prefix of *finalized* blocks
 * (everything up to and including the last blank line that is not inside a code
 * fence) and the unfinalized remainder. Returns null prefix when nothing is
 * final yet.
 */
export function splitFinalizedBlocks(buf: string): { complete: string; rest: string } {
  const lines = buf.split('\n')
  let inFence = false
  let lastBoundary = -1 // index of the last blank line outside a fence
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence
    // A boundary is a blank line *between* content. The final split element is the
    // still-incomplete current line (the trailing "\n" artifact), never a boundary.
    else if (!inFence && line.trim() === '' && i < lines.length - 1) lastBoundary = i
  }
  if (lastBoundary < 0) return { complete: '', rest: buf }
  return {
    complete: lines.slice(0, lastBoundary).join('\n'),
    rest: lines.slice(lastBoundary + 1).join('\n')
  }
}

/**
 * Streaming markdown renderer. `push()` renders and returns any blocks that have
 * finalized since the last call; `flush()` renders whatever is left at turn end.
 */
export class MarkdownStream {
  private buf = ''
  constructor(private readonly opts: MarkdownOpts) {}

  push(delta: string): string {
    this.buf += delta
    const { complete, rest } = splitFinalizedBlocks(this.buf)
    if (!complete.trim()) {
      this.buf = rest.length < this.buf.length ? rest : this.buf
      return ''
    }
    this.buf = rest
    return `${renderMarkdownAnsi(complete, this.opts)}\n`
  }

  flush(): string {
    const out = this.buf.trim() ? `${renderMarkdownAnsi(this.buf, this.opts)}\n` : ''
    this.buf = ''
    return out
  }

  /** True when nothing is buffered — used to decide whether a flush is needed. */
  get empty(): boolean {
    return this.buf.length === 0
  }
}
