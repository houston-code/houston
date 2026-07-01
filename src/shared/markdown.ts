/**
 * A small, dependency-free Markdown parser for the transcript.
 *
 * It produces a block/inline tree that `Markdown.tsx` renders to React. We hand-roll
 * it (rather than pulling in react-markdown + remark + a highlighter) to keep this
 * security-sensitive Electron app lean — same spirit as the in-house `diff.ts`.
 *
 * Supported: ATX headings, fenced code, blockquotes, ordered/unordered lists
 * (nested), GFM pipe tables, thematic breaks, and inline code / bold / italic /
 * strikethrough / links / autolinks. It is intentionally a pragmatic subset of
 * CommonMark, tuned for the markdown coding agents actually emit.
 */

export type Align = 'left' | 'right' | 'center' | null

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' }

export interface ListItem {
  /** Each item is a sequence of blocks, so items can hold paragraphs and nested lists. */
  blocks: Block[]
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'hr' }
  | { type: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }

// ---- Block-level parsing -------------------------------------------------

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})([^`]*)$/
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const UL_RE = /^(\s*)([-*+])\s+(.*)$/
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const BLOCKQUOTE_RE = /^ {0,3}>\s?(.*)$/

/**
 * Hard cap on the document size handed to the parser, so a single pathological
 * input can't exhaust memory. Beyond this the tail is dropped with a notice.
 */
const MAX_DOC_CHARS = 1_000_000

/**
 * Per-document budget for inline look-ahead steps. The inline scanners (links,
 * code spans, emphasis, autolinks) each scan forward to find their close; on
 * adversarial input (e.g. thousands of unclosed `[a](`) that compounds to O(n²)
 * and freezes the renderer. Capping the cumulative scan steps bounds the work to
 * O(n): once the budget is spent, further scans give up and the remaining text
 * renders verbatim instead of hanging the UI. The budget scales with input length
 * (with a floor) so normal documents — which use ~O(n) steps — are never
 * truncated, while quadratic blowup is capped at a small multiple of n.
 */
function inlineScanFloor(len: number): number {
  return Math.max(2_000_000, len * 20)
}
let inlineScanBudget = 0

/** Parse a markdown document into a list of blocks. */
export function parseMarkdown(src: string): Block[] {
  let text = src
  if (text.length > MAX_DOC_CHARS) {
    text = `${text.slice(0, MAX_DOC_CHARS)}\n\n[content truncated]`
  }
  // The inline look-ahead budget is (re)set per block by parseInline (proportional
  // to each block's length), so a pathological block is bounded to O(len) without
  // starving later blocks. The cap above just bounds total memory.
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Blank line — skip.
    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code block.
    const fence = line.match(FENCE_RE)
    if (fence) {
      const marker = fence[2][0]
      const lang = fence[3].trim().split(/\s+/)[0] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{${fence[2].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume closing fence (or EOF)
      blocks.push({ type: 'code', lang, value: body.join('\n') })
      continue
    }

    // Heading.
    const heading = line.match(HEADING_RE)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) })
      i++
      continue
    }

    // Thematic break.
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Table (a header row of pipes followed by a delimiter row).
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const table = parseTable(lines, i)
      if (table) {
        blocks.push(table.block)
        i = table.next
        continue
      }
    }

    // Blockquote.
    if (BLOCKQUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        const m = lines[i].match(BLOCKQUOTE_RE)
        if (!m) break
        inner.push(m[1])
        i++
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner) })
      continue
    }

    // List (ordered or unordered).
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const list = parseList(lines, i)
      blocks.push(list.block)
      i = list.next
      continue
    }

    // Paragraph — gather until a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
      para.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', children: parseInline(joinParagraph(para)) })
  }

  return blocks
}

/** Does the line at `i` begin a non-paragraph block? Used to terminate paragraphs. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))
  )
}

/** Join paragraph lines, honoring hard breaks (two trailing spaces or a backslash). */
function joinParagraph(lines: string[]): string {
  return lines
    .map((l, idx) => {
      const trimmed = l.replace(/\s+$/, '')
      const hardBreak = /\s{2,}$/.test(l) || /\\$/.test(trimmed)
      const text = trimmed.replace(/\\$/, '')
      return idx < lines.length - 1 ? text + (hardBreak ? '\n' : ' ') : trimmed
    })
    .join('')
}

interface ListParse {
  block: Extract<Block, { type: 'list' }>
  next: number
}

function parseList(lines: string[], start: number): ListParse {
  const ordered = OL_RE.test(lines[start])
  const firstMatch = (lines[start].match(OL_RE) ?? lines[start].match(UL_RE)) as RegExpMatchArray
  const baseIndent = firstMatch[1].length
  const startNum = ordered ? parseInt(firstMatch[2], 10) : 1

  const items: ListItem[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    // A new item at (roughly) the base indent, of the same kind as the list.
    const itemMatch = line.match(OL_RE) ?? line.match(UL_RE)
    if (itemMatch && itemMatch[1].length <= baseIndent + 1 && sameListType(line, ordered)) {
      const content: string[] = [itemMatch[itemMatch.length - 1]]
      const contentIndent = itemMatch[1].length + itemMatch[2].length + 1
      i++
      // Gather continuation + nested lines (indented, or lazy paragraph continuations).
      while (i < lines.length) {
        const next = lines[i]
        if (next.trim() === '') {
          // Look ahead: a blank then an indented line keeps the item open.
          const after = lines[i + 1]
          if (after && (indentOf(after) >= contentIndent || isListMarker(after))) {
            content.push('')
            i++
            continue
          }
          break
        }
        if (indentOf(next) >= contentIndent) {
          content.push(next.slice(contentIndent))
          i++
          continue
        }
        // A sibling list item at base indent ends this item.
        if (isListMarker(next) && indentOf(next) <= baseIndent + 1) break
        // Lazy continuation of the item's paragraph.
        if (!startsBlock(lines, i)) {
          content.push(next.trim())
          i++
          continue
        }
        break
      }
      items.push({ blocks: parseBlocks(content) })
      continue
    }
    break
  }

  return { block: { type: 'list', ordered, start: startNum, items }, next: i }
}

function sameListType(line: string, ordered: boolean): boolean {
  return ordered ? OL_RE.test(line) : UL_RE.test(line)
}
function isListMarker(line: string): boolean {
  return UL_RE.test(line) || OL_RE.test(line)
}
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

// ---- Tables --------------------------------------------------------------

function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed)
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cur += '|'
      i++
    } else if (row[i] === '|') {
      cells.push(cur)
      cur = ''
    } else {
      cur += row[i]
    }
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

function parseTable(lines: string[], start: number): { block: Extract<Block, { type: 'table' }>; next: number } | null {
  const header = splitRow(lines[start])
  const align: Align[] = splitRow(lines[start + 1]).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
  const rows: Inline[][][] = []
  let i = start + 2
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    const cells = splitRow(lines[i])
    rows.push(cells.map((c) => parseInline(c)))
    i++
  }
  return {
    block: { type: 'table', align, header: header.map((c) => parseInline(c)), rows },
    next: i
  }
}

// ---- Inline parsing ------------------------------------------------------

const URL_RE = /^https?:\/\/[^\s<]+/i

/**
 * Parse inline markdown (emphasis, code, links) into a node list. Each top-level
 * call resets the inline look-ahead budget (proportional to this run's length) so
 * the forward scanners can't be driven into O(n²) by adversarial content;
 * recursion (link text, emphasis inner) shares the budget via parseInlineInner.
 */
export function parseInline(src: string): Inline[] {
  inlineScanBudget = inlineScanFloor(src.length)
  return parseInlineInner(src)
}

function parseInlineInner(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf) out.push({ type: 'text', value: buf })
    buf = ''
  }

  while (i < src.length) {
    const c = src[i]

    // Hard line break preserved from joinParagraph.
    if (c === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }

    // Backslash escape of a punctuation char.
    if (c === '\\' && i + 1 < src.length && isPunct(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }

    // Inline code span.
    if (c === '`') {
      const span = codeSpan(src, i)
      if (span) {
        flush()
        out.push({ type: 'code', value: span.value })
        i = span.end
        continue
      }
    }

    // Angle autolink: <https://…>
    if (c === '<') {
      let close = -1
      for (let k = i + 1; k < src.length; k++) {
        if (--inlineScanBudget <= 0) break
        if (src[k] === '>') {
          close = k
          break
        }
      }
      if (close > i) {
        const url = src.slice(i + 1, close)
        if (URL_RE.test(url)) {
          flush()
          out.push({ type: 'link', href: url, children: [{ type: 'text', value: url }] })
          i = close + 1
          continue
        }
      }
    }

    // Link: [text](href)
    if (c === '[') {
      const link = parseLink(src, i)
      if (link) {
        flush()
        out.push({ type: 'link', href: link.href, children: parseInlineInner(link.text) })
        i = link.end
        continue
      }
    }

    // Bare URL autolink.
    if ((c === 'h' || c === 'H') && (i === 0 || isBoundary(src[i - 1]))) {
      const m = src.slice(i).match(URL_RE)
      if (m) {
        const url = stripTrailingPunct(m[0])
        flush()
        out.push({ type: 'link', href: url, children: [{ type: 'text', value: url }] })
        i += url.length
        continue
      }
    }

    // Emphasis / strong / strikethrough.
    const emph = parseEmphasis(src, i)
    if (emph) {
      flush()
      out.push(emph.node)
      i = emph.end
      continue
    }

    buf += c
    i++
  }

  flush()
  return out
}

