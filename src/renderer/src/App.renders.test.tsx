import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Conversation, ConversationMeta } from '@shared/agent'
import type { FileDiff } from '@shared/workingTree'
import { defaultSettings } from '@shared/defaults'
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
 * Anything not stubbed resolves to nothing.
 */
function installApi(chats: number) {
  const listeners = new Map<string, Set<Listener>>()
  const now = Date.now()
  const metas: ConversationMeta[] = Array.from({ length: chats }, (_, i) => ({
    id: `c${i}`,
    title: `Chat number ${i}`,
    workspace: '/w',
    providerId: 'anthropic',
    model: 'claude-haiku-5-5',
    createdAt: now - i * 3_600_000,
    updatedAt: now - i * 3_600_000
  }))
  const conversation = (id: string): Conversation =>
    ({ ...metas.find((m) => m.id === id), messages: [{ role: 'user', content: `hello from ${id}` }] }) as Conversation
  const settings = { ...defaultSettings(), recentWorkspaces: ['/w'], previewOpen: true }
  settings.selected = { providerId: settings.providers[0].id, model: settings.providers[0].models[0].id }
  const getConversation = vi.fn(async (id: string) => conversation(id))
  const stubs: Record<string, unknown> = {
    getSettings: async () => settings,
    getLaunchChat: async () => 'c0',
    listConversations: async () => metas,
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
    getWorkingTreeStats: async () => ({ isRepo: true, branch: 'main', fileCount: 3, added: 3, removed: 3 })
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
    emit(e: AgentEvent): void {
      for (const cb of listeners.get('onAgentEvent') ?? []) cb(e)
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
