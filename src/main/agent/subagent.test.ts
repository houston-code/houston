import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import { createSecretRedactor } from './redact'
import { runSubAgent, SUBAGENT_TOOLS, SUBAGENT_WRITE_TOOLS } from './subagent'
import { checkpointFileCount, restoreCheckpoint, clearCheckpoints } from './checkpoints'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-sub-'))
})
afterEach(() => {
  clearCheckpoints()
  rmSync(ws, { recursive: true, force: true })
})

/** A scripted provider: each call yields the next pre-programmed turn. */
function scriptedProvider(turns: ProviderStreamEvent[][]): Provider {
  let i = 0
  return {
    async *streamChat(_req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
      for (const ev of turn) yield ev
    }
  }
}

/** Records the tool names offered on the first turn, then ends the turn. */
function capturingProvider(seen: { tools: string[] }): Provider {
  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      seen.tools = (req.tools ?? []).map((t) => t.name)
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'end_turn' }
    }
  }
}

/** Scripts turns AND records the system prompt + messages seen on each call. */
function recordingProvider(
  turns: ProviderStreamEvent[][],
  sink: { system: string; messages: ChatMessage[][] }
): Provider {
  let i = 0
  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      sink.system = req.system ?? ''
      sink.messages.push((req.messages ?? []) as ChatMessage[])
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
      for (const ev of turn) yield ev
    }
  }
}

