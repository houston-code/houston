import { describe, it, expect } from 'vitest'
import { ControlTagScrubber } from './control-tag-scrubber'

/** Feed chunks through a fresh scrubber and return the full cleaned output. */
function run(chunks: string[]): string {
  const s = new ControlTagScrubber()
  let out = ''
  for (const c of chunks) out += s.push(c)
  out += s.flush()
  return out
}

describe('ControlTagScrubber', () => {
  it('passes ordinary prose through unchanged', () => {
    expect(run(['Here are the gaps ', 'in the analysis.'])).toBe('Here are the gaps in the analysis.')
  })

  it('drops a <tool_response> block and its contents', () => {
    expect(run(['Done. <tool_response>{"ok":true}</tool_response> Next.'])).toBe('Done.  Next.')
  })

  it('drops a <tool_call> block leaked into text', () => {
    expect(run(['<tool_call>{"name":"read_file","arguments":{}}</tool_call>'])).toBe('')
  })

  it('drops ChatML special tokens', () => {
    expect(run(['a <|im_start|>b<|im_end|> c'])).toBe('a b c')
  })

  it('handles a control tag split across chunks', () => {
    // Open tag, contents, and close tag each arrive in pieces.
    expect(run(['result: <tool_re', 'sponse>{"x":', '1}</tool_re', 'sponse> ok'])).toBe('result:  ok')
    expect(run(['a <|im', '_end|> b'])).toBe('a  b')
  })

  it('preserves angle brackets that are not control tags', () => {
    expect(run(['x < y'])).toBe('x < y')
    expect(run(['<div>hi</div>'])).toBe('<div>hi</div>')
    expect(run(['use the ', '<thing> ', 'here'])).toBe('use the <thing> here')
  })

  it('holds a possible partial tag, then emits it on flush if it never completes', () => {
    const s = new ControlTagScrubber()
    // `<tool` looks like the start of `<tool_call>` — held, not emitted yet.
    expect(s.push('text <tool')).toBe('text ')
    // Stream ends without completing the tag — surface the leftover rather than eat it.
    expect(s.flush()).toBe('<tool')
  })

  it('drops an unterminated block that runs to end of stream', () => {
    expect(run(['keep <tool_response>never closed...'])).toBe('keep ')
  })

  it('drops multiple blocks in one stream', () => {
    expect(run(['<tool_response>a</tool_response>mid<tool_response>b</tool_response>end'])).toBe('midend')
  })
})
