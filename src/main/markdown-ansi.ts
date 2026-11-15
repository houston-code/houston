import { parseMarkdown, type Block, type Inline, type ListItem } from '@shared/markdown'
import type { Painter } from './tui'
import { PROSE_PATH, type MarkdownLinks } from './tui-links'
import { osc8Link, wrapAnsi, visibleWidth, terminalText } from './tui-wrap'

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
  /**
   * Where links and file paths point, when the terminal shows OSC 8 hyperlinks.
   * Omitted (no TTY, screen-reader mode, colour off): everything stays plain text.
   */
  links?: MarkdownLinks
}

/**
 * The desktop app draws these blocks as pictures (svg, mermaid) or runs them
 * (html visual); here they stay code, with a note saying where to see them.
 */
export function visualHint(lang: string, info: string): string | null {
  const l = lang.toLowerCase()
  if (l === 'svg' || l === 'mermaid') return 'diagram: open this chat in the Houston app to see it drawn'
  if (l === 'html' && info.toLowerCase().split(/\s+/).includes('visual')) {
    return 'interactive visual: open this chat in the Houston app to run it'
  }
  return null
}

export function renderMarkdownAnsi(src: string, opts: MarkdownOpts): string {
  // The source is the model's text. Its control characters are made inert before it is
  // parsed, so a reply can't move the cursor, rewrite the lines above it or write the
  // clipboard; the only escapes in the output are the colours added here.
  return renderBlocks(parseMarkdown(terminalText(src)), opts, 0)
}

function renderBlocks(blocks: Block[], opts: MarkdownOpts, depth: number): string {
  // Top-level blocks get a blank line between them, as on the desktop: without it a
  // blockquote under a code block read as more code (both draw a │ gutter) and a
  // heading ran into the list below it. Inside a list item they stay tight.
  return blocks
    .map((b) => renderBlock(b, opts, depth))
    .filter((s) => s.length > 0)
    .join(depth === 0 ? '\n\n' : '\n')
}

