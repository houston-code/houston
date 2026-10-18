/**
 * Read a conversation back out of an HTML file written by `conversationToHtml`.
 *
 * Current exports carry the conversation as JSON in an inert `<template>` (see
 * `html-export.ts`), which imports exactly like a JSON export. Files exported
 * before that block existed hold only the rendered page. For those the visible
 * user and assistant text is recovered and tool activity is dropped: a tool result
 * can't be paired with its call without the ids the page never showed, and an
 * unpaired result is rejected by the providers.
 *
 * The result is untrusted, conversation-shaped data; callers must still pass it
 * through `validateImportedConversation`. Parsing uses plain index scans over
 * bounded slices (no DOM, no backtracking regex over the whole file), so a hostile
 * file costs linear time.
 */

import { HTML_DATA_FORMAT, HTML_DATA_OPEN_TAG, HTML_DATA_VERSION } from './html-export'

export interface ParsedHtmlConversation {
  /** Conversation-shaped data for `validateImportedConversation`. */
  raw: unknown
  /** True when only the visible text could be recovered (an export from before the data block). */
  textOnly: boolean
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0'
}

/**
 * Decode HTML character references in a single pass, so `&amp;lt;` becomes `&lt;`
 * rather than `<`. Covers what `escapeHtml` emits plus what a browser's "save page"
 * re-serialization can introduce (`&nbsp;`, numeric references); anything else is
 * left as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,8});/g, (match, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref] ?? match
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/** The text between `open` and the next `close` in `s`, or undefined when either is missing. */
function between(s: string, open: string, close: string): string | undefined {
  const start = s.indexOf(open)
  if (start < 0) return undefined
  const end = s.indexOf(close, start + open.length)
  return end < 0 ? undefined : s.slice(start + open.length, end)
}

/** Read the embedded data block that starts at `at` (the index of its opening tag). */
function readDataBlock(html: string, at: number): ParsedHtmlConversation {
  const start = at + HTML_DATA_OPEN_TAG.length
  // The JSON inside is HTML-escaped, so the first closing tag is the block's own.
  const end = html.indexOf('</template>', start)
  if (end < 0) throw new Error('The chat data in this HTML file is cut off.')
  let data: unknown
  try {
    data = JSON.parse(decodeHtmlEntities(html.slice(start, end)))
  } catch {
    throw new Error('The chat data in this HTML file is damaged.')
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('The chat data in this HTML file is damaged.')
  }
  const { format, version } = data as { format?: unknown; version?: unknown }
  if (format !== HTML_DATA_FORMAT || typeof version !== 'number') {
    throw new Error('The chat data in this HTML file is damaged.')
  }
  if (version > HTML_DATA_VERSION) {
    throw new Error('This chat was exported by a newer version of Houston. Update Houston to import it.')
  }
  return { raw: data, textOnly: false }
}

const SECTION_OPEN = '<section class="turn turn--'
const SECTION_CLOSE = '</section>'
const BODY_OPEN = '<pre class="turn__body">'

/**
 * Recover the user and assistant text from an export that predates the data block.
 * Tool calls, tool results, and system turns are left out, and turns that end up
 * adjacent with the same role are joined so the log still alternates.
 */
function readVisibleText(html: string): ParsedHtmlConversation {
  const messages: { role: string; content: string }[] = []
  let turns = 0
  let at = html.indexOf(SECTION_OPEN)
  while (at >= 0) {
    const roleStart = at + SECTION_OPEN.length
    const end = html.indexOf(SECTION_CLOSE, roleStart)
    if (end < 0) break
    // Work inside this one section, so a turn without a body can't pull in the next one's.
    const section = html.slice(roleStart, end)
    const tagEnd = section.indexOf('">')
    if (tagEnd < 0) break
    turns++
    const role = section.slice(0, tagEnd)
    const body = between(section, BODY_OPEN, '</pre>')
    const content = body === undefined ? '' : decodeHtmlEntities(body)
    if ((role === 'user' || role === 'assistant') && content.trim()) {
      const last = messages[messages.length - 1]
      if (last && last.role === role) last.content += `\n\n${content}`
      else messages.push({ role, content })
    }
    at = html.indexOf(SECTION_OPEN, end + SECTION_CLOSE.length)
  }
  if (turns === 0) throw new Error('This HTML file is not a Houston chat export.')
  if (messages.length === 0) throw new Error('This HTML file has no chat text to import.')
  const title = between(html, '<title>', '</title>')
  return {
    raw: { title: title === undefined ? undefined : decodeHtmlEntities(title), messages },
    textOnly: true
  }
}

/** Parse a Houston HTML export into conversation-shaped data (still to be validated). */
export function parseConversationHtml(html: string): ParsedHtmlConversation {
  const at = html.indexOf(HTML_DATA_OPEN_TAG)
  return at >= 0 ? readDataBlock(html, at) : readVisibleText(html)
}
