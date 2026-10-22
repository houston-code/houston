import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/constants'
import { MAX_APPROVAL_NOTE } from '@shared/agent'

// Hoisted holders the mocks close over, so each test can steer run ownership and
// observe the loop resolvers the handlers call.
const h = vi.hoisted(() => ({
  // The native delete-confirmation dialog and the worktree probe/teardown it drives.
  showMessageBox: vi.fn(),
  isWorktreeDisposable: vi.fn(),
  removeWorktree: vi.fn(),
  // channel -> the handler registered via ipcMain.handle, captured at registerIpc().
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cancelRun: vi.fn(),
  resolveApproval: vi.fn(),
  resolveQuestion: vi.fn(),
  setRunPolicy: vi.fn(),
  setRunEffort: vi.fn(),
  steerRun: vi.fn<(runId: string, text: string) => boolean>(() => true),
  saveMemory: vi.fn<(ws: string, scope: string, text: string) => Promise<string>>(
    async (_ws, scope) => `/AGENTS.md#${scope}`
  ),
  // Spied so the agentStart/agentRetry tests can inspect the request the handler
  // hands the drain loop (in particular the validated approvalPolicy).
  runAndDrain: vi.fn(),
  // Configured per test to return the WebContents id that "owns" a run.
  runOwner: vi.fn<(runId: string) => number | undefined>(),
  // Steerable "is a run live on this conversation" — the checkpoint gate reads it.
  activeRun: vi.fn<(conversationId: string) => string | null>(() => null),
  // Electron 44's clipboard: both reads resolve, and an image comes back as a Blob
  // under an image/* MIME type rather than from the removed readImage().
  clipboard: {
    readText: vi.fn<() => Promise<string>>(async () => ''),
    read: vi.fn<() => Promise<unknown[]>>(async () => [])
  },
  // Stands in for Chromium's image decoder: any non-empty payload decodes, and toPNG
  // re-encodes it to PNG bytes whatever the source format was. Empty bytes are what the
  // real nativeImage reports for something that doesn't decode as an image at all.
  nativeImage: {
    createFromBuffer: vi.fn((buf: Buffer) => ({
      isEmpty: () => buf.length === 0,
      toPNG: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), buf])
    }))
  }
}))

// Mock electron so registerIpc can register (and we can capture) its handlers
// without a real Electron runtime. Nothing in the import graph touches an electron
// API at module load, so a sparse surface is enough.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
    on: () => {}
  },
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp', getName: () => 'Houston', on: () => {} },
  dialog: { showMessageBox: h.showMessageBox },
  clipboard: h.clipboard,
  nativeImage: h.nativeImage,
  shell: {},
  // The HTML-visual scheme handler is installed on the default session at registration.
  session: { defaultSession: { protocol: { handle: () => {} } } },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }
}))

// Mock the agent loop: the four run-control resolvers become spies, and runOwner is
// steerable so we can assert the handlers gate on the run's recorded owner.
vi.mock('./agent/loop', () => ({
  cancelRun: h.cancelRun,
  resolveApproval: h.resolveApproval,
  resolveQuestion: h.resolveQuestion,
  setRunPolicy: h.setRunPolicy,
  setRunEffort: h.setRunEffort,
  steerRun: h.steerRun,
  runOwner: h.runOwner,
  activeRunForConversation: h.activeRun,
  pendingPromptsForConversation: vi.fn(() => []),
  runningConversationIds: vi.fn(() => []),
  onActiveRunsChanged: vi.fn(() => () => {})
}))

// Mock the drain module so agentStart/agentRetry's runAndDrain is a spy — the tests
// assert on the request it receives without spinning up a real agent run.
vi.mock('./agent/drain', () => ({
  runAndDrain: h.runAndDrain,
  drainQueue: vi.fn()
}))
// Keep the real worktree module, but stub the probe and teardown the delete
// handler calls so its dialog choice can be tested without real git.
vi.mock('./agent/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent/worktree')>()),
  isWorktreeDisposable: h.isWorktreeDisposable,
  removeWorktree: h.removeWorktree
}))
// Don't touch the real filesystem for the `#`-capture handler.
vi.mock('./memory', () => ({ saveMemory: h.saveMemory }))

import { MAX_QUESTION_ANSWER_LEN, registerIpc, resolveDeleteAction } from './ipc'
// The real checkpoints module (not mocked): the gating tests drive actual snapshots.
import {
  recordOriginal,
  recordResult,
  noteConversationRun,
  clearCheckpoints,
  flushCheckpoints,
  turnFingerprint
} from './agent/checkpoints'
import { setUserDataDir } from './userData'
import {
  createConversation,
  deleteConversation,
  forkConversation,
  getConversation,
  setMessages
} from './conversations'
import { configureHasKey, updateSettings } from './store'

// registerIpc wires the scheduler, whose store lives under the profile directory.
// Production sets the userData seam before app.whenReady() (index.ts); mirror that
// invariant here so registering handlers doesn't trip the unconfigured-seam guard.
const MODULE_USER_DIR = mkdtempSync(join(tmpdir(), 'houston-ipc-userdata-'))
setUserDataDir(MODULE_USER_DIR)

