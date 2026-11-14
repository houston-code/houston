/**
 * Splits a leading `<think>…</think>` block off a streamed reply. Reasoning models
 * served through OpenAI-compatible hosts (Qwen3, DeepSeek-R1 and their distills on
 * Ollama, vLLM, llama.cpp and LM Studio) often write their reasoning into the content
 * stream inside these tags instead of a separate reasoning field, so it showed up as
 * the answer, and a tool call written after it was never recovered.
 *
 * Only a block that opens the reply counts: `<think>` later in a reply is the model
 * talking about the tag, and stays text. Tags split across chunks are handled; an
 * unterminated block is all reasoning.
 */

const OPEN = '<think>'
const CLOSE = '</think>'

export interface ThinkSplit {
  reasoning: string
  content: string
}

export class LeadingThinkSplitter {
  private state: 'lead' | 'think' | 'body' = 'lead'
  private buf = ''
  /** Drop the whitespace between `</think>` and the answer. */
  private trimBody = false

  push(text: string): ThinkSplit {
    const out: ThinkSplit = { reasoning: '', content: '' }
    if (!text) return out
    if (this.state === 'body') {
      out.content = this.body(text)
      return out
    }
    this.buf += text
    if (this.state === 'lead') {
      const lead = this.buf.trimStart()
      if (!lead) return out
      if (lead.startsWith(OPEN)) {
        this.state = 'think'
        // The newline a model puts right after the tag isn't part of its reasoning.
        this.buf = lead.slice(OPEN.length).replace(/^\r?\n/, '')
      } else if (OPEN.startsWith(lead)) {
        return out // A partial tag: wait for more.
      } else {
        this.state = 'body'
        out.content = this.buf
        this.buf = ''
        return out
      }
    }
    // state === 'think'
    const end = this.buf.indexOf(CLOSE)
    if (end >= 0) {
      out.reasoning = this.buf.slice(0, end)
      const rest = this.buf.slice(end + CLOSE.length)
      this.buf = ''
      this.state = 'body'
      this.trimBody = true
      out.content = this.body(rest)
      return out
    }
    // Hold back a tail that could be the start of `</think>`.
    const keep = partialSuffix(this.buf, CLOSE)
    out.reasoning = this.buf.slice(0, this.buf.length - keep)
    this.buf = this.buf.slice(this.buf.length - keep)
    return out
  }

  /** Whatever is still held at the end of the stream. */
  flush(): ThinkSplit {
    const held = this.buf
    this.buf = ''
    if (this.state === 'think') return { reasoning: held, content: '' }
    if (this.state === 'lead') {
      this.state = 'body'
      return { reasoning: '', content: held }
    }
    return { reasoning: '', content: '' }
  }

  private body(text: string): string {
    if (!this.trimBody) return text
    const trimmed = text.trimStart()
    if (trimmed) this.trimBody = false
    return trimmed
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n
  }
  return 0
}

/** `text` without a leading `<think>…</think>` block (or an unterminated one). */
export function stripLeadingThink(text: string): string {
  const s = new LeadingThinkSplitter()
  const a = s.push(text)
  const b = s.flush()
  return a.content + b.content
}
