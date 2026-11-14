import { describe, expect, it } from 'vitest'
import type { BackgroundShellInfo, ChatMessage } from '@shared/agent'
import type { SubagentRecord } from '@shared/subagents'
import { makePainter } from './tui'
import {
  chatSubagents,
  parseTasksArgs,
  renderShellDetail,
  renderSubagentDetail,
  renderTaskList,
  safeLine,
  shellInChat,
  shellKillPhrase,
  SubagentTracker,
  taskElapsed,
  taskLabel,
  taskPickerSpec,
  taskRows,
  taskRunning,
  taskStatus,
  type TaskRow,
  type TaskShell,
  type TrackedSubagent
} from './tui-tasks'

const paint = makePainter(false)
const NOW = 1_000_000

const shell = (over: Partial<TaskShell> = {}): TaskShell => ({
  id: 'sh1',
  command: 'npm run dev',
  running: true,
  exitCode: null,
  startedAt: NOW - 125_000,
  exitedAt: null,
  conversationId: 'c1',
  workspace: '/proj',
  ...over
})

const record = (over: Partial<SubagentRecord> = {}): SubagentRecord => ({
  id: 'sa1',
  kind: 'research',
  label: 'find the config loader',
  model: 'claude-test',
  modelSource: 'run',
  prompt: 'Where is the config loaded?',
  tools: ['read_file'],
  status: 'running',
  startedAt: NOW - 30_000,
  steps: [],
  ...over
})

const agentRow = (over: Partial<TrackedSubagent> = {}): Extract<TaskRow, { kind: 'subagent' }> => ({
  kind: 'subagent',
  agent: {
    key: 'call1:sa1',
    runId: 'run-1',
    recordId: 'sa1',
    chat: 'c1',
    kind: 'research',
    label: 'find the config loader',
    model: 'claude-test',
    prompt: 'Where is the config loaded?',
    status: 'running',
    startedAt: NOW - 30_000,
    steps: [],
    ...over
  }
})

describe('parseTasksArgs', () => {
  it('reads list, show and kill', () => {
    expect(parseTasksArgs('')).toEqual({ op: 'list' })
    expect(parseTasksArgs('  ')).toEqual({ op: 'list' })
    expect(parseTasksArgs('3')).toEqual({ op: 'show', index: 3 })
    expect(parseTasksArgs('kill 2')).toEqual({ op: 'kill', index: 2 })
    expect(parseTasksArgs('stop 2')).toEqual({ op: 'kill', index: 2 })
  })

  it('refuses anything else with the usage', () => {
    for (const bad of ['0', '-1', '1.5', 'kill', 'kill x', 'kill 0', 'foo', '1 2', 'kill 1 2']) {
      expect(parseTasksArgs(bad)).toEqual({ op: 'usage' })
    }
  })
})

