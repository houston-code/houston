import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatMessage } from '@shared/agent'
import type { AppSettings, PermissionRule, ProviderConfig } from '@shared/types'
import { elsewhereNote, makePainter, runTui, type TuiDeps, type TuiIo, type TuiPersist } from './tui'
import type { DraftRecord, DraftStore } from './tui-drafts'
import { parsePermissionsArgs, runPermissionsCommand } from './tui-permissions'

// Moving between chats (/spawned, /resume, /fork <n>, /import) and settings written
// after a prompt: the session must act on the chat and the settings as they are now.

const done: AgentEvent = { runId: 'x', type: 'done', stopReason: 'end_turn' }

interface Chat {
  title: string
  workspace: string
  messages: ChatMessage[]
}

function harness(inputs: Array<string | null>, chats: Record<string, Chat> = {}) {
  let current: AppSettings = {
    schemaVersion: 1,
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }],
    selected: { providerId: 'anthropic', model: 'claude' },
    approvalPolicy: 'ask',
    recentWorkspaces: []
  } as unknown as AppSettings
  const store = new Map<string, Chat>(Object.entries(chats))
  const writes: Array<{ id: string; messages: ChatMessage[] }> = []
  let seq = 0
  const persist: TuiPersist = {
    create: ({ workspace }) => {
      const id = `conv-${++seq}`
      store.set(id, { title: 'New chat', workspace, messages: [] })
      return { id }
    },
    setMessages: (id, messages) => {
      writes.push({ id, messages })
      const c = store.get(id)
      if (c) c.messages = messages
    },
    setSettings: () => {},
    list: (workspace) =>
      [...store.entries()]
        .filter(([, c]) => c.workspace === workspace)
        .map(([id, c]) => ({ id, title: c.title, updatedAt: 0 })),
    search: () => [],
    fork: () => null,
    forkAt: (id, point) => {
      const c = store.get(id)
      if (!c || point.kind !== 'turn') return null
      const fid = `conv-${++seq}`
      store.set(fid, { ...c, messages: c.messages.slice(0, point.n * 2) })
      return { id: fid }
    },
    get: (id) => {
      const c = store.get(id)
      return c ? { ...c, messages: [...c.messages] } : null
    }
  }
  const saved = new Map<string, DraftRecord>()
  const drafts: DraftStore = {
    load: (k) => saved.get(k) ?? null,
    save: (k, r) => {
      if (r && (r.text.trim() || r.queued.length)) saved.set(k, r)
      else saved.delete(k)
    }
  }
  const out: string[] = []
  const composerInitials: Array<string | undefined> = []
  const runs: Array<{ workspace: string; conversationId?: string; messages: ChatMessage[] }> = []
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
    stopSpinner: () => {}
  }
  let runCount = 0
  const d: TuiDeps = {
    getSettings: () => current,
    updateSettings: (patch) => {
      current = { ...current, ...patch }
    },
    startRun: async (req, send, onMessages) => {
      runs.push({ workspace: req.workspace, conversationId: req.conversationId, messages: req.messages })
      send({ ...done, runId: req.runId })
      onMessages?.([...req.messages, { role: 'assistant', content: 'ok' }])
    },
    resolveApproval: () => {},
    resolveQuestion: () => {},
    resolvePlan: () => {},
    resolveElicitation: () => {},
    cancelRun: () => {},
    io,
    persist,
    drafts,
    newId: () => `run-${++runCount}`
  }
  return {
    d,
    io,
    store,
    writes,
    saved,
    runs,
    composerInitials,
    next,
    text: () => out.join(''),
    settings: () => current,
    setSettings: (s: AppSettings) => {
      current = s
    },
    useComposer: () => {
      io.readComposer = async (_p, initial) => {
        composerInitials.push(initial)
        return next()
      }
    }
  }
}

const opts = { cwd: '/proj', approvalPolicy: 'ask' as const, color: false }
const spawned = (id: string, running: boolean) => ({ id, title: 'Spawned work', running, startedAt: 1 })
const msgs = (...texts: string[]): ChatMessage[] =>
  texts.map((content, n) => ({ role: n % 2 ? 'assistant' : 'user', content }) as ChatMessage)

describe('/spawned: a session in its own folder', () => {
  it('opens it to read, but a message sent here is refused rather than editing this folder', async () => {
    const h = harness(['/spawned', '1', 'now fix the tests', null], {
      s1: { title: 'Spawned work', workspace: '/proj/.houston/worktrees/s1', messages: msgs('do it', 'done') }
    })
    h.d.backgroundSessions = () => [spawned('s1', false)]
    await runTui({ ...opts }, h.d)
    expect(h.runs).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.store.get('s1')?.messages).toEqual(msgs('do it', 'done'))
    expect(h.text()).toContain('opened: 2 messages')
    expect(h.text()).toContain('this session works in another folder (/proj/.houston/worktrees/s1)')
    expect(h.text()).toContain('· not sent: this session works in another folder')
  })

  it('continues a finished session of this same folder as before', async () => {
    const h = harness(['/spawned', '1', 'now fix the tests', null], {
      s1: { title: 'Spawned work', workspace: '/proj', messages: msgs('do it', 'done') }
    })
    h.d.backgroundSessions = () => [spawned('s1', false)]
    await runTui({ ...opts }, h.d)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]).toMatchObject({ workspace: '/proj', conversationId: 's1' })
    expect(h.runs[0].messages.map((m) => m.content)).toEqual(['do it', 'done', 'now fix the tests'])
  })

  it('names the folder and the command that opens it there', () => {
    expect(elsewhereNote('/w/t', 'abc')).toContain('another folder (/w/t); /cd there to continue it, or open it there with: ')
    expect(elsewhereNote('/w/t', 'abc')).toContain('abc')
  })
})

