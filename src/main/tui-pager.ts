import type { ChatMessage } from '@shared/agent'
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX } from '@shared/agent'
import { runEndNoticeText, runEndRecords } from '@shared/runEnd'
import type { Painter } from './tui'
import type { EditorKey } from './tui-keys'
import { stripAnsi, stripControlCharsKeepLines, truncateVisible, visibleWidth, wrapAnsi } from './tui-wrap'

/**
 * The transcript viewer (Ctrl-O, `/transcript`): the whole session on the alternate
 * screen, with everything the live view folds away (reasoning, full tool arguments,
 * full tool output). This module is the pure part: the document a chat renders to,
 * the key reducer, and the screen a state draws. tui-io.ts owns the terminal.
 */

/** A chat rendered at one width: the screen lines, and where each of your prompts starts. */
export interface TranscriptDoc {
  lines: string[]
  /** Indexes into `lines` of each message you sent, in order (for `{` and `}`). */
  prompts: number[]
}

/** What the viewer shows: rendered per width, so a resize rewraps it. */
export interface PagerSource {
  title: string
  render: (width: number) => TranscriptDoc
  /** The whole transcript as plain text, for `v` (open it in $VISUAL/$EDITOR). */
  plain: () => string
}

type Style = Parameters<Painter>[1]

/** One run of text in the document, before wrapping. */
interface Block {
  text: string
  styles?: Style[]
  /** Columns every line of the block is indented by. */
  indent?: number
  /** The block is the header of a message you sent. */
  prompt?: boolean
}

/** Display-safe text: tabs expanded, every other control character removed, line by line. */
export function sanitizeLines(text: string): string[] {
  return stripControlCharsKeepLines(text.replace(/\t/g, '    '))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
}

/** `2026-11-14 09:05` in local time, or '' for a missing or unreadable timestamp. */
export function formatStamp(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function header(label: string, iso: string | undefined, extra?: string): string {
  return [label, formatStamp(iso), extra].filter(Boolean).join(' · ')
}

function argsText(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2) ?? '{}'
  } catch {
    return String(args)
  }
}

/** The chat as blocks, in order: every message, call and result in full. */
function transcriptBlocks(messages: ChatMessage[]): Block[] {
  const out: Block[] = []
  const gap = (): void => {
    if (out.length) out.push({ text: '' })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
        gap()
        out.push({ text: header('summary of earlier messages (compacted)', m.at), styles: ['yellow', 'bold'] })
        out.push({ text: m.content.slice(COMPACTION_SUMMARY_PREFIX.length).trim(), styles: ['dim'], indent: 2 })
        continue
      }
      if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
        gap()
        out.push({ text: m.content, styles: ['dim'], indent: 2 })
        continue
      }
      gap()
      out.push({
        text: header('you', m.at, m.steered ? 'steered into the running turn' : undefined),
        styles: ['green', 'bold'],
        prompt: true
      })
      if (m.invokedAs) {
        out.push({ text: m.invokedAs.typed ?? m.invokedAs.label, indent: 2 })
        out.push({ text: 'the prompt Houston sent for it:', styles: ['dim'], indent: 2 })
        out.push({ text: m.content, styles: ['dim'], indent: 4 })
      } else {
        out.push({ text: m.content, indent: 2 })
      }
      if (m.images?.length) {
        out.push({ text: `(${m.images.length} image${m.images.length === 1 ? '' : 's'} attached)`, styles: ['dim'], indent: 2 })
      }
      continue
    }
    if (m.role === 'assistant') {
      const thoughts = (m.reasoning ?? []).map((r) => r.text.trim()).filter(Boolean)
      if (thoughts.length || m.content.trim()) {
        gap()
        out.push({ text: header('houston', m.at, m.model), styles: ['cyan', 'bold'] })
        for (const t of thoughts) {
          out.push({ text: 'thinking:', styles: ['dim'], indent: 2 })
          out.push({ text: t, styles: ['dim'], indent: 4 })
        }
        if (m.content.trim()) out.push({ text: m.content.trim(), indent: 2 })
      }
      for (const call of m.toolCalls ?? []) {
        gap()
        out.push({ text: `▸ ${call.name}`, styles: ['magenta', 'bold'], indent: 2 })
        out.push({ text: argsText(call.arguments), styles: ['dim'], indent: 4 })
      }
      for (const r of runEndRecords(m)) {
        gap()
        out.push({ text: header(`run ended: ${runEndNoticeText(r)}`, r.at), styles: ['yellow'], indent: 2 })
      }
      continue
    }
    if (m.role === 'tool') {
      gap()
      out.push({ text: `◂ ${m.toolName ?? 'tool'} output`, styles: ['magenta'], indent: 2 })
      out.push({ text: m.content.length ? m.content : '(no output)', indent: 4 })
      const attached = (m.images?.length ?? 0) + (m.documents?.length ?? 0)
      if (attached) out.push({ text: `(${attached} attachment${attached === 1 ? '' : 's'})`, styles: ['dim'], indent: 4 })
      for (const r of runEndRecords(m)) {
        out.push({ text: header(`run ended: ${runEndNoticeText(r)}`, r.at), styles: ['yellow'], indent: 2 })
      }
    }
  }
  return out
}

