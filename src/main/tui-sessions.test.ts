import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, type ChatMessage } from '@shared/agent'
import type { PermissionRule } from '@shared/types'
import { makePainter } from './tui'
import {
  chatToJson,
  chatToMarkdown,
  defaultExportName,
  EXPORT_TOOL_LINES,
  parseExportArgs,
  renderPermissionRules,
  renderRecap,
  sessionPreviewLines,
  writeExportFile
} from './tui-sessions'

const paint = makePainter(false)

describe('sessionPreviewLines', () => {
  const entry = { title: 'Auth \x1b[2Jrefactor', updatedAt: 0 }
  const base = { width: 40, paint, when: '2h ago' }

  it('shows the title, when, count, first prompt and the start of the last reply', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'one\ntwo\nthree\nfour' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'later question' },
      { role: 'assistant', content: `last reply ${'x'.repeat(80)}` }
    ]
    const lines = sessionPreviewLines(entry, msgs, { ...base, folder: '~/app' })
    expect(lines.slice(1)).toEqual([
      '  Auth [2Jrefactor',
      '  updated 2h ago · 4 messages · ~/app',
      '  you ›',
      '    one',
      '    two',
      '    three …',
      '  houston ›',
      `    last reply ${'x'.repeat(23)}…`
    ])
    for (const l of lines) expect([...l].length).toBeLessThan(40)
  })

  it('skips system notes for the first prompt, and handles empty and unreadable chats', () => {
    expect(sessionPreviewLines(entry, [], base).at(-1)).toBe('  (no messages yet)')
    expect(sessionPreviewLines(entry, null, base).at(-1)).toBe("  couldn't read this chat")
    const compacted: ChatMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX} summary` },
      { role: 'user', content: 'real ask' }
    ]
    const lines = sessionPreviewLines(entry, compacted, { ...base, lines: 2 })
    expect(lines).toContain('    real ask')
    expect(lines.join('\n')).not.toContain('summary')
    expect(lines).toContain('  updated 2h ago · 2 messages')
  })
})

const chat: ChatMessage[] = [
  { role: 'user', content: 'what does greet do?' },
  { role: 'assistant', content: 'It greets.\nWith a fallback.' },
  { role: 'user', content: 'rename the fallback' },
  {
    role: 'assistant',
    content: 'Looking.',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/greet.js' } }]
  },
  { role: 'tool', content: 'line 1\nline 2', toolCallId: 'c1', toolName: 'read_file' },
  { role: 'assistant', content: 'Done: it says friend now.' }
]

describe('renderRecap', () => {
  it('shows each message you sent with the reply that answered it', () => {
    const out = renderRecap(chat, paint)
    expect(out.split('\n')).toEqual([
      '· where you left off:',
      '  you › what does greet do?',
      '  houston › It greets.',
      '            With a fallback.',
      '  you › rename the fallback',
      '  houston › Done: it says friend now.'
    ])
  })

  it('keeps only the last few exchanges and says how many there were', () => {
    const many: ChatMessage[] = Array.from({ length: 5 }, (_, i) => [
      { role: 'user' as const, content: `q${i}` },
      { role: 'assistant' as const, content: `a${i}` }
    ]).flat()
    const out = renderRecap(many, paint)
    expect(out).toContain('the last 3 of 5 messages')
    expect(out).not.toContain('q1')
    expect(out).toContain('q4')
  })

  it('shows the command for an invoked turn, marks a missing reply, and skips summaries', () => {
    const out = renderRecap(
      [
        { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\nearlier stuff` },
        {
          role: 'user',
          content: 'Review my current uncommitted changes…',
          invokedAs: { kind: 'command', label: '/review', typed: '/review' }
        }
      ],
      paint
    )
    expect(out).toContain('you › /review')
    expect(out).toContain('(no reply)')
    expect(out).not.toContain('earlier stuff')
  })

  it('clips long messages and strips control characters', () => {
    const out = renderRecap([{ role: 'user', content: `a\x1b]52;c;x\x07b\n2\n3\n4` }], paint)
    expect(out).not.toContain('\x1b')
    expect(out).toContain('you › a]52;c;xb')
    expect(out).toContain('2 …')
    expect(out).not.toContain('\n       3')
  })

  it('is empty for a chat with nothing to show', () => {
    expect(renderRecap([], paint)).toBe('')
  })

  it('shows each earlier run-end notice under its exchange, leaving the latest to the closing line', () => {
    const out = renderRecap(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'partial', runEnds: [{ reason: 'aborted', at: '2026-11-13T10:00:00Z' }] },
        { role: 'user', content: 'q2' },
        {
          role: 'assistant',
          content: 'more',
          unanswered: [{ reason: 'aborted', at: '2026-11-13T10:01:00Z' }],
          runEnds: [
            { reason: 'limit', limit: 'max-steps', at: '2026-11-13T10:01:30Z' },
            { reason: 'error', message: 'boom\x1b[2J', at: '2026-11-13T10:02:00Z' }
          ]
        },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'cut', runEnds: [{ reason: 'aborted', at: '2026-11-13T10:03:00Z' }] }
      ],
      paint
    )
    const lines = out.split('\n')
    expect(lines.indexOf('  · Stopped.')).toBe(lines.indexOf('  houston › partial') + 1)
    const more = lines.indexOf('  houston › more')
    // Oldest first: the older unanswered record, then the current ones.
    expect(lines[more + 1]).toBe('  · Stopped.')
    expect(lines[more + 2]).toMatch(/^ {2}· Reached the step limit/)
    expect(lines[more + 3]).toBe('  · boom[2J')
    // The last exchange's Stop is the latest run's ending: runEndNotice says it.
    expect(lines.at(-1)).toBe('  houston › cut')
  })
})

