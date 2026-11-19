import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Provider, ProviderStreamEvent } from '@shared/agent'

// A provider that stops a turn at a usage limit naming its reset: the run waits for the
// reset (here, the sleep returns at once) and carries on with the same turn.

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [], mcpServers: [], additionalRoots: [] } as Record<
    string,
    unknown
  >,
  sleeps: [] as number[],
  onSleep: null as (() => void) | null
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'p', kind: 'anthropic', label: 'P', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('./managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [], releaseMcpRun: () => {} }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
vi.mock('./plugins', () => ({
  loadPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  loadTrustedPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  readPluginFiles: async () => ({ files: [], skipped: [] })
}))
// Every wait returns at once, recorded (as the time it would last); a test can act
// during one (Stop).
vi.mock('./retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./retry')>()),
  abortableSleep: async (ms: number) => {
    h.sleeps.push(ms)
    h.onSleep?.()
  },
  sleepUntil: async (deadline: number) => {
    h.sleeps.push(deadline - Date.now())
    h.onSleep?.()
  }
}))

const { startRun, cancelRun } = await import('./loop')
const { MAX_LIMIT_WAITS } = await import('./retry')

const TWO_HOURS = 2 * 60 * 60_000
const limited: ProviderStreamEvent = {
  type: 'error',
  message: '429 usage limit reached for this plan',
  status: 429,
  retryAfterMs: TWO_HOURS
}
const answer: ProviderStreamEvent[] = [
  { type: 'text', text: 'carried on' },
  { type: 'done', stopReason: 'end_turn' }
]

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-limit-wait-'))
  h.sleeps = []
  h.onSleep = null
  delete h.settings.usageLimitWait
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

async function run(
  limitedCalls: number,
  opts: { unattended?: boolean } = {}
): Promise<{ calls: number; events: AgentEvent[]; runId: string }> {
  let calls = 0
  h.provider = {
    async *streamChat() {
      calls++
      if (calls <= limitedCalls) {
        yield limited
        return
      }
      for (const ev of answer) yield ev
    }
  }
  const events: AgentEvent[] = []
  const runId = `run-${Math.round(Math.random() * 1e9)}`
  await startRun(
    {
      runId,
      workspace: ws,
      providerId: 'p',
      model: 'claude-sonnet-5',
      approvalPolicy: 'full-auto',
      messages: [{ role: 'user', content: 'go' }],
      ...(opts.unattended ? { unattended: true } : {})
    },
    (e) => events.push(e)
  )
  return { calls, events, runId }
}

const limitWaits = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'retry' }> => e.type === 'retry' && e.throttle?.resetAt !== undefined)

describe('waiting out a usage limit', () => {
  it('waits for the reset the provider named and continues the same turn', async () => {
    const before = Date.now()
    const { calls, events } = await run(1)
    expect(calls).toBe(2)
    const waits = limitWaits(events)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toMatchObject({ attempt: 1, max: MAX_LIMIT_WAITS })
    const resetAt = waits[0].throttle?.resetAt ?? 0
    expect(resetAt).toBeGreaterThanOrEqual(before + TWO_HOURS)
    expect(resetAt).toBeLessThanOrEqual(Date.now() + TWO_HOURS)
    // One wait, of the whole time to the reset, not the capped retry delay.
    expect(h.sleeps).toHaveLength(1)
    expect(h.sleeps[0]).toBeGreaterThan(TWO_HOURS - 5_000)
    expect(events.some((e) => e.type === 'text' && e.delta === 'carried on')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('waits at most a few times a run, then fails as before', async () => {
    const { events } = await run(1_000)
    expect(limitWaits(events)).toHaveLength(MAX_LIMIT_WAITS)
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('fails at once when the setting is off', async () => {
    h.settings.usageLimitWait = false
    const { events } = await run(1_000)
    expect(limitWaits(events)).toHaveLength(0)
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('never waits on an unattended run', async () => {
    const { events } = await run(1_000, { unattended: true })
    expect(limitWaits(events)).toHaveLength(0)
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('stops when the run is cancelled during the wait', async () => {
    let id = ''
    h.onSleep = () => cancelRun(id)
    let calls = 0
    h.provider = {
      async *streamChat() {
        calls++
        yield limited
      }
    }
    const events: AgentEvent[] = []
    id = `run-${Math.round(Math.random() * 1e9)}`
    await startRun(
      {
        runId: id,
        workspace: ws,
        providerId: 'p',
        model: 'claude-sonnet-5',
        approvalPolicy: 'full-auto',
        messages: [{ role: 'user', content: 'go' }]
      },
      (e) => events.push(e)
    )
    expect(calls).toBe(1)
    expect(limitWaits(events)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })
  })
})
