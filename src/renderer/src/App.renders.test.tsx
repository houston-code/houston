import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Conversation, ConversationMeta } from '@shared/agent'
import type { FileDiff } from '@shared/workingTree'
import { defaultSettings } from '@shared/defaults'
import { appendComposerImages } from './lib/composerImageDraft'
import App from './App'

// Count each pane's own renders. The counter sits inside whatever App wraps the pane in,
// so it moves only when the pane itself renders.
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('./components/Sidebar', async (orig) => {
  const m = await orig<typeof import('./components/Sidebar')>()
  const { counted } = await import('../test/countRenders')
  return { ...m, Sidebar: counted(renders, 'Sidebar', m.Sidebar) }
})
vi.mock('./components/Titlebar', async (orig) => {
  const m = await orig<typeof import('./components/Titlebar')>()
  const { counted } = await import('../test/countRenders')
  return { ...m, Titlebar: counted(renders, 'Titlebar', m.Titlebar) }
})
vi.mock('./components/Composer', async (orig) => {
  const m = await orig<typeof import('./components/Composer')>()
  const { counted } = await import('../test/countRenders')
  return { ...m, Composer: counted(renders, 'Composer', m.Composer) }
})
vi.mock('./components/DiffPanel', async (orig) => {
  const m = await orig<typeof import('./components/DiffPanel')>()
  const { counted } = await import('../test/countRenders')
  return { ...m, DiffPanel: counted(renders, 'DiffPanel', m.DiffPanel) }
})
vi.mock('./components/Transcript', async (orig) => {
  const m = await orig<typeof import('./components/Transcript')>()
  const { counted } = await import('../test/countRenders')
  return { ...m, Transcript: counted(renders, 'Transcript', m.Transcript) }
})

// Images handed to another chat's message box (jsdom has no IndexedDB to keep them in).
vi.mock('./lib/composerImageDraft', async (orig) => {
  const m = await orig<typeof import('./lib/composerImageDraft')>()
  return { ...m, appendComposerImages: vi.fn(async () => {}) }
})

type Listener = (...args: unknown[]) => void

function diffFiles(n: number): FileDiff[] {
  return Array.from({ length: n }, (_, f) => ({
    path: `src/file${f}.ts`,
    status: 'modified' as const,
    added: 1,
    removed: 1,
    binary: false,
    hunks: [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { type: 'del' as const, text: `const a${f} = 1` },
          { type: 'add' as const, text: `const a${f} = 2` },
          { type: 'ctx' as const, text: 'export {}' }
        ]
      }
    ]
  }))
}

/**
 * A `window.api` for mounting the whole App: a chat (`c0`) reopened at launch with its
 * run (`run-1`) still going, `chats` chats in the sidebar, and the Changes tab open.
 * Anything not stubbed resolves to nothing; `overrides` replaces any stub, and
 * `workspaces` gives a chat its own project.
 */
