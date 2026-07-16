import { describe, it, expect } from 'vitest'
import {
  signalFor,
  titleSequence,
  notifySequence,
  bellSequence,
  workingTitle,
  idleTitle
} from './tui-notify'
import type { AgentEvent } from '@shared/agent'

const approval: AgentEvent = {
  runId: 'r',
  type: 'tool_approval',
  callId: 'c1',
  name: 'run_shell',
  summary: 'rm -rf build',
  kind: 'shell'
}

describe('signalFor', () => {
  // The events that STOP the run are the whole point: the agent is waiting on a
  // human who may not know it.
  it('alerts and retitles for everything that blocks the run', () => {
    expect(signalFor(approval)).toMatchObject({ title: expect.stringContaining('needs approval') })
    expect(signalFor(approval)?.alert).toMatchObject({ body: expect.stringContaining('rm -rf build') })

    const q = signalFor({ runId: 'r', type: 'tool_question', callId: 'q', question: 'Which one?', options: [] })
    expect(q?.title).toContain('needs an answer')
    expect(q?.alert?.body).toBe('Which one?')

    const plan = signalFor({ runId: 'r', type: 'plan_ready', callId: 'p', plan: { title: 'Refactor auth' } })
    expect(plan?.title).toContain('plan ready')
    expect(plan?.alert?.body).toBe('Refactor auth')
  })

  it('alerts and goes idle when the turn finishes', () => {
    const s = signalFor({ runId: 'r', type: 'done', stopReason: 'end_turn' })
    expect(s?.alert?.body).toBe('Finished responding.')
    expect(s?.title).toBe(idleTitle())
  })

  // They pressed Ctrl-C: they are right there. Pinging them is noise.
  it('stays silent when the user stopped the run themselves', () => {
    expect(signalFor({ runId: 'r', type: 'done', stopReason: 'aborted' })).toBeNull()
  })

  // A bell per tool call trains people to ignore the bell.
  it('says nothing for ordinary progress', () => {
    expect(signalFor({ runId: 'r', type: 'text', delta: 'hi' })).toBeNull()
    expect(signalFor({ runId: 'r', type: 'tool_start', callId: 'c', name: 'read_file', args: {} })).toBeNull()
  })

  it('folds the project name into the title and the alert', () => {
    const s = signalFor(approval, 'my-proj')
    expect(s?.title).toContain('my-proj')
    expect(s?.alert?.title).toContain('my-proj')
  })
})

describe('escape sequences', () => {
  it('sets both window and tab title (OSC 0)', () => {
    expect(titleSequence('hello')).toBe('\x1b]0;hello\x07')
  })

  it('emits both notification dialects, since no single one covers the field', () => {
    const out = notifySequence({ title: 'Houston', body: 'Finished' })
    expect(out).toContain('\x1b]9;Houston: Finished\x07')
    expect(out).toContain('\x1b]777;notify;Houston;Finished\x07')
  })

  it('rings the bell', () => {
    expect(bellSequence()).toBe('\x07')
  })

  it('titles say what is happening', () => {
    expect(workingTitle('needs approval', 'proj')).toBe('● needs approval · proj')
    expect(idleTitle('proj')).toBe('Houston · proj')
    expect(idleTitle()).toBe('Houston')
  })
})

/**
 * These strings are built from tool summaries and error text, some of it remote
 * (an MCP server's message). BEL and ESC terminate an OSC payload, so leaving one
 * in would let that text close our sequence and start its own.
 */
describe('OSC injection', () => {
  it('strips control characters from a title', () => {
    const out = titleSequence('a\x07\x1b]0;pwn\x07b')
    // `;` is neutralized as well: it separates OSC params wherever it appears.
    expect(out).toBe('\x1b]0;a]0,pwnb\x07')
  })

  it('strips control characters from a notification built from remote text', () => {
    const out = notifySequence({ title: 'T', body: 'x\x07\x1b]9;evil\x07' })
    // Exactly one terminator per sequence: the payload cannot close ours early.
    expect(out.split('\x07')).toHaveLength(3)
    expect(out).not.toContain('\x1b]9;evil')
  })

  it('strips 8-bit C1 introducers too', () => {
    expect(titleSequence('a\u009d0;pwn')).toBe('\x1b]0;a0,pwn\x07')
  })

  it('neutralizes the OSC parameter separator', () => {
    // `;` splits OSC params, so a body containing one could forge extra arguments.
    expect(notifySequence({ title: 'a;b', body: 'c;d' })).toContain(']777;notify;a,b;c,d')
  })

  it('caps a long body so a huge tool summary cannot flood the terminal', () => {
    const out = notifySequence({ title: 'T', body: 'x'.repeat(500) })
    expect(out.length).toBeLessThan(400)
    expect(out).toContain('…')
  })
})