/**
 * The delete-confirmation dialog used to be a two-button `window.confirm` whose
 * "Cancel" still deleted the chat (it only governed the worktree). These guard
 * the replacement: button 0 is always Cancel, so a cancel never deletes; only the
 * worktree dialog's button 2 tears a worktree with work in it down; and a clean,
 * merged worktree goes with the chat.
 */
describe('resolveDeleteAction', () => {
  it('treats button 0 as Cancel — never deletes — in every dialog', () => {
    for (const kind of ['plain', 'worktree', 'disposableWorktree'] as const) {
      expect(resolveDeleteAction(kind, 0)).toEqual({ delete: false, removeWorktree: false })
    }
  })

  it('deletes a plain chat on button 1, leaving no worktree to remove', () => {
    expect(resolveDeleteAction('plain', 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes a worktree chat but keeps the worktree on button 1', () => {
    expect(resolveDeleteAction('worktree', 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes and removes the worktree on button 2', () => {
    expect(resolveDeleteAction('worktree', 2)).toEqual({ delete: true, removeWorktree: true })
  })

  it('never removes a worktree that does not exist, even on button 2', () => {
    expect(resolveDeleteAction('plain', 2)).toEqual({ delete: true, removeWorktree: false })
  })

  it('removes a disposable worktree along with the chat on Delete', () => {
    expect(resolveDeleteAction('disposableWorktree', 1)).toEqual({
      delete: true,
      removeWorktree: true
    })
  })
})

/**
 * The delete handler probes the worktree before asking: an untouched worktree gets
 * the plain two-button confirmation and is removed with the chat, while one with
 * work in it still gets the keep/remove choice.
 */
describe('conversationDelete dialog', () => {
  const wt = { path: '/repo/.houston/worktrees/x', branch: 'brave-falcon', repoRoot: '/repo' }
  const del = (id: string): Promise<{ deleted: boolean; worktree: unknown }> =>
    h.handlers.get(IPC.conversationDelete)!({ sender: {} }, id) as Promise<{
      deleted: boolean
      worktree: unknown
    }>

  registerIpc()
  beforeEach(() => {
    h.showMessageBox.mockReset()
    h.isWorktreeDisposable.mockReset()
    h.removeWorktree.mockReset()
    h.removeWorktree.mockResolvedValue({ removed: true, branchDeleted: true })
  })

  it('skips the keep/remove choice and removes a clean, merged worktree', async () => {
    const conv = createConversation({ workspace: wt.path, providerId: 'p', model: 'm', worktree: wt })
    h.isWorktreeDisposable.mockResolvedValue(true)
    h.showMessageBox.mockResolvedValue({ response: 1 })
    const res = await del(conv.id)
    const opts = h.showMessageBox.mock.calls[0][1] as { buttons: string[]; detail: string }
    expect(opts.buttons).toEqual(['Cancel', 'Delete'])
    expect(opts.detail).toMatch(/will be removed too/)
    expect(opts.detail).not.toMatch(/—/)
    expect(h.removeWorktree).toHaveBeenCalledWith(wt)
    expect(res.deleted).toBe(true)
    expect(getConversation(conv.id)).toBeNull()
  })

  it('touches nothing when a clean worktree delete is cancelled', async () => {
    const conv = createConversation({ workspace: wt.path, providerId: 'p', model: 'm', worktree: wt })
    h.isWorktreeDisposable.mockResolvedValue(true)
    h.showMessageBox.mockResolvedValue({ response: 0 })
    expect((await del(conv.id)).deleted).toBe(false)
    expect(h.removeWorktree).not.toHaveBeenCalled()
    expect(getConversation(conv.id)).not.toBeNull()
    // Leave no chat behind on this worktree: a later test would see it as shared.
    deleteConversation(conv.id)
  })

  it('still offers keep/remove for a worktree with work in it', async () => {
    const conv = createConversation({ workspace: wt.path, providerId: 'p', model: 'm', worktree: wt })
    h.isWorktreeDisposable.mockResolvedValue(false)
    h.showMessageBox.mockResolvedValue({ response: 1 })
    const res = await del(conv.id)
    const opts = h.showMessageBox.mock.calls[0][1] as { buttons: string[]; detail: string }
    expect(opts.buttons).toEqual(['Cancel', 'Delete, keep worktree', 'Delete & remove worktree'])
    expect(opts.detail).not.toMatch(/—/)
    expect(h.removeWorktree).not.toHaveBeenCalled()
    expect(res.deleted).toBe(true)
  })

  it('never removes a worktree a fork still uses, even a clean one', async () => {
    const shared = { ...wt, path: '/repo/.houston/worktrees/shared', branch: 'shared' }
    const source = createConversation({ workspace: shared.path, providerId: 'p', model: 'm', worktree: shared })
    const fork = forkConversation(source.id)!
    h.isWorktreeDisposable.mockResolvedValue(true)
    h.showMessageBox.mockResolvedValue({ response: 1 })
    const res = await del(fork.id)
    const opts = h.showMessageBox.mock.calls[0][1] as { buttons: string[]; detail: string }
    expect(opts.buttons).toEqual(['Cancel', 'Delete'])
    expect(opts.detail).toMatch(/stays, because another chat still uses it/)
    expect(opts.detail).not.toMatch(/—/)
    expect(h.removeWorktree).not.toHaveBeenCalled()
    expect(res).toEqual({ deleted: true, worktree: null })
    expect(getConversation(source.id)?.worktree).toEqual(shared)

    // With the fork gone, the source is the worktree's last chat again.
    h.showMessageBox.mockClear()
    await del(source.id)
    expect(h.removeWorktree).toHaveBeenCalledWith(shared)
  })

  it('does not probe git for a chat without a worktree', async () => {
    const conv = createConversation({ workspace: '/repo', providerId: 'p', model: 'm' })
    h.showMessageBox.mockResolvedValue({ response: 1 })
    await del(conv.id)
    expect(h.isWorktreeDisposable).not.toHaveBeenCalled()
    expect((h.showMessageBox.mock.calls[0][1] as { buttons: string[] }).buttons).toEqual([
      'Cancel',
      'Delete'
    ])
  })
})

/**
 * Run-control IPC (approve / answer / set-policy / cancel) is authorized against the
 * run's OWNER — the WebContents that started it — not the runId alone. Every
 * AgentEvent broadcasts its runId to every window, so without this gate any window
 * that merely observed a runId could approve/deny another window's dangerous tool
 * call, inject an answer into its ask_user prompt, escalate it to full-auto, or
 * cancel it. Here the handlers are captured from a mocked ipcMain and driven with a
 * fake IpcMainInvokeEvent whose sender.id is (or isn't) the recorded owner.
 */
describe('run-control IPC ownership', () => {
  const OWNER = 7
  const OTHER = 99
  const RUN = 'run-1'
  const CALL = 'call-1'

  // A fake IpcMainInvokeEvent — only event.sender.id is read by the handlers.
  const from = (senderId: number) => ({ sender: { id: senderId } })
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }

  // Register the handlers once, then reset spies + point every run at OWNER.
  registerIpc()
  beforeEach(() => {
    vi.clearAllMocks()
    h.runOwner.mockReturnValue(OWNER)
  })

  describe('agentApprove', () => {
    it('resolves the approval when the owning window calls', () => {
      handler(IPC.agentApprove)(from(OWNER), RUN, CALL, 'allow')
      expect(h.resolveApproval).toHaveBeenCalledWith(RUN, CALL, 'allow', undefined)
    })

    it('passes the denial guidance through to the loop', () => {
      handler(IPC.agentApprove)(from(OWNER), RUN, CALL, 'deny', '  use staging  ')
      expect(h.resolveApproval).toHaveBeenCalledWith(RUN, CALL, 'deny', 'use staging')
    })

    it('caps a huge note at the boundary rather than trusting the renderer', () => {
      handler(IPC.agentApprove)(from(OWNER), RUN, CALL, 'deny', 'x'.repeat(9000))
      const note = h.resolveApproval.mock.calls.at(-1)?.[3] as string
      expect(note.length).toBe(MAX_APPROVAL_NOTE)
    })

    it('ignores a non-string note', () => {
      handler(IPC.agentApprove)(from(OWNER), RUN, CALL, 'deny', { evil: true })
      expect(h.resolveApproval).toHaveBeenCalledWith(RUN, CALL, 'deny', undefined)
    })

    it('rejects a mismatched-sender approve — the run is untouched', () => {
      handler(IPC.agentApprove)(from(OTHER), RUN, CALL, 'allow')
      expect(h.resolveApproval).not.toHaveBeenCalled()
    })

    it('keeps the isToolApprovalDecision guard: an off-list decision never reaches the loop', () => {
      handler(IPC.agentApprove)(from(OWNER), RUN, CALL, 'nonsense')
      expect(h.resolveApproval).not.toHaveBeenCalled()
    })
  })

  describe('memorySave', () => {
    it('saves a #-capture at the requested scope and returns the path', async () => {
      const path = await handler(IPC.memorySave)(from(OWNER), '/ws', 'project', '  always lint  ')
      expect(h.saveMemory).toHaveBeenCalledWith('/ws', 'project', 'always lint') // trimmed
      expect(path).toBe('/AGENTS.md#project')
    })

    it('rejects a bad scope, a non-string, or an empty note without touching disk', async () => {
      expect(await handler(IPC.memorySave)(from(OWNER), '/ws', 'nonsense', 'x')).toBeNull()
      expect(await handler(IPC.memorySave)(from(OWNER), '/ws', 'project', { evil: true })).toBeNull()
      expect(await handler(IPC.memorySave)(from(OWNER), '/ws', 'project', '   ')).toBeNull()
      expect(h.saveMemory).not.toHaveBeenCalled()
    })

    it('caps an oversized note at the boundary', async () => {
      await handler(IPC.memorySave)(from(OWNER), '/ws', 'global', 'x'.repeat(9000))
      const text = h.saveMemory.mock.calls.at(-1)?.[2] as string
      expect(text.length).toBe(2000) // MAX_MEMORY_NOTE
    })

    // A project save with no workspace would let the write land in the process cwd
    // and throw in mkdir(''); the renderer has no .catch, so it must not reach saveMemory.
    it('returns null for a project save with an empty workspace', async () => {
      expect(await handler(IPC.memorySave)(from(OWNER), '', 'project', 'note')).toBeNull()
      expect(await handler(IPC.memorySave)(from(OWNER), '   ', 'project', 'note')).toBeNull()
      expect(h.saveMemory).not.toHaveBeenCalled()
      // Global scope has no workspace to speak of, so an empty one is fine there.
      await handler(IPC.memorySave)(from(OWNER), '', 'global', 'note')
      expect(h.saveMemory).toHaveBeenCalledWith('', 'global', 'note')
    })
  })

  describe('agentSteer', () => {
    it('steers the run when the owning window calls', () => {
      handler(IPC.agentSteer)(from(OWNER), RUN, 'use YAML instead')
      expect(h.steerRun).toHaveBeenCalledWith(RUN, 'use YAML instead')
    })

    it('rejects a mismatched-sender steer — the run is untouched', () => {
      const r = handler(IPC.agentSteer)(from(OTHER), RUN, 'inject into another window’s run')
      expect(h.steerRun).not.toHaveBeenCalled()
      expect(r).toBe(false)
    })

    it('ignores a non-string payload', () => {
      const r = handler(IPC.agentSteer)(from(OWNER), RUN, { evil: true })
      expect(h.steerRun).not.toHaveBeenCalled()
      expect(r).toBe(false)
    })

    it('returns whether a live run accepted it (false → caller falls back to queuing)', () => {
      h.steerRun.mockReturnValueOnce(false)
      expect(handler(IPC.agentSteer)(from(OWNER), RUN, 'too late, run ended')).toBe(false)
    })
  })

  describe('agentRespondQuestion', () => {
    it('delivers the answer when the owning window calls', () => {
      handler(IPC.agentRespondQuestion)(from(OWNER), RUN, CALL, 'Postgres')
      expect(h.resolveQuestion).toHaveBeenCalledWith(RUN, CALL, 'Postgres')
    })

    it('rejects a mismatched-sender answer — no answer is injected', () => {
      handler(IPC.agentRespondQuestion)(from(OTHER), RUN, CALL, 'evil')
      expect(h.resolveQuestion).not.toHaveBeenCalled()
    })

    it('rejects a non-string answer', () => {
      handler(IPC.agentRespondQuestion)(from(OWNER), RUN, CALL, { not: 'a string' })
      expect(h.resolveQuestion).not.toHaveBeenCalled()
    })

    it('caps an over-long answer at MAX_QUESTION_ANSWER_LEN before it reaches the loop', () => {
      const huge = 'x'.repeat(MAX_QUESTION_ANSWER_LEN + 5_000)
      handler(IPC.agentRespondQuestion)(from(OWNER), RUN, CALL, huge)
      expect(h.resolveQuestion).toHaveBeenCalledTimes(1)
      const delivered = h.resolveQuestion.mock.calls[0][2] as string
      expect(delivered).toHaveLength(MAX_QUESTION_ANSWER_LEN)
      expect(delivered).toBe(huge.slice(0, MAX_QUESTION_ANSWER_LEN))
    })
  })

  describe('agentSetPolicy', () => {
    it('sets the policy when the owning window calls', () => {
      handler(IPC.agentSetPolicy)(from(OWNER), RUN, 'full-auto')
      expect(h.setRunPolicy).toHaveBeenCalledWith(RUN, 'full-auto')
    })

    it('rejects a mismatched-sender policy change — no silent escalation to full-auto', () => {
      handler(IPC.agentSetPolicy)(from(OTHER), RUN, 'full-auto')
      expect(h.setRunPolicy).not.toHaveBeenCalled()
    })
  })

  describe('agentSetEffort', () => {
    it('sets the effort when the owning window calls', () => {
      handler(IPC.agentSetEffort)(from(OWNER), RUN, 'low')
      expect(h.setRunEffort).toHaveBeenCalledWith(RUN, 'low')
    })

    it("rejects a change from a window that doesn't own the run", () => {
      handler(IPC.agentSetEffort)(from(OTHER), RUN, 'low')
      expect(h.setRunEffort).not.toHaveBeenCalled()
    })
  })

  describe('agentCancel', () => {
    it('cancels the run when the owning window calls', () => {
      handler(IPC.agentCancel)(from(OWNER), RUN)
      expect(h.cancelRun).toHaveBeenCalledWith(RUN)
    })

    it('rejects a mismatched-sender cancel — the run keeps going', () => {
      handler(IPC.agentCancel)(from(OTHER), RUN)
      expect(h.cancelRun).not.toHaveBeenCalled()
    })
  })

  // A finished/unknown run has no recorded owner; runOwner returns undefined and the
  // loop resolvers already no-op on unknown runIds, so the gate lets the call through
  // rather than depending on which window happens to still be open.
  it('allows a call for a run with no recorded owner (finished/unknown)', () => {
    h.runOwner.mockReturnValue(undefined)
    handler(IPC.agentCancel)(from(OTHER), RUN)
    expect(h.cancelRun).toHaveBeenCalledWith(RUN)
  })
})

/**
 * Checkpoint restore/reapply cannot be gated on a run owner — a checkpoint
 * deliberately outlives its run (persisted across restarts), so by the time the
 * revert button is clicked there is no owner left to compare. The gate instead
 * requires the runId to be some conversation's LATEST turn (what the UI offers)
 * on a conversation with no live run. These drive the real checkpoints module
 * through the registered handlers.
 */
describe('checkpoint restore/reapply gating', () => {
  registerIpc()
  const from = (senderId: number) => ({ sender: { id: senderId } })
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }

  let ws: string
  let cpUserDir: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-ipc-cp-'))
    // A fresh persistence dir per test: recordOriginal now re-hydrates a run's snapshot
    // from disk on an in-memory miss, so a shared checkpoints dir + reused runId would
    // let one test's on-disk snapshot leak into the next (clearCheckpoints is memory-only).
    cpUserDir = mkdtempSync(join(tmpdir(), 'houston-ipc-cp-ud-'))
    setUserDataDir(cpUserDir)
    h.activeRun.mockReturnValue(null)
  })

  afterEach(async () => {
    h.activeRun.mockReturnValue(null)
    await flushCheckpoints() // let any queued disk write settle before clearing
    clearCheckpoints()
    rmSync(ws, { recursive: true, force: true })
    rmSync(cpUserDir, { recursive: true, force: true })
    setUserDataDir(MODULE_USER_DIR) // restore for later describes (createConversation)
  })

  /** Record one modified file as `runId`, the latest turn of `conversationId`. */
  async function recordTurn(conversationId: string, runId: string): Promise<string> {
    const f = join(ws, 'a.txt')
    writeFileSync(f, 'original')
    noteConversationRun(conversationId, runId)
    await recordOriginal(runId, [ws], 'a.txt')
    writeFileSync(f, 'modified')
    await recordResult(runId, [ws], 'a.txt')
    return f
  }

  it('restores the latest turn of an idle conversation', async () => {
    const f = await recordTurn('conv-cp', 'run-cp')
    expect(await handler(IPC.checkpointRestore)(from(1), 'run-cp')).toBe(1)
    expect(readFileSync(f, 'utf8')).toBe('original')
  })

  it('refuses a runId that is no longer the conversation latest turn', async () => {
    const f = await recordTurn('conv-cp', 'run-old')
    noteConversationRun('conv-cp', 'run-new') // a newer turn replaced it
    expect(await handler(IPC.checkpointRestore)(from(1), 'run-old')).toBe(0)
    expect(readFileSync(f, 'utf8')).toBe('modified') // files untouched
  })

  it('refuses a restore while the conversation is mid-run', async () => {
    const f = await recordTurn('conv-cp', 'run-cp')
    h.activeRun.mockReturnValue('run-live')
    expect(await handler(IPC.checkpointRestore)(from(1), 'run-cp')).toBe(0)
    expect(readFileSync(f, 'utf8')).toBe('modified')
  })

  it('refuses an unknown runId', async () => {
    expect(await handler(IPC.checkpointRestore)(from(1), 'run-unknown')).toBe(0)
  })

  it('gates reapply the same way', async () => {
    const f = await recordTurn('conv-cp', 'run-cp')
    expect(await handler(IPC.checkpointRestore)(from(1), 'run-cp')).toBe(1) // allowed
    noteConversationRun('conv-cp', 'run-new') // then a newer turn supersedes it
    expect(await handler(IPC.checkpointReapply)(from(1), 'run-cp')).toBe(0)
    expect(readFileSync(f, 'utf8')).toBe('original') // still reverted
  })
})