function installApi(chats: number, overrides: Record<string, unknown> = {}, workspaces: Record<string, string> = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const now = Date.now()
  const metas: ConversationMeta[] = Array.from({ length: chats }, (_, i) => ({
    id: `c${i}`,
    title: `Chat number ${i}`,
    workspace: workspaces[`c${i}`] ?? '/w',
    providerId: 'anthropic',
    model: 'claude-haiku-5-5',
    createdAt: now - i * 3_600_000,
    updatedAt: now - i * 3_600_000
  }))
  const conversation = (id: string): Conversation =>
    ({ ...metas.find((m) => m.id === id), messages: [{ role: 'user', content: `hello from ${id}` }] }) as Conversation
  const settings = { ...defaultSettings(), recentWorkspaces: ['/w'], previewOpen: true }
  settings.selected = { providerId: settings.providers[0].id, model: settings.providers[0].models[0].id }
  settings.providers[0] = { ...settings.providers[0], hasKey: true }
  const getConversation = vi.fn(async (id: string) => conversation(id))
  const stubs: Record<string, unknown> = {
    getSettings: async () => settings,
    getLaunchChat: async () => 'c0',
    listConversations: async () => [...metas],
    getConversation,
    getActiveRun: async (id: string) => (id === 'c0' ? 'run-1' : null),
    getLiveTranscript: async () => [],
    getPendingPrompts: async () => [],
    getCheckpoint: async () => null,
    getChatStatus: async () => ({}),
    listQueue: async () => [],
    listCommands: async () => [],
    listPreviewServers: async () => [],
    getBackgroundShells: async () => [],
    getRateLimits: async () => [],
    getWorkingTreeChanges: async () => ({ isRepo: true, branch: 'main', files: diffFiles(3), added: 3, removed: 3 }),
    getWorkingTreeStats: async () => ({ isRepo: true, branch: 'main', fileCount: 3, added: 3, removed: 3 }),
    ...overrides
  }
  // Anything else: a callable that is also a promise of undefined, so it serves as an
  // unsubscribe function, an awaited call, or a .then/.catch chain.
  const inert = (): unknown => {
    const p = Promise.resolve(undefined)
    return Object.assign(() => {}, { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) })
  }
  window.api = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in stubs) return stubs[prop]
        if (/^on[A-Z]/.test(prop)) {
          return (cb: Listener) => {
            let set = listeners.get(prop)
            if (!set) listeners.set(prop, (set = new Set()))
            set.add(cb)
            return () => set!.delete(cb)
          }
        }
        return inert
      }
    }
  ) as unknown as typeof window.api
  return {
    getConversation,
    conversation,
    settings,
    metas,
    /** Main's signal on a channel with no payload (e.g. onSettingsChanged). */
    signal(prop: string): void {
      for (const cb of listeners.get(prop) ?? []) cb()
    },
    emit(e: AgentEvent): void {
      for (const cb of listeners.get('onAgentEvent') ?? []) cb(e)
    },
    /** Fire any `on…` subscription, e.g. `onChatStatusChanged`. */
    fire(channel: string, ...args: unknown[]): void {
      for (const cb of listeners.get(channel) ?? []) cb(...args)
    }
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Frames run when the test says so.
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  frames = []
  renders.clear()
  localStorage.setItem('houston.dockTab', 'changes')
  localStorage.setItem('houston.changes.scope', 'tree')
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})
function runFrames(): void {
  act(() => {
    for (const cb of frames.splice(0)) cb(performance.now())
  })
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    runFrames()
  }
}
const count = (name: string): number => renders.get(name) ?? 0

describe('App following changes made in another window', () => {
  it('re-reads the settings and the chat list when main says they changed', async () => {
    const api = installApi(1)
    render(<App />)
    await settle()
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    api.settings.theme = theme
    api.signal('onSettingsChanged')
    await settle()
    expect(document.documentElement.dataset.theme).toBe(theme)

    api.metas.push({ ...api.metas[0], id: 'other', title: 'Made in the other window' })
    api.signal('onConversationsChanged')
    await settle()
    expect(screen.getByText('Made in the other window')).toBeInTheDocument()
  })
})