/**
 * Wrap one display line to `width`, keeping its leading whitespace as a hanging
 * indent (wrapAnsi would drop it). `width` 0 leaves it whole.
 */
function wrapKeepingIndent(line: string, width: number): string[] {
  if (width <= 0 || visibleWidth(line) <= width) return [line]
  const lead = /^ */.exec(line)?.[0] ?? ''
  const room = width - lead.length
  if (room < 10) return wrapAnsi(line, width).split('\n')
  return wrapAnsi(line.slice(lead.length), room)
    .split('\n')
    .map((l) => lead + l)
}

/**
 * The chat as the viewer's document at `width` columns (0: unwrapped). Every line
 * is sanitized, wrapped as plain text and painted after, so a style never spans a
 * wrap and nothing a model, tool or file wrote can reach the terminal as a control.
 */
export function renderTranscript(
  messages: ChatMessage[],
  paint: Painter,
  opts: { width: number }
): TranscriptDoc {
  const lines: string[] = []
  const prompts: number[] = []
  for (const b of transcriptBlocks(messages)) {
    if (b.prompt) prompts.push(lines.length)
    const pad = ' '.repeat(b.indent ?? 0)
    const width = opts.width > 0 ? opts.width - pad.length : 0
    for (const raw of sanitizeLines(b.text)) {
      for (const piece of wrapKeepingIndent(raw, Math.max(width, opts.width > 0 ? 10 : 0))) {
        const text = pad + piece
        lines.push(b.styles?.length && piece ? paint(text, ...b.styles) : text)
      }
    }
  }
  if (!lines.length) lines.push(paint('(nothing in this chat yet)', 'dim'))
  return { lines, prompts }
}

/** The transcript as plain text, unwrapped, for an editor. */
export function transcriptPlain(messages: ChatMessage[], title: string): string {
  const doc = renderTranscript(messages, (s) => s, { width: 0 })
  return `${sanitizeLines(title).join(' ')}\n\n${doc.lines.join('\n')}\n`
}

// --- The viewer's state --------------------------------------------------------

export interface PagerState {
  /** The first document line on screen. */
  top: number
  /** The search in effect (highlighted, and what n / N step through). */
  query: string | null
  /** The search being typed after `/`, or null when not typing one. */
  input: string | null
  /** A one-off note for the status line, cleared by the next key. */
  message: string
  /**
   * The line of the match last shown (search Enter, n, N). n and N step from it while
   * it is on screen: one in the last screenful sits below `top`, so stepping from the
   * scroll position found the same match again forever.
   */
  match?: number | null
}

export type PagerOutcome = { kind: 'close' } | { kind: 'edit' }