describe('task rows', () => {
  it('keeps the shells of this chat, or of this folder for an unsaved session', () => {
    const info = (o: Partial<BackgroundShellInfo>): BackgroundShellInfo => shell(o)
    expect(shellInChat(info({ conversationId: 'c1' }), 'c1', '/proj')).toBe(true)
    expect(shellInChat(info({ conversationId: 'c2' }), 'c1', '/proj')).toBe(false)
    expect(shellInChat(info({ conversationId: undefined }), null, '/proj')).toBe(true)
    expect(shellInChat(info({ conversationId: undefined, workspace: '/other' }), null, '/proj')).toBe(false)
    // Another chat's shell in the same folder is not this unsaved session's.
    expect(shellInChat(info({ conversationId: 'c2' }), null, '/proj')).toBe(false)
  })

  it('orders shells and agents together, oldest first', () => {
    const rows = taskRows(
      [shell({ id: 'late', startedAt: NOW - 1_000 }), shell({ id: 'early', startedAt: NOW - 90_000 })],
      [agentRow({ startedAt: NOW - 50_000 }).agent]
    )
    expect(rows.map((r) => (r.kind === 'shell' ? r.shell.id : 'agent'))).toEqual(['early', 'agent', 'late'])
  })

  it('names the state of each kind', () => {
    expect(taskStatus({ kind: 'shell', shell: shell() })).toBe('running')
    expect(taskStatus({ kind: 'shell', shell: shell({ running: false, exitCode: 0 }) })).toBe('exited 0')
    expect(taskStatus({ kind: 'shell', shell: shell({ running: false, exitCode: 2 }) })).toBe('exited 2')
    expect(taskStatus({ kind: 'shell', shell: shell({ running: false, exitCode: null }) })).toBe('killed')
    expect(taskStatus({ kind: 'shell', shell: shell({ running: false, exitCode: 0, leftover: true }) })).toBe(
      'exited 0, still serving'
    )
    expect(taskStatus(agentRow())).toBe('running')
    expect(taskStatus(agentRow({ status: 'done', outcome: 'done' }))).toBe('done')
    expect(taskStatus(agentRow({ status: 'done', outcome: 'empty' }))).toBe('cut short')
    expect(taskStatus(agentRow({ status: 'error' }))).toBe('failed')
    expect(taskStatus(agentRow({ status: 'aborted' }))).toBe('stopped')
    expect(taskStatus(agentRow({ status: 'step-limit' }))).toBe('cut short')
  })

  it('counts a leftover server as still running, so it can be stopped', () => {
    expect(taskRunning({ kind: 'shell', shell: shell({ running: false, exitCode: 0, leftover: true }) })).toBe(true)
    expect(taskRunning({ kind: 'shell', shell: shell({ running: false, exitCode: 0 }) })).toBe(false)
    expect(taskRunning(agentRow({ status: 'done' }))).toBe(false)
  })

  it('times a running task to now and a finished one to its end', () => {
    expect(taskElapsed({ kind: 'shell', shell: shell() }, NOW)).toBe('2m 5s')
    expect(taskElapsed({ kind: 'shell', shell: shell({ running: false, exitCode: 0, exitedAt: NOW - 120_000 }) }, NOW)).toBe('5s')
    expect(taskElapsed(agentRow({ status: 'done', endedAt: NOW - 10_000 }), NOW)).toBe('20s')
  })

  it("labels an agent by its custom agent's name when the label lacks it", () => {
    expect(taskLabel(agentRow({ agentName: 'reviewer', label: 'check the diff' }))).toBe('reviewer: check the diff')
    expect(taskLabel(agentRow({ agentName: 'reviewer', label: 'reviewer agent' }))).toBe('reviewer agent')
  })
})

