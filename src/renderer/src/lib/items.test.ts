import { describe, expect, it } from 'vitest'
import {
  COMPACTION_SUMMARY_PREFIX,
  SYSTEM_NOTE_PREFIX,
  type AgentEvent,
  type ChatMessage,
  type ReviewFinding
} from '@shared/agent'
import {
  itemsFromMessages,
  lastUserText,
  reduceEvent,
  type DisplayItem,
  type NoticeItem,
  type PlanItem,
  type QuestionItem,
  type ToolItem,
  type UserItem
} from './items'
import { describeTool } from './toolDisplay'

describe('itemsFromMessages', () => {
  it('flags the compaction summary turn so it renders as markdown', () => {
    const summary = '- did a thing\n- learned a fact'
    const messages: ChatMessage[] = [
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}` },
      { role: 'assistant', content: 'Understood.' }
    ]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBe(true)
  })

  it('leaves ordinary user turns unflagged', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '- a normal message with a dash' }]
    const items = itemsFromMessages(messages)
    const user = items.find((i): i is UserItem => i.kind === 'user')
    expect(user?.isSummary).toBeUndefined()
  })

  it('renders an injected system note as an info notice, not a user bubble', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'add a file menu' },
      { role: 'user', content: `${SYSTEM_NOTE_PREFIX} You have gone several turns without a change.` },
      { role: 'assistant', content: 'ok' }
    ]
    const items = itemsFromMessages(messages)
    // Exactly one user bubble (the real turn); the note is a notice with the prefix stripped.
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1)
    const notice = items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.tone).toBe('info')
    expect(notice?.text).toBe('You have gone several turns without a change.')
    expect(notice?.text).not.toContain(SYSTEM_NOTE_PREFIX)
    // The note must not become the "last user message" (Esc-Esc recall, etc.).
    expect(lastUserText(items)).toBe('add a file menu')
  })

  it('rebuilds an answered ask_user call as a question card', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'q1',
            name: 'ask_user',
            arguments: { question: 'Which database?', options: ['SQLite', 'Postgres'] }
          }
        ]
      },
      { role: 'tool', toolCallId: 'q1', toolName: 'ask_user', content: 'Postgres' }
    ]
    const items = itemsFromMessages(messages)
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q).toMatchObject({
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      answer: 'Postgres'
    })
    // It must NOT also appear as a generic tool row.
    expect(items.some((i) => i.kind === 'tool' && i.id === 'q1')).toBe(false)
  })
})

describe('present_plan', () => {
  const planReady: AgentEvent = {
    runId: 'r',
    type: 'plan_ready',
    callId: 'p1',
    plan: { title: 'Do the thing', steps: ['Step one', 'Step two'], files: ['a.ts'] }
  }

  it('turns plan_ready into a pending plan item', () => {
    const items = reduceEvent([], planReady)
    const plan = items.find((i): i is PlanItem => i.kind === 'plan')
    expect(plan).toMatchObject({ id: 'p1', status: 'pending' })
    expect(plan?.plan.title).toBe('Do the thing')
    expect(plan?.plan.steps).toEqual(['Step one', 'Step two'])
  })

  it('supersedes a prior pending plan when a revised plan arrives', () => {
    let items = reduceEvent([], planReady)
    items = reduceEvent(items, {
      runId: 'r',
      type: 'plan_ready',
      callId: 'p2',
      plan: { title: 'Revised', steps: ['New step'] }
    })
    const plans = items.filter((i): i is PlanItem => i.kind === 'plan')
    expect(plans).toHaveLength(2)
    expect(plans.find((p) => p.id === 'p1')?.status).toBe('superseded')
    expect(plans.find((p) => p.id === 'p2')?.status).toBe('pending')
  })

  it('does not render present_plan as a tool row on tool_start', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'p1',
      name: 'present_plan',
      args: {}
    })
    expect(items).toHaveLength(0)
  })

  it('folds an accept result into the plan marker status', () => {
    let items = reduceEvent([], planReady)
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'p1',
      name: 'present_plan',
      ok: true,
      output: 'The user ACCEPTED the plan and switched off Plan mode.'
    })
    expect(items.find((i): i is PlanItem => i.kind === 'plan')?.status).toBe('accepted')
    // It must NOT also appear as a generic tool row.
    expect(items.some((i) => i.kind === 'tool' && i.id === 'p1')).toBe(false)
  })

  it('folds a reject result into the plan marker status', () => {
    let items = reduceEvent([], planReady)
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'p1',
      name: 'present_plan',
      ok: true,
      output: 'The user REJECTED this plan.'
    })
    expect(items.find((i): i is PlanItem => i.kind === 'plan')?.status).toBe('rejected')
  })

  it('carries the freeform `plan` markdown as the plan body on reload', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'p1',
            name: 'present_plan',
            arguments: { title: 'Ship it', plan: '## Plan\n\nDo **everything**.', files: ['x.ts'] }
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'p1',
        toolName: 'present_plan',
        content: 'The user ACCEPTED the plan and switched off Plan mode.'
      }
    ]
    const plan = itemsFromMessages(messages).find((i): i is PlanItem => i.kind === 'plan')
    expect(plan).toMatchObject({ id: 'p1', status: 'accepted' })
    expect(plan?.plan).toMatchObject({ title: 'Ship it', body: '## Plan\n\nDo **everything**.', files: ['x.ts'] })
    expect(plan?.plan.steps).toBeUndefined()
  })

  it('rebuilds a legacy (steps-based) present_plan call as a plan marker on reload', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'p1',
            name: 'present_plan',
            arguments: { title: 'Ship it', steps: ['One'], files: ['x.ts'] }
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'p1',
        toolName: 'present_plan',
        content: 'The user ACCEPTED the plan and switched off Plan mode.'
      }
    ]
    const items = itemsFromMessages(messages)
    const plan = items.find((i): i is PlanItem => i.kind === 'plan')
    expect(plan).toMatchObject({ id: 'p1', status: 'accepted' })
    expect(plan?.plan).toMatchObject({ title: 'Ship it', steps: ['One'], files: ['x.ts'] })
    expect(items.some((i) => i.kind === 'tool' && i.id === 'p1')).toBe(false)
  })
})

describe('reduceEvent — ask_user', () => {
  const question: AgentEvent = {
    runId: 'r',
    type: 'tool_question',
    callId: 'q1',
    question: 'Pick one',
    options: [{ label: 'A' }, { label: 'B', description: 'the second' }],
    multiSelect: true
  }

  it('turns tool_question into a question item', () => {
    const items = reduceEvent([], question)
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q).toMatchObject({ id: 'q1', question: 'Pick one', multiSelect: true })
    expect(q?.options).toHaveLength(2)
  })

  it('does not render ask_user as a tool row on tool_start', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'q1',
      name: 'ask_user',
      args: {}
    })
    expect(items).toHaveLength(0)
  })

  it('folds the ask_user result into the question card as the answer', () => {
    let items = reduceEvent([], question)
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'q1',
      name: 'ask_user',
      ok: true,
      output: 'A'
    })
    const q = items.find((i): i is QuestionItem => i.kind === 'question')
    expect(q?.answer).toBe('A')
  })
})

describe('reduceEvent — prompt replay on re-adopt (upsert by callId)', () => {
  it('flips an existing tool row to awaiting-approval instead of duplicating it', () => {
    // A run parked on an approval: the call is first rebuilt from the persisted log
    // as a tool row, then its approval prompt is replayed when re-adopted.
    const fromLog = itemsFromMessages([
      {
        role: 'assistant',
        content: 'writing',
        toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.txt' } }]
      }
    ])
    const items = reduceEvent(fromLog, {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 'write a.txt',
      kind: 'write'
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && i.id === 'w1')
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('awaiting-approval')
    expect(tools[0].summary).toBe('write a.txt')
    // An approval payload without args must not wipe the args already on the row.
    expect(tools[0].args).toEqual({ path: 'a.txt' })
  })

  it('carries a write preview from tool_approval onto the row', () => {
    const preview = [{ path: 'a.txt', diff: [{ type: 'add' as const, text: 'hi' }] }]
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 's',
      kind: 'write',
      preview
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools[0].preview).toEqual(preview)
  })

  it('carries a preview from tool_start, so an auto-approved write still gets a diff', () => {
    // An auto-approved write never shows an approval card, so tool_start is the only
    // place its preview can arrive.
    const preview = [{ path: 'a.txt', diff: [{ type: 'add' as const, text: 'hi' }] }]
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'w1',
      name: 'write_file',
      args: { path: 'a.txt' },
      kind: 'write',
      preview
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools[0].preview).toEqual(preview)
  })

  it('does not wipe an existing preview when a later event carries none', () => {
    const preview = [{ path: 'a.txt', diff: [{ type: 'add' as const, text: 'hi' }] }]
    let items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 's',
      kind: 'write',
      preview
    })
    // tool_start follows approval; the diff must survive it, since the file has now
    // changed on disk and the "before" can never be recovered.
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_start',
      callId: 'w1',
      name: 'write_file',
      args: { path: 'a.txt' },
      kind: 'write'
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools[0].preview).toEqual(preview)
    expect(tools[0].status).toBe('running')
  })

  it('appends an approval row when no row exists yet (the normal live first emit)', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 's',
      kind: 'write'
    })
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('awaiting-approval')
  })

  it('carries args on the approval row so the card shows the command being approved', () => {
    // Regression: the approval prompt used to render its verb with a blank target
    // because args only arrived on tool_start (emitted after approval). The event now
    // carries args, so describeTool can show the real command at approval time.
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'c1',
      name: 'run_shell',
      summary: 'npm test',
      args: { command: 'npm test' },
      kind: 'shell'
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool')!
    expect(tool.args).toEqual({ command: 'npm test' })
    expect(describeTool(tool)).toEqual({ verb: 'Run', target: 'npm test', mono: true })
  })

  it('updates an existing question card instead of duplicating it', () => {
    const fromLog = itemsFromMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'q1', name: 'ask_user', arguments: { question: 'Which?', options: ['A', 'B'] } }
        ]
      }
    ])
    const items = reduceEvent(fromLog, {
      runId: 'r',
      type: 'tool_question',
      callId: 'q1',
      question: 'Which?',
      options: [{ label: 'A' }, { label: 'B' }]
    })
    const questions = items.filter((i): i is QuestionItem => i.kind === 'question' && i.id === 'q1')
    expect(questions).toHaveLength(1)
  })
})

describe('tool_start kind tagging', () => {
  it('tags an auto-approved tool row with its kind (no approval prompt needed)', () => {
    // An auto-approved write emits only tool_start (no tool_approval), so the kind has
    // to ride on tool_start for the row to be recognizable as a write.
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'w1',
      name: 'write_file',
      args: { path: 'a.ts' },
      kind: 'write'
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool' && i.id === 'w1')
    expect(tool?.toolKind).toBe('write')
  })

  it('preserves a kind already set by an approval prompt when tool_start follows', () => {
    let items = reduceEvent([], {
      runId: 'r',
      type: 'tool_approval',
      callId: 'w1',
      name: 'write_file',
      summary: 'write a.ts',
      kind: 'write'
    })
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_start',
      callId: 'w1',
      name: 'write_file',
      args: { path: 'a.ts' },
      kind: 'write'
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool' && i.id === 'w1')
    expect(tool?.toolKind).toBe('write')
    expect(tool?.status).toBe('running')
  })

  it('leaves toolKind unset for a legacy tool_start with no kind', () => {
    const items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'x1',
      name: 'read_file',
      args: {}
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool' && i.id === 'x1')
    expect(tool?.toolKind).toBeUndefined()
  })
})

describe('PR lifecycle notices', () => {
  it('appends a created-PR notice after a gh_pr_create result (live)', () => {
    let items = reduceEvent([], {
      runId: 'r',
      type: 'tool_start',
      callId: 'p1',
      name: 'gh_pr_create',
      args: { title: 'x' }
    })
    items = reduceEvent(items, {
      runId: 'r',
      type: 'tool_result',
      callId: 'p1',
      name: 'gh_pr_create',
      ok: true,
      output: 'https://github.com/acme/houston/pull/42'
    })
    const tool = items.find((i): i is ToolItem => i.kind === 'tool')
    expect(tool?.status).toBe('done')
    const notice = items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.text).toContain('Opened pull request #42')
  })

  it('does not add a notice for an ordinary tool result', () => {
    const items = reduceEvent(
      [{ kind: 'tool', id: 'r1', name: 'read_file', status: 'running' }],
      { runId: 'r', type: 'tool_result', callId: 'r1', name: 'read_file', ok: true, output: 'hi' }
    )
    expect(items.some((i) => i.kind === 'notice')).toBe(false)
  })

  it('rebuilds created + merged notices from the saved log', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p1', name: 'gh_pr_create', arguments: { title: 'x' } }]
      },
      { role: 'tool', toolCallId: 'p1', toolName: 'gh_pr_create', content: 'https://x/pull/9' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p2', name: 'gh_pr_view', arguments: { number: 9 } }]
      },
      {
        role: 'tool',
        toolCallId: 'p2',
        toolName: 'gh_pr_view',
        content: '#9 Title [merged]\nfeat → main\nhttps://x/pull/9'
      }
    ]
    const notices = itemsFromMessages(messages).filter((i): i is NoticeItem => i.kind === 'notice')
    expect(notices.map((n) => n.text)).toEqual([
      expect.stringContaining('Opened pull request #9'),
      expect.stringContaining('Pull request #9 merged')
    ])
  })
})

describe('reduceEvent — loop-control notices', () => {
  const RID = 'r1'

  it('renders a distinct notice for the stalled limit reason', () => {
    const items = reduceEvent([], { runId: RID, type: 'limit', reason: 'stalled' })
    const notice = items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.tone).toBe('error')
    expect(notice?.text).toMatch(/repeating myself/i)
  })

  it('still renders the existing max-steps and max-output notices', () => {
    const steps = reduceEvent([], { runId: RID, type: 'limit', reason: 'max-steps' })
    expect(steps.find((i): i is NoticeItem => i.kind === 'notice')?.text).toMatch(/step limit/i)
    const output = reduceEvent([], { runId: RID, type: 'limit', reason: 'max-output' })
    expect(output.find((i): i is NoticeItem => i.kind === 'notice')?.text).toMatch(/output limit/i)
  })

  it('renders a passed/failed verification notice', () => {
    const passed = reduceEvent([], { runId: RID, type: 'verification', passed: true })
    const okNotice = passed.find((i): i is NoticeItem => i.kind === 'notice')
    expect(okNotice?.tone).toBe('info')
    expect(okNotice?.text).toMatch(/verification passed/i)

    const failed = reduceEvent([], { runId: RID, type: 'verification', passed: false })
    const badNotice = failed.find((i): i is NoticeItem => i.kind === 'notice')
    expect(badNotice?.tone).toBe('error')
    expect(badNotice?.text).toMatch(/verification failed/i)
  })

  it('renders a notice event (hook systemMessage) as an info notice', () => {
    const items = reduceEvent([], { runId: RID, type: 'notice', message: 'formatted 2 files' })
    const notice = items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.tone).toBe('info')
    expect(notice?.text).toBe('formatted 2 files')
  })

  it('a notice finalizes a streaming assistant bubble before appending', () => {
    const streaming = reduceEvent([], { runId: RID, type: 'text', delta: 'partial…' })
    const items = reduceEvent(streaming, { runId: RID, type: 'notice', message: 'note' })
    const assistant = items.find((i) => i.kind === 'assistant')
    expect(assistant && 'streaming' in assistant && assistant.streaming).toBe(false)
    expect(items.at(-1)?.kind).toBe('notice')
  })
})

describe('lastUserText', () => {
  const user = (id: string, text: string, isSummary = false): DisplayItem => ({
    kind: 'user',
    id,
    text,
    ...(isSummary ? { isSummary: true } : {})
  })

  it('returns the most recent user turn', () => {
    const items: DisplayItem[] = [
      user('u1', 'first'),
      { kind: 'assistant', id: 'a1', text: 'reply', streaming: false },
      user('u2', 'second')
    ]
    expect(lastUserText(items)).toBe('second')
  })

  it('skips the synthetic compaction-summary turn', () => {
    const items: DisplayItem[] = [user('u1', 'real message'), user('s1', 'summary blob', true)]
    expect(lastUserText(items)).toBe('real message')
  })

  it('returns undefined when there is no user turn', () => {
    expect(lastUserText([])).toBeUndefined()
    expect(
      lastUserText([{ kind: 'assistant', id: 'a1', text: 'hi', streaming: false }])
    ).toBeUndefined()
  })
})

describe('reduceEvent tool progress', () => {
  const ev = (e: AgentEvent): AgentEvent => e

  it('attaches a progress line to a running tool and clears it on the result', () => {
    let items: DisplayItem[] = []
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} })
    )
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_progress', callId: 'c1', message: 'Reviewing correctness…' })
    )
    const running = items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!
    expect(running.status).toBe('running')
    expect(running.progress).toContain('Reviewing')

    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_result', callId: 'c1', name: 'review_changes', ok: true, output: 'done' })
    )
    const done = items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!
    expect(done.status).toBe('done')
    expect(done.progress).toBeUndefined()
  })

  it('ignores progress for a tool that is not present', () => {
    const items = reduceEvent([], ev({ runId: 'r1', type: 'tool_progress', callId: 'missing', message: 'x' }))
    expect(items).toEqual([])
  })
})

describe('reduceEvent subagent rows', () => {
  const ev = (e: AgentEvent): AgentEvent => e
  const start = (): DisplayItem[] =>
    reduceEvent([], ev({ runId: 'r1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} }))
  const sub = (id: string, label: string, status: 'running' | 'done' | 'error'): AgentEvent =>
    ev({ runId: 'r1', type: 'subagent', parentCallId: 'c1', id, label, status })
  const toolC1 = (items: DisplayItem[]): ToolItem =>
    items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!

  it('adds a child row on start and updates it in place by id', () => {
    let items = start()
    items = reduceEvent(items, sub('correctness', 'Correctness', 'running'))
    expect(toolC1(items).subagents).toEqual([{ id: 'correctness', label: 'Correctness', status: 'running' }])

    items = reduceEvent(items, sub('correctness', 'Correctness — 2 issues', 'done'))
    // Same id updates the existing row — no duplicate; label + status reflect the outcome.
    expect(toolC1(items).subagents).toEqual([
      { id: 'correctness', label: 'Correctness — 2 issues', status: 'done' }
    ])
  })

  it('keeps one row per distinct subagent id, in arrival order', () => {
    let items = start()
    for (const id of ['correctness', 'security', 'quality']) items = reduceEvent(items, sub(id, id, 'running'))
    expect(toolC1(items).subagents?.map((s) => s.id)).toEqual(['correctness', 'security', 'quality'])
  })

  it('finalizes any still-running child rows when the tool result arrives', () => {
    let items = start()
    items = reduceEvent(items, sub('quality', 'Quality', 'running'))
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_result', callId: 'c1', name: 'review_changes', ok: true, output: 'done' })
    )
    const tool = toolC1(items)
    expect(tool.status).toBe('done')
    expect(tool.subagents).toEqual([{ id: 'quality', label: 'Quality', status: 'done' }])
  })

  it('ignores a subagent event for a parent tool that is not present', () => {
    const items = reduceEvent([], sub('correctness', 'Correctness', 'running'))
    expect(items).toEqual([])
  })
})

describe('reduceEvent review findings', () => {
  const ev = (e: AgentEvent): AgentEvent => e
  const start = (): DisplayItem[] =>
    reduceEvent([], ev({ runId: 'r1', type: 'tool_start', callId: 'c1', name: 'review_changes', args: {} }))
  const finding = (id: string, status: ReviewFinding['status']): AgentEvent =>
    ev({
      runId: 'r1',
      type: 'review_finding',
      parentCallId: 'c1',
      finding: { id, dimension: 'security', severity: 'high', title: id, status }
    })
  const toolC1 = (items: DisplayItem[]): ToolItem =>
    items.find((it): it is ToolItem => it.kind === 'tool' && it.id === 'c1')!

  it('adds findings under the review row and updates them in place by id', () => {
    let items = start()
    items = reduceEvent(items, finding('security:0', 'candidate'))
    items = reduceEvent(items, finding('security:1', 'candidate'))
    items = reduceEvent(items, finding('security:0', 'confirmed'))
    expect(toolC1(items).findings?.map((f) => [f.id, f.status])).toEqual([
      ['security:0', 'confirmed'],
      ['security:1', 'candidate']
    ])
  })

  it('turns a finding still verifying into unverified when the review ends', () => {
    let items = start()
    items = reduceEvent(items, finding('security:0', 'verifying'))
    items = reduceEvent(items, finding('security:1', 'rejected'))
    items = reduceEvent(
      items,
      ev({ runId: 'r1', type: 'tool_result', callId: 'c1', name: 'review_changes', ok: true, output: 'x' })
    )
    expect(toolC1(items).findings?.map((f) => f.status)).toEqual(['candidate', 'rejected'])
  })

  it('ignores a finding for a review row that is not present', () => {
    expect(reduceEvent([], finding('security:0', 'candidate'))).toEqual([])
  })
})
