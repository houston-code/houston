/**
 * HTML to markdown for `web_fetch`.
 *
 * The page is parsed with a spec-compliant HTML parser (parse5), so entities are
 * decoded exactly once by the same rules a browser uses (named, decimal and hex,
 * and the legacy forms without a semicolon), and markup the parser treats as raw
 * text (`<script>`, `<style>`) can never leak into the output as prose.
 *
 * What the model gets is the page's main content as markdown:
 * - `<pre>` blocks come out as fenced code, byte for byte, indentation included,
 *   with the language taken from a `language-*` / `lang-*` class when there is one;
 * - links come out as `[text](absolute url)`, resolved against the page URL;
 * - headings, lists, block quotes, tables and emphasis keep their structure;
 * - scripts, styles, forms, hidden elements and page chrome (navigation, footers,
 *   sidebars, cookie banners) are dropped, and a readability-style pass picks the
 *   element that holds the article when the page doesn't mark it with `<main>`.
 *
 * Output is plain text that happens to be markdown; it is still untrusted page
 * content and the caller fences it as such.
 */

import { parse, Tokenizer, TokenizerMode } from 'parse5'
import type { DefaultTreeAdapterTypes as T, Token, TokenHandler } from 'parse5'

type Node = T.ChildNode | T.ParentNode
type Element = T.Element

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Elements whose content is never page text. */
const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'map',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'datalist',
  'dialog',
  'svg',
  'math',
  'link',
  'meta'
])

/** Page chrome: navigation and boilerplate around the content. */
const CHROME_TAGS = new Set(['nav', 'footer', 'aside', 'form'])
const CHROME_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'menu',
  'menubar',
  'dialog',
  'alertdialog'
])

/** class/id words that mark boilerplate, and the fragments that mark content (after readability's lists). */
const UNLIKELY =
  /(^|[-_\s])(banner|breadcrumbs?|comments?|cookies?|consent|disqus|footer|gdpr|header|masthead|menu|modal|navbar|nav|newsletter|pagination|popup|promo|related|replies|share|sidebar|social|sponsor|subscribe|toolbar|ads?|advert)([-_\s]|$)/i
const LIKELY = /article|body|column|content|main|post|entry|story|text|blog|docs?|markdown|prose/i

const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'fieldset',
  'center',
  'hgroup',
  'dl',
  'body',
  'html'
])

/** Characters that stand in for structural whitespace and code blocks until the final pass, so cleanup can't eat them. */
const INDENT = '\u0001'
const PRE_OPEN = '\u0002'
const PRE_CLOSE = '\u0003'

export interface HtmlToMarkdownOptions {
  /** The page URL, for resolving relative links and images. */
  baseUrl?: string
  /** Keep the whole body instead of picking the main content. */
  fullPage?: boolean
}

/** Page text never carries the renderer's sentinels (or any C0 control but tab, newline and CR). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function isElement(n: Node): n is Element {
  return 'tagName' in n
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value
}

function children(n: Node): T.ChildNode[] {
  return 'childNodes' in n ? n.childNodes : []
}

function isHidden(el: Element): boolean {
  if (attr(el, 'hidden') !== undefined) return true
  if (attr(el, 'aria-hidden') === 'true') return true
  const style = attr(el, 'style')
  return !!style && /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style)
}

function isDropped(el: Element): boolean {
  return DROP.has(el.tagName) || el.namespaceURI === SVG_NS || isHidden(el)
}

/** Elements a browser lays out on their own line, for text collected without the renderer. */
const LINE_BLOCK = new Set([
  ...BLOCK,
  'li',
  'tr',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dt',
  'dd'
])

/**
 * Concatenated text of `n`, skipping dropped elements. `<br>` counts as a newline;
 * with `blockLines`, so does the edge of a block element (a highlighter that puts
 * each code line in its own `<div>`). Iterative, so nesting depth can't overflow
 * the stack.
 */