describe('sanitizing', () => {
  it('collapses whitespace and drops control characters, escapes included', () => {
    expect(safeLine('a\n  b\tc')).toBe('a b c')
    expect(safeLine('\x1b]52;c;cGF5\x07pwn\x1b[2J')).not.toContain('\x1b')
    const row: TaskRow = { kind: 'shell', shell: shell({ command: 'echo \x1b[31mred\x1b[0m && \x9bx' }) }
    // eslint-disable-next-line no-control-regex -- checking for control characters is the point
    expect(taskLabel(row)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  })

  it('keeps escapes out of every rendered view', () => {
    const evil = '\x1b]52;c;cGF5\x07\x1b[2J'
    const sh: Extract<TaskRow, { kind: 'shell' }> = { kind: 'shell', shell: shell({ command: `run ${evil}`, lastLine: evil, urls: [`http://x${evil}`] }) }
    const ag = agentRow({
      label: `lbl ${evil}`,
      prompt: evil,
      model: evil,
      status: 'done',
      report: `report ${evil}\nsecond`,
      steps: [{ index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: `read ${evil}`, ok: true }]
    })
    const views = [
      renderTaskList([sh, ag], NOW, paint, 80),
      renderShellDetail(sh, 1, [`out ${evil}`], NOW, paint),
      renderSubagentDetail(ag, 2, NOW, paint, 80),
      ...taskPickerSpec([sh, ag], NOW, 80).options.flatMap((o) => [o.label, o.description ?? ''])
    ]
    // eslint-disable-next-line no-control-regex -- checking for the escapes is the point
    for (const v of views) expect(v).not.toMatch(/\x1b|\x07/)
  })
})

describe('renderTaskList', () => {
  it('says so when there is nothing', () => {
    expect(renderTaskList([], NOW, paint)).toContain('No background tasks in this chat yet')
  })

  it('numbers rows with kind, label, status, elapsed and the last output line', () => {
    const out = renderTaskList(
      [{ kind: 'shell', shell: shell({ lastLine: 'ready on http://localhost:5173' }) }, agentRow({ kind: 'writable' })],
      NOW,
      paint,
      100
    )
    expect(out).toContain('Background tasks (2 running):')
    expect(out).toMatch(/1\. shell\s+npm run dev\s+running\s+2m 5s/)
    expect(out).toContain('ready on http://localhost:5173')
    expect(out).toMatch(/2\. agent \(writes\)\s+find the config loader\s+running\s+30s/)
    expect(out).toContain('/tasks kill <n>')
  })

  it('clips a long command to the width', () => {
    const out = renderTaskList([{ kind: 'shell', shell: shell({ command: 'x'.repeat(400) }) }], NOW, paint, 60)
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    expect(out).toContain('…')
  })
})

describe('details', () => {
  it("shows a shell's last lines and how to stop it", () => {
    const sh: Extract<TaskRow, { kind: 'shell' }> = { kind: 'shell', shell: shell({ urls: ['http://localhost:5173/'] }) }
    const tail = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
    const out = renderShellDetail(sh, 1, tail, NOW, paint)
    expect(out).toContain('$ npm run dev')
    expect(out).toContain('serving http://localhost:5173/')
    expect(out).toContain('last 50 lines')
    expect(out).toContain('line 50')
    expect(out).not.toContain('line 10\n')
    expect(out).toContain('/tasks kill 1 stops it')
    expect(renderShellDetail(sh, 1, [], NOW, paint)).toContain('(no output yet)')
    const ended: Extract<TaskRow, { kind: 'shell' }> = { kind: 'shell', shell: shell({ running: false, exitCode: 1 }) }
    expect(renderShellDetail(ended, 1, ['boom'], NOW, paint)).not.toContain('stops it')
  })

  it("shows an agent's task, recent steps, and its report once it ends", () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({
      index: i,
      turn: 1,
      kind: 'tool' as const,
      tool: 'read_file',
      summary: `read file${i}.ts`,
      ok: true
    }))
    const running = renderSubagentDetail(agentRow({ steps }), 2, NOW, paint, 100)
    expect(running).toContain('task: Where is the config loaded?')
    expect(running).toContain('last 20 of 25 steps')
    expect(running).toContain('read file24.ts')
    expect(running).not.toContain('read file4.ts')
    expect(running).toContain('/tasks kill 2 stops it')
    const done = renderSubagentDetail(agentRow({ status: 'done', outcome: 'done', report: 'It is in config.ts.\n\n' }), 2, NOW, paint)
    expect(done).toContain('report:')
    expect(done).toContain('It is in config.ts.')
    expect(done).not.toContain('stops it')
    // A saved agent (no run) can't be stopped, so it doesn't offer to.
    expect(renderSubagentDetail(agentRow({ runId: undefined }), 2, NOW, paint)).not.toContain('stops it')
  })
})