function isPunct(ch: string): boolean {
  return /[\\`*_{}[\]()#+\-.!~|<>]/.test(ch)
}
function isBoundary(ch: string): boolean {
  return /[\s([{<]/.test(ch)
}
function isAlnum(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9]/.test(ch)
}

function stripTrailingPunct(url: string): string {
  let end = url.length
  while (end > 0 && /[.,;:!?'")\]}]/.test(url[end - 1])) {
    // Keep a closing paren if the URL contains a matching opening one (e.g. wiki links).
    if (url[end - 1] === ')' && countChar(url.slice(0, end), '(') > countChar(url.slice(0, end), ')') - 1) break
    end--
  }
  return url.slice(0, end)
}
function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** Match a backtick code span starting at `start`. Returns its literal value and end index. */
function codeSpan(src: string, start: number): { value: string; end: number } | null {
  let n = 0
  while (src[start + n] === '`') n++
  let j = start + n
  while (j < src.length) {
    if (--inlineScanBudget <= 0) return null
    if (src[j] === '`') {
      let run = 0
      while (src[j + run] === '`') run++
      if (run === n) {
        let value = src.slice(start + n, j)
        // CommonMark: strip one leading/trailing space if the content isn't all spaces.
        if (value.length > 1 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') {
          value = value.slice(1, -1)
        }
        return { value, end: j + n }
      }
      j += run
    } else {
      j++
    }
  }
  return null
}

function parseLink(src: string, start: number): { text: string; href: string; end: number } | null {
  // Find the matching ] for the opening [, allowing one level of nested brackets.
  let depth = 0
  let close = -1
  for (let j = start; j < src.length; j++) {
    if (--inlineScanBudget <= 0) return null
    if (src[j] === '\\') {
      j++
      continue
    }
    if (src[j] === '[') depth++
    else if (src[j] === ']') {
      depth--
      if (depth === 0) {
        close = j
        break
      }
    }
  }
  if (close === -1 || src[close + 1] !== '(') return null
  // Read the destination up to the matching ), allowing nested parens.
  let depthP = 0
  let end = -1
  for (let j = close + 1; j < src.length; j++) {
    if (--inlineScanBudget <= 0) return null
    if (src[j] === '(') depthP++
    else if (src[j] === ')') {
      depthP--
      if (depthP === 0) {
        end = j
        break
      }
    }
  }
  if (end === -1) return null
  let dest = src.slice(close + 2, end).trim()
  // Drop an optional "title".
  const sp = dest.search(/\s/)
  if (sp !== -1) dest = dest.slice(0, sp)
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
  return { text: src.slice(start + 1, close), href: dest, end: end + 1 }
}

const DELIMS: { mark: string; type: 'strong' | 'em' | 'del'; wrap?: 'em' }[] = [
  { mark: '***', type: 'strong', wrap: 'em' },
  { mark: '___', type: 'strong', wrap: 'em' },
  { mark: '**', type: 'strong' },
  { mark: '__', type: 'strong' },
  { mark: '~~', type: 'del' },
  { mark: '*', type: 'em' },
  { mark: '_', type: 'em' }
]

function parseEmphasis(src: string, start: number): { node: Inline; end: number } | null {
  for (const { mark, type, wrap } of DELIMS) {
    if (!src.startsWith(mark, start)) continue
    const L = mark.length
    const after = src[start + L]
    // Opening delimiter must hug content (no whitespace right after).
    if (after === undefined || /\s/.test(after)) continue
    // Underscores don't open inside a word.
    if (mark[0] === '_' && isAlnum(src[start - 1])) continue

    const closeIdx = findClosing(src, start + L, mark)
    if (closeIdx === -1) continue
    // Closing must hug content and, for underscores, sit at a word boundary.
    if (/\s/.test(src[closeIdx - 1])) continue
    if (mark[0] === '_' && isAlnum(src[closeIdx + L])) continue

    const inner = src.slice(start + L, closeIdx)
    if (inner === '') continue
    const children = parseInlineInner(inner)
    const node: Inline = wrap
      ? { type, children: [{ type: wrap, children }] }
      : { type, children }
    return { node, end: closeIdx + L }
  }
  return null
}

/** Find the closing run of `mark`, skipping over code spans so delimiters inside code don't match. */
function findClosing(src: string, from: number, mark: string): number {
  let j = from
  while (j < src.length) {
    if (--inlineScanBudget <= 0) return -1
    if (src[j] === '`') {
      const span = codeSpan(src, j)
      if (span) {
        j = span.end
        continue
      }
    }
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src.startsWith(mark, j)) {
      // Don't match a longer run as this (shorter) delimiter, e.g. `*` inside `**`.
      const ch = mark[0]
      if (src[j - 1] !== ch && src[j + mark.length] !== ch) return j
    }
    j++
  }
  return -1
}

/**
 * Restrict link hrefs to schemes safe to hand to the OS browser. Anything else
 * (javascript:, data:, file:, protocol-relative `//host`, bare relative paths)
 * returns null and is rendered as plain text rather than a clickable link.
 */
export function safeHref(href: string): string | null {
  const h = href.trim()
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h
  if (h.startsWith('#')) return h
  return null
}