function textContent(n: Node, blockLines = false): string {
  // Parts are joined once at the end, and the last character is tracked apart:
  // `out.endsWith()` on a string built by `+=` flattens it on every call, which made
  // a large flattened subtree quadratic.
  const out: string[] = []
  let endsInNewline = true
  let pendingBreak = false
  const emit = (text: string): void => {
    if (!text) return
    if (pendingBreak && out.length && !endsInNewline && !text.startsWith('\n')) out.push('\n')
    pendingBreak = false
    out.push(text)
    endsInNewline = text.endsWith('\n')
  }
  // Entries are nodes to visit, or `null` marking the end of a block element.
  const stack: (Node | null)[] = [n]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === null) {
      pendingBreak = true
      continue
    }
    if (cur.nodeName === '#text') {
      emit(clean((cur as T.TextNode).value))
      continue
    }
    if (isElement(cur)) {
      if (isDropped(cur)) continue
      if (cur.tagName === 'br') {
        emit('\n')
        continue
      }
      if (blockLines && cur !== n && LINE_BLOCK.has(cur.tagName)) {
        pendingBreak = true
        stack.push(null)
      }
    }
    const kids = children(cur)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out.join('')
}

/**
 * Past this depth the tree is flattened to its text. Real pages stay far below it
 * (browsers stop nesting at 512); the cap keeps the recursive walks below from
 * overflowing the stack on a page nested thousands deep.
 */
const MAX_DEPTH = 256

function flattenDeep(root: Node): void {
  const stack: [Node, number][] = [[root, 0]]
  while (stack.length) {
    const [n, depth] = stack.pop()!
    if (depth >= MAX_DEPTH && isElement(n) && n.childNodes.some(isElement)) {
      const text: T.TextNode = { nodeName: '#text', value: textContent(n, true), parentNode: n }
      n.childNodes = [text]
      continue
    }
    for (const c of children(n)) stack.push([c, depth + 1])
  }
}

/**
 * Tags nested deeper than this are dropped before parsing (their text is kept). The
 * parser's tree builder scans its stack of open elements for most start tags, so its
 * time grows with the square of the nesting depth: a 5 MB page of nested `<div>`s
 * would take over an hour. With the stack held to this depth parsing stays linear in
 * the page's size. It sits above {@link MAX_DEPTH}, so what is dropped here would have
 * been flattened to text anyway.
 */
const MAX_PARSE_DEPTH = MAX_DEPTH + 64

/** Elements that take no end tag, so never deepen the tree. */
const VOID = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input',
  'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

/**
 * Elements whose end tag may be left out: the next sibling closes them, so a run of
 * them doesn't nest. Not counted, or a long list of unclosed `<li>` would read as deep.
 */
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'rb', 'rt', 'rtc', 'rp',
  'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption'
])

/** What the tokenizer reads after these start tags, as the tree builder would set it. */
const TEXT_MODE: Record<string, (typeof TokenizerMode)[keyof typeof TokenizerMode]> = {
  script: TokenizerMode.SCRIPT_DATA,
  style: TokenizerMode.RAWTEXT,
  xmp: TokenizerMode.RAWTEXT,
  iframe: TokenizerMode.RAWTEXT,
  noembed: TokenizerMode.RAWTEXT,
  noframes: TokenizerMode.RAWTEXT,
  noscript: TokenizerMode.RAWTEXT,
  textarea: TokenizerMode.RCDATA,
  title: TokenizerMode.RCDATA,
  plaintext: TokenizerMode.PLAINTEXT
}

/**
 * Drops the start and end tags of elements nested past {@link MAX_PARSE_DEPTH}, in one
 * linear tokenizer pass, so the parse that follows stays linear too. Returns the HTML
 * unchanged when nothing is that deep.
 */
