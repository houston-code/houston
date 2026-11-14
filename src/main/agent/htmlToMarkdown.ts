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

import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as T } from 'parse5'

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

/** Concatenated text of `n`, skipping dropped elements. `<br>` counts as a newline. */
function textContent(n: Node): string {
  if (n.nodeName === '#text') return clean((n as T.TextNode).value)
  if (isElement(n)) {
    if (isDropped(n)) return ''
    if (n.tagName === 'br') return '\n'
  }
  let out = ''
  for (const c of children(n)) out += textContent(c)
  return out
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

function isChrome(el: Element): boolean {
  if (CHROME_TAGS.has(el.tagName) || CHROME_ROLES.has(attr(el, 'role') ?? '')) return true
  if (el.tagName === 'body' || el.tagName === 'main' || el.tagName === 'article') return false
  const ci = classAndId(el)
  return UNLIKELY.test(ci) && !LIKELY.test(ci)
}

/** Drop navigation, footers, sidebars and similar chrome, unless they hold the content itself. */
function stripChrome(root: Element): void {
  const stats = measure(root)
  const walk = (el: Element): void => {
    for (const c of [...el.childNodes]) {
      if (!isElement(c) || isDropped(c)) continue
      if (isChrome(c) && !stats.get(c)?.holdsContent) remove(c)
      else walk(c)
    }
  }
  walk(root)
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
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  if (!m[2]) return inner
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`
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

function codeLanguage(el: Element): string {
  const codeChild = el.childNodes.find((c): c is Element => isElement(c) && c.tagName === 'code')
  const cls = `${attr(el, 'class') ?? ''} ${codeChild ? (attr(codeChild, 'class') ?? '') : ''}`
  const m = cls.match(/(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i)
  if (m) return m[1].toLowerCase()
  const dataLang = attr(el, 'data-lang') ?? (codeChild ? attr(codeChild, 'data-lang') : undefined)
  return dataLang && /^[\w+#.-]+$/.test(dataLang) ? dataLang.toLowerCase() : ''
}

class Renderer {
  private readonly codeBlocks: string[] = []

  constructor(private readonly baseUrl: string | undefined) {}

  /** Render `root` to markdown. */
  document(root: Node): string {
    return this.restoreCode(this.blockContent(root))
      .replace(new RegExp(INDENT, 'g'), ' ')
      .replace(/[ \t]+$/gm, '')
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
    let code = textContent(el)
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
    const grid = rows.map((tr) =>
      tr.childNodes.filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'))
    )
    const cols = Math.max(0, ...grid.map((r) => r.length))
    // A layout table (one column, or cells holding blocks) reads better as its content.
    const blocky = (e: Element): boolean =>
      e.tagName === 'pre' || e.tagName === 'table' || e.tagName === 'ul' || e.tagName === 'ol'
    if (cols < 2 || grid.some((r) => r.some((cell) => contains(cell, blocky)))) {
      const cells = grid
        .flat()
        .map((cell) => this.blockContent(cell))
        .filter(Boolean)
      return cells.length ? `\n\n${cells.join('\n\n')}\n\n` : ''
    }
    const lines = grid.map((r) => {
      const cells = r.map((cell) => oneLine(this.inline(cell)).replace(/\|/g, '\\|'))
      while (cells.length < cols) cells.push('')
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

/** Convert an HTML document to markdown: the main content, with code, links and structure kept. */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): string {
  const doc = parse(html)
  const titleEl = findFirst(doc, 'title')
  const title = titleEl ? oneLine(textContent(titleEl)) : ''
  const body = findFirst(doc, 'body')
  if (!body) return title ? `# ${title}` : ''

  let root: Element = body
  if (!opts.fullPage) {
    stripChrome(body)
    root = pickContent(body)
  }
  const md = new Renderer(opts.baseUrl).document(root)
  // The <title> is often the only statement of what the page is; lead with it when
  // the content has no top heading of its own.
  if (title && !findFirst(root, 'h1')) return md ? `# ${title}\n\n${md}` : `# ${title}`
  return md
}