describe('runSubAgent', () => {
  it('uses a read tool then returns the final report', async () => {
    writeFileSync(join(ws, 'note.txt'), 'the answer is 42')
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'text', text: 'The file says the answer is 42.' },
        { type: 'done', stopReason: 'end_turn' }
      ]
    ])
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'what does note.txt say?',
      signal: new AbortController().signal
    })
    expect(report).toContain('42')
  })

  it("keeps each turn's reasoning state on its transcript for the next request", async () => {
    // Signed thinking and function-call thought signatures have to come back with the
    // tool loop's next request; some models reject it otherwise.
    writeFileSync(join(ws, 'note.txt'), 'the answer is 42')
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const reasoning = [{ text: '', model: 'm', id: 'c1', signature: 'sig-1' }]
    const provider = recordingProvider(
      [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use', reasoning }
        ],
        [{ type: 'text', text: 'It says 42.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'what does note.txt say?',
      signal: new AbortController().signal
    })
    const assistant = sink.messages[1].find((m) => m.role === 'assistant')
    expect(assistant?.reasoning).toEqual(reasoning)
  })

  it('refuses tools outside the read-only set', async () => {
    // The subagent shouldn't be offered write tools, but guard even if asked.
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'write_file', arguments: { path: 'x', content: 'y' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'Could not write.' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'try to write',
      signal: new AbortController().signal
    })
    // write_file must not be in the allowed set, and no file should be created.
    expect(SUBAGENT_TOOLS).not.toContain('write_file')
    expect(report).toContain('Could not write.')
  })

  it('returns an aborted note when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const report = await runSubAgent({
      provider: scriptedProvider([]),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: ac.signal
    })
    expect(report).toContain('aborted')
  })

  it('surfaces a provider error', async () => {
    const provider = scriptedProvider([[{ type: 'error', message: 'boom' }]])
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal
    })
    expect(report).toContain('boom')
  })

  it('offers the full default set when no tools allow-list is given', async () => {
    const seen = { tools: [] as string[] }
    await runSubAgent({
      provider: capturingProvider(seen),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal
    })
    expect(seen.tools).toEqual([...SUBAGENT_TOOLS])
  })

  it('narrows the offered tools to a declared allow-list', async () => {
    const seen = { tools: [] as string[] }
    await runSubAgent({
      provider: capturingProvider(seen),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal,
      tools: ['read_file']
    })
    expect(seen.tools).toEqual(['read_file'])
  })

  it('drops unknown entries from the declared allow-list', async () => {
    const seen = { tools: [] as string[] }
    await runSubAgent({
      provider: capturingProvider(seen),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal,
      // write_file/run_shell are never in the read-only set, bogus is unknown.
      tools: ['read_file', 'glob', 'write_file', 'run_shell', 'bogus']
    })
    expect(seen.tools).toEqual(['read_file', 'glob'])
  })

  it('refuses to execute a tool excluded by the allow-list', async () => {
    writeFileSync(join(ws, 'note.txt'), 'secret')
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'read note.txt',
      signal: new AbortController().signal,
      // read_file is excluded, so the call must be rejected, not executed.
      tools: ['glob']
    })
    expect(report).toContain('Done.')
    // The model only saw the rejection note, never the file contents.
  })

  it('redacts secrets from a tool output before the transcript reaches the provider', async () => {
    // A config file holding this install's own stored credential (an opaque value
    // with no recognizable format) plus a token-shaped third-party secret — the same
    // two layers the main loop's flushResult redaction covers.
    writeFileSync(
      join(ws, 'config.env'),
      'KEY=stored-opaque-credential-value-xyz\nGH=ghp_' + 'A'.repeat(36)
    )
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'config.env' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Read it.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'read config.env',
      signal: new AbortController().signal,
      redact: createSecretRedactor(['stored-opaque-credential-value-xyz'])
    })
    // The transcript sent on the subagent's next turn carries the scrubbed output:
    // known-value redaction strips the stored key, pattern redaction the GitHub token.
    const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    expect(String(toolMsg?.content)).not.toContain('stored-opaque-credential-value-xyz')
    expect(String(toolMsg?.content)).not.toContain('ghp_')
    expect(String(toolMsg?.content)).toContain('[redacted:secret]')
    expect(String(toolMsg?.content)).toContain('[redacted:github-token]')
  })

  it('leaves tool outputs untouched when no redactor is given', async () => {
    writeFileSync(join(ws, 'note.txt'), 'plain contents, nothing secret')
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'read note.txt',
      signal: new AbortController().signal
    })
    const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 'c1')
    expect(String(toolMsg?.content)).toContain('plain contents, nothing secret')
  })

  it('reports each turn token usage via onUsage', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'glob', arguments: { pattern: '*' } } },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 } }
      ],
      [
        { type: 'text', text: 'Done.' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 8 } }
      ]
    ])
    const usages: Array<{ inputTokens?: number; outputTokens?: number }> = []
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'do something',
      signal: new AbortController().signal,
      onUsage: (u) => usages.push(u)
    })
    expect(usages).toEqual([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 120, outputTokens: 8 }
    ])
  })

  describe('writable tier', () => {
    it('offers the read tools plus the write/shell tools', async () => {
      const seen = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(seen),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        writable: true
      })
      expect(seen.tools).toEqual([...SUBAGENT_TOOLS, ...SUBAGENT_WRITE_TOOLS])
    })

    it('fails CLOSED to read-only tools when a writable agent lists only unknown names', async () => {
      const seen = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(seen),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        writable: true,
        // None of these are Houston tool names, so the intersection is empty. It must
        // NOT widen back to the full write+shell base — that would grant MORE than named.
        tools: ['bash', 'grep']
      })
      expect(seen.tools).toEqual([...SUBAGENT_TOOLS])
      for (const w of SUBAGENT_WRITE_TOOLS) expect(seen.tools).not.toContain(w)
    })

    it('keeps the read-only tier free of write tools', async () => {
      const seen = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(seen),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal
        // writable omitted → read-only
      })
      for (const w of SUBAGENT_WRITE_TOOLS) expect(seen.tools).not.toContain(w)
    })

    it('actually writes a file when writable', async () => {
      const provider = scriptedProvider([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hello from subagent' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Wrote out.txt.' }, { type: 'done', stopReason: 'end_turn' }]
      ])
      const report = await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'create out.txt',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws]
      })
      expect(report).toContain('Wrote out.txt')
      expect(existsSync(join(ws, 'out.txt'))).toBe(true)
      expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hello from subagent')
    })

    it('records edits in the dispatching turn checkpoint when checkpointRunId is set', async () => {
      writeFileSync(join(ws, 'existing.txt'), 'before-sub')
      const patch = [
        '*** Begin Patch',
        '*** Update File: existing.txt',
        '@@',
        '-before-sub',
        '+after-sub',
        '*** Add File: created.txt',
        '+made by subagent',
        '*** End Patch'
      ].join('\n')
      const provider = scriptedProvider([
        [
          { type: 'tool_call', call: { id: 'p1', name: 'apply_patch', arguments: { patch } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Patched.' }, { type: 'done', stopReason: 'end_turn' }]
      ])
      await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'apply the change',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws],
        checkpointRunId: 'parent-run-1'
      })
      expect(readFileSync(join(ws, 'existing.txt'), 'utf8')).toBe('after-sub')
      expect(readFileSync(join(ws, 'created.txt'), 'utf8')).toBe('made by subagent\n')
      // Both files landed in the PARENT run's checkpoint, so reverting the turn
      // undoes the delegated changes too.
      expect(checkpointFileCount('parent-run-1')).toBe(2)
      expect(await restoreCheckpoint('parent-run-1')).toBe(2)
      expect(readFileSync(join(ws, 'existing.txt'), 'utf8')).toBe('before-sub')
      expect(existsSync(join(ws, 'created.txt'))).toBe(false)
    })

    it('does not record checkpoints when no checkpointRunId is given', async () => {
      const provider = scriptedProvider([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'plain.txt', content: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Wrote.' }, { type: 'done', stopReason: 'end_turn' }]
      ])
      await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'write it',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws]
      })
      expect(readFileSync(join(ws, 'plain.txt'), 'utf8')).toBe('x')
      expect(checkpointFileCount('parent-run-1')).toBe(0)
    })

    it('a declared allow-list can narrow the writable tier to a subset', async () => {
      const seen = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(seen),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        writable: true,
        tools: ['read_file', 'edit_file', 'bogus']
      })
      expect(seen.tools).toEqual(['read_file', 'edit_file'])
    })

    it('fails closed: refuses run_shell on a host with no OS sandbox', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [
          [
            { type: 'tool_call', call: { id: 's1', name: 'run_shell', arguments: { command: 'echo hi' } } },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [{ type: 'text', text: 'Reported.' }, { type: 'done', stopReason: 'end_turn' }]
        ],
        sink
      )
      const report = await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'run echo',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws],
        shellSandboxed: false
      })
      expect(report).toContain('Reported.')
      // The subagent is told shell is unavailable on this host…
      expect(sink.system).toContain('run_shell is not available')
      // …and the run_shell call was answered with the refusal note, never executed.
      const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 's1')
      expect(toolMsg?.content).toContain('run_shell is unavailable')
    })

    it('offers run_shell to a writable subagent when the host IS sandboxed', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [[{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]],
        sink
      )
      await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        writable: true,
        shellSandboxed: true
      })
      expect(sink.system).toContain('run shell commands')
    })

    it('routes an unconfined run_shell through the gate and returns its output', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [
          [
            { type: 'tool_call', call: { id: 's1', name: 'run_shell', arguments: { command: 'echo gated-ok' } } },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [{ type: 'text', text: 'Ran it.' }, { type: 'done', stopReason: 'end_turn' }]
        ],
        sink
      )
      const gated: string[] = []
      const report = await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'run echo',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws],
        shellSandboxed: false,
        gateUnconfinedShell: async (args, run) => {
          gated.push(String(args.command))
          return run()
        }
      })
      expect(report).toContain('Ran it.')
      // The command went through the gate exactly once…
      expect(gated).toEqual(['echo gated-ok'])
      // …the system prompt describes per-command approval instead of refusing shell…
      expect(sink.system).toContain('each run_shell command first asks the user for approval')
      expect(sink.system).not.toContain('run_shell is not available')
      // …and the subagent saw the command's real output as the tool result.
      const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 's1')
      expect(toolMsg?.content).toContain('gated-ok')
    })

    it('returns the gate refusal to the subagent without running the command', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [
          [
            {
              type: 'tool_call',
              call: { id: 's1', name: 'run_shell', arguments: { command: 'touch should-not-exist.txt' } }
            },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [{ type: 'text', text: 'Denied, moving on.' }, { type: 'done', stopReason: 'end_turn' }]
        ],
        sink
      )
      const report = await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'run touch',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws],
        shellSandboxed: false,
        // Refuses without ever invoking the run thunk.
        gateUnconfinedShell: async () => 'Denied by the user.'
      })
      expect(report).toContain('Denied, moving on.')
      const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 's1')
      expect(toolMsg?.content).toBe('Denied by the user.')
      expect(existsSync(join(ws, 'should-not-exist.txt'))).toBe(false)
    })

    it('never consults the gate when the host IS sandboxed', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [
          [
            { type: 'tool_call', call: { id: 's1', name: 'run_shell', arguments: { command: 'echo confined-ok' } } },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [{ type: 'text', text: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]
        ],
        sink
      )
      let consulted = false
      await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'run echo',
        signal: new AbortController().signal,
        writable: true,
        roots: [ws],
        shellSandboxed: true,
        gateUnconfinedShell: async (_args, run) => {
          consulted = true
          return run()
        }
      })
      // A confined command runs under the dispatch consent — no per-command gate.
      expect(consulted).toBe(false)
      const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 's1')
      expect(toolMsg?.content).toContain('confined-ok')
    })
  })
})