export function capNesting(html: string, maxDepth = MAX_PARSE_DEPTH): string {
  // A page with fewer tags than the cap can't nest past it.
  let tags = 0
  for (let i = html.indexOf('<'); i !== -1 && tags <= maxDepth; i = html.indexOf('<', i + 1)) tags++
  if (tags <= maxDepth) return html

  // Offsets are taken on the text the tokenizer sees, with line endings normalized as
  // the parser normalizes them, so they index the string spliced below.
  const src = html.replace(/\r\n?/g, '\n')
  const open: string[] = []
  const openCount = new Map<string, number>()
  const droppedCount = new Map<string, number>()
  const cuts: [number, number][] = []
  const cut = (t: Token.TagToken): void => {
    if (t.location) cuts.push([t.location.startOffset, t.location.endOffset])
  }
  const bump = (m: Map<string, number>, name: string, by: number): void => {
    m.set(name, (m.get(name) ?? 0) + by)
  }
  const noop = (): void => {}
  const handler: TokenHandler = {
    onStartTag(t) {
      const name = t.tagName
      const mode = TEXT_MODE[name]
      if (mode !== undefined) tokenizer.state = mode
      if (VOID.has(name) || OPTIONAL_END.has(name)) return
      if (open.length >= maxDepth) {
        // Raw-text elements keep their tags, so their contents stay out of the text.
        if (mode !== undefined) return
        cut(t)
        bump(droppedCount, name, 1)
        return
      }
      open.push(name)
      bump(openCount, name, 1)
    },
    onEndTag(t) {
      const name = t.tagName
      // Dropped elements all sit inside the deepest kept one, so they match first.
      if ((droppedCount.get(name) ?? 0) > 0) {
        cut(t)
        bump(droppedCount, name, -1)
        return
      }
      if ((openCount.get(name) ?? 0) > 0) {
        // Close back to the matching element, as the tree builder does for most tags;
        // that closes every dropped element too.
        for (;;) {
          const top = open.pop()!
          bump(openCount, top, -1)
          if (top === name) break
        }
        droppedCount.clear()
      }
    },
    onComment: noop,
    onDoctype: noop,
    onEof: noop,
    onCharacter: noop,
    onNullCharacter: noop,
    onWhitespaceCharacter: noop
  }
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, handler)
  tokenizer.write(src, true)
  if (!cuts.length) return html

  const parts: string[] = []
  let at = 0
  for (const [start, end] of cuts) {
    parts.push(src.slice(at, start))
    at = end
  }
  parts.push(src.slice(at))
  return parts.join('')
}

/** Per-element text measures, gathered in one pass so scoring stays linear in page size. */
interface Stats {
  /** Visible characters (whitespace runs counted once). */
  len: number
  /** Of those, characters inside links. */
  linkLen: number
  /** The subtree holds a `<main>`, `<article>`, `role=main` or `<pre>`. */
  holdsContent: boolean
}

function isContentHolder(el: Element): boolean {
  return el.tagName === 'main' || el.tagName === 'article' || attr(el, 'role') === 'main' || el.tagName === 'pre'
}

function measure(root: Element): Map<Element, Stats> {
  const stats = new Map<Element, Stats>()
  const walk = (el: Element, inLink: boolean): Stats => {
    const s: Stats = { len: 0, linkLen: 0, holdsContent: false }
    const link = inLink || el.tagName === 'a'
    for (const c of el.childNodes) {
      if (c.nodeName === '#text') {
        const n = (c as T.TextNode).value.replace(/\s+/g, ' ').trim().length
        s.len += n
        if (link) s.linkLen += n
      } else if (isElement(c) && !isDropped(c)) {
        const cs = walk(c, link)
        s.len += cs.len
        s.linkLen += cs.linkLen
        s.holdsContent ||= cs.holdsContent || isContentHolder(c)
      }
    }
    stats.set(el, s)
    return s
  }
  walk(root, false)
  return stats
}

function findAll(n: Node, pred: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const c of children(n)) {
    if (!isElement(c) || isDropped(c)) continue
    if (pred(c)) out.push(c)
    findAll(c, pred, out)
  }
  return out
}

function contains(n: Node, pred: (el: Element) => boolean): boolean {
  for (const c of children(n)) {
    if (!isElement(c) || isDropped(c)) continue
    if (pred(c) || contains(c, pred)) return true
  }
  return false
}

function findFirst(n: Node, tag: string): Element | null {
  for (const c of children(n)) {
    if (!isElement(c)) continue
    if (c.tagName === tag) return c
    const inner = findFirst(c, tag)
    if (inner) return inner
  }
  return null
}

function remove(el: Element): void {
  const parent = el.parentNode
  if (!parent) return
  const i = parent.childNodes.indexOf(el)
  if (i >= 0) parent.childNodes.splice(i, 1)
  el.parentNode = null
}

function classAndId(el: Element): string {
  return `${attr(el, 'class') ?? ''} ${attr(el, 'id') ?? ''}`
}

function isContentRoot(el: Element): boolean {
  return el.tagName === 'main' || el.tagName === 'article' || attr(el, 'role') === 'main'
}

/**
 * Whether `el` looks like page chrome. Inside the marked content (`<main>`,
 * `<article>`) only navigation counts: an `<aside>` there is a callout and a
 * `*-header` class is a heading, not the site's masthead.
 */
