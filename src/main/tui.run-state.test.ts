import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatMessage } from '@shared/agent'
import type { CompactResult } from './agent/compact'
import type { AppSettings } from '@shared/types'
import { runTui, type TuiDeps, type TuiIo, type TuiPersist } from './tui'

// Run state the terminal keeps between and around turns: the tab's progress while an
// approval waits, /retry after a `!` command, lines typed while a rewind summarizes,
// and notification settings changed mid-session.

const baseSettings = (): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }],
    selected: { providerId: 'anthropic', model: 'claude' },
    approvalPolicy: 'ask',
    recentWorkspaces: []
  }) as unknown as AppSettings

const opts = { cwd: '/proj', approvalPolicy: 'ask' as const, color: false }
const done: AgentEvent = { runId: 'x', type: 'done', stopReason: 'end_turn' }

/** A minimal in-memory chat store. */
function memoryPersist(): TuiPersist {
  const store = new Map<string, { title: string; workspace: string; messages: ChatMessage[] }>()
  let seq = 0
  return {
    create: ({ workspace }) => {
      const id = `conv-${++seq}`
      store.set(id, { title: 'New chat', workspace, messages: [] })
      return { id }
    },
    setMessages: (id, messages) => {
      const c = store.get(id)
      if (c) c.messages = messages
    },
    setSettings: () => {},
    list: (workspace) =>
      [...store.entries()].filter(([, c]) => c.workspace === workspace).map(([id, c]) => ({ id, title: c.title, updatedAt: 0 })),
    search: () => [],
    fork: () => null,
    get: (id) => store.get(id) ?? null
  } as TuiPersist
}

/**
 * A scripted terminal. Lines come from `inputs` whether the composer or a plain prompt
 * reads them; with `composer`, the composer records the draft it opens with.
 */
function harness(
  events: AgentEvent[] | ((n: number) => AgentEvent[]),
  inputs: Array<string | null>,
  o: { composer?: boolean; reply?: (n: number) => string | null } = {}
) {
  const out: string[] = []
  const log: string[] = []
  const initials: Array<string | undefined> = []
  const runs: ChatMessage[][] = []
  const signals: Array<{ title?: string; mode?: string }> = []
  let settings = baseSettings()
  let i = 0
  const next = (): string | null => (i < inputs.length ? inputs[i++] : null)
  const io: TuiIo = {
    out: (s) => out.push(s),
    clearLine: () => {},
    readLine: async () => next(),
    onInterrupt: () => {},
    cancelRead: () => {},
    startSpinner: () => {},
    setSpinnerLabel: () => {},
    stopSpinner: () => {},
    progress: (s) => log.push(s),
    signal: (s) => signals.push(s as { title?: string; mode?: string }),
    select: async () => {
      log.push('answered')
      return { kind: 'commit', value: 'allow' }
    },
    ...(o.composer
      ? {
          readComposer: async (_prompt: string | (() => string), initial?: string) => {
            initials.push(initial)
            return next()
          }
        }
      : {})
  }
  const d: TuiDeps = {
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch }
    },
    startRun: async (req, send, onMessages) => {
      runs.push(req.messages.map((m) => ({ ...m })))
      const evs = typeof events === 'function' ? events(runs.length) : events
      for (const e of evs) send({ ...e, runId: req.runId } as AgentEvent)
      const reply = o.reply?.(runs.length)
      onMessages?.(reply ? [...req.messages, { role: 'assistant', content: reply }] : req.messages)
    },
    resolveApproval: () => {},
    resolveQuestion: () => {},
    resolvePlan: () => {},
    resolveElicitation: () => {},
    cancelRun: () => {},
    runUserShell: async (_cmd, onOutput) => {
      onOutput('hi\n')
      return 0
    },
    io,
    newId: () => `run-${runs.length + 1}`
  }
  return { d, io, log, runs, signals, initials, text: () => out.join('') }
}

describe('terminal progress while an approval waits', () => {
  it('stays blocked through other events until the approval is answered', async () => {
    const t = harness(
      [
        { runId: 'x', type: 'tool_approval', callId: 'c1', name: 'run_shell', summary: 'ls', args: { command: 'ls' }, kind: 'shell' },
        // A parallel subagent's row and the reply's text arrive while the prompt waits.
        { runId: 'x', type: 'text', delta: 'still going' },
        { runId: 'x', type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0 } as AgentEvent,
        done
      ],
      ['go', null]
    )
    await runTui(opts, t.d)
    const blocked = t.log.indexOf('blocked-permission')
    expect(blocked).toBeGreaterThan(-1)
    // Nothing reads as working between the block and the answer.
    expect(t.log.slice(blocked + 1, t.log.indexOf('answered'))).toEqual([])
    expect(t.log.slice(t.log.indexOf('answered') + 1)).toContain('working')
  })
})