function renderBlock(b: Block, opts: MarkdownOpts, depth: number): string {
  const { paint } = opts
  const width = opts.width ?? 0
  const wrap = (s: string, indent = 0): string =>
    width > 0 ? indentLines(wrapAnsi(s, Math.max(1, width - indent)), indent) : s
  switch (b.type) {
    case 'heading': {
      const text = renderInline(b.children, paint, opts.links)
      return paint(`${'#'.repeat(b.level)} ${text}`, 'bold', 'cyan')
    }
    case 'paragraph':
      return wrap(renderInline(b.children, paint, opts.links))
    case 'code': {
      const body = opts.highlight ? opts.highlight(b.lang, b.value) : b.value
      const gutter = paint('│ ', 'dim')
      // A line wider than the terminal wraps under its own gutter, so the block keeps
      // its edge instead of the terminal folding the line back to column 0.
      const room = width > 2 ? width - 2 : 0
      const lines = body
        .replace(/\n$/, '')
        .split('\n')
        .flatMap((l) => (room > 0 && visibleWidth(l) > room ? wrapCode(l, room) : [l]))
      const label = b.lang ? paint(`${b.lang}`, 'dim') : ''
      const head = label ? `${paint('┌', 'dim')} ${label}\n` : ''
      const hint = visualHint(b.lang, b.info)
      return head + lines.map((l) => `${gutter}${l}`).join('\n') + (hint ? `\n${paint(`  ↳ ${hint}`, 'dim')}` : '')
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
      return renderTable(b, paint, width, opts.links)
  }
}

function renderListItem(
  item: ListItem,
  ordered: boolean,
  index: number,
  opts: MarkdownOpts,
  depth: number
): string {
  // A GFM task item keeps its bullet and shows its box after it: "• [x] done".
  const box = item.checked === undefined ? '' : item.checked ? '[x]' : '[ ]'
  const listMarker = ordered ? `${index}.` : '•'
  const marker = box ? `${listMarker} ${box}` : listMarker
  const bullet = box
    ? `${opts.paint(listMarker, 'cyan')} ${item.checked ? opts.paint(box, 'green') : opts.paint(box, 'dim')}`
    : opts.paint(marker, 'cyan')
  const pad = ' '.repeat(marker.length + 1)
  // Every line of the body is prefixed below (indent + bullet or its padding), so it
  // must wrap that much narrower. Wrapping at the full width and indenting after made
  // long items overflow the terminal, which then broke them mid-word.
  const prefix = 2 * depth + pad.length
  const width = opts.width ?? 0
  const body = renderBlocks(
    item.blocks,
    { ...opts, width: width > 0 ? Math.max(1, width - prefix) : width },
    depth + 1
  )
  // First line gets the bullet; continuation lines align under the text.
  const lines = body.split('\n')
  return lines.map((l, i) => (i === 0 ? `${'  '.repeat(depth)}${bullet} ${l}` : `${'  '.repeat(depth)}${pad}${l}`)).join('\n')
}

/** Narrowest a table column is squeezed to before the table is left to overflow. */
const MIN_COLUMN = 6

/**
 * Column widths that fit `width` (0: no limit): the widest columns give up room first,
 * down to {@link MIN_COLUMN}. A table that can't fit even then keeps its natural widths
 * and lets the terminal wrap it, which beats a column of one-letter rows.
 */
export function fitColumns(natural: number[], width: number): number[] {
  const gaps = 3 * Math.max(0, natural.length - 1)
  if (width <= 0 || natural.reduce((a, w) => a + w, 0) + gaps <= width) return natural
  const budget = width - gaps
  if (budget < natural.reduce((a, w) => a + Math.min(w, MIN_COLUMN), 0)) return natural
  const out = [...natural]
  let total = out.reduce((a, w) => a + w, 0)
  while (total > budget) {
    let widest = 0
    for (let i = 1; i < out.length; i++) if (out[i] > out[widest]) widest = i
    if (out[widest] <= MIN_COLUMN) break
    out[widest]--
    total--
  }
  return out
}

function renderTable(
  b: Extract<Block, { type: 'table' }>,
  paint: Painter,
  width: number,
  links: MarkdownLinks | undefined
): string {
  const cells = [b.header, ...b.rows].map((row) => row.map((c) => renderInline(c, paint, links)))
  const cols = Math.max(0, ...cells.map((r) => r.length))
  const natural: number[] = []
  for (let c = 0; c < cols; c++) {
    natural[c] = Math.max(...cells.map((r) => visibleWidth(r[c] ?? '')))
  }
  const widths = fitColumns(natural, width)
  // A cell wider than its column wraps inside it; the row is as tall as its tallest cell.
  const fmtRow = (row: string[]): string => {
    const wrapped = widths.map((w, c) => {
      const cell = row[c] ?? ''
      return visibleWidth(cell) > w ? wrapAnsi(cell, w).split('\n') : [cell]
    })
    const height = Math.max(1, ...wrapped.map((l) => l.length))
    const lines: string[] = []
    for (let i = 0; i < height; i++) {
      lines.push(wrapped.map((l, c) => padVisible(l[i] ?? '', widths[c], b.align[c])).join(paint(' │ ', 'dim')))
    }
    return lines.join('\n')
  }
  const sep = paint(widths.map((w) => '─'.repeat(w)).join('─┼─'), 'dim')
  const [header, ...rows] = cells
  const head = fmtRow(header)
    .split('\n')
    .map((l) => paint(l, 'bold'))
    .join('\n')
  return [head, sep, ...rows.map(fmtRow)].join('\n')
}

/** A code line cut into rows of `width` columns (code has no word breaks to honour). */
function wrapCode(line: string, width: number): string[] {
  // wrapAnsi hard-splits a run longer than the row and breaks at spaces otherwise;
  // its leading indentation would be lost on a break, which code can live with.
  return wrapAnsi(line, width).split('\n')
}

// ---- inline -----------------------------------------------------------------

export function renderInline(nodes: Inline[], paint: Painter, links?: MarkdownLinks): string {
  return nodes.map((n) => renderInlineNode(n, paint, links)).join('')
}

/** Prose with each path-shaped word that names a workspace file made a hyperlink. */
function linkPaths(text: string, links: MarkdownLinks | undefined): string {
  if (!links || !text.includes('/')) return text
  return text.replace(PROSE_PATH, (word: string) => {
    const url = links.path(word)
    return url ? osc8Link(url, word) : word
  })
}

/** The text of a link node, with no links of its own inside (a hyperlink can't nest). */
function plainInline(nodes: Inline[], paint: Painter): string {
  return renderInline(nodes, paint)
}

function renderInlineNode(n: Inline, paint: Painter, links: MarkdownLinks | undefined): string {
  switch (n.type) {
    case 'text':
      return linkPaths(n.value, links)
    case 'strong':
      return paint(renderInline(n.children, paint, links), 'bold')
    case 'em':
      return paint(renderInline(n.children, paint, links), 'yellow')
    case 'del':
      return paint(renderInline(n.children, paint, links), 'dim')
    case 'code': {
      const shown = paint(n.value, 'green')
      // A path in backticks is the usual way a reply names a file.
      const url = links && !/\s/.test(n.value) ? links.path(n.value) : null
      return url ? osc8Link(url, shown) : shown
    }
    case 'link': {
      const text = plainInline(n.children, paint)
      const url = links?.href(n.href) ?? null
      // A bare URL already shows its target; a labelled link keeps it beside the label,
      // so where a click goes is never hidden behind the words.
      const same = n.children.length === 1 && n.children[0].type === 'text' && n.children[0].value === n.href
      const suffix = same ? '' : ` ${paint(`(${n.href})`, 'dim')}`
      if (!url) return `${text}${suffix}`
      return `${osc8Link(url, paint(text, 'cyan'))}${suffix}`
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
  const scan = new BlockScanner()
  scan.advance(buf)
  return scan.split(buf)
}

/** An open code fence: a closing fence must use the same char and be at least as long. */
type Fence = { char: string; len: number } | null

/**
 * Line-by-line state for finding block boundaries in a growing buffer. Only
 * complete lines (ended by a newline) are read, each exactly once: a boundary is a
 * blank line, and a line can only be blank once its newline has arrived, so text
 * after the last newline never needs reading yet. This keeps a long block (a big
 * code fence) linear to stream instead of rescanning it on every delta.
 */
class BlockScanner {
  /** Offset of the first line not yet read. */
  private pos = 0
  // Track the OPEN fence's marker char + length: a closing fence must use the same
  // char and be at least as long (CommonMark). Toggling on any fence marker let a
  // `~~~` line inside a ``` block close the fence, splitting the buffer mid-code-block.
  private fence: Fence = null
  /** The last blank line outside a fence: where it starts, and where the line after it starts. */
  private boundary: { start: number; next: number } | null = null

  /** Read the complete lines of `buf` past the ones already read. */
  advance(buf: string): void {
    for (let nl = buf.indexOf('\n', this.pos); nl >= 0; nl = buf.indexOf('\n', this.pos)) {
      const line = buf.slice(this.pos, nl)
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) {
        if (!this.fence) this.fence = { char: marker[0], len: marker.length }
        else if (marker[0] === this.fence.char && marker.length >= this.fence.len) this.fence = null
        // else: a different-char or shorter fence inside a code block is just content.
      }
      // A boundary is a blank line *between* content; a line still being written
      // (no newline yet) is never one.
      else if (!this.fence && line.trim() === '') this.boundary = { start: this.pos, next: nl + 1 }
      this.pos = nl + 1
    }
  }

  /**
   * Split `buf` (the text this scanner has read) at the last boundary: the finalized
   * blocks before it, and the remainder after it. Nothing is final without one.
   */
  split(buf: string): { complete: string; rest: string } {
    if (!this.boundary) return { complete: '', rest: buf }
    return {
      // Up to the newline that ends the line before the boundary, not including it.
      complete: buf.slice(0, Math.max(0, this.boundary.start - 1)),
      rest: buf.slice(this.boundary.next)
    }
  }

  /**
   * Drop everything up to the last boundary, which the caller has consumed. The fence
   * state carries over: a boundary is only ever outside a fence, so reading the rest
   * afresh would reach the same state.
   */
  consumeBoundary(): void {
    if (!this.boundary) return
    this.pos -= this.boundary.next
    this.boundary = null
  }

  reset(): void {
    this.pos = 0
    this.fence = null
    this.boundary = null
  }
}

/**
 * Streaming markdown renderer. `push()` renders and returns any blocks that have
 * finalized since the last call; `flush()` renders whatever is left at turn end.
 */
export class MarkdownStream {
  private buf = ''
  // Whether a block has been printed. Chunks are cut at the reply's blank lines, so
  // each later chunk starts with the blank line that separated it in the source.
  private printed = false
  // Boundary-finding state for `buf`, kept between pushes so each delta reads only its
  // own new lines rather than the whole unfinished block again.
  private readonly scan = new BlockScanner()
  constructor(private readonly opts: MarkdownOpts) {}

  private emit(src: string): string {
    const out = `${this.printed ? '\n' : ''}${renderMarkdownAnsi(src, this.opts)}\n`
    this.printed = true
    return out
  }

  push(delta: string): string {
    // Kept raw until a block is rendered (renderMarkdownAnsi cleans it then), so a CRLF
    // split across two deltas still reads as one line ending.
    this.buf += delta
    // A block can only finalize at a blank line, which needs a newline to end it.
    if (!delta.includes('\n')) return ''
    this.scan.advance(this.buf)
    const { complete, rest } = this.scan.split(this.buf)
    this.scan.consumeBoundary()
    this.buf = rest
    return complete.trim() ? this.emit(complete) : ''
  }

  flush(): string {
    const out = this.buf.trim() ? this.emit(this.buf) : ''
    this.buf = ''
    this.scan.reset()
    return out
  }

  /** Drop the unfinished block without rendering it (text that was taken back). */
  discard(): void {
    this.buf = ''
    this.scan.reset()
  }

  /** True when nothing is buffered — used to decide whether a flush is needed. */
  get empty(): boolean {
    return this.buf.length === 0
  }
}