function isChrome(el: Element, inContent: boolean): boolean {
  if (inContent) return el.tagName === 'nav' || attr(el, 'role') === 'navigation'
  if (CHROME_TAGS.has(el.tagName) || CHROME_ROLES.has(attr(el, 'role') ?? '')) return true
  if (el.tagName === 'body' || isContentRoot(el)) return false
  const ci = classAndId(el)
  return UNLIKELY.test(ci) && !LIKELY.test(ci)
}

/** An element holding this share of the page's text is content, whatever its tag or class says. */
const CONTENT_SHARE = 0.25
/** Or this much text outside links. */
const CONTENT_CHARS = 500
/** When the chrome to remove adds up to more than this share of the page, the guess is wrong: remove none. */
const MAX_STRIPPED_SHARE = 0.75

/**
 * Drop navigation, footers, sidebars and similar chrome, unless they hold the
 * content itself. Tags and class words are only a hint: an element carrying a
 * real share of the page's text is kept, and when the chrome found adds up to
 * most of the page nothing is removed at all.
 */
function stripChrome(root: Element): void {
  const stats = measure(root)
  const total = stats.get(root)?.len ?? 0
  const substantial = (el: Element): boolean => {
    const s = stats.get(el)
    if (!s) return false
    return s.holdsContent || s.len >= total * CONTENT_SHARE || s.len - s.linkLen >= CONTENT_CHARS
  }
  const doomed: Element[] = []
  let removed = 0
  const walk = (el: Element, inContent: boolean): void => {
    for (const c of el.childNodes) {
      if (!isElement(c) || isDropped(c)) continue
      if (isChrome(c, inContent) && !substantial(c)) {
        doomed.push(c)
        removed += stats.get(c)?.len ?? 0
      } else walk(c, inContent || isContentRoot(c))
    }
  }
  walk(root, false)
  if (total > 0 && removed > total * MAX_STRIPPED_SHARE) return
  for (const el of doomed) remove(el)
}

/**
 * Readability-style candidate scoring: each paragraph-like block scores by its
 * length and comma count, credited fully to its parent and half to its
 * grandparent; the best container, discounted by how much of it is link text,
 * holds the article.
 */
function scoreCandidates(body: Element, stats: Map<Element, Stats>): Element | null {
  const scores = new Map<Element, number>()
  const credit = (el: Element, score: number): void => {
    if (!scores.has(el)) {
      const ci = classAndId(el)
      let base = 0
      if (LIKELY.test(ci)) base += 25
      if (UNLIKELY.test(ci)) base -= 25
      if (el.tagName === 'article' || el.tagName === 'main') base += 10
      scores.set(el, base)
    }
    scores.set(el, scores.get(el)! + score)
  }
  for (const p of findAll(body, (el) => el.tagName === 'p' || el.tagName === 'pre' || el.tagName === 'td')) {
    const text = textContent(p).replace(/\s+/g, ' ').trim()
    if (text.length < 25) continue
    const score = 1 + text.split(',').length + Math.min(Math.floor(text.length / 100), 3)
    const parent = p.parentNode && isElement(p.parentNode) ? p.parentNode : null
    if (!parent) continue
    credit(parent, score)
    const grand = parent.parentNode && isElement(parent.parentNode) ? parent.parentNode : null
    if (grand) credit(grand, score / 2)
  }
  let best: Element | null = null
  let bestScore = 0
  for (const [el, s] of scores) {
    const st = stats.get(el)
    if (!st?.len) continue
    const final = s * (1 - st.linkLen / st.len)
    if (final > bestScore) {
      best = el
      bestScore = final
    }
  }
  return best
}

const MIN_CONTENT_CHARS = 140

/** The element that holds the page's content: `<main>`, then `<article>`, then the best-scoring block, else the body. */
function pickContent(body: Element): Element {
  const stats = measure(body)
  const len = (el: Element): number => stats.get(el)?.len ?? 0
  const longest = (els: Element[]): Element | null => {
    let best: Element | null = null
    for (const el of els) if (!best || len(el) > len(best)) best = el
    return best && len(best) >= MIN_CONTENT_CHARS ? best : null
  }
  const main = longest(findAll(body, (el) => el.tagName === 'main' || attr(el, 'role') === 'main'))
  if (main) return main
  const articles = findAll(body, (el) => el.tagName === 'article')
  // Several articles side by side is a listing page, not one article: keep them all.
  if (articles.length === 1) {
    const article = longest(articles)
    if (article) return article
  }
  const candidate = scoreCandidates(body, stats)
  // A candidate that holds only a sliver of the page is a guess too far: when the
  // page has no clear article, the whole (de-chromed) body is the safer answer. A
  // page of several articles needs a candidate that covers most of them.
  const share = articles.length > 1 ? 0.75 : 0.4
  if (candidate && candidate !== body && len(candidate) >= Math.max(MIN_CONTENT_CHARS, len(body) * share)) {
    return candidate
  }
  return body
}