describe('App during a streaming run', () => {
  it('re-renders the transcript for a streamed delta, not the sidebar, title bar, composer or dock', async () => {
    const { emit } = installApi(200)
    render(<App />)
    await settle()
    expect(screen.getByText('Chat number 199')).toBeInTheDocument()
    expect(document.querySelector('.changes-file')).not.toBeNull()
    const before = new Map(renders)
    expect(before.get('Sidebar')).toBeGreaterThan(0)
    expect(before.get('DiffPanel')).toBeGreaterThan(0)

    for (let i = 0; i < 5; i++) {
      act(() => emit({ runId: 'run-1', type: 'text', delta: `word${i} ` }))
      runFrames()
    }
    await settle()

    expect(document.body.textContent).toContain('word0 word1 word2 word3 word4')
    expect(count('Transcript')).toBeGreaterThan(before.get('Transcript') ?? 0)
    for (const pane of ['Sidebar', 'Titlebar', 'Composer', 'DiffPanel']) {
      expect({ pane, renders: count(pane) }).toEqual({ pane, renders: before.get(pane) ?? 0 })
    }
  })

  it('still renders the panes when what they show changes, and their handlers stay current', async () => {
    const { emit, getConversation } = installApi(20)
    render(<App />)
    await settle()
    for (let i = 0; i < 3; i++) {
      act(() => emit({ runId: 'run-1', type: 'text', delta: `word${i} ` }))
      runFrames()
    }
    // The run ends: the composer's Stop turns back into Send.
    const composer = count('Composer')
    act(() => emit({ runId: 'run-1', type: 'done', stopReason: 'end_turn' }))
    await settle()
    expect(count('Composer')).toBeGreaterThan(composer)

    // A sidebar click after all that runs App's current handler: it opens that chat.
    fireEvent.click(screen.getByText('Chat number 3'))
    await settle()
    expect(getConversation).toHaveBeenLastCalledWith('c3')
    expect(screen.getByText('hello from c3')).toBeInTheDocument()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function composerBox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
}

describe('App when the open chat changes under async work', () => {
  it('starts a prepared command in the chat it was typed in, not the one opened meanwhile', async () => {
    const prepared = deferred<unknown>()
    const startAgent = vi.fn(async () => ({}))
    const cancelAgent = vi.fn(async () => {})
    const prepareCommand = vi.fn(() => prepared.promise)
    const { emit } = installApi(3, {
      listCommands: async () => [
        { name: 'deploy', description: 'Deploy it', template: 'Deploy $ARGUMENTS', source: 'project', model: 'claude-haiku-5-5' }
      ],
      prepareCommand,
      startAgent,
      cancelAgent
    })
    render(<App />)
    await settle()
    // c1 is idle: type the command there.
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    expect(screen.getByText('hello from c1')).toBeInTheDocument()
    fireEvent.change(composerBox(), { target: { value: '/deploy now' } })
    fireEvent.keyDown(composerBox(), { key: 'Enter' })
    await settle()
    expect(prepareCommand).toHaveBeenCalled()

    // While main prepares it, the user opens c0, whose run-1 is still going.
    fireEvent.click(screen.getByText('Chat number 0'))
    await settle()
    expect(screen.getByText('hello from c0')).toBeInTheDocument()
    await act(async () => {
      prepared.resolve({
        ok: true,
        notes: [],
        turn: {
          text: 'Deploy now',
          invokedAs: { kind: 'command', label: '/deploy', typed: '/deploy now' },
          grant: 'grant-1'
        }
      })
    })
    await settle()

    // The turn went to c1, in the background, with the command's grant.
    expect(startAgent).toHaveBeenCalledTimes(1)
    expect(startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', userText: 'Deploy now', commandGrant: 'grant-1' })
    )
    // c0 still follows its own run: no c1 bubble, run-1's output shows, Stop stops run-1.
    expect(document.body.textContent).not.toContain('/deploy')
    act(() => emit({ runId: 'run-1', type: 'text', delta: 'still run one' }))
    runFrames()
    await settle()
    expect(document.body.textContent).toContain('still run one')
    fireEvent.click(screen.getByRole('button', { name: /^stop/i }))
    expect(cancelAgent).toHaveBeenCalledWith('run-1')
  })

  it('follows a queued follow-up that starts while the chat is being opened', async () => {
    const firstRead = deferred<Conversation>()
    let followUpStarted = false
    const meta = (id: string) => ({ id, title: `Chat number ${id.slice(1)}`, workspace: '/w', providerId: 'anthropic', model: 'claude-haiku-5-5', createdAt: 0, updatedAt: 0 })
    const c1 = (withFollowUp: boolean): Conversation =>
      ({
        ...meta('c1'),
        messages: [
          { role: 'user', content: 'hello from c1' },
          ...(withFollowUp ? [{ role: 'user', content: 'and the queued follow-up' }] : [])
        ]
      }) as Conversation
    let c1Reads = 0
    const { emit } = installApi(2, {
      getConversation: vi.fn(async (id: string) => {
        if (id !== 'c1') return { ...meta(id), messages: [{ role: 'user', content: `hello from ${id}` }] }
        return ++c1Reads === 1 ? firstRead.promise : c1(followUpStarted)
      }),
      getActiveRun: async (id: string) => (id === 'c0' ? 'run-1' : id === 'c1' ? (followUpStarted ? 'run-0b' : 'run-0') : null)
    })
    render(<App />)
    await settle()
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    // While its log is still loading, run-0 ends and main starts the queued follow-up.
    act(() => {
      emit({ runId: 'run-0', type: 'done', stopReason: 'end_turn' })
      followUpStarted = true
      emit({ runId: 'run-0b', type: 'turn_start', conversationId: 'c1', userText: 'and the queued follow-up' })
    })
    await act(async () => firstRead.resolve(c1(false)))
    await settle()
    act(() => emit({ runId: 'run-0b', type: 'text', delta: 'the follow-up reply' }))
    runFrames()
    await settle()
    expect(screen.getByText('and the queued follow-up')).toBeInTheDocument()
    expect(document.body.textContent).toContain('the follow-up reply')
    expect(screen.getByRole('button', { name: /^stop/i })).toBeInTheDocument()
  })

  it('follows a run of the open chat started from another window', async () => {
    let startedElsewhere = false
    const { emit, fire } = installApi(2, {
      getConversation: vi.fn(async (id: string) => ({
        id,
        title: `Chat number ${id.slice(1)}`,
        workspace: '/w',
        providerId: 'anthropic',
        model: 'claude-haiku-5-5',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          { role: 'user', content: `hello from ${id}` },
          ...(id === 'c1' && startedElsewhere ? [{ role: 'user', content: 'sent from the other window' }] : [])
        ]
      })),
      getActiveRun: async (id: string) => (id === 'c0' ? 'run-1' : id === 'c1' && startedElsewhere ? 'run-w' : null)
    })
    render(<App />)
    await settle()
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    expect(screen.queryByRole('button', { name: /^stop/i })).toBeNull()
    startedElsewhere = true
    act(() => fire('onChatStatusChanged', { c0: { running: true, pending: [] }, c1: { running: true, pending: [] } }))
    await settle()
    act(() => emit({ runId: 'run-w', type: 'text', delta: 'reply to the other window' }))
    runFrames()
    await settle()
    expect(screen.getByText('sent from the other window')).toBeInTheDocument()
    expect(document.body.textContent).toContain('reply to the other window')
    expect(screen.getByRole('button', { name: /^stop/i })).toBeInTheDocument()
  })

  it('does not follow a run again once its end has arrived', async () => {
    const getActiveRun = vi.fn(async (id: string) => (id === 'c0' ? 'run-1' : null))
    const { emit, fire } = installApi(2, { getActiveRun })
    render(<App />)
    await settle()
    expect(screen.getByRole('button', { name: /^stop/i })).toBeInTheDocument()
    // The run's end arrives while main still lists it as the chat's run (it is saving
    // the turn's checkpoint) and the status still says running.
    act(() => fire('onChatStatusChanged', { c0: { running: true, pending: [] } }))
    act(() => emit({ runId: 'run-1', type: 'done', stopReason: 'end_turn' }))
    await settle()
    expect(screen.queryByRole('button', { name: /^stop/i })).toBeNull()
  })

  it('reads the slash commands of a running chat opened in another project', async () => {
    const listCommands = vi.fn(async () => [])
    installApi(
      2,
      { listCommands, getActiveRun: async (id: string) => (id === 'c0' ? 'run-1' : id === 'c1' ? 'run-2' : null) },
      { c1: '/v' }
    )
    render(<App />)
    await settle()
    expect(listCommands).toHaveBeenCalledWith('/w')
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    expect(screen.getByRole('button', { name: /^stop/i })).toBeInTheDocument()
    expect(listCommands).toHaveBeenLastCalledWith('/v')
  })
})

describe('App reopening a chat', () => {
  it('shows a background agent saved mid-work as stopped when no run owns the chat', async () => {
    const saved = {
      id: 'sa1',
      kind: 'research' as const,
      label: 'Trace',
      model: 'agent-model',
      modelSource: 'run' as const,
      prompt: 'p',
      tools: ['read_file'],
      backgroundId: 'bg1',
      status: 'running' as const,
      startedAt: 1,
      steps: []
    }
    installApi(2, {
      getConversation: async (id: string) =>
        ({
          id,
          title: `Chat number ${id.slice(1)}`,
          workspace: '/w',
          providerId: 'anthropic',
          model: 'claude-haiku-5-5',
          createdAt: 0,
          updatedAt: 0,
          messages: [
            { role: 'user', content: `hello from ${id}` },
            { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'dispatch_agent', arguments: { description: 'Trace', prompt: 'p' } }] },
            { role: 'tool', content: 'started in the background', toolCallId: 't1', toolName: 'dispatch_agent', subagents: [saved] },
            { role: 'assistant', content: 'it is working on it' }
          ]
        }) as Conversation
    })
    render(<App />)
    await settle()
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    expect(screen.getByText('agent-model')).toBeInTheDocument()
    // A running agent's chips count its current step; a stopped one doesn't.
    expect(screen.queryByText('step 1')).toBeNull()
  })
})