export function initialPagerState(): PagerState {
  return { top: 0, query: null, input: null, message: '' }
}

/** The lowest `top` that still fills the screen: the end of the document. */
export function maxTop(doc: TranscriptDoc, height: number): number {
  return Math.max(0, doc.lines.length - Math.max(1, height))
}

/** Document lines holding `query`, case-insensitive. */
export function searchMatches(doc: TranscriptDoc, query: string): number[] {
  const q = query.toLowerCase()
  if (!q) return []
  const out: number[] = []
  doc.lines.forEach((l, i) => {
    if (stripAnsi(l).toLowerCase().includes(q)) out.push(i)
  })
  return out
}

/**
 * Advance the viewer by one key. `height` is how many document lines fit on
 * screen. Pure: the adapter draws the state and acts on the outcome.
 */
export function reducePager(
  s: PagerState,
  key: EditorKey,
  ctx: { doc: TranscriptDoc; height: number }
): { state: PagerState; outcome?: PagerOutcome } {
  const height = Math.max(1, ctx.height)
  const last = maxTop(ctx.doc, height)
  const clamp = (n: number): number => Math.max(0, Math.min(last, n))
  const at = (top: number, message = ''): { state: PagerState } => ({ state: { ...s, top: clamp(top), message } })

  if (s.input !== null) {
    switch (key.type) {
      case 'char':
        return { state: { ...s, input: s.input + key.value, message: '' } }
      case 'paste':
        return { state: { ...s, input: s.input + (key.value.split('\n')[0] ?? ''), message: '' } }
      case 'backspace':
        if (!s.input) return { state: { ...s, input: null } }
        return { state: { ...s, input: [...s.input].slice(0, -1).join('') } }
      case 'enter': {
        const query = s.input
        if (!query) return { state: { ...s, input: null } }
        const hits = searchMatches(ctx.doc, query)
        const next = hits.find((i) => i >= s.top) ?? hits[0]
        if (next === undefined) return { state: { ...s, input: null, query: null, message: `no match for "${query}"` } }
        return { state: { ...s, input: null, query, top: clamp(next), match: next, message: matchNote(hits, next) } }
      }
      case 'escape':
      case 'interrupt':
        return { state: { ...s, input: null } }
      default:
        return { state: s }
    }
  }

  switch (key.type) {
    case 'up':
      return at(s.top - 1)
    case 'down':
    case 'enter':
      return at(s.top + 1)
    case 'page-up':
      return at(s.top - height)
    case 'page-down':
      return at(s.top + height)
    case 'home':
      return at(0)
    case 'end':
      return at(last)
    case 'escape':
    case 'interrupt':
      return { state: s, outcome: { kind: 'close' } }
    case 'char': {
      // A fast typist's keys can arrive batched in one chunk: each is its own command.
      let cur: PagerState = s
      for (const ch of key.value) {
        const r = pagerChar(cur, ch, ctx.doc, height, clamp, last)
        if (r.outcome) return r
        cur = r.state
      }
      return { state: cur }
    }
    default:
      return { state: s }
  }
}

function matchNote(hits: number[], line: number): string {
  const i = hits.indexOf(line)
  return `match ${i + 1} of ${hits.length}`
}