function resolveUrl(raw: string | undefined, base: string | undefined): string | null {
  const href = raw?.trim()
  if (!href) return null
  let url: URL
  try {
    url = base ? new URL(href, base) : new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
  return url.toString()
}

/** A URL as a markdown link target: no spaces or bare parentheses to end it early. */
function linkTarget(url: string): string {
  return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** Whitespace cleanup between blocks; structure (sentinels) and code (placeholders) are untouched. */
function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/** Text on one line, for headings, link text, and table cells. */
function oneLine(text: string): string {
  return normalize(text).replace(/\n+/g, ' ').trim()
}

/** Wrap inline content in a marker, keeping surrounding whitespace outside it. */
function wrapInline(inner: string, marker: string): string {
  // By length, not a regex: a lazy match against a long whitespace run is quadratic.
  const body = inner.trim()
  if (!body) return inner
  const lead = inner.length - inner.trimStart().length
  const trail = inner.length - inner.trimEnd().length
  return `${inner.slice(0, lead)}${marker}${body}${marker}${inner.slice(inner.length - trail)}`
}

/** Strip trailing spaces and tabs from every line, with a linear scan. */
function trimLineEnds(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let end = line.length
      while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
      return end === line.length ? line : line.slice(0, end)
    })
    .join('\n')
}

function longestRun(text: string, ch: string): number {
  let best = 0
  let run = 0
  for (const c of text) {
    run = c === ch ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n')
}

function closestTable(el: Element): Element | null {
  let p = el.parentNode
  while (p && isElement(p)) {
    if (p.tagName === 'table') return p
    p = p.parentNode
  }
  return null
}

const MAX_TABLE_COLS = 100
const MAX_ROWSPAN = 1000
const MAX_GRID_CELLS = 1_000_000

function span(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Lay a table's cells out on a grid the way a browser does, so a value stays
 * under its column: each cell takes the next free column of its row, `colspan`
 * leaves the extra columns blank, and `rowspan` repeats the cell in the rows
 * below. Null when the spans would make the grid unreasonably large.
 */
function spanGrid(rows: Element[][]): (Element | null)[][] | null {
  const grid: (Element | null | undefined)[][] = rows.map(() => [])
  let budget = MAX_GRID_CELLS
  for (let r = 0; r < rows.length; r++) {
    const line = grid[r]
    let col = 0
    for (const cell of rows[r]) {
      while (line[col] !== undefined) col++
      if (col >= MAX_TABLE_COLS) break
      const colspan = Math.min(Math.max(span(attr(cell, 'colspan'), 1), 1), MAX_TABLE_COLS - col)
      const rawRows = span(attr(cell, 'rowspan'), 1)
      // rowspan="0" runs to the end of the table.
      const rowspan = Math.min(rawRows === 0 ? rows.length - r : rawRows, rows.length - r, MAX_ROWSPAN)
      budget -= colspan * rowspan
      if (budget < 0) return null
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) grid[r + dr][col + dc] = dc === 0 ? cell : null
      }
      col += colspan
    }
  }
  return grid.map((line) => Array.from(line, (c) => c ?? null))
}

