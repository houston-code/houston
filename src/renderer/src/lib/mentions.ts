/** Parsing for the composer's `@`-file-mention autocomplete. Pure + tested. */

export interface MentionToken {
  /** Index of the `@` in the text. */
  start: number
  /** Text typed after the `@` (the file-search query). */
  query: string
}

/**
 * Detect a `@token` being typed immediately before the cursor. The `@` must be at
 * the start of the input or follow whitespace (so `user@host` doesn't trigger),
 * and the token runs to the cursor with no whitespace. Returns null when the
 * cursor isn't inside such a token.
 */
export function mentionBeforeCursor(textBeforeCursor: string): MentionToken | null {
  const m = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/)
  if (!m) return null
  const query = m[1]
  return { start: textBeforeCursor.length - query.length - 1, query }
}

/** Replace the active mention token with `@<path> ` and report the new caret. */
export function applyMention(
  text: string,
  mention: MentionToken,
  path: string
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  return {
    text: `${text.slice(0, mention.start)}@${path} ${text.slice(end)}`,
    caret: mention.start + path.length + 2
  }
}