describe('a chat something else is still writing', () => {
  it('/spawned on a running session: a message is not saved over what the session writes, and goes back in the prompt', async () => {
    const h = harness(['/spawned', '1', 'and add docs', null], {
      s1: { title: 'Spawned work', workspace: '/proj', messages: msgs('do it') }
    })
    h.useComposer()
    let running = true
    h.d.backgroundSessions = () => [spawned('s1', running)]
    h.d.chatRunning = (id) => id === 's1' && running
    // The session saves more while the user types.
    h.io.readLine = async () => {
      const ans = h.next()
      h.store.get('s1')!.messages = msgs('do it', 'step one done')
      return ans
    }
    await runTui({ ...opts }, h.d)
    running = false
    expect(h.runs).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.store.get('s1')?.messages).toEqual(msgs('do it', 'step one done'))
    expect(h.text()).toContain('not sent: this chat is still running in the background')
    expect(h.composerInitials.at(-1)).toBe('and add docs')
  })

  it('once it has finished, the next message adds to what it saved, not to the copy opened earlier', async () => {
    const inputs = ['/spawned', '1', 'and add docs', null]
    const h = harness(inputs, { s1: { title: 'Spawned work', workspace: '/proj', messages: msgs('do it') } })
    let running = true
    h.d.backgroundSessions = () => [spawned('s1', running)]
    h.d.chatRunning = (id) => id === 's1' && running
    h.io.readLine = async () => {
      const ans = h.next()
      if (ans === 'and add docs') {
        // It finished (and saved its work) after the chat was opened.
        h.store.get('s1')!.messages = msgs('do it', 'all done')
        running = false
      }
      return ans
    }
    await runTui({ ...opts }, h.d)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].messages.map((m) => m.content)).toEqual(['do it', 'all done', 'and add docs'])
    expect(h.writes[0].messages.map((m) => m.content)).toEqual(['do it', 'all done', 'and add docs'])
  })

  it('/resume of a chat running in another process: refused, and its log left alone', async () => {
    const h = harness(['/resume', '1', 'hello', null], {
      c1: { title: 'Busy chat', workspace: '/proj', messages: msgs('first', 'reply') }
    })
    h.d.chatRunning = () => true
    await runTui({ ...opts }, h.d)
    expect(h.runs).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.text()).toContain('not sent: this chat is still running in the background')
  })
})

describe('switching chats leaves the old one no draft of follow-ups already sent', () => {
  it('/import', async () => {
    const h = harness([])
    h.d.importChat = () => ({ id: 'imp', title: 'Imported', messages: [], providerId: 'anthropic', model: 'claude', textOnly: false })
    h.store.set('imp', { title: 'Imported', workspace: '/proj', messages: [] })
    const answers: Array<string | null> = ['go', null]
    h.io.readComposer = async () => answers.shift() ?? null
    // Typed while the first turn ran: the import, then a message for the imported chat.
    const queued = [['/import chat.json', 'start the other task']]
    h.io.takeQueued = () => queued.shift() ?? []
    await runTui({ ...opts }, h.d)
    expect(h.runs.map((r) => [r.conversationId, r.messages.at(-1)?.content])).toEqual([
      ['conv-1', 'go'],
      ['imp', 'start the other task']
    ])
    expect(h.saved.has('conv-1')).toBe(false)
  })

  it('/fork <n>', async () => {
    const h = harness([])
    const answers: Array<string | null> = ['go', 'more', null]
    h.io.readComposer = async () => answers.shift() ?? null
    const queued: string[][] = [[], ['/fork 2', 'start the other task']]
    h.io.takeQueued = () => queued.shift() ?? []
    await runTui({ ...opts }, h.d)
    expect(h.runs.map((r) => r.conversationId)).toEqual(['conv-1', 'conv-1', 'conv-2'])
    expect(h.saved.has('conv-1')).toBe(false)
  })
})

describe('settings written after a prompt keep what was saved meanwhile', () => {
  it('/permissions add: a rule saved while the confirmation was open stays', async () => {
    const paint = makePainter(false)
    const theirs: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'rm *' }
    let settings = { permissionRules: [] as PermissionRule[] } as AppSettings
    const out: string[] = []
    await runPermissionsCommand(
      parsePermissionsArgs('add allow run_shell *'),
      {
        getSettings: () => settings,
        updateSettings: (patch) => {
          settings = { ...settings, ...patch }
        },
        readLine: async () => {
          // Another window saves a rule while this question waits.
          settings = { ...settings, permissionRules: [theirs] }
          return 'y'
        },
        now: () => 1,
        out: (t) => out.push(t)
      },
      paint
    )
    expect(settings.permissionRules?.map((r) => r.match)).toEqual(['rm *', '*'])
    expect(out.join('')).toContain('added as rule 2')
  })

  it('/login, Other host: a host saved while its questions were open stays', async () => {
    const h = harness(['/login', '2', '1', null])
    h.d.isMac = true
    h.d.setKey = () => ({ shadowedByEnv: null })
    const mine = { id: 'mine', label: 'Mine', requiresKey: false, hasKey: true, models: [] } as unknown as ProviderConfig
    const readLine = h.io.readLine
    h.io.readLine = async (prompt, o) => {
      const ans = await readLine(prompt, o)
      // Another window adds a host while the catalog question is open.
      if (prompt.includes('host')) h.setSettings({ ...h.settings(), providers: [...h.settings().providers, mine] })
      return ans
    }
    await runTui({ ...opts }, h.d)
    expect(h.settings().providers.map((p) => p.id)).toEqual(['anthropic', 'mine', 'openrouter'])
  })
})