function codeLanguage(el: Element): string {
  const codeChild = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === 'code')
  const cls = `${attr(el, 'class') ?? ''} ${codeChild ? (attr(codeChild, 'class') ?? '') : ''}`
  const m = cls.match(/(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i)
  if (m) return m[1].toLowerCase()
  const dataAttr = (e: Element): string | undefined => attr(e, 'data-lang') ?? attr(e, 'data-language')
  const dataLang = dataAttr(el) ?? (codeChild ? dataAttr(codeChild) : undefined)
  return dataLang && /^[\w+#.-]+$/.test(dataLang) ? dataLang.toLowerCase() : ''
}

class Renderer {
  private readonly codeBlocks: string[] = []

  constructor(private readonly baseUrl: string | undefined) {}

  /** Render `root` to markdown. */
  document(root: Node): string {
    return trimLineEnds(this.restoreCode(this.blockContent(root)).replace(new RegExp(INDENT, 'g'), ' '))
  }

  /** Render children as blocks, normalized, with code blocks still as placeholders. */
  private blockContent(n: Node): string {
    return normalize(this.inline(n))
  }

  private inline(n: Node): string {
    let out = ''
    for (const c of children(n)) out += this.node(c)
    return out
  }

  private node(n: T.ChildNode): string {
    if (n.nodeName === '#text') return clean((n as T.TextNode).value).replace(/\s+/g, ' ')
    if (!isElement(n) || isDropped(n)) return ''
    const tag = n.tagName
    switch (tag) {
      case 'br':
        return '\n'
      case 'hr':
        return '\n\n---\n\n'
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = oneLine(this.inline(n))
        return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : ''
      }
      case 'pre':
        return this.pre(n)
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt': {
        const text = textContent(n).replace(/\s+/g, ' ')
        if (!text.trim()) return text
        const ticks = '`'.repeat(longestRun(text, '`') + 1)
        const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
        return `${ticks}${pad}${text}${pad}${ticks}`
      }
      case 'a':
        return this.link(n)
      case 'img': {
        const alt = oneLine(clean(attr(n, 'alt') ?? ''))
        if (!alt) return ''
        const src = resolveUrl(attr(n, 'src'), this.baseUrl)
        return src && !src.startsWith('mailto:') ? `![${escapeBrackets(alt)}](${linkTarget(src)})` : alt
      }
      case 'strong':
      case 'b':
        return wrapInline(this.inline(n), '**')
      case 'em':
      case 'i':
      case 'cite':
        return wrapInline(this.inline(n), '_')
      case 'del':
      case 's':
      case 'strike':
        return wrapInline(this.inline(n), '~~')
      case 'ul':
      case 'ol':
      case 'menu':
        return this.list(n)
      case 'blockquote': {
        const body = this.blockContent(n)
        if (!body) return ''
        return `\n\n${body
          .split('\n')
          .map((l) => `>${INDENT}${l}`)
          .join('\n')}\n\n`
      }
      case 'table':
        return this.table(n)
      case 'dt': {
        const text = oneLine(this.inline(n))
        return text ? `\n\n**${text}**\n` : ''
      }
      case 'dd': {
        const body = this.blockContent(n)
        return body ? `\n${indent(body, INDENT.repeat(2))}\n` : ''
      }
      case 'li':
      case 'tr':
        // Outside the list or table that would place it: still one per line.
        return `\n${this.inline(n)}\n`
      case 'td':
      case 'th':
        return ` ${this.inline(n)} `
      default:
        if (BLOCK.has(tag)) return `\n\n${this.inline(n)}\n\n`
        return this.inline(n)
    }
  }

  private pre(el: Element): string {
    let code = textContent(el, true)
    if (code.endsWith('\n')) code = code.slice(0, -1)
    if (!code.trim()) return ''
    const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1))
    const id = this.codeBlocks.push(`${fence}${codeLanguage(el)}\n${code}\n${fence}`) - 1
    return `\n\n${PRE_OPEN}${id}${PRE_CLOSE}\n\n`
  }

  private link(el: Element): string {
    const inner = this.inline(el)
    const text = oneLine(inner)
    const href = resolveUrl(attr(el, 'href'), this.baseUrl)
    if (!text) return ''
    // A link wrapped around blocks (a card, a code sample) keeps its content.
    if (!href || text.includes(PRE_OPEN)) return inner
    const lead = /^\s/.test(inner) ? ' ' : ''
    const trail = /\s$/.test(inner) ? ' ' : ''
    return `${lead}[${escapeBrackets(text)}](${linkTarget(href)})${trail}`
  }

  private list(el: Element): string {
    const ordered = el.tagName === 'ol'
    let n = Number.parseInt(attr(el, 'start') ?? '1', 10)
    if (!Number.isFinite(n)) n = 1
    const items: string[] = []
    for (const c of el.childNodes) {
      if (!isElement(c) || isDropped(c)) continue
      if (c.tagName !== 'li') {
        // A nested list placed directly in the list (invalid but common), or stray content.
        const body = normalize(this.node(c))
        if (body) items.push(indent(body, INDENT.repeat(2)))
        continue
      }
      const body = this.blockContent(c)
      const marker = ordered ? `${n++}.` : '-'
      if (!body) continue
      const pad = INDENT.repeat(marker.length + 1)
      const [first, ...rest] = body.split('\n')
      items.push([`${marker}${INDENT}${first}`, ...rest.map((l) => (l ? pad + l : l))].join('\n'))
    }
    return items.length ? `\n\n${items.join('\n')}\n\n` : ''
  }

  private table(el: Element): string {
    const rows = findAll(el, (e) => e.tagName === 'tr').filter((tr) => closestTable(tr) === el)
    const rowCells = rows.map((tr) =>
      tr.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'))
    )
    const grid = spanGrid(rowCells)
    const cols = grid ? Math.max(0, ...grid.map((r) => r.length)) : 0
    // A layout table (one column, or cells holding blocks) reads better as its content.
    const blocky = (e: Element): boolean =>
      e.tagName === 'pre' || e.tagName === 'table' || e.tagName === 'ul' || e.tagName === 'ol'
    if (!grid || cols < 2 || rowCells.some((r) => r.some((cell) => contains(cell, blocky)))) {
      const cells = rowCells
        .flat()
        .map((cell) => this.blockContent(cell))
        .filter(Boolean)
      return cells.length ? `\n\n${cells.join('\n\n')}\n\n` : ''
    }
    const rendered = new Map<Element, string>()
    const text = (cell: Element): string => {
      let t = rendered.get(cell)
      if (t === undefined) rendered.set(cell, (t = oneLine(this.inline(cell)).replace(/\|/g, '\\|')))
      return t
    }
    const lines = grid.map((r) => {
      const cells = Array.from({ length: cols }, (_, i) => (r[i] ? text(r[i]!) : ''))
      return `| ${cells.join(' | ')} |`
    })
    const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
    return `\n\n${[lines[0], sep, ...lines.slice(1)].join('\n')}\n\n`
  }

  /** Swap code placeholders back in, carrying the line's indent or quote prefix onto every code line. */
  private restoreCode(text: string): string {
    const token = new RegExp(`^(.*?)${PRE_OPEN}(\\d+)${PRE_CLOSE}`, 'gm')
    return text.replace(token, (_m, prefix: string, id: string) => {
      const block = this.codeBlocks[Number(id)] ?? ''
      const carry = new RegExp(`^[> ${INDENT}]*$`).test(prefix) ? prefix : ''
      return prefix + block.split('\n').join(`\n${carry}`)
    })
  }
}