describe('taskPickerSpec', () => {
  it('offers Enter to view and x to kill, one option per row in list order', () => {
    const spec = taskPickerSpec([{ kind: 'shell', shell: shell({ lastLine: 'ready' }) }, agentRow()], NOW, 100)
    expect(spec.enterLabel).toBe('view')
    expect(spec.actions).toEqual([{ id: 'kill', keys: ['x'], label: 'kill' }])
    expect(spec.options.map((o) => o.value)).toEqual(['0', '1'])
    expect(spec.options[0].label).toContain('1. shell  npm run dev')
    expect(spec.options[0].description).toContain('running, 2m 5s: ready')
  })
})

describe('shellKillPhrase', () => {
  it('says what stopping did', () => {
    expect(shellKillPhrase(1, 'killed')).toContain('stopping task 1')
    expect(shellKillPhrase(1, 'killed-leftovers')).toContain('left running')
    expect(shellKillPhrase(1, 'already-exited')).toContain('already finished')
    expect(shellKillPhrase(1, 'not-found')).toContain('no longer tracked')
  })
})

describe('SubagentTracker', () => {
  it('follows an agent from start to end, and leaves reviewers out', () => {
    const t = new SubagentTracker()
    t.apply({ type: 'subagent_start', runId: 'r1', parentCallId: 'call1', record: record() }, 'c1')
    t.apply({ type: 'subagent_start', runId: 'r1', parentCallId: 'call2', record: record({ id: 'sa2', kind: 'reviewer' }) }, 'c1')
    t.apply(
      { type: 'subagent_step', runId: 'r1', parentCallId: 'call1', recordId: 'sa1', step: { index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: 'read a.ts' } },
      'c1'
    )
    // The same step finishing updates it in place.
    t.apply(
      { type: 'subagent_step', runId: 'r1', parentCallId: 'call1', recordId: 'sa1', step: { index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: 'read a.ts', ok: true } },
      'c1'
    )
    t.apply(
      { type: 'subagent_end', runId: 'r1', parentCallId: 'call1', recordId: 'sa1', update: { status: 'done', outcome: 'done', endedAt: NOW, report: 'found it' } },
      'c1'
    )
    const [a, ...rest] = t.forChat('c1')
    expect(rest).toHaveLength(0)
    expect(a).toMatchObject({ key: 'call1:sa1', runId: 'r1', status: 'done', report: 'found it', endedAt: NOW })
    expect(a.steps).toEqual([{ index: 0, turn: 1, kind: 'tool', tool: 'read_file', summary: 'read a.ts', ok: true }])
    expect(t.forChat('c2')).toHaveLength(0)
    t.forget('c1')
    expect(t.forChat('c1')).toHaveLength(0)
  })

  it('ignores events for an agent it never saw start', () => {
    const t = new SubagentTracker()
    t.apply({ type: 'subagent_end', runId: 'r1', parentCallId: 'x', recordId: 'sa1', update: { status: 'done', endedAt: NOW } }, 'c1')
    expect(t.forChat('c1')).toHaveLength(0)
  })
})

describe('chatSubagents', () => {
  it("lists a chat's saved agents, with the live entry winning for the same agent", () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'tool',
        toolCallId: 'call1',
        content: 'report',
        subagents: [record({ status: 'done', outcome: 'done', report: 'saved report', endedAt: NOW - 1 }), record({ id: 'sa2', kind: 'reviewer' })]
      },
      { role: 'tool', toolCallId: 'call0', content: 'x', subagents: [record({ id: 'sa9', status: 'running' })] }
    ]
    const live: TrackedSubagent = { ...agentRow({ key: 'call1:sa1', status: 'done', report: 'live report' }).agent }
    const all = chatSubagents(messages, [live], 'c1')
    expect(all.map((a) => a.key).sort()).toEqual(['call0:sa9', 'call1:sa1'])
    expect(all.find((a) => a.key === 'call1:sa1')?.report).toBe('live report')
    // A saved record still marked running was cut off when its run ended.
    const stale = all.find((a) => a.key === 'call0:sa9')!
    expect(stale.status).toBe('aborted')
    expect(stale.runId).toBeUndefined()
  })
})
