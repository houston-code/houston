import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, systemNoteMessage, type ChatMessage, type RunEndRecord } from './agent'
import type { TurnReceipt } from './evidence'
import {
  FAILURE_SIGNALS,
  FAILURE_SIGNAL_INFO,
  LISTED_FAILURE_SIGNALS,
  attachFailureSignals,
  buildFailureSignals,
  emptyFailureSignalCounts,
  signalParts,
  type FailureSignal,
  type FailureSignalsInput
} from './failureSignals'
import { buildScorecard } from './scorecard'
import { renderShellEscapeRecord } from './shellEscape'

// ---- fixture builders (synthetic only, never real user data) ----

const at = '2026-11-01T00:00:00.000Z'
const user = (content = 'please fix the bug'): ChatMessage => ({ role: 'user', content })
const reply = (content = 'Done.', extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content,
  model: 'model-x',
  ...extra
})
const calls = (...names: string[]): Partial<ChatMessage> => ({
  toolCalls: names.map((name, i) => ({ id: `c${i}`, name, arguments: {} }))
})
const result = (toolName: string, content = 'ok'): ChatMessage => ({ role: 'tool', content, toolName, toolCallId: 'c0' })
const ended = (r: Omit<RunEndRecord, 'at'>): Partial<ChatMessage> => ({ runEnds: [{ ...r, at }] })
const receipt = (extra: Partial<TurnReceipt>): TurnReceipt => ({
  v: 1,
  checks: [],
  otherCommands: 0,
  filesChanged: [],
  filesChangedCount: 0,
  ...extra
})

const chat = (messages: ChatMessage[], extra: Partial<FailureSignalsInput> = {}): FailureSignalsInput => ({
  model: 'model-x',
  messages,
  ...extra
})

/** The signals one chat raised, as {signal: count} with the zero ones left out. */
function fired(...chats: FailureSignalsInput[]): Partial<Record<FailureSignal, number>> {
  const { totals } = buildFailureSignals(chats)
  return Object.fromEntries(FAILURE_SIGNALS.filter((s) => totals[s] > 0).map((s) => [s, totals[s]]))
}

describe('a chat where everything went fine', () => {
  it('raises no signal', () => {
    const fine = chat([
      user(),
      reply('Reading it.', calls('read_file')),
      result('read_file', '1\tconst x = 1'),
      reply('Fixing it.', calls('edit_file')),
      result('edit_file', 'Edited src/a.ts'),
      reply('Fixed: the null check was missing.', { receipt: receipt({ filesChanged: ['src/a.ts'], filesChangedCount: 1 }) }),
      user('thanks'),
      reply('Glad to help.')
    ])
    expect(fired(fine)).toEqual({})
  })
})

