import { describe, it, expect } from 'vitest'
import {
  signalFor,
  titleSequence,
  notifySequence,
  bellSequence,
  workingTitle,
  idleTitle,
  alertSequence,
  resolveNotifyMode,
  describeNotifyMode,
  idleReminderSpec,
  isNotifyMode,
  progressForEvent,
  progressSequence,
  progressSupport,
  supportsOsc94,
  type ProgressSupport
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

describe('notification modes (/notify)', () => {
  const spec = { title: 'Houston', body: 'Finished' }

  it('auto rings the bell and sends both notification forms', () => {
    expect(alertSequence(spec, 'auto')).toBe(bellSequence() + notifySequence(spec))
    expect(alertSequence(spec)).toBe(alertSequence(spec, 'auto'))
  })

  it('osc sends the notification only, bell the bell only, off nothing', () => {
    expect(alertSequence(spec, 'osc')).toBe(notifySequence(spec))
    expect(alertSequence(spec, 'osc')).not.toContain('\x07\x1b]9')
    expect(alertSequence(spec, 'bell')).toBe('\x07')
    expect(alertSequence(spec, 'off')).toBe('')
  })

  it('defaults to the shared notify-me switch when the terminal has no setting of its own', () => {
    expect(resolveNotifyMode({})).toBe('auto')
    expect(resolveNotifyMode({ desktopNotifications: false })).toBe('off')
    expect(resolveNotifyMode({ desktopNotifications: false, tuiNotify: 'bell' })).toBe('bell')
    expect(resolveNotifyMode({ tuiNotify: 'nonsense' as never })).toBe('auto')
  })

  it('validates mode names', () => {
    expect(['auto', 'osc', 'bell', 'off'].every(isNotifyMode)).toBe(true)
    expect(isNotifyMode('loud')).toBe(false)
  })

  it('says the title still updates when off', () => {
    expect(describeNotifyMode('off')).toContain('window title still updates')
  })

  it('names the project in the idle reminder', () => {
    expect(idleReminderSpec('proj')).toEqual({
      title: 'Houston · proj',
      body: 'Houston is waiting for your next message'
    })
    expect(idleReminderSpec().title).toBe('Houston')
  })
})

describe('titles that follow the chat', () => {
  it('puts the chat title in the idle and working titles', () => {
    expect(idleTitle('proj', 'Fix the login bug')).toBe('Fix the login bug · proj')
    expect(workingTitle('needs approval', 'proj', 'Fix the login bug')).toBe('● needs approval · Fix the login bug · proj')
  })

  it('falls back to Houston for an untitled chat', () => {
    expect(idleTitle('proj', 'New chat')).toBe('Houston · proj')
    expect(idleTitle('proj', null)).toBe('Houston · proj')
    expect(workingTitle('working', 'proj', '')).toBe('● working · proj')
  })

  it('carries the chat title on event signals', () => {
    expect(signalFor(approval, 'proj', 'Ship it')?.title).toBe('● needs approval · Ship it · proj')
    expect(signalFor({ runId: 'r', type: 'done', stopReason: 'end_turn' }, 'proj', 'Ship it')?.title).toBe('Ship it · proj')
  })

  it('strips control characters from a chat title', () => {
    expect(idleTitle('proj', 'a\x1b]0;evil\x07b')).toBe('a]0;evilb · proj')
  })
})

describe('progress reporting', () => {
  const ESC = '\x1b'
  const plain: ProgressSupport = { osc94: false, tmux: false }
  const full: ProgressSupport = { osc94: true, tmux: false }

  it('sends OSC 9;4 only to terminals known to draw it', () => {
    expect(supportsOsc94({ WT_SESSION: 'x' })).toBe(true)
    expect(supportsOsc94({ TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(supportsOsc94({ TERM_PROGRAM: 'WezTerm' })).toBe(true)
    expect(supportsOsc94({ ConEmuANSI: 'ON' })).toBe(true)
    expect(supportsOsc94({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.1' })).toBe(true)
    // Older iTerm2 shows any OSC 9 as a notification: it must never get 9;4.
    expect(supportsOsc94({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.9' })).toBe(false)
    expect(supportsOsc94({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
    expect(supportsOsc94({})).toBe(false)
  })

  it('stays out of tmux and screen unless passthrough is asked for, and off when off', () => {
    expect(progressSupport(undefined, {})).toEqual({ osc94: false, tmux: false })
    expect(progressSupport('off', { WT_SESSION: '1' })).toBeNull()
    expect(progressSupport('auto', { TMUX: '/tmp/t,1,0' })).toBeNull()
    expect(progressSupport('passthrough', { TMUX: '/tmp/t,1,0' })).toEqual({ osc94: false, tmux: true })
    expect(progressSupport('passthrough', { STY: '1.pts' })).toBeNull()
    expect(progressSupport('bogus', { TERM_PROGRAM: 'ghostty' })).toEqual({ osc94: true, tmux: false })
  })

  it('reports each state with OSC 7501 and, where drawn, OSC 9;4', () => {
    expect(progressSequence('working', full)).toBe(`${ESC}]9;4;3\x07${ESC}]7501;state=working:app=houston${ESC}\\`)
    expect(progressSequence('error', full)).toContain(`${ESC}]9;4;2;100\x07`)
    expect(progressSequence('done', full)).toBe(`${ESC}]9;4;0\x07${ESC}]7501;state=done:app=houston${ESC}\\`)
    expect(progressSequence('blocked-permission', plain)).toBe(`${ESC}]7501;state=blocked:kind=permission:app=houston${ESC}\\`)
    expect(progressSequence('blocked-question', plain)).toContain('state=blocked:kind=question')
    expect(progressSequence('idle', plain)).toContain('state=idle')
    expect(progressSequence('clear', plain)).toBe(`${ESC}]7501;state=clear${ESC}\\`)
  })

  it('sends the label as base64 with no control characters', () => {
    const seq = progressSequence('working', plain, 'Fix bug\x07 · proj')
    const b64 = /title=([A-Za-z0-9+/=]+)/.exec(seq)![1]
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Fix bug · proj')
  })

  it('wraps every sequence for tmux passthrough, doubling the ESCs inside', () => {
    const seq = progressSequence('working', { osc94: false, tmux: true })
    expect(seq).toBe(`${ESC}Ptmux;${ESC}${ESC}]7501;state=working:app=houston${ESC}${ESC}\\${ESC}\\`)
  })

  it('maps events to progress: blocked on approvals and questions, working otherwise', () => {
    expect(progressForEvent(approval)).toBe('blocked-permission')
    expect(progressForEvent({ runId: 'r', type: 'tool_question', callId: 'c', question: 'q?' } as unknown as AgentEvent)).toBe('blocked-question')
    expect(progressForEvent({ runId: 'r', type: 'text', delta: 'x' })).toBe('working')
    expect(progressForEvent({ runId: 'r', type: 'done', stopReason: 'end_turn' })).toBeNull()
  })
})