const meta = { id: 'conv-1', title: 'Greet fallback', providerId: 'anthropic', model: 'claude', at: new Date('2026-11-13T10:00:00Z') }

describe('chatToMarkdown', () => {
  it('writes the title, the facts, both sides, tool calls and tool output', () => {
    const md = chatToMarkdown(chat, meta)
    expect(md.startsWith('# Greet fallback\n')).toBe(true)
    expect(md).toContain('model anthropic / claude, session conv-1')
    expect(md).toContain('## You\n\nwhat does greet do?')
    expect(md).toContain('## Houston\n\nDone: it says friend now.')
    expect(md).toContain('- **read_file** `{"path":"src/greet.js"}`')
    expect(md).toContain('read_file output:\n\n```\nline 1\nline 2\n```')
  })

  it('fences tool output so backticks inside cannot close the block, and cuts long output', () => {
    const long = Array.from({ length: EXPORT_TOOL_LINES + 5 }, (_, i) => `l${i}`).join('\n')
    const md = chatToMarkdown(
      [
        { role: 'tool', content: 'has ``` inside', toolName: 'run_shell' },
        { role: 'tool', content: long, toolName: 'run_shell' }
      ],
      meta
    )
    expect(md).toContain('````\nhas ``` inside\n````')
    expect(md).toContain('_(5 more lines)_')
    expect(md).not.toContain(`l${EXPORT_TOOL_LINES + 1}`)
  })
})

describe('chatToJson', () => {
  it('keeps every message as saved, with the facts', () => {
    const parsed = JSON.parse(chatToJson(chat, meta))
    expect(parsed).toMatchObject({ format: 'houston-chat', version: 1, id: 'conv-1', title: 'Greet fallback' })
    expect(parsed.exportedAt).toBe('2026-11-13T10:00:00.000Z')
    expect(parsed.messages).toEqual(chat)
  })
})

describe('export arguments and names', () => {
  it('reads the format word, else the extension', () => {
    expect(parseExportArgs('')).toEqual({ format: 'md' })
    expect(parseExportArgs('json')).toEqual({ format: 'json' })
    expect(parseExportArgs('markdown notes/chat.md')).toEqual({ format: 'md', path: 'notes/chat.md' })
    expect(parseExportArgs('out.json')).toEqual({ format: 'json', path: 'out.json' })
    expect(parseExportArgs('json my chat.txt')).toEqual({ format: 'json', path: 'my chat.txt' })
    expect(parseExportArgs('jsonish.md')).toEqual({ format: 'md', path: 'jsonish.md' })
  })

  it('names a default file from the title and time', () => {
    const at = new Date(2026, 10, 13, 9, 5)
    expect(defaultExportName('Fix the / login bug!', at, 'md')).toBe('houston-fix-the-login-bug-20261113-0905.md')
    expect(defaultExportName('???', at, 'json')).toBe('houston-chat-20261113-0905.json')
  })
})

describe('writeExportFile', () => {
  it('writes relative to the folder, owner-only, and never over an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-export-'))
    try {
      const full = writeExportFile(dir, 'chat.md', 'hello')
      expect(full).toBe(join(dir, 'chat.md'))
      expect(readFileSync(full, 'utf8')).toBe('hello')
      if (process.platform !== 'win32') expect(statSync(full).mode & 0o777).toBe(0o600)
      writeFileSync(join(dir, 'taken.md'), 'mine')
      expect(() => writeExportFile(dir, 'taken.md', 'x')).toThrow(/already exists/)
      expect(readFileSync(join(dir, 'taken.md'), 'utf8')).toBe('mine')
      expect(() => writeExportFile(dir, 'missing/dir/x.md', 'x')).toThrow(/no such folder/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderPermissionRules', () => {
  it('numbers each rule with its action, tool, subject and where it came from', () => {
    const rules: PermissionRule[] = [
      { action: 'allow', tool: 'run_shell', match: 'git status', exact: true, source: 'prompt', addedAt: 1 },
      { action: 'deny', tool: '*', match: '/etc/**' }
    ]
    const out = renderPermissionRules(rules, paint, 3 * 86_400_000 + 1)
    expect(out).toContain(' 1. allow run_shell  git status  (exact, from a prompt, 3 days ago)')
    expect(out).toContain(' 2. deny  *          /etc/**')
    expect(out).toContain('/permissions remove <n>')
  })

  it('says how a rule gets saved when there are none', () => {
    expect(renderPermissionRules([], paint, 0)).toContain('no saved permission rules')
  })
})