function escapeBrackets(text: string): string {
  return text.replace(/[[\]]/g, '\\$&')
}

/** The URL relative links resolve against: the document's first `<base href>`, else the page URL. */
function documentBase(doc: Node, pageUrl: string | undefined): string | undefined {
  const stack: Node[] = [doc]
  let href: string | undefined
  while (stack.length && href === undefined) {
    const n = stack.pop()!
    if (isElement(n) && n.tagName === 'base' && attr(n, 'href')?.trim()) href = attr(n, 'href')!.trim()
    const kids = children(n)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  if (href === undefined) return pageUrl
  try {
    const url = pageUrl ? new URL(href, pageUrl) : new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : pageUrl
  } catch {
    return pageUrl
  }
}

/** Convert an HTML document to markdown: the main content, with code, links and structure kept. */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): string {
  // A leading byte-order mark would push the parser out of <head>, printing the title twice.
  const doc = parse(capNesting(html.startsWith('﻿') ? html.slice(1) : html))
  flattenDeep(doc)
  const titleEl = findFirst(doc, 'title')
  const title = titleEl ? oneLine(textContent(titleEl)) : ''
  const body = findFirst(doc, 'body')
  if (!body) return title ? `# ${title}` : ''

  let root: Element = body
  if (!opts.fullPage) {
    stripChrome(body)
    root = pickContent(body)
  }
  const md = new Renderer(documentBase(doc, opts.baseUrl)).document(root)
  // The <title> is often the only statement of what the page is; lead with it when
  // the content has no top heading of its own.
  if (title && !findFirst(root, 'h1')) return md ? `# ${title}\n\n${md}` : `# ${title}`
  return md
}
