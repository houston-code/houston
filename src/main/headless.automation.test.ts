import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AppSettings } from '@shared/types'
import { SYSTEM_NOTE_PREFIX, type AgentEvent, type AgentRunRequest, type ChatMessage } from '@shared/agent'
import { schemaProblems, validateJson, type JsonSchema } from '@shared/jsonSchema'
import {
  HEADLESS_EXIT,
  HEADLESS_SCHEMA_VERSION,
  checkStructuredAnswer,
  extractJsonAnswer,
  parseHeadlessArgs,
  parseStreamJsonLine,
  resolveHeadlessInputs,
  runHeadless,
  type HeadlessDeps,
  type HeadlessOptions
} from './headless'

// The automation contract of the headless client: --output-schema, --allowed-tools /
// --disallowed-tools, --append-system-prompt, --mcp-config, --input-format
// stream-json, and the versioned --json schema.

const CWD = '/work'

function settings(): AppSettings {
  return {
    providers: [
      { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', models: [{ id: 'claude' }], requiresKey: true, hasKey: true, builtIn: true }
    ],
    selected: { providerId: 'anthropic', model: 'claude' }
  } as unknown as AppSettings
}

const baseOpts: HeadlessOptions = {
  prompt: 'review this',
  cwd: '/proj',
  approvalPolicy: 'plan',
  onApproval: 'deny',
  allowShellNetwork: false,
  json: true,
  continueSession: false
}

/** A text-only turn the scripted startRun plays back. */
const answer = (text: string): AgentEvent[] => [
  { runId: 'r', type: 'usage', inputTokens: 100, outputTokens: 10, cost: 0.01 },
  { runId: 'r', type: 'text', delta: text },
  { runId: 'r', type: 'done', stopReason: 'end_turn' }
]

/** Deps whose startRun plays one scripted turn per call and records each request. */
function deps(turns: AgentEvent[][], extra: Partial<HeadlessDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const requests: AgentRunRequest[] = []
  let n = 0
  const d: HeadlessDeps = {
    getSettings: settings,
    startRun: async (req, send, onMessages) => {
      requests.push(structuredClone(req))
      const events = turns[n++] ?? answer('')
      for (const e of events) send({ ...e, runId: req.runId } as AgentEvent)
      const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
      onMessages?.([...req.messages, { role: 'assistant', content: text }])
    },
    resolveApproval: () => {},
    resolveQuestion: () => {},
    resolvePlan: () => {},
    resolveElicitation: () => {},
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    newId: () => `run-${n + 1}`,
    version: '9.9.9',
    readFile: async (p) => {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
    ...extra
  }
  return { d, out, err, requests }
}

const lines = (out: string[]): Record<string, unknown>[] =>
  out
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

async function* fromLines(items: string[]): AsyncIterable<string> {
  for (const l of items) yield l
}

describe('parseHeadlessArgs: automation flags', () => {
  const parse = (...args: string[]) => parseHeadlessArgs(['houston', ...args], CWD)

  it('reads --output-schema as inline JSON or a path resolved against the current directory', () => {
    expect(parse('-p', 'x', '--output-schema', '{"type":"object"}')?.outputSchema).toBe('{"type":"object"}')
    expect(parse('-p', 'x', '--output-schema', 'schema.json')?.outputSchema).toBe(resolve(CWD, 'schema.json'))
    expect(parse('-p', 'x', '--output-schema=/abs/s.json')?.outputSchema).toBe(resolve('/abs/s.json'))
    expect(parse('-p', 'x', '--output-schema')?.usageError).toMatch(/needs a JSON Schema/)
    expect(parse('-p', 'x', '--output-schema', 'a.json', '--output-schema', 'b.json')?.usageError).toMatch(/only once/)
  })

  it('reads and concatenates --allowed-tools and --disallowed-tools, refusing bad lists', () => {
    const o = parse('-p', 'x', '--allowed-tools', 'read_file,glob', '--allowed-tools=run_shell(git *)', '--disallowed-tools', 'web_fetch')
    expect(o?.allowedTools).toEqual([
      { tool: 'read_file', match: '*' },
      { tool: 'glob', match: '*' },
      { tool: 'run_shell', match: 'git *' }
    ])
    expect(o?.disallowedTools).toEqual([{ tool: 'web_fetch', match: '*' }])
    expect(parse('-p', 'x', '--allowed-tools', 'read_file glob')?.usageError).toMatch(/--allowed-tools/)
    expect(parse('-p', 'x', '--disallowed-tools')?.usageError).toMatch(/--disallowed-tools needs at least one/)
  })

  it('reads --append-system-prompt as text or @file, in order', () => {
    expect(parse('-p', 'x', '--append-system-prompt', 'Be terse.', '--append-system-prompt', '@rules.md')?.appendSystemPrompt).toEqual([
      'Be terse.',
      `@${resolve(CWD, 'rules.md')}`
    ])
    expect(parse('-p', 'x', '--append-system-prompt', '  ')?.usageError).toMatch(/needs text/)
    expect(parse('-p', 'x', '--append-system-prompt', '@')?.usageError).toMatch(/needs text/)
  })

  it('reads --mcp-config paths', () => {
    expect(parse('-p', 'x', '--mcp-config', 'mcp.json')?.mcpConfig).toEqual([resolve(CWD, 'mcp.json')])
    expect(parse('-p', 'x', '--mcp-config', '')?.usageError).toMatch(/--mcp-config needs/)
  })

  it('makes --input-format stream-json a headless run on its own, needing --json and no -p prompt', () => {
    const o = parse('--input-format', 'stream-json', '--json')
    expect(o).toMatchObject({ inputFormat: 'stream-json', prompt: '' })
    expect(o?.usageError).toBeUndefined()
    expect(o?.promptFromStdin).toBeUndefined()
    // Even with a piped stdin, which is the stream, never the prompt.
    expect(parseHeadlessArgs(['houston', '--input-format=stream-json', '--json'], CWD, { stdinPiped: true, bareStdinPrompt: true })?.promptFromStdin).toBeUndefined()
    expect(parse('--input-format', 'stream-json')?.usageError).toMatch(/needs --json/)
    expect(parse('-p', 'do it', '--input-format', 'stream-json', '--json')?.usageError).toMatch(/drop the -p prompt/)
    expect(parse('-p', 'x', '--input-format', 'xml')?.usageError).toMatch(/--input-format must be one of text, stream-json/)
    // The default text format still needs a prompt.
    expect(parse('--input-format', 'text', '--json')).toBeNull()
  })

  it('never takes one of the new flags as -p\'s prompt', () => {
    const o = parseHeadlessArgs(['houston', '-p', '--allowed-tools', 'read_file'], CWD, { stdinPiped: true })
    expect(o?.promptFromStdin).toBe(true)
    expect(o?.allowedTools).toEqual([{ tool: 'read_file', match: '*' }])
  })
})

describe('resolveHeadlessInputs', () => {
  const files: Record<string, string> = {
    '/s/good.json': '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}',
    '/s/notjson.json': '{nope',
    '/s/unsupported.json': '{"type":"object","unevaluatedProperties":false}',
    '/s/array.json': '[]',
    '/s/rules.md': 'Run the linter.\n',
    '/s/empty.md': '  \n',
    '/s/big.md': 'x'.repeat(300 * 1024),
    '/s/mcp.json': JSON.stringify({ mcpServers: [{ id: 'gh', command: 'gh-mcp', env: { TOKEN: 't' } }, { id: 'web', url: 'https://mcp.example.com' }] }),
    '/s/mcp-bad-entry.json': JSON.stringify({ mcpServers: [{ id: 'gh' }] }),
    '/s/mcp-no-array.json': JSON.stringify({ servers: [] }),
    '/s/mcp-dup.json': JSON.stringify({ mcpServers: [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }] }),
    '/s/mcp-many.json': JSON.stringify({ mcpServers: Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, command: 'x' })) })
  }
  const readFile = async (p: string): Promise<string> => {
    if (p in files) return files[p]
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
  const resolveWith = (o: Partial<HeadlessOptions>) => resolveHeadlessInputs({ ...baseOpts, ...o }, readFile)
  const error = async (o: Partial<HeadlessOptions>): Promise<string> => {
    const r = await resolveWith(o)
    if (!('error' in r)) throw new Error('expected an error')
    return r.error
  }

  it('loads a schema from a file or inline, and refuses one it cannot enforce', async () => {
    expect(await resolveWith({ outputSchema: '/s/good.json' })).toMatchObject({ outputSchema: { required: ['ok'] } })
    expect(await resolveWith({ outputSchema: '{"type":"string"}' })).toMatchObject({ outputSchema: { type: 'string' } })
    expect(await error({ outputSchema: '/s/missing.json' })).toMatch(/cannot read \/s\/missing.json \(ENOENT\)/)
    expect(await error({ outputSchema: '/s/notjson.json' })).toMatch(/not valid JSON/)
    expect(await error({ outputSchema: '{"type":' })).toMatch(/the schema is not valid JSON/)
    expect(await error({ outputSchema: '/s/unsupported.json' })).toMatch(/"unevaluatedProperties" keyword is not supported/)
    expect(await error({ outputSchema: '/s/array.json' })).toMatch(/must be a JSON object/)
  })

  it('joins --append-system-prompt parts and refuses empty or oversized ones', async () => {
    expect(await resolveWith({ appendSystemPrompt: ['Be terse.', '@/s/rules.md'] })).toMatchObject({
      appendSystemPrompt: 'Be terse.\n\nRun the linter.'
    })
    expect(await error({ appendSystemPrompt: ['@/s/empty.md'] })).toMatch(/\/s\/empty.md is empty/)
    expect(await error({ appendSystemPrompt: ['@/s/big.md'] })).toMatch(/larger than 256 KB/)
    expect(await error({ appendSystemPrompt: ['@/s/nope.md'] })).toMatch(/cannot read/)
  })

  it('validates --mcp-config like project config, loudly, with the same cap', async () => {
    const r = await resolveWith({ mcpConfig: ['/s/mcp.json'] })
    expect(r).toMatchObject({
      mcpServers: [
        { id: 'gh', command: 'gh-mcp', env: { TOKEN: 't' }, enabled: true },
        { id: 'web', url: 'https://mcp.example.com', enabled: true }
      ]
    })
    expect(await error({ mcpConfig: ['/s/mcp-bad-entry.json'] })).toMatch(/server 1 needs an "id" and a "command" or "url"/)
    expect(await error({ mcpConfig: ['/s/mcp-no-array.json'] })).toMatch(/needs an "mcpServers" array/)
    expect(await error({ mcpConfig: ['/s/mcp-dup.json'] })).toMatch(/share the id "a"/)
    expect(await error({ mcpConfig: ['/s/mcp.json', '/s/mcp.json'] })).toMatch(/share the id "gh"/)
    expect(await error({ mcpConfig: ['/s/mcp-many.json'] })).toMatch(/at most 10 servers/)
    expect(await error({ mcpConfig: ['/s/notjson.json'] })).toMatch(/not valid JSON/)
  })

  it('refuses an unknown built-in tool name, so a typo cannot scope nothing', async () => {
    expect(await error({ disallowedTools: [{ tool: 'run_shel', match: '*' }] })).toMatch(/--disallowed-tools: unknown tool "run_shel"/)
    expect(await error({ allowedTools: [{ tool: 'reed_file', match: '*' }] })).toMatch(/--allowed-tools: unknown tool/)
    expect(
      await resolveWith({
        allowedTools: [{ tool: 'mcp__gh__list', match: '*' }, { tool: 'read_*', match: '*' }],
        disallowedTools: [{ tool: 'run_shell', match: 'rm *' }]
      })
    ).toMatchObject({
      toolScope: {
        allowed: [{ tool: 'mcp__gh__list', match: '*' }, { tool: 'read_*', match: '*' }],
        disallowed: [{ tool: 'run_shell', match: 'rm *' }]
      }
    })
  })
})

