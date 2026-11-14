import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SYSTEM_NOTE_PREFIX,
  type AgentEvent,
  type ChatMessage,
  type Provider,
  type ProviderStreamEvent,
  type ToolApprovalDecision
} from '@shared/agent'
import type { Hook, PermissionRule } from '@shared/types'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'

// Integration coverage for the Agent Skills format in the loop: a loaded skill's
// `allowed-tools` narrowing what runs, and `paths:` globs surfacing a skill once.
// The same harness as loop.hooks.test.ts (mocked host, provider and sandbox).

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [] as Hook[], mcpServers: [], additionalRoots: [] } as Record<string, unknown>,
  // A queue of results per hook command (shifted per call); falls back to static.
  script: {} as Record<string, Array<Partial<SandboxRunResult>>>,
  static: {} as Record<string, Partial<SandboxRunResult>>,
  calls: [] as SandboxRunOptions[],
  // Side effects a hook command has when it runs (e.g. rewriting a file, the way
  // a formatter hook would), keyed like `script`.
  effects: {} as Record<string, () => void>,
  // Admin managed-policy rules (highest-precedence, tighten-only tier), injected
  // through the `./managedPolicy` mock below; default none.
  managedRules: [] as PermissionRule[],
  // What isSandboxed() reports. Real hosts differ (macOS confines, Linux CI often
  // doesn't), which changes shell-approval behavior — so tests pin it. Default true
  // (a confining host, the behavior these tests were written against).
  sandboxed: true
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', label: 'A', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
// The admin managed policy normally reads a fixed root-owned system path; in tests
// we inject its rules through the hoisted holder instead of touching the real path.
vi.mock('./managedPolicy', () => ({
  loadManagedPolicy: async () => ({ permissionRules: h.managedRules })
}))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [], releaseMcpRun: () => {} }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
vi.mock('./plugins', () => ({
  loadPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  loadPluginsIfEnabled: async () => ({ has: () => false, size: 0, emit: async () => {} })
}))
// Fake the sandbox runner so hooks don't spawn real processes, and pin isSandboxed
// so shell-approval behavior doesn't vary by host; every other sandbox export stays
// real so the loop's approval logic is otherwise unchanged.
vi.mock('../sandbox', async (importActual) => {
  const actual = await importActual<typeof import('../sandbox')>()
  return {
    ...actual,
    isSandboxed: () => h.sandboxed,
    runSandboxed: async (o: SandboxRunOptions): Promise<SandboxRunResult> => {
      h.calls.push(o)
      h.effects[o.command]?.()
      const queued = h.script[o.command]?.shift()
      const r = queued ?? h.static[o.command] ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0, timedOut: false, sandboxed: true }
    }
  }
})

const { startRun, resolveApproval } = await import('./loop')

/** A provider that replays one pre-scripted turn per streamChat call. */
function scripted(turns: ProviderStreamEvent[][]): Provider & { calls: number } {
  const p = {
    calls: 0,
    async *streamChat() {
      const turn = turns[p.calls++] ?? [{ type: 'done', stopReason: 'end_turn' } as ProviderStreamEvent]
      for (const ev of turn) yield ev
    }
  }
  return p
}

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-loophooks-'))
  h.settings.hooks = []
  h.settings.permissionRules = []
  h.script = {}
  h.static = {}
  h.calls = []
  h.effects = {}
  h.managedRules = []
  h.sandboxed = true
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function run(opts: {
  turns?: ProviderStreamEvent[][]
  provider?: Provider
  userText?: string
  messages?: ChatMessage[]
  onApproval?: (callId: string, decide: (d: ToolApprovalDecision) => void) => void
}): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  h.provider = opts.provider ?? scripted(opts.turns ?? [])
  const runId = `run-${Math.round(Math.random() * 1e9)}`
  const events: AgentEvent[] = []
  let messages: ChatMessage[] = []
  await startRun(
    {
      runId,
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      messages: opts.messages ?? [{ role: 'user', content: opts.userText ?? 'do it' }]
    },
    (e) => {
      events.push(e)
      if (e.type === 'tool_approval' && opts.onApproval) {
        // Respond on a later tick — the loop registers the approval resolver on the
        // line *after* it emits tool_approval, just as the real renderer replies async.
        setTimeout(() => opts.onApproval!(e.callId, (d) => resolveApproval(runId, e.callId, d)), 0)
      }
    },
    (m) => {
      messages = m
    }
  )
  return { events, messages }
}

