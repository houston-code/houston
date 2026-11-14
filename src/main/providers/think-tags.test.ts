import { describe, expect, it } from 'vitest'
import { LeadingThinkSplitter, stripLeadingThink } from './think-tags'

/** Feed `chunks` through a splitter and collect what it routed each way. */
function split(chunks: string[]): { reasoning: string; content: string } {
  const s = new LeadingThinkSplitter()
  let reasoning = ''
  let content = ''
  for (const c of [...chunks.map((c) => s.push(c)), s.flush()]) {
    reasoning += c.reasoning
    content += c.content
  }
  return { reasoning, content }
}

describe('LeadingThinkSplitter', () => {
  it('routes a leading think block to reasoning and the rest to content', () => {
    expect(split(['<think>\nweigh it\n</think>\n\nThe answer.'])).toEqual({ reasoning: 'weigh it\n', content: 'The answer.' })
  })

  it('handles tags split across chunks', () => {
    expect(split(['  <th', 'ink>a', 'b</th', 'ink>', '\n', 'done'])).toEqual({ reasoning: 'ab', content: 'done' })
  })

  it('leaves a reply that does not open with the tag alone, even when it mentions it', () => {
    expect(split(['Use ', '<think> tags like this.'])).toEqual({ reasoning: '', content: 'Use <think> tags like this.' })
    expect(split(['<thing>x</thing>'])).toEqual({ reasoning: '', content: '<thing>x</thing>' })
  })

  it('treats an unterminated block as reasoning, and a too-short reply as content', () => {
    expect(split(['<think>still going'])).toEqual({ reasoning: 'still going', content: '' })
    expect(split(['<th'])).toEqual({ reasoning: '', content: '<th' })
  })

  it('does not hold the reasoning back more than a possible closing tag', () => {
    const s = new LeadingThinkSplitter()
    expect(s.push('<think>abc</')).toEqual({ reasoning: 'abc', content: '' })
  })

  it('strips a leading block from whole text', () => {
    expect(stripLeadingThink('<think>x</think>{"a":1}')).toBe('{"a":1}')
    expect(stripLeadingThink('plain')).toBe('plain')
  })
})