describe('extractJsonAnswer / checkStructuredAnswer', () => {
  it('finds the JSON in a bare answer, a fenced one, or one wrapped in prose', () => {
    expect(extractJsonAnswer('{"a":1}')).toEqual({ value: { a: 1 } })
    expect(extractJsonAnswer('Here:\n```json\n{"a":2}\n```\n')).toEqual({ value: { a: 2 } })
    expect(extractJsonAnswer('Result: {"a":3} done')).toEqual({ value: { a: 3 } })
    expect(extractJsonAnswer('[1,2]')).toEqual({ value: [1, 2] })
    expect(extractJsonAnswer('no json here')).toBeUndefined()
    expect(extractJsonAnswer('')).toBeUndefined()
  })

  it('reports why an answer misses the schema', () => {
    const schema = { type: 'object', required: ['ok'] }
    expect(checkStructuredAnswer(schema, '{"ok":true}')).toEqual({ ok: true, value: { ok: true } })
    expect(checkStructuredAnswer(schema, '{}')).toEqual({ ok: false, errors: ['$: missing required property "ok"'] })
    expect(checkStructuredAnswer(schema, 'sorry')).toEqual({ ok: false, errors: ['the final answer is not JSON'] })
    expect(checkStructuredAnswer(schema, '')).toEqual({ ok: false, errors: ['there was no final answer'] })
  })
})

