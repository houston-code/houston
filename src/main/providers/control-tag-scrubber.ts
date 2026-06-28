/**
 * Streaming scrubber for ChatML / Hermes control tags that local models (qwen via
 * Ollama, etc.) sometimes emit as literal text in their *visible* output:
 *
 *   - `<tool_call>…</tool_call>`     — a tool request the model wrote as text
 *   - `<tool_response>…</tool_response>` — the tool-result wrapper, echoed back
 *   - `<|im_start|>` / `<|im_end|>` / any `<|…|>` — ChatML role/special tokens
 *
 * These are protocol artifacts, never user-facing prose, so they're dropped along
 * with the block contents. (Whole-turn `<tool_call>` payloads are recovered and
 * executed upstream in tool-call-fallback.ts; what reaches here is leakage that
 * couldn't be turned into a real call — e.g. a stray `<tool_response>` echo.)
 *
 * Stateful and streaming-safe: tags split across chunks are held back until they
 * complete. Feed every text delta through `push`, then `flush` once at end.
 */

const BLOCK_TAGS = ['tool_call', 'tool_response'] as const
type BlockTag = (typeof BLOCK_TAGS)[number]

const STANDALONE = /<\|[^|]*\|>/ // a complete ChatML special token, e.g. <|im_end|>

interface Control {
  start: number
  end: number
  kind: 'open' | 'standalone'
  tag?: BlockTag
}

/** Earliest complete control construct in `s`, or null if none is complete yet. */
function findNextControl(s: string): Control | null {
  let best: Control | null = null
  for (const tag of BLOCK_TAGS) {
    const open = `<${tag}>`
    const i = s.indexOf(open)
    if (i !== -1 && (!best || i < best.start)) {
      best = { start: i, end: i + open.length, kind: 'open', tag }
    }
  }
  const m = STANDALONE.exec(s)
  if (m && (!best || m.index < best.start)) {
    best = { start: m.index, end: m.index + m[0].length, kind: 'standalone' }
  }
  return best
}

/**
 * Length of the suffix of `s` to hold back because it might be the start of a
 * control construct completed by a later chunk: a strict prefix of an opening
 * block tag, or an unterminated `<|…` token. 0 when the trailing `<` (if any) is
 * plainly not a control tag (e.g. `<div>`), so it's safe to emit.
 */
function partialLeadLen(s: string): number {
  const lt = s.lastIndexOf('<')
  if (lt === -1) return 0
  const tail = s.slice(lt)
  for (const tag of BLOCK_TAGS) {
    const open = `<${tag}>`
    if (tail.length < open.length && open.startsWith(tail)) return tail.length
  }
  // Unterminated ChatML token: `<|`, `<|im_end`, `<|im_end|` (no closing `|>` yet).
  if (/^<\|[^|]*\|?$/.test(tail)) return tail.length
  return 0
}

export class ControlTagScrubber {
  private buf = ''
  /** When inside a dropped block, the closing tag we're scanning for. */
  private dropUntil: string | null = null

  push(text: string): string {
    this.buf += text
    return this.drain(false)
  }

  flush(): string {
    return this.drain(true)
  }

  private drain(final: boolean): string {
    let out = ''
    for (;;) {
      if (this.dropUntil) {
        const i = this.buf.indexOf(this.dropUntil)
        if (i === -1) {
          // Closing tag not here yet — drop everything, keeping only a possible
          // partial of the closing tag at the end so a split close still matches.
          this.buf = final ? '' : tailPartialOf(this.buf, this.dropUntil)
          return out
        }
        this.buf = this.buf.slice(i + this.dropUntil.length)
        this.dropUntil = null
        continue
      }

      const ctrl = findNextControl(this.buf)
      if (!ctrl) {
        if (final) {
          out += this.buf
          this.buf = ''
        } else {
          const safe = this.buf.length - partialLeadLen(this.buf)
          out += this.buf.slice(0, safe)
          this.buf = this.buf.slice(safe)
        }
        return out
      }

      out += this.buf.slice(0, ctrl.start)
      if (ctrl.kind === 'open') {
        this.dropUntil = `</${ctrl.tag}>`
      }
      this.buf = this.buf.slice(ctrl.end)
    }
  }
}

/** Longest suffix of `s` that is a strict prefix of `token` (for split close tags). */
function tailPartialOf(s: string, token: string): string {
  const max = Math.min(s.length, token.length - 1)
  for (let n = max; n > 0; n--) {
    if (token.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
  }
  return ''
}
