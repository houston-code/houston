/**
 * Golden-transcript regression guard for agent behavior.
 *
 * Runs scripted scenarios through the REAL agent loop (`startRun`) with a
 * deterministic fake provider, then pins the whole behavior surface into
 * checked-in golden files under `goldens/`:
 *
 *  - the exact system prompt sent to the model, per client config and per
 *    model family (desktop / CLI / plan mode / per-model addenda),
 *  - the full tool schemas advertised to the model (names, descriptions,
 *    parameter schemas) per client config,
 *  - every provider request a scenario produces (message-window assembly,
 *    reasoning/caching knobs), and
 *  - the full `AgentEvent` stream each scenario emits (the surface all three
 *    clients render).
 *
 * Any prompt or loop change that shifts one of these surfaces fails here with
 * a reviewable text diff instead of shipping silently. When a diff is
 * intentional, regenerate with `npm run goldens:update` and commit the updated
 * files — the golden diff then documents the behavior change in the PR.
 *
 * Everything environment-dependent is mocked or fixed (global rules file, git
 * context, gh probe, MCP, managed policy, workspace path), so the goldens are
 * byte-identical across machines and CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  ChatMessage,
  ChatRequest,
  PlanDecision,
  Provider,
  ProviderStreamEvent,
  ToolApprovalDecision,
  ToolSchema
} from '@shared/agent'
import type { ApprovalPolicy } from '@shared/types'
import { resetCaptureBackend, setCaptureBackend } from './viewlocalhost'
import { resetSpawnBackend, setSpawnBackend } from './spawn'
import type { CaptureDeps } from './viewlocalhost'
import type { SpawnBackend } from './spawn'

// Hoisted holders the mocks read, so each scenario can vary the fixed inputs.
const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  // Model metadata the fake host lists for the selected provider (drives the
  // per-model capability gates: reasoningCapable, explicitCacheControl).
  models: [] as unknown[],
  // Project-rules text folded into the system prompt ('' = no rules section).
  rulesText: '',
  // Git context line folded into the system prompt ('' = no git section).
  gitContext: '',
  settings: {} as Record<string, unknown>
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: (id: string) => ({
    id,
    kind: id,
    label: id,
    models: h.models,
    requiresKey: false,
    hasKey: true,
    builtIn: true
  }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [] }))
vi.mock('./managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
// The real loader reads the user's global ~/.claude/CLAUDE.md — machine state
// that must not leak into goldens. Scenarios inject rules text via `h.rulesText`.
vi.mock('./rules', async (importActual) => ({
  ...(await importActual<typeof import('./rules')>()),
  loadProjectRules: async () => ({
    text: h.rulesText,
    files: h.rulesText ? ['CLAUDE.md'] : []
  })
}))
// Real gitContext shells out to git; githubContext probes PATH for gh. Both are
// environment-dependent, so scenarios script the git section via `h.gitContext`.
vi.mock('./git', () => ({ gitContext: async () => h.gitContext }))
vi.mock('./github', async (importActual) => ({
  ...(await importActual<typeof import('./github')>()),
  githubContext: () => ''
}))
vi.mock('./plugins', () => {
  const inert = { has: () => false, size: 0, emit: async () => {} }
  return { loadPlugins: async () => inert, loadPluginsIfEnabled: async () => inert }
})

// Imported after the mocks are registered.
const { startRun, resolveApproval, resolveQuestion, resolvePlan } = await import('./loop')

const GOLDEN_RUN_ID = 'golden-run'

/** One provider request, snapshotted before the scripted turn streams back. */
interface CapturedRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: ToolSchema[]
  reasoningEffort?: string
  reasoningCapable?: boolean
  reasoningSummary?: string
  verbosity?: string
  explicitCacheControl?: boolean
}

/** A provider that records every request and replays one scripted turn per call. */
function capturingProvider(turns: ProviderStreamEvent[][], captured: CapturedRequest[]): Provider {
  let i = 0
  return {
    async *streamChat(req: ChatRequest) {
      captured.push({
        model: req.model,
        system: req.system ?? '',
        messages: structuredClone(req.messages),
        tools: structuredClone(req.tools ?? []),
        reasoningEffort: req.reasoningEffort,
        reasoningCapable: req.reasoningCapable,
        reasoningSummary: req.reasoningSummary,
        verbosity: req.verbosity,
        explicitCacheControl: req.explicitCacheControl
      })
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' as const }]
      for (const ev of turn) yield ev
    }
  }
}