function pagerChar(
  s: PagerState,
  ch: string,
  doc: TranscriptDoc,
  height: number,
  clamp: (n: number) => number,
  last: number
): { state: PagerState; outcome?: PagerOutcome } {
  const at = (top: number, message = ''): { state: PagerState } => ({ state: { ...s, top: clamp(top), message } })
  switch (ch) {
    case 'j':
      return at(s.top + 1)
    case 'k':
      return at(s.top - 1)
    case ' ':
    case 'f':
      return at(s.top + height)
    case 'b':
      return at(s.top - height)
    case 'g':
      return at(0)
    case 'G':
      return at(last)
    case 'q':
    case 'Q':
      return { state: s, outcome: { kind: 'close' } }
    case 'v':
      return { state: s, outcome: { kind: 'edit' } }
    case '/':
      return { state: { ...s, input: '', message: '' } }
    case 'n':
    case 'N': {
      if (!s.query) return at(s.top, 'no search yet: press / to search')
      const hits = searchMatches(doc, s.query)
      if (!hits.length) return at(s.top, `no match for "${s.query}"`)
      const shown = s.match ?? null
      const from = shown !== null && shown >= s.top && shown < s.top + height ? shown : s.top
      const go = (line: number, message: string): { state: PagerState } => ({
        state: { ...s, top: clamp(line), match: line, message }
      })
      if (ch === 'n') {
        const next = hits.find((i) => i > from)
        if (next === undefined) return go(hits[0], `${matchNote(hits, hits[0])}, from the top`)
        return go(next, matchNote(hits, next))
      }
      const prev = [...hits].reverse().find((i) => i < from)
      const end = hits[hits.length - 1]
      if (prev === undefined) return go(end, `${matchNote(hits, end)}, from the bottom`)
      return go(prev, matchNote(hits, prev))
    }
    case '{': {
      const prev = [...doc.prompts].reverse().find((i) => i < s.top)
      return prev === undefined ? at(s.top, 'no earlier message from you') : at(prev)
    }
    case '}': {
      const next = doc.prompts.find((i) => i > s.top)
      return next === undefined ? at(s.top, 'no later message from you') : at(next)
    }
    default:
      return { state: s }
  }
}

/** Inverse video, for the status line and search hits. */
const inverse = (s: string): string => `\x1b[7m${s}\x1b[27m`

/** `line` (a document line) with every hit of `query` in inverse video. Loses its own colors. */
function highlight(line: string, query: string): string {
  const plain = stripAnsi(line)
  const lower = plain.toLowerCase()
  const q = query.toLowerCase()
  let out = ''
  let from = 0
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
    out += plain.slice(from, i) + inverse(plain.slice(i, i + q.length))
    from = i + q.length
  }
  return out + plain.slice(from)
}

const PAGER_KEYS = 'j/k scroll · space/b page · g/G ends · / search · { } your messages · v editor · q close'

/**
 * The screen for a state: `rows - 1` document lines then the status line, each
 * narrower than `cols` so no row wraps. Always exactly `rows` entries.
 */
export function renderPagerScreen(
  s: PagerState,
  doc: TranscriptDoc,
  opts: { rows: number; cols: number; title: string; paint: Painter }
): string[] {
  const height = Math.max(1, opts.rows - 1)
  const width = Math.max(1, opts.cols - 1)
  const shown = doc.lines.slice(s.top, s.top + height)
  const out = shown.map((l) => {
    const line = s.query && stripAnsi(l).toLowerCase().includes(s.query.toLowerCase()) ? highlight(l, s.query) : l
    return truncateVisible(line, width)
  })
  while (out.length < height) out.push(opts.paint('~', 'dim'))
  let status: string
  if (s.input !== null) {
    status = `/${sanitizeLines(s.input).join(' ')}`
  } else {
    const total = doc.lines.length
    const end = Math.min(total, s.top + height)
    const pct = total <= height ? 100 : Math.round((end / total) * 100)
    const where = `lines ${total ? s.top + 1 : 0}-${end} of ${total} (${pct}%)`
    const note = sanitizeLines(s.message).join(' ') || PAGER_KEYS
    status = [sanitizeLines(opts.title).join(' '), where, note].filter(Boolean).join(' · ')
  }
  status = truncateVisible(status, width)
  out.push(s.input !== null ? status : inverse(status + ' '.repeat(Math.max(0, width - visibleWidth(status)))))
  return out
}

/** Where `top` lands after the document is rewrapped from `before` to `after` lines. */
export function rewrapTop(top: number, before: number, after: number): number {
  if (before <= 0) return 0
  return Math.round((top / before) * after)
}
