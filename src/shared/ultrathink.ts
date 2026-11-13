/**
 * The `ultrathink` keyword: typed anywhere in a message, it asks for the deepest
 * reasoning on that one turn without changing the chat's reasoning setting. The loop
 * raises the turn's effort and tells the model; the composers show a hint while the
 * word is in the draft. One detector for all of them, so what the hint promises is
 * exactly what the run does.
 */

import { SYSTEM_NOTE_PREFIX, type ChatMessage, type ReasoningEffort } from './agent'

/** A use of the keyword: `[start, end)` offsets into the text. */
export interface KeywordRange {
  start: number
  end: number
}

const KEYWORD = /ultrathink/gi

/** Characters that make the word part of a longer name, path or flag when adjacent. */
const NAME_CHAR = /[\p{L}\p{N}_\-/\\]/u

/** Quote marks: a quoted keyword is being talked about, not used. */
const QUOTE = /["'`‘’“”]/

/**
 * The text with code blanked out, offsets unchanged: fenced blocks, then inline spans.
 * An unclosed fence runs to the end, as it renders. Code is quoted material, so the
 * keyword inside it is inert. Blanking keeps the scan linear however long the paste.
 */
function withoutCode(text: string): string {
  if (!text.includes('`')) return text
  const blank = (m: string): string => ' '.repeat(m.length)
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]+`/g, blank)
}

/**
 * Where the keyword is used as a word of its own. Skipped: the word inside a longer
 * name, a path or a flag (`ultrathink.ts`, `src/ultrathink`, `--ultrathink`), a quoted
 * mention (`"ultrathink"`), and anything in code. A sentence-ending period is fine.
 */
export function findUltrathink(text: string): KeywordRange[] {
  if (!/ultrathink/i.test(text)) return []
  const prose = withoutCode(text)
  const out: KeywordRange[] = []
  for (const m of prose.matchAll(KEYWORD)) {
    const start = m.index
    const end = start + m[0].length
    const before = prose[start - 1] ?? ''
    const after = prose[end] ?? ''
    if (before && (NAME_CHAR.test(before) || QUOTE.test(before) || before === '.')) continue
    if (after && (NAME_CHAR.test(after) || QUOTE.test(after))) continue
    // `ultrathink.` ends a sentence; `ultrathink.ts` is a file name.
    if (after === '.' && NAME_CHAR.test(prose[end + 1] ?? '')) continue
    out.push({ start, end })
  }
  return out
}

/**
 * The text cut at `ranges` into runs, each flagged as keyword or not, for a client
 * that draws the keyword differently. Null when there is nothing to mark.
 */
export function splitByRanges(
  text: string,
  ranges: readonly KeywordRange[]
): { text: string; keyword: boolean }[] | null {
  if (!ranges.length) return null
  const parts: { text: string; keyword: boolean }[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.start > pos) parts.push({ text: text.slice(pos, r.start), keyword: false })
    parts.push({ text: text.slice(r.start, r.end), keyword: true })
    pos = r.end
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), keyword: false })
  return parts
}

/** Whether a message uses the keyword (see {@link findUltrathink}). */
export function hasUltrathink(text: string): boolean {
  return findUltrathink(text).length > 0
}

/** The effort a turn carrying the keyword runs at; providers without the tier clamp it. */
export const ULTRATHINK_EFFORT = 'xhigh' as const

/** What the model is told on a turn carrying the keyword. */
export const ULTRATHINK_NOTE =
  'The user included the keyword "ultrathink" in their message, asking for deeper reasoning on this turn. Reason as thoroughly as the task warrants before acting and before answering.'

/** What the user is told when a turn's reasoning is raised. */
export const ULTRATHINK_NOTICE = 'ultrathink: reasoning raised to the highest level for this turn'

/** The hint a composer shows while the draft carries the keyword and it will raise the turn. */
export const ULTRATHINK_HINT = 'ultrathink: this turn runs at the highest reasoning level'

/** The hint when the chat is already at the level the keyword asks for. */
export const ULTRATHINK_HINT_ALREADY = 'ultrathink: this chat already runs at the highest reasoning level'

/** The hint when the model has no reasoning mode for the keyword to raise. */
export const ULTRATHINK_HINT_NONE = 'ultrathink: this model has no reasoning level to raise'

/**
 * What the keyword does to a turn: `raises` its effort, finds the chat `already` at
 * the top, or does `none` of it because the model cannot reason.
 */
export type UltrathinkEffect = 'raises' | 'already' | 'none'

/**
 * The keyword's effect for a chat at `effort`. `reasons`: the model has a reasoning
 * mode at all. `sendsXhigh`: the provider passes `xhigh` through instead of clamping
 * it to `high` (see providerSendsXhigh), in which case a chat at `high` is already at
 * the most this model can be asked for.
 */
export function ultrathinkEffect(
  effort: ReasoningEffort | undefined,
  reasons: boolean,
  sendsXhigh: boolean
): UltrathinkEffect {
  if (!reasons) return 'none'
  const atTop = effort === ULTRATHINK_EFFORT || (!sendsXhigh && effort === 'high')
  return atTop ? 'already' : 'raises'
}

/** The composer hint for an effect, so the hint never promises more than the turn gets. */
export function ultrathinkHint(effect: UltrathinkEffect): string {
  return effect === 'raises' ? ULTRATHINK_HINT : effect === 'already' ? ULTRATHINK_HINT_ALREADY : ULTRATHINK_HINT_NONE
}

/**
 * Whether the turn a run is starting carries the keyword, and whether the model has
 * already been told. Reads the user message at the end of the log, looking past the
 * notes Houston appends after it, so a turn retried after a failure keeps its boost
 * without being told twice. A log ending in a reply or a tool result is a continued
 * turn with no new message, and carries nothing.
 */
export function ultrathinkAtTail(messages: readonly ChatMessage[]): { on: boolean; noted: boolean } {
  let noted = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') break
    if (m.content.startsWith(SYSTEM_NOTE_PREFIX)) {
      if (m.content.includes(ULTRATHINK_NOTE)) noted = true
      continue
    }
    // A prompt Houston wrote (a command's expansion, a handed-off brief) is not the
    // user's typing: only the command line they typed counts there.
    const typed = m.invokedAs ? (m.invokedAs.typed ?? '') : m.content
    return { on: hasUltrathink(typed), noted }
  }
  return { on: false, noted: false }
}
