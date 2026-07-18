import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/constants'
import { MAX_APPROVAL_NOTE } from '@shared/agent'

// Hoisted holders the mocks close over, so each test can steer run ownership and
// observe the loop resolvers the handlers call.
const h = vi.hoisted(() => ({
  // channel -> the handler registered via ipcMain.handle, captured at registerIpc().
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cancelRun: vi.fn(),
  resolveApproval: vi.fn(),
  resolveQuestion: vi.fn(),
  setRunPolicy: vi.fn(),
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
  activeRun: vi.fn<(conversationId: string) => string | null>(() => null)
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
  dialog: {},
  clipboard: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }
}))

// Mock the agent loop: the four run-control resolvers become spies, and runOwner is
// steerable so we can assert the handlers gate on the run's recorded owner.
vi.mock('./agent/loop', () => ({
  cancelRun: h.cancelRun,
  resolveApproval: h.resolveApproval,
  resolveQuestion: h.resolveQuestion,
  setRunPolicy: h.setRunPolicy,
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
// Don't touch the real filesystem for the `#`-capture handler.
vi.mock('./memory', () => ({ saveMemory: h.saveMemory }))

import { MAX_QUESTION_ANSWER_LEN, registerIpc, resolveDeleteAction } from './ipc'
// The real checkpoints module (not mocked): the gating tests drive actual snapshots.
import {
  recordOriginal,
  recordResult,
  noteConversationRun,
  clearCheckpoints,
  flushCheckpoints
} from './agent/checkpoints'
import { setUserDataDir } from './userData'
import { createConversation, getConversation } from './conversations'

// registerIpc wires the scheduler, whose store lives under the profile directory.
// Production sets the userData seam before app.whenReady() (index.ts); mirror that
// invariant here so registering handlers doesn't trip the unconfigured-seam guard.
const MODULE_USER_DIR = mkdtempSync(join(tmpdir(), 'houston-ipc-userdata-'))
setUserDataDir(MODULE_USER_DIR)

/**
 * The delete-confirmation dialog used to be a two-button `window.confirm` whose
 * "Cancel" still deleted the chat (it only governed the worktree). These guard
 * the replacement: button 0 is always Cancel, so a cancel never deletes, and only
 * the worktree dialog's button 2 tears the worktree down.
 */
describe('resolveDeleteAction', () => {
  it('treats button 0 as Cancel — never deletes — for a plain chat', () => {
    expect(resolveDeleteAction(false, 0)).toEqual({ delete: false, removeWorktree: false })
  })

  it('treats button 0 as Cancel — never deletes — for a worktree chat', () => {
    expect(resolveDeleteAction(true, 0)).toEqual({ delete: false, removeWorktree: false })
  })

  it('deletes a plain chat on button 1, leaving no worktree to remove', () => {
    expect(resolveDeleteAction(false, 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes a worktree chat but keeps the worktree on button 1', () => {
    expect(resolveDeleteAction(true, 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes and removes the worktree on button 2', () => {
    expect(resolveDeleteAction(true, 2)).toEqual({ delete: true, removeWorktree: true })
  })

  it('never removes a worktree that does not exist, even on button 2', () => {
    expect(resolveDeleteAction(false, 2)).toEqual({ delete: true, removeWorktree: false })
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
})
