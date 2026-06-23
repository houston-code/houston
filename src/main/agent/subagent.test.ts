import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import { runSubAgent, SUBAGENT_TOOLS } from './subagent'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-sub-'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

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
})
