import { describe, it, expect } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type ChatMessage } from '@shared/agent'
import { codeBlockLabel, copyableReplies, describeCopied, extractCodeBlocks, nthLatestReply } from './tui-copy'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const bot = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content, ...extra })

describe('copyableReplies', () => {
  it('keeps assistant messages with text, oldest first', () => {
    const msgs: ChatMessage[] = [
      user('hi'),
      bot('', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] }),
      { role: 'tool', content: 'file text', toolCallId: 'c1' },
      bot('first answer'),
      user('again'),
      bot('   '),
      bot('second answer')
    ]
    expect(copyableReplies(msgs)).toEqual(['first answer', 'second answer'])
  })

  it("skips the acknowledgement after a compaction summary (it is Houston's, not a reply)", () => {
    const msgs: ChatMessage[] = [user(`${COMPACTION_SUMMARY_PREFIX}\n\n- stuff`), bot('Understood.'), user('go'), bot('real')]
    expect(copyableReplies(msgs)).toEqual(['real'])
  })
})

describe('nthLatestReply', () => {
  const msgs = [user('a'), bot('one'), user('b'), bot('two'), user('c'), bot('three')]
  it('counts back from the last reply', () => {
    expect(nthLatestReply(msgs, 1)).toBe('three')
    expect(nthLatestReply(msgs, 3)).toBe('one')
  })
  it('is null past the first reply or for a bad index', () => {
    expect(nthLatestReply(msgs, 4)).toBeNull()
    expect(nthLatestReply(msgs, 0)).toBeNull()
    expect(nthLatestReply([], 1)).toBeNull()
  })
})

describe('extractCodeBlocks', () => {
  it('finds backtick and tilde fences with their language', () => {
    const text = 'Run this:\n```bash\nnpm test\nnpm run lint\n```\nthen\n~~~\nplain\n~~~\n'
    expect(extractCodeBlocks(text)).toEqual([
      { lang: 'bash', code: 'npm test\nnpm run lint' },
      { lang: '', code: 'plain' }
    ])
  })

  it('closes only on a fence of the same character at least as long', () => {
    const text = '````md\n```js\ninner\n```\n````'
    expect(extractCodeBlocks(text)).toEqual([{ lang: 'md', code: '```js\ninner\n```' }])
  })

  it('runs an unclosed block to the end, and ignores inline backticks', () => {
    expect(extractCodeBlocks('use ```x``` inline')).toEqual([])
    expect(extractCodeBlocks('```py\nprint(1)\n')).toEqual([{ lang: 'py', code: 'print(1)\n' }])
  })

  it('handles CRLF and indented fences', () => {
    expect(extractCodeBlocks('  ```ts\r\nconst a = 1\r\n  ```\r\n')).toEqual([{ lang: 'ts', code: 'const a = 1' }])
  })

  it('finds nothing in prose', () => {
    expect(extractCodeBlocks('no code here')).toEqual([])
  })
})

describe('codeBlockLabel / describeCopied', () => {
  it('labels a block by its first non-blank line, cut to fit', () => {
    expect(codeBlockLabel({ lang: '', code: '\n  const x = 1\nmore' })).toBe('const x = 1')
    expect(codeBlockLabel({ lang: '', code: '' })).toBe('(empty)')
    expect(codeBlockLabel({ lang: '', code: 'x'.repeat(80) }, 10)).toBe(`${'x'.repeat(9)}…`)
  })
  it('counts characters and lines', () => {
    expect(describeCopied('a')).toBe('1 char, 1 line')
    expect(describeCopied('ab\ncd')).toBe('5 chars, 2 lines')
    expect(describeCopied('x'.repeat(1234))).toBe('1,234 chars, 1 line')
    expect(describeCopied('')).toBe('0 chars, 0 lines')
  })
})