/**
 * Rewind over IPC: the handlers validate every argument before it reaches the store
 * or the filesystem, and refuse while the conversation has a live run (whoever owns
 * it). These drive the real rewind, checkpoints, and conversation store.
 */
describe('rewind IPC', () => {
  registerIpc()
  const from = (senderId: number) => ({ sender: { id: senderId } })
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }

  let ws: string
  let userDir: string
  let convId: string

  beforeEach(async () => {
    ws = mkdtempSync(join(tmpdir(), 'houston-ipc-rw-'))
    userDir = mkdtempSync(join(tmpdir(), 'houston-ipc-rw-ud-'))
    setUserDataDir(userDir)
    h.activeRun.mockReturnValue(null)
    convId = createConversation({ workspace: ws, providerId: 'p', model: 'm' }).id
    // One turn that changed a.txt.
    const user = { role: 'user' as const, content: 'make it so' }
    setMessages(convId, [user, { role: 'assistant', content: 'done' }])
    writeFileSync(join(ws, 'a.txt'), 'original')
    noteConversationRun(convId, 'run-rw', { index: 0, fp: turnFingerprint(user) })
    await recordOriginal('run-rw', [ws], 'a.txt')
    writeFileSync(join(ws, 'a.txt'), 'modified')
    await recordResult('run-rw', [ws], 'a.txt')
  })

  afterEach(async () => {
    h.activeRun.mockReturnValue(null)
    await flushCheckpoints()
    clearCheckpoints()
    rmSync(ws, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
    setUserDataDir(MODULE_USER_DIR)
  })

  it('previews, applies, and undoes a rewind', async () => {
    expect(await handler(IPC.rewindPreview)(from(1), convId, 0, 'both', 'make it so')).toEqual({
      ok: true,
      turns: 1,
      files: 1,
      conflicts: [],
      unavailable: 0
    })
    const r = (await handler(IPC.rewindApply)(from(1), convId, 0, 'both', 'make it so')) as { ok: boolean }
    expect(r).toMatchObject({ ok: true, restored: 1, text: 'make it so', messages: [] })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('original')
    expect(handler(IPC.rewindCanUndo)(from(1), convId)).toBe(true)

    expect(await handler(IPC.rewindUndo)(from(2), convId)).toMatchObject({ ok: true, reapplied: 1 })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('modified')
    expect(getConversation(convId)?.messages).toHaveLength(2)
  })

  it('refuses while the conversation has a live run', async () => {
    h.activeRun.mockReturnValue('run-live')
    expect(await handler(IPC.rewindApply)(from(1), convId, 0, 'both', 'make it so')).toMatchObject({
      ok: false
    })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('modified')
    expect(getConversation(convId)?.messages).toHaveLength(2)
  })

  it.each([
    ['a non-string conversation id', [42, 0, 'both', 'make it so']],
    ['a traversal conversation id', ['../../etc', 0, 'both', 'make it so']],
    ['a negative turn', [null, -1, 'both', 'make it so']],
    ['a fractional turn', [null, 0.5, 'both', 'make it so']],
    ['a string turn', [null, '0', 'both', 'make it so']],
    ['an unknown mode', [null, 0, 'everything', 'make it so']],
    ['a missing text', [null, 0, 'both', undefined]],
    ['an oversized text', [null, 0, 'both', 'x'.repeat(1_000_001)]],
    ['a text that no longer matches', [null, 0, 'both', 'something else']]
  ])('refuses %s, changing nothing', async (_label, args) => {
    const [id, ...rest] = args as unknown[]
    const call = [id ?? convId, ...rest]
    expect(await handler(IPC.rewindPreview)(from(1), ...call)).toMatchObject({ ok: false })
    expect(await handler(IPC.rewindApply)(from(1), ...call)).toMatchObject({ ok: false })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('modified')
    expect(getConversation(convId)?.messages).toHaveLength(2)
  })

  it('refuses to start a run while a rewind is in flight, before appending the message', async () => {
    // The refusal is an agent event, and emitting one checks the notification setting.
    configureHasKey(() => false)
    updateSettings({ desktopNotifications: false })
    const send = vi.fn()
    const sender = { id: 1, send, isDestroyed: () => false }
    const pending = handler(IPC.rewindApply)(from(1), convId, 0, 'both', 'make it so')
    await handler(IPC.agentStart)({ sender }, {
      runId: 'r-mid', conversationId: convId, providerId: 'p', model: 'm', approvalPolicy: 'ask', userText: 'next'
    })
    await pending
    expect(h.runAndDrain).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      IPC.agentEvent,
      expect.objectContaining({ type: 'error', message: expect.stringContaining('being rewound') })
    )
    // The rewind's log stands; the refused message was never appended.
    expect(getConversation(convId)?.messages).toEqual([])
  })

  it('refuses a malformed undo and reports nothing to undo', async () => {
    expect(await handler(IPC.rewindUndo)(from(1), { id: convId })).toMatchObject({ ok: false })
    expect(handler(IPC.rewindCanUndo)(from(1), 7)).toBe(false)
    expect(await handler(IPC.rewindUndo)(from(1), convId)).toMatchObject({ ok: false })
  })
})