describe('unanswered', () => {
  it('counts each run that stopped before any reply, from its record', () => {
    const c = chat([
      // Two attempts at the same message failed before the model said anything (the
      // resend carried the first record over), then a third got a reply.
      { ...user(), runEnds: [{ reason: 'error', message: 'provider down', at }, { reason: 'aborted', at }] },
      reply('Here you go.'),
      user('and the tests?'),
      // A run that replied and then failed is not an unanswered one.
      { ...reply('Running them.'), ...ended({ reason: 'error' }) }
    ])
    expect(fired(c)).toEqual({ unanswered: 2 })
  })

  it('counts a run that stopped on a note Houston added before the first reply', () => {
    const c = chat([user('think hard'), { ...systemNoteMessage('think harder'), ...ended({ reason: 'error' }) }])
    expect(fired(c)).toEqual({ unanswered: 1 })
  })

  it('counts the older record of a run that got no reply', () => {
    const c = chat([{ ...user(), unanswered: [{ reason: 'error', at }] }, user('hello?'), reply()])
    expect(fired(c)).toEqual({ unanswered: 1 })
  })

  it('in a chat saved before records, counts a turn the next message followed with no reply', () => {
    const c = chat([user('first'), user('first'), reply()])
    expect(fired(c)).toEqual({ unanswered: 1 })
  })

  it("never counts the latest turn, which may still be running, or a user's own !cmd record", () => {
    expect(fired(chat([user(), reply(), user('still going')]))).toEqual({})
    const shell = { role: 'user' as const, content: renderShellEscapeRecord('npm test', '1 failed', 1) }
    expect(fired(chat([user(), reply(), shell, user('fix those failures'), reply()]))).toEqual({})
  })

  it("doesn't take a steered message or a compaction summary for a turn of its own", () => {
    const c = chat([
      { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX} earlier work` },
      user(),
      reply('On it.', calls('read_file')),
      { ...user('also check b.ts'), steered: true },
      result('read_file'),
      reply('Both done.')
    ])
    expect(fired(c)).toEqual({})
  })
})

describe('stepLimit and stalled', () => {
  it('counts the runs those limits ended, from their records', () => {
    const c = chat([
      user(),
      { ...reply('Halfway.'), ...ended({ reason: 'limit', limit: 'max-steps' }) },
      user('go on'),
      { ...reply('Still stuck.'), ...ended({ reason: 'limit', limit: 'stalled' }) },
      user('try again'),
      // Other limits aren't signals of their own: the scorecard's run-end counts show them.
      { ...reply('Out of budget.'), ...ended({ reason: 'limit', limit: 'max-cost' }) }
    ])
    expect(fired(c)).toEqual({ stepLimit: 1, stalled: 1 })
  })
})

describe('toolArgError', () => {
  it('counts calls refused for their arguments or an empty edit', () => {
    const c = chat([
      user(),
      reply('', calls('present_plan')),
      result('present_plan', 'Invalid arguments for tool "present_plan": files must be array.\nRequired: plan'),
      reply('', calls('multi_edit')),
      result('multi_edit', 'Error: edits must be a non-empty array.'),
      reply('', calls('multi_edit')),
      result('multi_edit', 'Error: edit 2: old_string must not be empty.'),
      reply('', calls('edit_file')),
      result('edit_file', 'Error: old_string and new_string are identical, so the edit would make no change.'),
      // A hook's bad rewrite isn't the model's mistake.
      reply('', calls('edit_file')),
      result('edit_file', 'Error: A PreToolUse hook rewrote the input, but it was invalid:\nInvalid arguments'),
      reply('Fixed.')
    ])
    expect(fired(c)).toEqual({ toolArgError: 4 })
  })
})

describe('repeatedError', () => {
  it('counts the same tool failing the same way a third time, once', () => {
    const fail = (n: number): ChatMessage[] => [
      reply('', calls('read_file')),
      result('read_file', `Error: ENOENT: no such file or directory, open 'src/missing${n}.ts'`)
    ]
    const c = chat([user(), ...fail(1), ...fail(2), ...fail(3), ...fail(4), reply('It does not exist.')])
    expect(fired(c)).toEqual({ repeatedError: 1 })
  })

  it("reads a shell command's non-zero exit as a failure, and keeps different errors apart", () => {
    const shell = (out: string): ChatMessage[] => [reply('', calls('run_shell')), result('run_shell', out)]
    const failing = 'FAIL src/a.test.ts\n  expected 1, got 2\n[exit code: 1]\n[cwd: packages/app]'
    const c = chat([
      user(),
      ...shell(failing),
      ...shell('Error: something else'),
      ...shell(failing),
      ...shell('all good\n[exit code: 0]'),
      ...shell(failing),
      reply('The test still fails.')
    ])
    expect(fired(c)).toEqual({ repeatedError: 1 })
  })
})

describe('toolCallAsText', () => {
  it('counts a reply that wrote a call out instead of making it', () => {
    const c = chat([
      user(),
      reply('I will now call {"name": "read_file", "arguments": {"path": "a.ts"}}'),
      user('ok'),
      reply('<parameter name="path">a.ts</parameter>'),
      user('ok'),
      // Call markup leaked into a real call's arguments.
      reply('', { toolCalls: [{ id: 'c0', name: 'write_file', arguments: { path: '<parameter name="path">a.ts' } }] }),
      result('write_file', 'Wrote a.ts'),
      reply('Done.')
    ])
    expect(fired(c)).toEqual({ toolCallAsText: 3 })
  })
})

describe('silentTurnEnd', () => {
  it('counts a turn that ended on a tool result with no closing message', () => {
    const c = chat([user(), reply('', calls('run_shell')), result('run_shell', 'built\n[exit code: 0]'), user('well?'), reply()])
    expect(fired(c)).toEqual({ silentTurnEnd: 1 })
  })

  it("doesn't count one the record explains, a denial, or the interrupted-call placeholder", () => {
    const then = [user('next'), reply()]
    const stopped = chat([user(), reply('', calls('run_shell')), { ...result('run_shell', 'partial'), ...ended({ reason: 'aborted' }) }, ...then])
    const denied = chat([user(), reply('', calls('run_shell')), result('run_shell', 'Denied by the user.'), ...then])
    const interrupted = chat([user(), reply('', calls('run_shell')), result('run_shell', 'No result: the previous turn was interrupted.'), ...then])
    expect(fired(stopped, denied, interrupted)).toEqual({})
  })

  it("doesn't count the latest turn, which may still be running", () => {
    expect(fired(chat([user(), reply('', calls('run_shell')), result('run_shell', 'building...')]))).toEqual({})
  })
})

describe('askUserBurst', () => {
  it('counts a turn that asked three or more questions before changing anything, once', () => {
    const ask = (): ChatMessage[] => [reply('', calls('ask_user')), result('ask_user', 'yes')]
    const c = chat([user(), ...ask(), ...ask(), ...ask(), ...ask(), reply('', calls('write_file')), result('write_file'), reply()])
    expect(fired(c)).toEqual({ askUserBurst: 1 })
  })

  it("doesn't count questions asked after work started", () => {
    const ask = (): ChatMessage[] => [reply('', calls('ask_user')), result('ask_user', 'yes')]
    const c = chat([user(), reply('', calls('edit_file')), result('edit_file'), ...ask(), ...ask(), ...ask(), reply()])
    expect(fired(c)).toEqual({})
  })
})

describe('todoGap and testEdit', () => {
  it('counts turns whose receipt shows a todo done with no passing check, or a loosened test', () => {
    const c = chat([
      user(),
      reply('All tests pass.', { receipt: receipt({ todoGaps: ['Run the tests'] }) }),
      user('really?'),
      reply('Done.', { receipt: receipt({ testEdits: [{ path: 'a.test.ts', kind: 'skip', detail: 'added it.skip' }] }) }),
      user('and?'),
      // Only dropped by the cap: still a loosened test.
      reply('Done again.', { receipt: receipt({ testEdits: [], testEditsOmitted: 2 }) })
    ])
    expect(fired(c)).toEqual({ todoGap: 1, testEdit: 2 })
  })
})

describe('buildFailureSignals', () => {
  it("counts only a fork's own messages, though it reads the turn it continued whole", () => {
    const copied = [user(), { ...reply(), runEnds: [{ reason: 'limit' as const, limit: 'max-steps' as const, at }] }]
    const c = chat([...copied, user('more'), reply('', calls('run_shell')), result('run_shell', 'x\n[exit code: 0]'), user('?'), reply()], {
      inherited: 2
    })
    expect(fired(c)).toEqual({ silentTurnEnd: 1 })
  })

  it('counts signals in the row of the reply they came from, and replies and chats per row', () => {
    const c = chat(
      [
        user(),
        reply('', { model: 'model-a', promptId: 'p1', ...calls('edit_file') }),
        result('edit_file', 'Error: edits must be a non-empty array.'),
        reply('Fixed.', { model: 'model-a', promptId: 'p1' }),
        user('switch'),
        reply('<tool_response>', { model: 'model-b', promptId: 'p2' })
      ],
      { model: 'model-b' }
    )
    const byModel = buildFailureSignals([c])
    expect(byModel.groupBy).toBe('model')
    const a = byModel.groups.find((g) => g.model === 'model-a')!
    const b = byModel.groups.find((g) => g.model === 'model-b')!
    expect(a).toMatchObject({ chats: 1, replies: 2 })
    expect(a.signals.toolArgError).toBe(1)
    expect(a.signals.toolCallAsText).toBe(0)
    expect(b).toMatchObject({ chats: 1, replies: 1 })
    expect(b.signals.toolCallAsText).toBe(1)

    const byPrompt = buildFailureSignals([c], { groupBy: 'model-prompt' })
    expect(byPrompt.groups.map((g) => [g.model, g.promptId])).toEqual([
      ['model-a', 'p1'],
      ['model-b', 'p2']
    ])
    expect(byPrompt.totals.toolArgError + byPrompt.totals.toolCallAsText).toBe(2)
  })

  it('returns counts only: no text from the chats reaches the report', () => {
    const secret = 'the-launch-codes-are-0000'
    const c = chat([
      user(secret),
      reply(`{"name": "x", "arguments": "${secret}"}`, calls('ask_user', 'ask_user', 'ask_user')),
      result('ask_user', `Error: ${secret}`)
    ])
    const report = buildFailureSignals([c, c, c])
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(JSON.stringify(report)).not.toContain('launch')
  })

  it('skips an empty chat without making a row for it', () => {
    expect(buildFailureSignals([chat([])]).groups).toEqual([])
  })
})

describe('attachFailureSignals', () => {
  it("puts each row's signals on the matching scorecard row, zero where none fired", () => {
    const noisy = chat([user(), reply('<parameter name="x">', { model: 'model-a' })])
    const quiet = chat([user(), reply('Done.', { model: 'model-b' })], { model: 'model-b' })
    const card = attachFailureSignals(buildScorecard([noisy, quiet]), buildFailureSignals([noisy, quiet]))
    const by = Object.fromEntries(card.models.map((r) => [r.model, r]))
    expect(by['model-a'].signals?.toolCallAsText).toBe(1)
    expect(by['model-b'].signals).toEqual(emptyFailureSignalCounts())
  })

  it('attaches nothing from a report grouped differently', () => {
    const c = chat([user(), reply()])
    const card = attachFailureSignals(buildScorecard([c]), buildFailureSignals([c], { groupBy: 'model-prompt' }))
    expect(card.models[0].signals).toBeUndefined()
  })
})

describe('signalParts', () => {
  it('lists the fired signals with their labels, leaving the run-end ones to the run-end counts', () => {
    const c = emptyFailureSignalCounts()
    c.stepLimit = 4
    c.stalled = 1
    c.repeatedError = 2
    c.unanswered = 1
    expect(signalParts(c)).toEqual([
      { signal: 'unanswered', label: 'no reply', count: 1 },
      { signal: 'repeatedError', label: 'repeated errors', count: 2 }
    ])
  })

  it('has a label and a hint for every signal, with no em dashes in either', () => {
    for (const s of FAILURE_SIGNALS) {
      expect(FAILURE_SIGNAL_INFO[s].label).not.toBe('')
      expect(`${FAILURE_SIGNAL_INFO[s].label} ${FAILURE_SIGNAL_INFO[s].hint}`).not.toContain('—')
    }
    expect(LISTED_FAILURE_SIGNALS).not.toContain('stepLimit')
    expect(LISTED_FAILURE_SIGNALS).not.toContain('stalled')
  })
})