let tmp: string
let ws: string
let realWs: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'houston-golden-'))
  // Fixed-name child dir so the prompt's `(project: "golden-ws")` is stable.
  ws = join(tmp, 'golden-ws')
  mkdirSync(ws)
  realWs = realpathSync(ws)
  h.models = []
  h.rulesText = ''
  h.gitContext = ''
  h.settings = {
    compactionThreshold: 0,
    reasoningEffort: 'off',
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: [],
    projectPlugins: false
  }
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  resetCaptureBackend()
  resetSpawnBackend()
  vi.restoreAllMocks()
})

/** Wire the desktop-only backends so the toolset/prompt match the Electron shell. */
function configureDesktopBackends(): void {
  setCaptureBackend({} as CaptureDeps)
  setSpawnBackend({} as SpawnBackend)
}

interface ScenarioResult {
  events: AgentEvent[]
  requests: CapturedRequest[]
}

/** Run one scripted scenario through the real loop to completion. */
async function runScenario(opts: {
  turns: ProviderStreamEvent[][]
  policy?: ApprovalPolicy
  userText?: string
  providerId?: string
  model?: string
  onApproval?: (callId: string, decide: (d: ToolApprovalDecision) => void) => void
  onQuestion?: (callId: string, answer: (a: string) => void) => void
  onPlan?: (callId: string, decide: (d: PlanDecision) => void) => void
}): Promise<ScenarioResult> {
  const requests: CapturedRequest[] = []
  h.provider = capturingProvider(opts.turns, requests)
  const events: AgentEvent[] = []
  const send = (e: AgentEvent): void => {
    events.push(e)
    // Resolve blocking prompts on a later tick, as the real clients do.
    if (e.type === 'tool_approval' && opts.onApproval) {
      setTimeout(() => opts.onApproval!(e.callId, (d) => resolveApproval(GOLDEN_RUN_ID, e.callId, d)), 0)
    }
    if (e.type === 'tool_question' && opts.onQuestion) {
      setTimeout(() => opts.onQuestion!(e.callId, (a) => resolveQuestion(GOLDEN_RUN_ID, e.callId, a)), 0)
    }
    if (e.type === 'plan_ready' && opts.onPlan) {
      setTimeout(() => opts.onPlan!(e.callId, (d) => resolvePlan(GOLDEN_RUN_ID, e.callId, d)), 0)
    }
  }
  await startRun(
    {
      runId: GOLDEN_RUN_ID,
      workspace: ws,
      providerId: opts.providerId ?? 'anthropic',
      model: opts.model ?? 'claude-sonnet-5',
      approvalPolicy: opts.policy ?? 'ask',
      messages: [{ role: 'user', content: opts.userText ?? 'hello' }]
    },
    send
  )
  return { events, requests }
}

// ---- serialization helpers ----

/** Replace the machine-specific workspace path so goldens are portable. */
function norm(s: string): string {
  return s.split(realWs).join('<workspace>').split(ws).join('<workspace>')
}

/** JSON with object keys sorted at every level, for stable one-line records. */
function stable(v: unknown): string {
  const sortKeys = (val: unknown): unknown => {
    if (Array.isArray(val)) return val.map(sortKeys)
    if (val && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sortKeys(x)])
      )
    }
    return val
  }
  return JSON.stringify(sortKeys(v))
}

/** Short content hash so transcripts can pin large strings without embedding them. */
function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

function fmtEvent(e: AgentEvent): string {
  const { runId: _runId, type, ...rest } = e
  // Cost is a float product of the pricing table; round away representation
  // noise (0.0040799999…) so the golden stays readable.
  if ('cost' in rest && typeof rest.cost === 'number') {
    rest.cost = Math.round(rest.cost * 1e6) / 1e6
  }
  return Object.keys(rest).length ? `${type} ${stable(rest)}` : type
}

function fmtMessage(m: ChatMessage, i: number): string {
  const head =
    m.role === 'tool' ? `${i + 1}. tool[${m.toolName ?? '?'}#${m.toolCallId ?? '?'}]` : `${i + 1}. ${m.role}`
  const parts = [`${head}: ${JSON.stringify(m.content)}`]
  for (const c of m.toolCalls ?? []) parts.push(`     -> calls ${c.name}#${c.id} ${stable(c.arguments)}`)
  if (m.reasoning?.length) parts.push(`     -> reasoning blocks: ${m.reasoning.length}`)
  return parts.join('\n')
}