/**
 * /skills and /agents list the workspace's capabilities. The IPC must project to
 * {name, description} only — an agent's full system prompt (its file body) must
 * never cross into the renderer just to render a name list.
 */
describe('capability listing IPC (skills / agents)', () => {
  registerIpc()
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }
  const event = {} // these handlers ignore the IpcMainInvokeEvent

  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-ipc-cap-'))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('lists skills as {name, description}', async () => {
    mkdirSync(join(ws, '.houston/skills/foo'), { recursive: true })
    writeFileSync(join(ws, '.houston/skills/foo/SKILL.md'), '---\nname: foo\ndescription: Does foo\n---\nbody')
    expect(await handler(IPC.skillsList)(event, ws)).toEqual([{ name: 'foo', description: 'Does foo' }])
  })

  it('lists agents without leaking the system prompt', async () => {
    mkdirSync(join(ws, '.houston/agents'), { recursive: true })
    writeFileSync(
      join(ws, '.houston/agents/security.md'),
      '---\ndescription: Reviews for vulns\n---\nYou are a SECRET reviewer prompt.'
    )
    const res = await handler(IPC.agentsList)(event, ws)
    expect(res).toEqual([{ name: 'security', description: 'Reviews for vulns' }])
    // The body (system prompt) must not cross the IPC boundary.
    expect(JSON.stringify(res)).not.toContain('SECRET')
  })

  it('returns [] for a blank workspace', async () => {
    expect(await handler(IPC.skillsList)(event, '')).toEqual([])
    expect(await handler(IPC.agentsList)(event, '')).toEqual([])
  })
})

