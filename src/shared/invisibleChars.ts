/**
 * Invisible characters in a message the user is about to send.
 *
 * Text copied from a web page, an issue, or a chat can carry characters that draw
 * nothing: zero-width spaces and joiners, bidirectional overrides that reorder what
 * is shown without changing what is sent, and Unicode tag characters (U+E0000 block),
 * which mirror ASCII invisibly and are a known way to hide instructions for a model
 * inside text that looks harmless. The user reviewed what they could see, so what
 * goes out should be that.
 *
 * Shared so the terminal and the desktop composer strip exactly the same set.
 *
 * Deliberately kept: a zero-width joiner or non-joiner between two letters (Persian,
 * Devanagari and other scripts need them to shape words), a joiner inside an emoji
 * sequence (family and profession emoji are built from them), and a well-formed emoji
 * tag sequence (the subdivision flags: a black flag, tag letters, a cancel tag).
 */

/** Zero-width joiner: legitimate inside emoji and between letters of some scripts. */
const ZWJ = 0x200d
/** Zero-width non-joiner: legitimate between letters (Persian, Indic scripts). */
const ZWNJ = 0x200c
/** The black flag that starts an emoji tag sequence (England, Scotland, Wales). */
const BLACK_FLAG = 0x1f3f4
/** The tag that ends an emoji tag sequence. */
const CANCEL_TAG = 0xe007f

function isZeroWidth(c: number): boolean {
  return (
    c === 0x200b || // zero-width space
    c === ZWNJ ||
    c === ZWJ ||
    (c >= 0x2060 && c <= 0x2064) || // word joiner, invisible math operators
    c === 0xfeff || // zero-width no-break space (BOM)
    c === 0x180e // Mongolian vowel separator
  )
}

/** Bidirectional embedding/override (U+202A-202E) and isolate (U+2066-2069) controls. */
function isBidiControl(c: number): boolean {
  return (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
}

function isTag(c: number): boolean {
  return c >= 0xe0000 && c <= 0xe007f
}

/** Any candidate at all, for the fast path. */
const INVISIBLE_RE = /[\u200b-\u200d\u2060-\u2064\ufeff\u180e\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u
const LETTER_OR_MARK = /[\p{L}\p{M}]/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/** True for the parts of an emoji a joiner can sit after: the picture, a skin tone, VS16. */
function emojiSide(ch: string | undefined): boolean {
  if (!ch) return false
  const c = ch.codePointAt(0) as number
  return PICTOGRAPHIC.test(ch) || (c >= 0x1f3fb && c <= 0x1f3ff) || c === 0xfe0f
}

/** True when the joiner at `i` sits inside an emoji sequence or between two letters. */
function legitimateJoiner(cps: string[], i: number): boolean {
  const prev = cps[i - 1]
  const next = cps[i + 1]
  if (cps[i].codePointAt(0) === ZWJ && emojiSide(prev) && next !== undefined && PICTOGRAPHIC.test(next)) return true
  return prev !== undefined && next !== undefined && LETTER_OR_MARK.test(prev) && LETTER_OR_MARK.test(next)
}

/**
 * The length (in code points) of a well-formed emoji tag sequence's tags starting at
 * `i` (just after a black flag): tag digits/lowercase letters ending in a cancel tag.
 * Zero when what follows is not one.
 */
function flagTagRun(cps: string[], i: number): number {
  let j = i
  while (j < cps.length) {
    const c = cps[j].codePointAt(0) as number
    if ((c >= 0xe0030 && c <= 0xe0039) || (c >= 0xe0061 && c <= 0xe007a)) j++
    else break
  }
  if (j === i || j >= cps.length || cps[j].codePointAt(0) !== CANCEL_TAG) return 0
  return j - i + 1
}

export interface StrippedText {
  text: string
  /** How many characters were removed. */
  removed: number
}

/** Remove invisible characters from `text`, keeping the legitimate uses described above. */
export function stripInvisible(text: string): StrippedText {
  // Fast path: nothing in the ranges at all (the common case, every message).
  if (!INVISIBLE_RE.test(text)) {
    return { text, removed: 0 }
  }
  const cps = [...text]
  let out = ''
  let removed = 0
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]
    const c = ch.codePointAt(0) as number
    if (c === BLACK_FLAG) {
      const run = flagTagRun(cps, i + 1)
      out += cps.slice(i, i + 1 + run).join('')
      i += run
      continue
    }
    if (isTag(c) || isBidiControl(c)) {
      removed++
      continue
    }
    if (isZeroWidth(c)) {
      if ((c === ZWJ || c === ZWNJ) && legitimateJoiner(cps, i)) {
        out += ch
        continue
      }
      removed++
      continue
    }
    out += ch
  }
  return { text: out, removed }
}

/** The note shown after stripping, e.g. "removed 3 invisible characters". */
export function invisibleNote(removed: number): string {
  return `removed ${removed} invisible character${removed === 1 ? '' : 's'}`
}