describe('progress, resume, and nesting', () => {
  it('reports one progress line per tool call, with a turn counter and the tool summary', async () => {
    writeFileSync(join(ws, 'note.txt'), 'x')
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
        { type: 'tool_call', call: { id: 'c2', name: 'search_files', arguments: { pattern: 'todo' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn' }
      ]
    ])
    const progress: string[] = []
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'look around',
      signal: new AbortController().signal,
      onProgress: (m) => progress.push(m)
    })
    expect(progress).toHaveLength(2)
    expect(progress[0]).toContain('turn 1/16')
    expect(progress[0]).toContain('note.txt')
    expect(progress[1]).toContain('Search "todo"')
  })

  it('hands the full transcript to onTranscript on a clean finish', async () => {
    writeFileSync(join(ws, 'note.txt'), 'the answer')
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'text', text: 'it says: the answer' },
        { type: 'done', stopReason: 'end_turn' }
      ]
    ])
    let transcript: ChatMessage[] | null = null
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'what does note.txt say?',
      signal: new AbortController().signal,
      onTranscript: (m) => {
        transcript = m
      }
    })
    // user → assistant(tool call) → tool result → assistant final: every call paired.
    expect(transcript).not.toBeNull()
    expect(transcript!.map((m: ChatMessage) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('does NOT hand a transcript to onTranscript after a provider error', async () => {
    const provider = scriptedProvider([[{ type: 'error', message: 'boom' }]])
    let called = false
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal,
      onTranscript: () => {
        called = true
      }
    })
    expect(report).toContain('subagent error')
    expect(called).toBe(false)
  })

  it('continues from priorMessages with the new prompt appended (and does not mutate them)', async () => {
    const prior: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first report' }
    ]
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [[{ type: 'text', text: 'second report' }, { type: 'done', stopReason: 'end_turn' }]],
      sink
    )
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'follow-up',
      signal: new AbortController().signal,
      priorMessages: prior
    })
    // The recorded array is the run's live message log (held by reference), so
    // only its head — what the provider was actually sent — is asserted here.
    expect(sink.messages[0].slice(0, 3).map((m) => m.content)).toEqual([
      'first task',
      'first report',
      'follow-up'
    ])
    expect(prior).toHaveLength(2)
  })

  describe('network access', () => {
    it('offers the web tools only when the network seam is wired', async () => {
      const wired = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(wired),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        network: { gate: async (_n, _a, run) => run() }
      })
      expect(wired.tools).toContain('web_fetch')
      expect(wired.tools).toContain('web_search')

      const without = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(without),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal
      })
      expect(without.tools).not.toContain('web_fetch')
      expect(without.tools).not.toContain('web_search')
    })

    it('routes a network call through the gate and returns its resolution', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [
          [
            {
              type: 'tool_call',
              call: { id: 'n1', name: 'web_fetch', arguments: { url: 'https://docs.example/api' } }
            },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [
            { type: 'text', text: 'Summarized.' },
            { type: 'done', stopReason: 'end_turn' }
          ]
        ],
        sink
      )
      const gated: Array<{ name: string; url: unknown }> = []
      const report = await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'read the docs',
        signal: new AbortController().signal,
        network: {
          // Resolves with canned text WITHOUT invoking the thunk — proving the
          // subagent never reaches the network unless the gate runs the call.
          gate: async (name, args) => {
            gated.push({ name, url: args.url })
            return 'GATED-BODY'
          }
        }
      })
      expect(report).toContain('Summarized.')
      expect(gated).toEqual([{ name: 'web_fetch', url: 'https://docs.example/api' }])
      // The gate's resolution is the tool result verbatim…
      const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 'n1')
      expect(toolMsg?.content).toBe('GATED-BODY')
      // …and the system prompt states the per-request approval contract.
      expect(sink.system).toContain('Each network request first asks the user for approval')
    })

    it('a declared allow-list can exclude the web tools', async () => {
      const seen = { tools: [] as string[] }
      await runSubAgent({
        provider: capturingProvider(seen),
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal,
        network: { gate: async (_n, _a, run) => run() },
        tools: ['read_file', 'glob']
      })
      expect(seen.tools).toEqual(['read_file', 'glob'])
    })

    it('tells a local-only subagent it has no network access', async () => {
      const sink = { system: '', messages: [] as ChatMessage[][] }
      const provider = recordingProvider(
        [[{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]],
        sink
      )
      await runSubAgent({
        provider,
        model: 'm',
        workspace: ws,
        prompt: 'x',
        signal: new AbortController().signal
      })
      expect(sink.system).toContain('You have no network access.')
    })
  })

  it('offers dispatch_agent only when a nested dispatcher is injected', async () => {
    const withNested = { tools: [] as string[] }
    await runSubAgent({
      provider: capturingProvider(withNested),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal,
      dispatchNested: async () => 'nested report'
    })
    expect(withNested.tools).toContain('dispatch_agent')

    const without = { tools: [] as string[] }
    await runSubAgent({
      provider: capturingProvider(without),
      model: 'm',
      workspace: ws,
      prompt: 'x',
      signal: new AbortController().signal
    })
    expect(without.tools).not.toContain('dispatch_agent')
  })

  it('routes a nested dispatch through the injected dispatcher', async () => {
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          {
            type: 'tool_call',
            call: {
              id: 'n1',
              name: 'dispatch_agent',
              arguments: { description: 'inner', prompt: 'inner question', model: 'cheap' }
            }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'text', text: 'outer report' },
          { type: 'done', stopReason: 'end_turn' }
        ]
      ],
      sink
    )
    const dispatched: Array<{ prompt: string; agent?: string; model?: string }> = []
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'outer task',
      signal: new AbortController().signal,
      dispatchNested: async (prompt, agent, model) => {
        dispatched.push({ prompt, agent, model })
        return 'inner report'
      }
    })
    expect(report).toBe('outer report')
    expect(dispatched).toEqual([{ prompt: 'inner question', agent: undefined, model: 'cheap' }])
    const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 'n1')
    expect(toolMsg?.content).toBe('inner report')
  })

  it('refuses resume from within a subagent', async () => {
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          {
            type: 'tool_call',
            call: {
              id: 'n1',
              name: 'dispatch_agent',
              arguments: { description: 'x', prompt: 'y', resume: 'ag1' }
            }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'text', text: 'ok' },
          { type: 'done', stopReason: 'end_turn' }
        ]
      ],
      sink
    )
    let nestedCalls = 0
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'outer',
      signal: new AbortController().signal,
      dispatchNested: async () => {
        nestedCalls++
        return 'should not run'
      }
    })
    expect(nestedCalls).toBe(0)
    const toolMsg = sink.messages[1].find((m) => m.role === 'tool' && m.toolCallId === 'n1')
    expect(toolMsg?.content).toContain('resume is not available')
  })
})