/**
 * agentStart/agentRetry accept the approval policy from the renderer. An unknown value
 * would fail OPEN downstream (needsApproval auto-approves any non-'ask' policy;
 * isBlockedByPlan stops guarding), so the handlers must validate it at the boundary —
 * mirroring the mid-run setRunPolicy path — and coerce anything off the list to 'plan'.
 */
describe('agentStart / agentRetry approval-policy validation', () => {
  const SENDER = 5
  const from = (senderId: number) => ({ sender: { id: senderId } })
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }
  const policyOf = (): string =>
    (h.runAndDrain.mock.calls[0][2] as { approvalPolicy: string }).approvalPolicy
  const freshConv = (): string =>
    createConversation({ workspace: '/tmp/ws', providerId: 'p', model: 'm' }).id

  registerIpc()
  beforeEach(() => {
    vi.clearAllMocks()
    h.activeRun.mockReturnValue(null)
  })

  it('coerces an unknown policy to the most restrictive (agentStart)', async () => {
    await handler(IPC.agentStart)(from(SENDER), {
      runId: 'r1', conversationId: freshConv(), providerId: 'p', model: 'm',
      approvalPolicy: 'yolo', userText: 'hi'
    })
    expect(h.runAndDrain).toHaveBeenCalledTimes(1)
    expect(policyOf()).toBe('plan')
  })

  it('passes a valid policy through unchanged (agentStart)', async () => {
    await handler(IPC.agentStart)(from(SENDER), {
      runId: 'r1', conversationId: freshConv(), providerId: 'p', model: 'm',
      approvalPolicy: 'full-auto', userText: 'hi'
    })
    expect(policyOf()).toBe('full-auto')
  })

  it('coerces an unknown policy to the most restrictive (agentRetry)', async () => {
    await handler(IPC.agentRetry)(from(SENDER), {
      runId: 'r2', conversationId: freshConv(), providerId: 'p', model: 'm',
      approvalPolicy: 'nonsense'
    })
    expect(h.runAndDrain).toHaveBeenCalledTimes(1)
    expect(policyOf()).toBe('plan')
  })

  it('a resend of a message whose turn failed replaces it rather than stacking a copy (agentStart)', async () => {
    const id = freshConv()
    const send = (runId: string, userText: string): unknown =>
      handler(IPC.agentStart)(from(SENDER), {
        runId, conversationId: id, providerId: 'p', model: 'm', approvalPolicy: 'ask', userText
      })
    await send('r1', 'start the dev server') // the run fails before answering (drain is a spy)
    await send('r2', 'start the dev server')
    expect(getConversation(id)?.messages).toEqual([{ role: 'user', content: 'start the dev server' }])
    const sent = h.runAndDrain.mock.calls[1][2] as { messages: unknown[] }
    expect(sent.messages).toEqual([{ role: 'user', content: 'start the dev server' }])
    // A different message is still appended.
    await send('r3', 'use port 4000')
    expect(getConversation(id)?.messages).toHaveLength(2)
  })

  it('persists a switched provider/model on retry (updateConversationMeta)', async () => {
    const id = createConversation({ workspace: '/tmp/ws', providerId: 'p', model: 'm' }).id
    await handler(IPC.agentRetry)(from(SENDER), {
      runId: 'r3', conversationId: id, providerId: 'q', model: 'm2', approvalPolicy: 'ask'
    })
    // Without this, the retry runs under q/m2 while the stored meta still says p/m,
    // mis-attributing the turn in the scorecard.
    const updated = getConversation(id)
    expect(updated?.providerId).toBe('q')
    expect(updated?.model).toBe('m2')
  })

  it("records the turn's effort and validated policy as the chat's own, and runs under them", async () => {
    const id = freshConv()
    await handler(IPC.agentStart)(from(SENDER), {
      runId: 'r1', conversationId: id, providerId: 'q', model: 'n',
      approvalPolicy: 'auto-edit', reasoningEffort: 'low', userText: 'hi'
    })
    expect(getConversation(id)).toMatchObject({
      providerId: 'q', model: 'n', approvalPolicy: 'auto-edit', reasoningEffort: 'low'
    })
    expect(h.runAndDrain.mock.calls[0][2]).toMatchObject({ approvalPolicy: 'auto-edit', reasoningEffort: 'low' })
  })

  it('stores the coerced policy, never the unknown one, and drops an unknown effort', async () => {
    const id = freshConv()
    await handler(IPC.agentRetry)(from(SENDER), {
      runId: 'r2', conversationId: id, providerId: 'p', model: 'm',
      approvalPolicy: 'yolo', reasoningEffort: 'max'
    })
    expect(getConversation(id)?.approvalPolicy).toBe('plan')
    expect(getConversation(id)?.reasoningEffort).toBeUndefined()
    expect(h.runAndDrain.mock.calls[0][2]).not.toHaveProperty('reasoningEffort')
  })

  it("conversationSetSettings saves one chat's change and returns its meta", async () => {
    const id = freshConv()
    const meta = await handler(IPC.conversationSetSettings)(from(SENDER), id, {
      approvalPolicy: 'plan',
      reasoningEffort: 'xhigh'
    })
    expect(meta).toMatchObject({ id, approvalPolicy: 'plan', reasoningEffort: 'xhigh' })
  })

  it('conversationCreate stores the new chat\'s settings, dropping unknown ones', async () => {
    const conv = (await handler(IPC.conversationCreate)(from(SENDER), {
      workspace: '/tmp/ws', providerId: 'p', model: 'm', reasoningEffort: 'medium', approvalPolicy: 'bogus'
    })) as { id: string }
    expect(getConversation(conv.id)?.reasoningEffort).toBe('medium')
    expect(getConversation(conv.id)?.approvalPolicy).toBeUndefined()
  })
})