describe('App putting a message back in a message box', () => {
  const img = { mediaType: 'image/png', data: 'AA==' }
  const withImage = (id: string): Conversation =>
    ({
      id,
      title: `Chat number ${id.slice(1)}`,
      workspace: '/w',
      providerId: 'anthropic',
      model: 'claude-haiku-5-5',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'look at this', images: [img] },
        { role: 'assistant', content: 'a reply' }
      ]
    }) as Conversation

  it('keeps the images of a message rewound out of the chat', async () => {
    installApi(2, {
      getConversation: async (id: string) => withImage(id),
      previewRewind: async () => ({ ok: true, turns: 1, files: 0, conflicts: [], unavailable: 0 }),
      rewind: async () => ({ ok: true, messages: [], text: 'look at this', restored: 0, conflicts: [], unavailable: 0, undoable: true })
    })
    render(<App />)
    await settle()
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    fireEvent.change(composerBox(), { target: { value: '/rewind 1 conversation' } })
    fireEvent.keyDown(composerBox(), { key: 'Enter' })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    await settle()
    expect(composerBox().value).toBe('look at this')
    expect(document.querySelector('.composer__attachments img')).not.toBeNull()
  })

  it('keeps the images of the message a fork starts from', async () => {
    vi.mocked(appendComposerImages).mockClear()
    installApi(2, {
      getConversation: async (id: string) => withImage(id),
      forkConversationAt: async () => ({ id: 'c9' })
    })
    render(<App />)
    await settle()
    fireEvent.click(screen.getByText('Chat number 1'))
    await settle()
    fireEvent.change(composerBox(), { target: { value: '/fork 1' } })
    fireEvent.keyDown(composerBox(), { key: 'Enter' })
    await settle()
    expect(appendComposerImages).toHaveBeenCalledWith('c9', [img])
  })
})

describe('App closing Settings', () => {
  it('puts the saved theme back when Settings closes without saving the one it previewed', async () => {
    installApi(1, { saveSettings: vi.fn(async () => Promise.reject(new Error('disk full'))) })
    render(<App />)
    await settle()
    const saved = document.documentElement.dataset.theme
    fireEvent.keyDown(window, { key: ',', ctrlKey: true, metaKey: true })
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }))
    const preview = saved === 'light' ? 'dark' : 'light'
    fireEvent.change(screen.getByRole('combobox', { name: 'Color theme' }), { target: { value: preview } })
    await settle()
    expect(document.documentElement.dataset.theme).toBe(preview)
    // The save fails: the first close stays open with the error, the second leaves.
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    expect(await screen.findByText(/Could not save settings: disk full/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Back to app' })).toBeNull()
    expect(document.documentElement.dataset.theme).toBe(saved)
  })
})