function fmtRequest(r: CapturedRequest, i: number): string {
  const system = norm(r.system)
  const lines = [
    `--- request ${i + 1} ---`,
    `model: ${r.model}`,
    `reasoning: effort=${r.reasoningEffort ?? '-'} capable=${r.reasoningCapable ?? '-'} summary=${r.reasoningSummary ?? '-'} verbosity=${r.verbosity ?? '-'}`,
    `explicitCacheControl: ${r.explicitCacheControl ?? '-'}`,
    `system: sha256:${sha(system)} (${system.length} chars)`,
    `tools (${r.tools.length}): ${r.tools.map((t) => t.name).join(', ')}`,
    `messages (${r.messages.length}):`,
    ...r.messages.map(fmtMessage)
  ]
  return lines.join('\n')
}

/** The full golden transcript for one scenario: every request, then every event. */
function transcript(name: string, r: ScenarioResult): string {
  return norm(
    [
      `# golden transcript: ${name}`,
      '',
      ...r.requests.map(fmtRequest),
      '--- events ---',
      ...r.events.map(fmtEvent),
      ''
    ].join('\n')
  )
}

/**
 * Multiset line diff of two prompts — enough to pin what a config ADDS or
 * REMOVES relative to a baseline without duplicating the whole prompt per
 * config. Position changes don't show here; the full-text goldens pin those.
 */