/**
 * Electron 44 replaced the synchronous clipboard with Chromium's asynchronous,
 * W3C-shaped API: `readText()` resolves, `readImage()` is gone, and an image arrives as
 * a Blob under whichever `image/*` MIME type the source app offered. The handler has to
 * flatten all of that into the one shape the composer consumes — `{ text, image }` with
 * the image always PNG — and a clipboard that rejects (locked by another process) has to
 * read as an empty clipboard, not as a failed paste.
 */
describe('clipboardRead', () => {
  registerIpc()
  const handler = (channel: string): ((...args: unknown[]) => unknown) => {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return fn
  }
  const event = {} // the handler ignores the IpcMainInvokeEvent
  const read = (): Promise<{ text: string; image: { mediaType: string; data: string } | null }> =>
    handler(IPC.clipboardRead)(event) as Promise<{
      text: string
      image: { mediaType: string; data: string } | null
    }>

  /** A ClipboardItem as clipboard.read() hands it back: a type list + a lazy getType(). */
  const item = (payloads: Record<string, Buffer | object>) => ({
    types: Object.keys(payloads),
    getType: vi.fn(async (t: string) => {
      const payload = payloads[t]
      return Buffer.isBuffer(payload) ? new Blob([new Uint8Array(payload)]) : payload
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    h.clipboard.readText.mockResolvedValue('')
    h.clipboard.read.mockResolvedValue([])
  })

  it('returns the clipboard text when there is no image', async () => {
    h.clipboard.readText.mockResolvedValue('hello')
    expect(await read()).toEqual({ text: 'hello', image: null })
  })

  it('re-encodes an image payload to PNG and reads only the image representation', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const entry = item({ 'text/html': Buffer.from('<b>hi</b>'), 'image/jpeg': jpeg })
    h.clipboard.readText.mockResolvedValue('hi')
    h.clipboard.read.mockResolvedValue([entry])

    const res = await read()
    expect(res.text).toBe('hi')
    // Always PNG, whatever the source app put on the clipboard.
    expect(res.image).toEqual({
      mediaType: 'image/png',
      data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), jpeg]).toString('base64')
    })
    // getType() is lazy, so the non-image representation is never materialized.
    expect(entry.getType).toHaveBeenCalledTimes(1)
    expect(entry.getType).toHaveBeenCalledWith('image/jpeg')
  })

  it('drops an image over the per-image cap but still pastes the text', async () => {
    h.clipboard.readText.mockResolvedValue('caption')
    h.clipboard.read.mockResolvedValue([item({ 'image/png': Buffer.alloc(6 * 1024 * 1024, 1) })])
    expect(await read()).toEqual({ text: 'caption', image: null })
  })

  it('ignores an entry with no image representation', async () => {
    h.clipboard.read.mockResolvedValue([item({ 'text/html': Buffer.from('<b>hi</b>') })])
    expect((await read()).image).toBeNull()
  })

  it('ignores bytes that do not decode as an image', async () => {
    h.clipboard.read.mockResolvedValue([item({ 'image/png': Buffer.alloc(0) })])
    expect((await read()).image).toBeNull()
  })

  it('ignores an image type whose payload is not a Blob', async () => {
    // getType() resolves to a plain object for the bookmark format; a source app can
    // offer any type, so the handler must not assume every payload is a Blob.
    h.clipboard.read.mockResolvedValue([item({ 'image/png': { title: 'x', url: 'y' } })])
    expect((await read()).image).toBeNull()
  })

  it('reads as an empty clipboard when the OS clipboard is unavailable', async () => {
    h.clipboard.readText.mockRejectedValue(new Error('clipboard locked'))
    h.clipboard.read.mockRejectedValue(new Error('clipboard locked'))
    // A rejection here would surface in the renderer as a failed paste instead.
    await expect(read()).resolves.toEqual({ text: '', image: null })
  })
})