describe('/retry after a ! command', () => {
  it('retries the failed message, not the shell record after it', async () => {
    const t = harness([done], ['fix the build', '!echo hi', '/retry', null])
    t.d.persist = memoryPersist()
    await runTui(opts, t.d)
    expect(t.runs).toHaveLength(2)
    const sent = t.runs[1].at(-1)
    expect(sent?.role).toBe('user')
    expect(sent?.content).toBe('fix the build')
    expect(t.text()).toContain('retrying your last message')
  })

  it('has nothing to retry when the turn before the ! command was answered', async () => {
    const t = harness([done], ['fix the build', '!echo hi', '/retry', null], { reply: () => 'done it' })
    t.d.persist = memoryPersist()
    await runTui(opts, t.d)
    expect(t.runs).toHaveLength(1)
    expect(t.text()).toContain('nothing to retry')
  })
})

describe('rewind summarize: lines typed meanwhile', () => {
  const summarizing = (t: ReturnType<typeof harness>, result: CompactResult, typed: string[], half: string) => {
    let queued: string[] = []
    let draft = ''
    t.io.takeQueued = () => {
      const q = queued
      queued = []
      return q
    }
    t.io.takeDraft = () => {
      const h = draft
      draft = ''
      return h
    }
    t.d.persist = memoryPersist()
    t.d.rewind = {
      preview: async () => ({ ok: true, turns: 1, files: 0, conflicts: [], unavailable: 0 }),
      apply: async () => ({ ok: false, error: 'no' }),
      undo: async () => ({ ok: false, error: 'no' })
    }
    t.d.summarize = async () => {
      queued = typed
      draft = half
      return result
    }
  }

  it('sends a line typed while it summarized as the next turn, and keeps the half-typed one as a draft', async () => {
    const t = harness([done], ['first', 'second', '/rewind 2 summarize', '', 'y', null, null], { composer: true })
    const summary: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'Summary of the earlier conversation: second' }
    ]
    summarizing(t, { ok: true, summarized: 1, messages: summary }, ['and then this'], 'half typ')
    await runTui(opts, t.d)
    expect(t.runs.at(-1)?.map((m) => m.content)).toEqual([...summary.map((m) => m.content), 'and then this'])
    expect(t.initials.at(-1)).toBe('half typ')
  })

  it('hands the lines back as the draft when the summary is cancelled', async () => {
    const t = harness([done], ['first', 'second', '/rewind 2 summarize', '', 'y', null], { composer: true })
    summarizing(t, { ok: false, summarized: 0, reason: 'cancelled' }, ['and then this'], 'half typ')
    await runTui(opts, t.d)
    expect(t.runs).toHaveLength(2)
    expect(t.initials.at(-1)).toBe('and then this\n\nhalf typ')
  })
})

describe('notification settings changed mid-session', () => {
  const lastTurnModes = (t: ReturnType<typeof harness>, from: number): Array<string | undefined> =>
    t.signals.slice(from).map((s) => s.mode)

  it('/config desktop-notifications off silences this terminal too', async () => {
    const t = harness([done], ['one', '/config desktop-notifications off', 'two', null])
    let mark = 0
    t.d.startRun = ((orig) => async (...args: Parameters<TuiDeps['startRun']>) => {
      if (t.runs.length === 1) mark = t.signals.length
      return orig(...args)
    })(t.d.startRun)
    await runTui(opts, t.d)
    expect(t.signals.slice(0, mark).some((s) => s.mode === 'auto')).toBe(true)
    expect(lastTurnModes(t, mark).filter(Boolean)).toEqual([])
  })

  it('/settings set desktopNotifications off silences this terminal too', async () => {
    const t = harness([done], ['one', '/settings set desktopNotifications off', 'two', null])
    let mark = 0
    t.d.startRun = ((orig) => async (...args: Parameters<TuiDeps['startRun']>) => {
      if (t.runs.length === 1) mark = t.signals.length
      return orig(...args)
    })(t.d.startRun)
    await runTui(opts, t.d)
    expect(t.signals.slice(0, mark).some((s) => s.mode === 'auto')).toBe(true)
    expect(lastTurnModes(t, mark).filter(Boolean)).toEqual([])
  })
})