function writeSkill(name: string, fm: string): void {
  mkdirSync(join(ws, '.agents', 'skills', name), { recursive: true })
  writeFileSync(join(ws, '.agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${fm}\n---\nFollow these steps.\n`)
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): ProviderStreamEvent => ({
  type: 'tool_call',
  call: { id, name, arguments: args }
})
const done = (stopReason: 'tool_use' | 'end_turn' = 'tool_use'): ProviderStreamEvent => ({ type: 'done', stopReason })

const resultFor = (messages: ChatMessage[], id: string): string =>
  String(messages.find((m) => m.role === 'tool' && m.toolCallId === id)?.content ?? '')

describe('Agent Skills format in the loop', () => {
  it("refuses a tool the active skill's allowed-tools leaves out, and still runs the allowed ones", async () => {
    writeSkill('readonly', 'description: Look but do not touch.\nallowed-tools: Read')
    writeFileSync(join(ws, 'a.txt'), 'hello')
    const { messages } = await run({
      turns: [
        [toolCall('s1', 'skill', { name: 'readonly' }), done()],
        [toolCall('w1', 'write_file', { path: 'b.txt', content: 'x' }), toolCall('r1', 'read_file', { path: 'a.txt' }), done()],
        [{ type: 'text', text: 'done' }, done('end_turn')]
      ],
      // Were the write not refused it would ask; approving makes a regression visible.
      onApproval: (_id, decide) => decide('allow')
    })
    expect(resultFor(messages, 's1')).toContain('only these tools run: Read')
    expect(resultFor(messages, 'w1')).toContain('Not run: the "readonly" skill')
    expect(existsSync(join(ws, 'b.txt'))).toBe(false)
    expect(resultFor(messages, 'r1')).toContain('hello')
  })

  it('leaves every tool alone before a restricting skill is loaded', async () => {
    writeSkill('readonly', 'description: Look but do not touch.\nallowed-tools: Read')
    const { messages } = await run({
      turns: [[toolCall('w1', 'write_file', { path: 'b.txt', content: 'x' }), done()], [done('end_turn')]],
      onApproval: (_id, decide) => decide('allow')
    })
    expect(resultFor(messages, 'w1')).not.toContain('Not run')
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('x')
  })

  it('names a skill whose paths match a touched file, once per conversation', async () => {
    writeSkill('pdf-help', 'description: Working with PDFs.\npaths: "*.pdf"')
    writeFileSync(join(ws, 'doc.pdf'), 'pdf bytes')
    writeFileSync(join(ws, 'other.pdf'), 'more')
    const { messages } = await run({
      turns: [
        [toolCall('r1', 'read_file', { path: 'doc.pdf' }), done()],
        [toolCall('r2', 'read_file', { path: 'other.pdf' }), done()],
        [{ type: 'text', text: 'ok' }, done('end_turn')]
      ]
    })
    const skillNotes = messages.filter(
      (m) => m.role === 'user' && String(m.content).startsWith(SYSTEM_NOTE_PREFIX) && String(m.content).includes('pdf-help')
    )
    expect(skillNotes).toHaveLength(1)
    expect(String(skillNotes[0].content)).toContain('- pdf-help (doc.pdf): Working with PDFs.')
    // The note follows the result that triggered it.
    const at = messages.indexOf(skillNotes[0])
    expect(messages[at - 1]).toMatchObject({ role: 'tool', toolCallId: 'r1' })

    // A later run of the same conversation doesn't name it again.
    const again = await run({
      messages: [...messages, { role: 'user', content: 'next' }],
      turns: [[toolCall('r3', 'read_file', { path: 'doc.pdf' }), done()], [done('end_turn')]]
    })
    expect(again.messages.filter((m) => String(m.content).includes('A skill matches')).length).toBe(1)
  })
})
