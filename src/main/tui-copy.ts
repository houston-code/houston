import { COMPACTION_SUMMARY_PREFIX, type ChatMessage } from '@shared/agent'

/**
 * `/copy [n]`: the pieces of the chat it can copy. Pure, so what counts as a reply
 * and how code blocks are found is testable without a terminal.
 */

/**
 * The assistant replies in the chat with text in them, oldest first. A message that
 * only called tools has nothing to copy, and the acknowledgement that follows a
 * compaction summary is Houston's, not the model's answer.
 */
export function copyableReplies(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.content.trim()) continue
    const prev = messages[i - 1]
    if (prev?.role === 'user' && prev.content.startsWith(COMPACTION_SUMMARY_PREFIX)) continue
    out.push(m.content)
  }
  return out
}

/** The n-th latest reply (1 = the last), or null when there are fewer than n. */
export function nthLatestReply(messages: readonly ChatMessage[], n: number): string | null {
  const replies = copyableReplies(messages)
  if (!Number.isInteger(n) || n < 1 || n > replies.length) return null
  return replies[replies.length - n]
}

export interface CodeBlock {
  /** The info string's first word (`ts` in ```ts), or empty. */
  lang: string
  /** The block's contents, without the fences. */
  code: string
}

/**
 * The fenced code blocks in a Markdown reply, in order. A fence is three or more
 * backticks or tildes, optionally indented up to three spaces; it closes on a line of
 * the same character at least as long. An unclosed block runs to the end, as
 * Markdown renders it.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const lines = text.split('\n')
  let open: { ch: string; len: number; lang: string; body: string[] } | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      // A backtick fence's info string can't contain a backtick (that is inline code).
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { ch: m[1][0], len: m[1].length, lang: m[2].trim().split(/\s+/)[0] ?? '', body: [] }
      }
      continue
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
    if (close && close[1][0] === open.ch && close[1].length >= open.len) {
      blocks.push({ lang: open.lang, code: open.body.join('\n') })
      open = null
      continue
    }
    open.body.push(line)
  }
  if (open) blocks.push({ lang: open.lang, code: open.body.join('\n') })
  return blocks
}

/** A code block's label in the picker: its first non-blank line. */
export function codeBlockLabel(block: CodeBlock, max = 60): string {
  const first = block.code.split('\n').find((l) => l.trim()) ?? '(empty)'
  const cps = [...first.trim()]
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : cps.join('')
}

/** "1,234 chars, 40 lines" for what was copied. */
export function describeCopied(text: string): string {
  const chars = [...text].length
  const lines = text === '' ? 0 : text.split('\n').length
  return `${chars.toLocaleString('en-US')} char${chars === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'}`
}