function promptDelta(baseline: string, other: string): string {
  const count = (lines: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const base = count(baseline.split('\n'))
  const next = count(other.split('\n'))
  const out: string[] = []
  for (const [line, n] of next) {
    const extra = n - (base.get(line) ?? 0)
    for (let i = 0; i < extra; i++) out.push(`+ ${line}`)
  }
  for (const [line, n] of base) {
    const missing = n - (next.get(line) ?? 0)
    for (let i = 0; i < missing; i++) out.push(`- ${line}`)
  }
  return out.length ? out.join('\n') : '(no line-level differences)'
}

/**
 * Every scripted turn reports explicit usage: without it the loop falls back to
 * a char-count estimate over the system prompt + messages, and the system
 * prompt embeds the real (machine-specific) workspace path — the estimate would
 * differ between macOS and Linux CI and break the goldens.
 */
const doneTurn = (usage = { inputTokens: 1300, outputTokens: 12 }): ProviderStreamEvent => ({
  type: 'done',
  stopReason: 'end_turn',
  usage
})
const doneToolUse = (usage = { inputTokens: 1200, outputTokens: 40 }): ProviderStreamEvent => ({
  type: 'done',
  stopReason: 'tool_use',
  usage
})

describe('agent behavior goldens', () => {
  it('basic turn (desktop): read a file, answer — pins prompt, toolset, requests, events', async () => {
    configureDesktopBackends()
    h.rulesText = 'Use two-space indentation.'
    h.gitContext = 'Git: on branch main, working tree clean.'
    writeFileSync(join(ws, 'notes.txt'), 'remember the milk\n')

    const r = await runScenario({
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'notes.txt' } } },
          doneToolUse()
        ],
        [
          { type: 'text', text: 'The notes say: ' },
          { type: 'text', text: 'remember the milk.' },
          doneTurn({ inputTokens: 1300, outputTokens: 12 })
        ]
      ],
      userText: 'What do my notes say?'
    })

    await expect(transcript('basic-turn', r)).toMatchFileSnapshot('goldens/transcript.basic-turn.txt')
    // The exact system prompt the desktop client sends (with rules + git context).
    await expect(norm(r.requests[0].system)).toMatchFileSnapshot('goldens/system-prompt.desktop.txt')
    // The full tool surface (names, descriptions, parameter schemas) — tool
    // descriptions are prompt text the model reads, so they are pinned verbatim.
    await expect(JSON.stringify(r.requests[0].tools, null, 2) + '\n').toMatchFileSnapshot(
      'goldens/toolset.desktop.json'
    )
  })

  it('approval flow (ask policy): one write allowed, one denied', async () => {
    configureDesktopBackends()
    const r = await runScenario({
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'A\n' } } },
          doneToolUse()
        ],
        [
          { type: 'tool_call', call: { id: 'c2', name: 'write_file', arguments: { path: 'b.txt', content: 'B\n' } } },
          doneToolUse({ inputTokens: 1250, outputTokens: 40 })
        ],
        [{ type: 'text', text: 'Created a.txt; b.txt was declined.' }, doneTurn()]
      ],
      policy: 'ask',
      userText: 'Create a.txt and b.txt',
      onApproval: (callId, decide) => decide(callId === 'c1' ? 'allow' : 'deny')
    })
    await expect(transcript('approval-flow', r)).toMatchFileSnapshot('goldens/transcript.approval-flow.txt')
  })

  it('plan mode: present_plan, accept — pins plan prompt, toolset, decision feedback', async () => {
    configureDesktopBackends()
    const r = await runScenario({
      turns: [
        [
          {
            type: 'tool_call',
            call: {
              id: 'c1',
              name: 'present_plan',
              arguments: {
                title: 'Add greeting',
                plan: '## Plan\n1. Add greet() to util.ts\n2. Call it from main.ts',
                files: ['src/util.ts', 'src/main.ts']
              }
            }
          },
          doneToolUse()
        ],
        [{ type: 'text', text: 'Starting on step 1.' }, doneTurn()]
      ],
      policy: 'plan',
      userText: 'Plan a greeting feature',
      onPlan: (_callId, decide) => decide({ kind: 'accept', mode: 'ask' })
    })
    await expect(transcript('plan-mode', r)).toMatchFileSnapshot('goldens/transcript.plan-mode.txt')
    await expect(norm(r.requests[0].system)).toMatchFileSnapshot('goldens/system-prompt.plan-mode.txt')
    await expect(JSON.stringify(r.requests[0].tools.map((t) => t.name), null, 2) + '\n').toMatchFileSnapshot(
      'goldens/toolset.plan-mode.names.json'
    )
  })

  it('ask_user: question asked, answered, answer fed back', async () => {
    configureDesktopBackends()
    const r = await runScenario({
      turns: [
        [
          {
            type: 'tool_call',
            call: {
              id: 'c1',
              name: 'ask_user',
              arguments: {
                question: 'Which color for the banner?',
                options: [{ label: 'Red' }, { label: 'Blue', description: 'calmer' }]
              }
            }
          },
          doneToolUse()
        ],
        [{ type: 'text', text: 'Blue it is.' }, doneTurn()]
      ],
      userText: 'Restyle the banner',
      onQuestion: (_callId, answer) => answer('Blue')
    })
    await expect(transcript('ask-user', r)).toMatchFileSnapshot('goldens/transcript.ask-user.txt')
  })

  it('CLI (no desktop backends): view_localhost and spawn_session are absent', async () => {
    // No configureDesktopBackends(): this is the standalone CLI configuration.
    const r = await runScenario({
      turns: [[{ type: 'text', text: 'hi' }, doneTurn()]]
    })
    await expect(norm(r.requests[0].system)).toMatchFileSnapshot('goldens/system-prompt.cli.txt')
    await expect(JSON.stringify(r.requests[0].tools.map((t) => t.name), null, 2) + '\n').toMatchFileSnapshot(
      'goldens/toolset.cli.names.json'
    )
  })

  it('per-model request shape: reasoning/caching knobs and prompt addenda per family', async () => {
    configureDesktopBackends()
    h.settings = { ...h.settings, reasoningEffort: 'medium' }
    const families: {
      providerId: string
      model: string
      caps?: Record<string, unknown>
    }[] = [
      { providerId: 'anthropic', model: 'claude-sonnet-5', caps: { reasoning: true } },
      { providerId: 'openai', model: 'gpt-5.2' },
      { providerId: 'ollama', model: 'llama3.3' }
    ]
    const blocks: string[] = []
    let baselineSystem: string | null = null
    for (const f of families) {
      h.models = f.caps ? [{ id: f.model, caps: f.caps }] : []
      const r = await runScenario({
        turns: [[{ type: 'text', text: 'ok' }, doneTurn({ inputTokens: 1000, outputTokens: 100 })]],
        providerId: f.providerId,
        model: f.model
      })
      const req = r.requests[0]
      const system = norm(req.system)
      const usage = r.events.find((e) => e.type === 'usage')
      const delta =
        baselineSystem === null
          ? '(baseline)'
          : promptDelta(baselineSystem, system)
      baselineSystem ??= system
      blocks.push(
        [
          `## ${f.providerId} / ${f.model}`,
          `host caps: ${f.caps ? stable(f.caps) : '-'}`,
          `reasoning: effort=${req.reasoningEffort ?? '-'} capable=${req.reasoningCapable ?? '-'} summary=${req.reasoningSummary ?? '-'} verbosity=${req.verbosity ?? '-'}`,
          `explicitCacheControl: ${req.explicitCacheControl ?? '-'}`,
          `tools: ${req.tools.length}`,
          `usage event: ${usage ? fmtEvent(usage) : '(none)'}`,
          `system prompt vs ${families[0].model} baseline:`,
          delta,
          ''
        ].join('\n')
      )
    }
    const doc = [
      '# per-model request shape',
      '',
      'Each block is the first provider request of a plain turn under that',
      'provider/model, with reasoningEffort=medium in settings. The prompt delta',
      'is a line-level diff against the first (anthropic) block.',
      '',
      ...blocks
    ].join('\n')
    await expect(doc).toMatchFileSnapshot('goldens/per-model-request-shape.txt')
  })
})