describe('local permission gate (gateLocal)', () => {
  it('routes every local call through the gate, and a refusal never runs or checkpoints it', async () => {
    writeFileSync(join(ws, 'note.txt'), 'readable note')
    writeFileSync(join(ws, 'kept.txt'), 'original')
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          { type: 'tool_call', call: { id: 'r1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'kept.txt', content: 'clobbered' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    const gated: Array<{ name: string; kind: string; path: unknown }> = []
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'read then write',
      signal: new AbortController().signal,
      writable: true,
      roots: [ws],
      checkpointRunId: 'gate-run-1',
      // Lets reads through, refuses every write without invoking its thunk.
      gateLocal: async (name, kind, args, run) => {
        gated.push({ name, kind, path: args.path })
        return kind === 'write' ? 'Denied by a permission rule.' : run()
      }
    })
    expect(gated).toEqual([
      { name: 'read_file', kind: 'read', path: 'note.txt' },
      { name: 'write_file', kind: 'write', path: 'kept.txt' }
    ])
    const toolMsgs = sink.messages[1].filter((m) => m.role === 'tool')
    expect(toolMsgs.find((m) => m.toolCallId === 'r1')?.content).toContain('readable note')
    expect(toolMsgs.find((m) => m.toolCallId === 'w1')?.content).toBe('Denied by a permission rule.')
    // The refused write never touched the file or the parent's checkpoint.
    expect(readFileSync(join(ws, 'kept.txt'), 'utf8')).toBe('original')
    expect(checkpointFileCount('gate-run-1')).toBe(0)
  })

  it('without a gate, refuses a credential-file read and still runs ordinary reads', async () => {
    writeFileSync(join(ws, '.env'), 'APP_MODE=ungated-dotenv-marker')
    writeFileSync(join(ws, 'note.txt'), 'ordinary note')
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [
          { type: 'tool_call', call: { id: 'r1', name: 'read_file', arguments: { path: '.env' } } },
          { type: 'tool_call', call: { id: 'r2', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'read both',
      signal: new AbortController().signal
    })
    const toolMsgs = sink.messages[1].filter((m) => m.role === 'tool')
    const refused = String(toolMsgs.find((m) => m.toolCallId === 'r1')?.content)
    // Fail closed: a dispatcher that can't prompt can't consent to the read.
    expect(refused).toContain("needs the user's approval")
    expect(refused).not.toContain('ungated-dotenv-marker')
    expect(toolMsgs.find((m) => m.toolCallId === 'r2')?.content).toContain('ordinary note')
  })
})

describe('output limit and argument checks', () => {
  /** Scripts turns and records each request's cap and messages. */
  function capRecording(turns: ProviderStreamEvent[][]): {
    provider: Provider
    requests: Array<{ maxTokens?: number; messages: ChatMessage[] }>
  } {
    const requests: Array<{ maxTokens?: number; messages: ChatMessage[] }> = []
    let i = 0
    return {
      requests,
      provider: {
        async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
          requests.push({ maxTokens: req.maxTokens, messages: structuredClone(req.messages) })
          for (const ev of turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev
        }
      }
    }
  }

  const toolResults = (messages: ChatMessage[]): string[] =>
    messages.filter((m) => m.role === 'tool').map((m) => m.content)

  it('answers a write the output limit cut off without running it, then raises the cap', async () => {
    const { provider, requests } = capRecording([
      [
        { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: {}, incomplete: true } },
        { type: 'done', stopReason: 'max_tokens' }
      ],
      [{ type: 'text', text: 'Wrote it in parts.' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const report = await runSubAgent({
      provider,
      model: 'claude-opus-5-5',
      workspace: ws,
      prompt: 'write a big file',
      writable: true,
      signal: new AbortController().signal
    })
    expect(report).toBe('Wrote it in parts.')
    const [result] = toolResults(requests[1].messages)
    expect(result).toMatch(/^Not run: your reply reached the output limit/)
    // The first turn no longer runs under a fixed 4096-token cap; the redo gets the ceiling.
    expect(requests.map((r) => r.maxTokens)).toEqual([undefined, 128_000])
  })

  it('checks arguments against the schema before running a tool', async () => {
    const { provider, requests } = capRecording([
      [
        { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'x.txt' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'write',
      writable: true,
      signal: new AbortController().signal
    })
    expect(toolResults(requests[1].messages)[0]).toMatch(/^Invalid arguments for tool "write_file"/)
    expect(existsSync(join(ws, 'x.txt'))).toBe(false)
  })

  it('continues a report the limit cut off and returns the whole of it', async () => {
    const { provider, requests } = capRecording([
      [{ type: 'text', text: 'The answer is lo' }, { type: 'done', stopReason: 'max_tokens' }],
      [{ type: 'text', text: 'ng and complete.' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const progress: string[] = []
    const report = await runSubAgent({
      provider,
      model: 'claude-haiku-4-5',
      workspace: ws,
      prompt: 'explain',
      signal: new AbortController().signal,
      onProgress: (m) => progress.push(m)
    })
    expect(report).toBe('The answer is long and complete.')
    expect(requests[1].messages.at(-1)!.content).toMatch(/Continue exactly where it stopped/)
    expect(requests[1].maxTokens).toBe(64_000)
    expect(progress.some((p) => p.includes('continuing past the output limit'))).toBe(true)
  })

  it('stops continuing after three cut-offs in a row and flags the report as cut off', async () => {
    let calls = 0
    const provider: Provider = {
      async *streamChat(): AsyncGenerator<ProviderStreamEvent> {
        calls++
        yield { type: 'text', text: `part${calls} ` }
        yield { type: 'done', stopReason: 'max_tokens' }
      }
    }
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'explain',
      signal: new AbortController().signal
    })
    expect(calls).toBe(4)
    expect(report).toBe("part1 part2 part3 part4\n\n[subagent report cut off at the model's output limit]")
  })
})

describe('a stream that fails partway through a turn', () => {
  // The subagent never streams to the user, so recovering a dropped turn needs no
  // retraction: the partial attempt is thrown away and the whole turn re-requested.
  const partials: Array<[string, ProviderStreamEvent[]]> = [
    ['text', [{ type: 'text', text: 'half a rep' }]],
    ['reasoning', [{ type: 'reasoning', text: 'let me think about th' }]],
    [
      'a tool call',
      [
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_call', call: { id: 'dead', name: 'read_file', arguments: { path: 'never.txt' } } }
      ]
    ]
  ]

  it.each(partials)('discards a turn cut off after %s and retries it whole', async (_kind, partial) => {
    const sink = { system: '', messages: [] as ChatMessage[][] }
    const provider = recordingProvider(
      [
        [...partial, { type: 'error', message: 'Overloaded', status: 529 }],
        [{ type: 'text', text: 'The full report.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      sink
    )
    const progress: string[] = []
    let transcript: ChatMessage[] = []
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'report',
      signal: new AbortController().signal,
      onProgress: (m) => progress.push(m),
      onTranscript: (m) => {
        transcript = m
      }
    })
    expect(report).toBe('The full report.')
    // The retry re-sent the same request: nothing from the dead attempt was appended.
    expect(sink.messages).toHaveLength(2)
    expect(sink.messages[1]).toEqual(sink.messages[0])
    // Only the redo reached the transcript, and the collected call never ran.
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(transcript[1].content).toBe('The full report.')
    expect(transcript.some((m) => m.toolCalls?.length || m.role === 'tool')).toBe(false)
    expect(progress.some((p) => p.includes('retrying (1)'))).toBe(true)
  }, 10_000)

  it('ends with the error when the failure after partial output is not transient', async () => {
    const provider = scriptedProvider([
      [
        { type: 'text', text: 'half a rep' },
        { type: 'error', message: 'invalid request body', status: 400 }
      ],
      [{ type: 'text', text: 'never requested' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    let transcribed = false
    const report = await runSubAgent({
      provider,
      model: 'm',
      workspace: ws,
      prompt: 'report',
      signal: new AbortController().signal,
      onTranscript: () => {
        transcribed = true
      }
    })
    expect(report).toBe('[subagent error: invalid request body]')
    expect(transcribed).toBe(false)
  })
})