/**
 * The Tasks panel's Stop and output-tail calls reach the shell registry by id. Only
 * the registry's own 8-hex ids are accepted; anything else is refused before the
 * registry is consulted, so the renderer can't steer a kill or read at a guessed key.
 */
describe('background shell IPC (Tasks panel)', () => {
  beforeEach(() => {
    h.handlers.clear()
    registerIpc()
  })

  const call = (channel: string, id: unknown): unknown => h.handlers.get(channel)!({ sender: {} }, id)

  it('refuses ids that are not registry ids', async () => {
    for (const bad of [undefined, 42, '', '../x', 'ABCDEF12', 'abcdef123', { id: 'abcdef12' }]) {
      expect(await call(IPC.shellStop, bad)).toBe('not-found')
      expect(await call(IPC.shellTail, bad)).toBeNull()
    }
  })

  it('tails and stops a real background shell', async () => {
    const { registerShell } = await import('./agent/shells')
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'console.log("hello from the server"); setInterval(() => {}, 1000)'])
    const id = registerShell('node server.js', child)
    await vi.waitFor(async () => expect(await call(IPC.shellTail, id)).toEqual(['hello from the server']))
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
    expect(await call(IPC.shellStop, id)).toBe('killed')
    await closed
    expect(await call(IPC.shellStop, id)).toBe('already-exited')
  })
})