describe('runHeadless: automation contract', () => {
  const schemaArg = '{"type":"object","required":["verdict"],"properties":{"verdict":{"enum":["pass","fail"]}}}'

  it('puts the scope, the appended prompt, the schema, and run-only MCP servers on the run request', async () => {
    const { d, requests } = deps([answer('ok')], {
      readFile: async () => JSON.stringify({ mcpServers: [{ id: 'gh', command: 'gh-mcp' }] })
    })
    await runHeadless(
      {
        ...baseOpts,
        allowedTools: [{ tool: 'read_file', match: '*' }],
        disallowedTools: [{ tool: 'run_shell', match: '*' }],
        appendSystemPrompt: ['Be terse.'],
        mcpConfig: ['/m.json'],
        outputSchema: '{"type":"string"}'
      },
      d
    )
    expect(requests[0]).toMatchObject({
      toolScope: { allowed: [{ tool: 'read_file', match: '*' }], disallowed: [{ tool: 'run_shell', match: '*' }] },
      appendSystemPrompt: 'Be terse.',
      outputSchema: { type: 'string' },
      extraMcpServers: [{ id: 'gh', command: 'gh-mcp', enabled: true }],
      announceTools: true,
      unattended: true
    })
  })

  it('sets none of them on a plain run, and announces tools only for --json', async () => {
    const { d, requests } = deps([answer('ok')])
    await runHeadless({ ...baseOpts, json: false }, d)
    for (const k of ['toolScope', 'appendSystemPrompt', 'outputSchema', 'extraMcpServers', 'announceTools']) {
      expect(requests[0]).not.toHaveProperty(k)
    }
  })

  it('exits 2 without starting a run when a file flag is bad', async () => {
    const { d, err, out, requests } = deps([answer('ok')])
    expect(await runHeadless({ ...baseOpts, outputSchema: '/nope.json' }, d)).toBe(HEADLESS_EXIT.usage)
    expect(requests).toHaveLength(0)
    expect(err.join('')).toMatch(/--output-schema: cannot read \/nope.json/)
    expect(out).toEqual([])
  })

  it('starts --json with an init line carrying the version, setup, and the tools the run offers', async () => {
    const { d, out } = deps([[{ runId: 'r', type: 'run_info', tools: ['read_file', 'glob'] }, ...answer('hi')]])
    await runHeadless(
      { ...baseOpts, allowedTools: [{ tool: 'read_file', match: '*' }, { tool: 'run_shell', match: 'git *' }] },
      d
    )
    const all = lines(out)
    expect(all[0]).toEqual({
      type: 'system',
      subtype: 'init',
      schemaVersion: HEADLESS_SCHEMA_VERSION,
      houstonVersion: '9.9.9',
      cwd: '/proj',
      providerId: 'anthropic',
      model: 'claude',
      approvalPolicy: 'plan',
      onApproval: 'deny',
      inputFormat: 'text',
      tools: ['read_file', 'glob'],
      allowedTools: ['read_file', 'run_shell(git *)'],
      outputSchema: false
    })
    // run_info feeds the init line instead of printing on its own.
    expect(all.filter((l) => l.type === 'run_info')).toEqual([])
    expect(all.filter((l) => l.type === 'system')).toHaveLength(1)
    expect(all.at(-1)).toMatchObject({ type: 'result', schemaVersion: HEADLESS_SCHEMA_VERSION, status: 'success' })
  })

  it('still starts with the init line when the model cannot be resolved', async () => {
    const { d, out } = deps([], { getSettings: () => ({ providers: [] }) as unknown as AppSettings })
    expect(await runHeadless(baseOpts, d)).toBe(HEADLESS_EXIT.failed)
    const all = lines(out)
    expect(all.map((l) => l.type)).toEqual(['system', 'result'])
    expect(all[0]).toMatchObject({ providerId: null, model: null })
    expect(all[1]).toMatchObject({ status: 'error', error: expect.stringMatching(/No model configured/) })
  })

  it('emits a matching answer as structured_output and exits 0', async () => {
    const { d, out, requests } = deps([answer('{"verdict":"pass"}')])
    expect(await runHeadless({ ...baseOpts, outputSchema: schemaArg }, d)).toBe(HEADLESS_EXIT.ok)
    expect(requests).toHaveLength(1)
    const result = lines(out).at(-1)
    expect(result).toMatchObject({ status: 'success', structured_output: { verdict: 'pass' } })
    expect(result).not.toHaveProperty('schemaErrors')
    expect(lines(out)[0]).toMatchObject({ outputSchema: true })
  })

  it('gives one bounded corrective turn when the answer misses, and keeps the corrected one', async () => {
    const { d, out, requests } = deps([answer('All good, it passes.'), answer('{"verdict":"pass"}')])
    expect(await runHeadless({ ...baseOpts, outputSchema: schemaArg, maxTurns: 30 }, d)).toBe(HEADLESS_EXIT.ok)
    expect(requests).toHaveLength(2)
    // The correction continues the conversation with a system note, capped at one step.
    const fix = requests[1]
    const note = fix.messages.at(-1) as ChatMessage
    expect(note.role).toBe('user')
    expect(note.content.startsWith(SYSTEM_NOTE_PREFIX)).toBe(true)
    expect(note.content).toContain('the final answer is not JSON')
    expect(fix.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(fix.overrides).toMatchObject({ maxIterations: 1 })
    const result = lines(out).at(-1)
    expect(result).toMatchObject({ status: 'success', structured_output: { verdict: 'pass' }, turns: 2, costUsd: 0.02 })
  })

  it('exits 4 with the reasons when the corrected answer still misses', async () => {
    const { d, out, requests } = deps([answer('{"verdict":"maybe"}'), answer('{"verdict":"unsure"}')])
    expect(await runHeadless({ ...baseOpts, outputSchema: schemaArg }, d)).toBe(HEADLESS_EXIT.schema)
    expect(requests).toHaveLength(2)
    // Only one corrective turn, never a loop.
    expect(requests[1].messages.at(-1)?.content).toContain('$/verdict: must be one of "pass", "fail"')
    const result = lines(out).at(-1)
    expect(result).toMatchObject({ status: 'schema_invalid', schemaErrors: ['$/verdict: must be one of "pass", "fail"'] })
    expect(result).not.toHaveProperty('structured_output')
  })

  it('does not spend a corrective turn on a run that already failed', async () => {
    const { d, out, requests } = deps([
      [
        { runId: 'r', type: 'text', delta: 'partial' },
        { runId: 'r', type: 'limit', reason: 'max-steps' },
        { runId: 'r', type: 'done', stopReason: 'end_turn' }
      ]
    ])
    expect(await runHeadless({ ...baseOpts, outputSchema: schemaArg }, d)).toBe(HEADLESS_EXIT.limit)
    expect(requests).toHaveLength(1)
    expect(lines(out).at(-1)).toMatchObject({ status: 'limit', schemaErrors: ['the final answer is not JSON'] })
  })

  it('reports a schema miss on stderr in text mode, with exit 4', async () => {
    const { d, err } = deps([answer('nope'), answer('still nope')])
    expect(await runHeadless({ ...baseOpts, json: false, outputSchema: schemaArg }, d)).toBe(HEADLESS_EXIT.schema)
    expect(err.join('')).toContain('asking for a corrected one')
    expect(err.join('')).toContain('the final answer does not match --output-schema')
  })

  it('stream-json: runs one turn per line in order, carrying the conversation, with a result per turn', async () => {
    const { d, out, requests } = deps([answer('first'), answer('second')], {
      readStdinLines: () =>
        fromLines([JSON.stringify({ type: 'user', content: 'one' }), '', JSON.stringify({ type: 'user', content: 'two' })])
    })
    expect(await runHeadless({ ...baseOpts, prompt: '', inputFormat: 'stream-json' }, d)).toBe(HEADLESS_EXIT.ok)
    expect(requests.map((r) => r.messages.map((m) => m.content))).toEqual([['one'], ['one', 'first', 'two']])
    const all = lines(out)
    expect(all[0]).toMatchObject({ type: 'system', inputFormat: 'stream-json' })
    expect(all.filter((l) => l.type === 'system')).toHaveLength(1)
    expect(all.filter((l) => l.type === 'result').map((l) => l.finalText)).toEqual(['first', 'second'])
    expect(all.at(-1)?.type).toBe('result')
  })

  it('stream-json: a malformed line ends the session with an input_error result and exit 2', async () => {
    const { d, out, requests, err } = deps([answer('first')], {
      readStdinLines: () => fromLines([JSON.stringify({ type: 'user', content: 'one' }), 'not json', JSON.stringify({ type: 'user', content: 'never' })])
    })
    expect(await runHeadless({ ...baseOpts, prompt: '', inputFormat: 'stream-json' }, d)).toBe(HEADLESS_EXIT.usage)
    expect(requests).toHaveLength(1)
    expect(err.join('')).toContain('stdin line 2: not valid JSON')
    expect(lines(out).at(-1)).toMatchObject({ type: 'result', status: 'input_error', error: 'stdin line 2: not valid JSON' })
  })

  it('stream-json: exits with the first failing turn\'s code, and runs the rest', async () => {
    const { d, requests } = deps([[{ runId: 'r', type: 'error', message: 'boom' }, { runId: 'r', type: 'done', stopReason: 'error' }], answer('ok')], {
      readStdinLines: () => fromLines(['{"type":"user","content":"a"}', '{"type":"user","content":"b"}'])
    })
    expect(await runHeadless({ ...baseOpts, prompt: '', inputFormat: 'stream-json' }, d)).toBe(HEADLESS_EXIT.failed)
    expect(requests).toHaveLength(2)
  })

  it('stream-json: an empty stream prints only the init line and exits 0', async () => {
    const { d, out, requests } = deps([], { readStdinLines: () => fromLines([]) })
    expect(await runHeadless({ ...baseOpts, prompt: '', inputFormat: 'stream-json' }, d)).toBe(HEADLESS_EXIT.ok)
    expect(requests).toHaveLength(0)
    expect(lines(out).map((l) => l.type)).toEqual(['system'])
  })

  it('stream-json: refuses to run where the host has no stdin line reader', async () => {
    const { d, err } = deps([])
    expect(await runHeadless({ ...baseOpts, prompt: '', inputFormat: 'stream-json' }, d)).toBe(HEADLESS_EXIT.usage)
    expect(err.join('')).toContain('no stdin reader')
  })

  it('parseStreamJsonLine accepts only user lines with content', () => {
    expect(parseStreamJsonLine('{"type":"user","content":"hi"}')).toEqual({ prompt: 'hi' })
    expect(parseStreamJsonLine('{"type":"assistant","content":"hi"}')).toEqual({ error: 'expected {"type":"user","content":"..."}' })
    expect(parseStreamJsonLine('{"type":"user","content":""}')).toEqual({ error: '"content" must be a non-empty string' })
    expect(parseStreamJsonLine('[1]')).toMatchObject({ error: expect.any(String) })
  })
})

describe('the checked-in --json schema', () => {
  const schema = JSON.parse(
    readFileSync(join(__dirname, '../../docs/schemas/headless-events.schema.json'), 'utf8')
  ) as Exclude<JsonSchema, boolean>

  // One of every AgentEvent variant: a new variant fails to compile here until it
  // is added, and the schema test below then fails until the schema describes it.
  const SAMPLES: { [K in AgentEvent['type']]: Extract<AgentEvent, { type: K }> } = {
    text: { runId: 'r', type: 'text', delta: 'Hi' },
    reasoning: { runId: 'r', type: 'reasoning', delta: 'hmm' },
    steered: { runId: 'r', type: 'steered', text: 'also do x' },
    tool_start: { runId: 'r', type: 'tool_start', callId: 'c', name: 'read_file', args: { path: 'a' }, kind: 'read' },
    tool_progress: { runId: 'r', type: 'tool_progress', callId: 'c', message: 'working' },
    subagent: { runId: 'r', type: 'subagent', parentCallId: 'c', id: 's', label: 'security', status: 'done' },
    review_finding: {
      runId: 'r',
      type: 'review_finding',
      parentCallId: 'c',
      finding: { id: 'f', dimension: 'security', severity: 'high', title: 't', status: 'confirmed' }
    } as Extract<AgentEvent, { type: 'review_finding' }>,
    tool_approval: { runId: 'r', type: 'tool_approval', callId: 'c', name: 'run_shell', summary: 'ls', kind: 'shell', shellOffline: true },
    tool_result: { runId: 'r', type: 'tool_result', callId: 'c', name: 'read_file', ok: true, output: 'x' },
    tool_question: { runId: 'r', type: 'tool_question', callId: 'c', question: 'q', options: [] },
    plan_ready: { runId: 'r', type: 'plan_ready', callId: 'c', plan: { title: 'Plan' } } as Extract<AgentEvent, { type: 'plan_ready' }>,
    elicitation: { runId: 'r', type: 'elicitation', callId: 'c', elicitId: 'e', serverId: 'gh', message: 'm', fields: [] },
    turn_start: { runId: 'r', type: 'turn_start', conversationId: 'conv', userText: 'next' },
    compaction: { runId: 'r', type: 'compaction', summarized: 4 },
    retry: { runId: 'r', type: 'retry', attempt: 1, max: 3, message: 'overloaded' },
    turn_discarded: { runId: 'r', type: 'turn_discarded', attempt: 1, reason: 'reset', textChars: 0, reasoningChars: 0 },
    model_fallback: { runId: 'r', type: 'model_fallback', from: 'A', to: 'B', reason: 'down' },
    limit: { runId: 'r', type: 'limit', reason: 'max-steps' },
    receipt: { runId: 'r', type: 'receipt', receipt: { v: 1, checks: [], otherCommands: 0, filesChanged: [] } } as unknown as Extract<
      AgentEvent,
      { type: 'receipt' }
    >,
    verification: { runId: 'r', type: 'verification', passed: true },
    runtime_missing: { runId: 'r', type: 'runtime_missing', runtime: 'node', label: 'Node.js', url: 'https://nodejs.org' },
    notice: { runId: 'r', type: 'notice', message: 'note' },
    usage: { runId: 'r', type: 'usage', inputTokens: 10, outputTokens: 2, cost: 0.001 },
    run_info: { runId: 'r', type: 'run_info', tools: ['read_file'] },
    done: { runId: 'r', type: 'done', stopReason: 'end_turn' },
    error: { runId: 'r', type: 'error', message: 'boom' }
  }

  it('is itself a schema the validator enforces in full', () => {
    expect(schemaProblems(schema)).toEqual([])
  })

  it('describes every event a --json run can print (run_info feeds the init line instead)', () => {
    const defs = Object.keys((schema.$defs ?? {}) as Record<string, unknown>)
      .filter((k) => k.startsWith('event_'))
      .map((k) => k.slice('event_'.length))
      .sort()
    const printed = Object.keys(SAMPLES)
      .filter((t) => t !== 'run_info')
      .sort()
    expect(defs).toEqual(printed)
  })

  it('validates every line of a --json run: init, session, each event, and result', async () => {
    const all = Object.values(SAMPLES) as AgentEvent[]
    const { d, out } = deps([all], {
      session: {
        load: () => null,
        create: () => ({ id: 'conv-1' }),
        setMessages: () => {},
        setSettings: () => {}
      },
      readFile: async () => '{"type":"object"}'
    })
    await runHeadless({ ...baseOpts, outputSchema: '/s.json', allowedTools: [{ tool: 'read_file', match: '*' }] }, d)
    const printed = lines(out)
    expect(printed.map((l) => l.type)).toEqual(
      expect.arrayContaining(['system', 'session', 'result', ...all.filter((e) => e.type !== 'run_info').map((e) => e.type)])
    )
    for (const line of printed) {
      expect({ line: line.type, errors: validateJson(schema, line) }).toEqual({ line: line.type, errors: [] })
    }
  })

  it('validates the result lines of every status', async () => {
    const statuses = [
      deps([answer('{}')]),
      deps([answer('nope'), answer('nope')]),
      deps([[{ runId: 'r', type: 'limit', reason: 'stalled' }, { runId: 'r', type: 'done', stopReason: 'end_turn' }]]),
      deps([], { getSettings: () => ({ providers: [] }) as unknown as AppSettings }),
      deps([], { readStdinLines: () => fromLines(['bad']) })
    ]
    const opts: Partial<HeadlessOptions>[] = [
      { outputSchema: '{"type":"object"}' },
      { outputSchema: '{"type":"object"}' },
      {},
      {},
      { prompt: '', inputFormat: 'stream-json' }
    ]
    const seen: unknown[] = []
    for (const [i, { d, out }] of statuses.entries()) {
      await runHeadless({ ...baseOpts, ...opts[i] }, d)
      const result = lines(out).at(-1)!
      seen.push(result.status)
      expect(validateJson(schema, result)).toEqual([])
    }
    expect(seen).toEqual(['success', 'schema_invalid', 'stalled', 'error', 'input_error'])
  })

  it('rejects a line that breaks the contract', () => {
    expect(validateJson(schema, { type: 'result', schemaVersion: 1, status: 'great' }).length).toBeGreaterThan(0)
    expect(validateJson(schema, { type: 'text', runId: 'r' }).length).toBeGreaterThan(0)
    expect(validateJson(schema, { type: 'system', subtype: 'init', schemaVersion: 2 }).length).toBeGreaterThan(0)
  })
})
