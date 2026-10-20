import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import type { TurnReceipt } from '@shared/evidence'
import { findAcceptedPlan, planProgress, planStillOpen, type AcceptedPlan } from './planChecklist'

const plan = (id: string, args: Record<string, unknown>): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name: 'present_plan', arguments: { title: 'Todo app', plan: '## Steps\n- build it', ...args } }]
})
const result = (id: string, content: string): ChatMessage => ({ role: 'tool', content, toolCallId: id, toolName: 'present_plan' })
const ACCEPTED = 'The user ACCEPTED the plan and switched off Plan mode. Carry out the plan now, step by step. Edits will be applied automatically as you make them.'

describe('findAcceptedPlan', () => {
  it('finds the accepted plan with its files and checks', () => {
    const log: ChatMessage[] = [
      { role: 'user', content: 'plan a todo app' },
      plan('p1', { files: ['app.py', 'test_app.py'], verify: ['pytest'] }),
      result('p1', ACCEPTED)
    ]
    expect(findAcceptedPlan(log)).toEqual({ index: 1, title: 'Todo app', files: ['app.py', 'test_app.py'], checks: ['pytest'] })
  })

  it("reads the checks from the user's hand-edited plan when it has no verify list", () => {
    const edited =
      'The user ACCEPTED the plan but EDITED it first, and switched off Plan mode. Carry out EXACTLY the following edited plan. ' +
      'It replaces the plan you presented, so follow it precisely even where it differs from yours:\n\n' +
      '## Steps\n- build it\n## Verification\n- npm test\n- curl /todos\n\nYou will be asked to approve each edit.'
    const log: ChatMessage[] = [plan('p1', { files: ['a.ts'] }), result('p1', edited)]
    expect(findAcceptedPlan(log)?.checks).toEqual(['npm test', 'curl /todos'])
  })

  it('has none in force when the latest plan was rejected, revised, or is still waiting', () => {
    const accepted: ChatMessage[] = [plan('p1', { files: ['a.py'] }), result('p1', ACCEPTED)]
    expect(findAcceptedPlan([...accepted, plan('p2', {}), result('p2', 'The user REJECTED this plan.')])).toBeNull()
    expect(findAcceptedPlan([...accepted, plan('p2', {})])).toBeNull()
    expect(findAcceptedPlan([{ role: 'user', content: 'hi' }])).toBeNull()
  })

  it('takes the newest accepted plan over an older one', () => {
    const log: ChatMessage[] = [
      plan('p1', { files: ['old.py'] }),
      result('p1', ACCEPTED),
      plan('p2', { files: ['new.py'] }),
      result('p2', ACCEPTED)
    ]
    expect(findAcceptedPlan(log)?.files).toEqual(['new.py'])
  })
})

const receipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
  v: 1,
  checks: [],
  otherCommands: 0,
  filesChanged: [],
  filesChangedCount: 0,
  ...over
})
const accepted: AcceptedPlan = { index: 1, title: 'Todo app', files: ['app.py', 'test_app.py', 'web/App.jsx'], checks: ['pytest', 'npm run build', 'add a todo in the browser'] }

describe('planProgress', () => {
  it('holds the plan against every receipt since it was accepted', () => {
    const p = planProgress({
      plan: accepted,
      acceptedAt: 1000,
      receipts: [
        receipt({ filesChanged: ['app.py'], checks: [{ kind: 'test', label: 'pytest', ok: false, exitCode: 1, runs: 1 }] }),
        receipt({ filesChanged: ['test_app.py'], checks: [{ kind: 'build', label: 'npm run build', ok: true, exitCode: 0, runs: 1 }] })
      ],
      workspace: '/ws',
      userText: 'finish the planned implementation',
      stat: () => undefined
    })
    expect(p).toEqual({
      title: 'Todo app',
      acceptedAt: 1000,
      filesTotal: 3,
      filesPending: ['web/App.jsx'],
      filesPendingCount: 1,
      checks: [
        { step: 'pytest', status: 'failed' },
        { step: 'npm run build', status: 'passed' },
        // Names no particular kind: any passing check of the code backs it.
        { step: 'add a todo in the browser', status: 'not-run' }
      ],
      complete: false
    })
  })

  it('matches a step written as a command by what it runs, not by another check failing', () => {
    // Found in the desktop app: "node test_app.mjs" read "ran, nothing passed" because a
    // failed browser check counted for a step that named no kind it recognized.
    const failedBrowser = receipt({
      checks: [{ kind: 'browser', label: 'http://localhost:8811/', ok: false, steps: { total: 0, passed: 0, notRun: 0 }, runs: 1 }]
    })
    const p = planProgress({
      plan: { ...accepted, checks: ['node test_app.mjs', 'add a todo and see it listed'] },
      receipts: [failedBrowser],
      workspace: '/ws',
      userText: '',
      stat: () => undefined
    })
    expect(p.checks).toEqual([
      { step: 'node test_app.mjs', status: 'not-run' },
      { step: 'add a todo and see it listed', status: 'not-run' }
    ])
    const ranTest = receipt({ checks: [{ kind: 'test', label: 'node test_app.mjs', ok: false, exitCode: 1, runs: 1 }] })
    expect(
      planProgress({ plan: { ...accepted, checks: ['node test_app.mjs'] }, receipts: [ranTest], workspace: '/ws', userText: '', stat: () => undefined })
        .checks
    ).toEqual([{ step: 'node test_app.mjs', status: 'failed' }])
  })

  it('backs a command step only with a run of that command', () => {
    // Also found in the app: "pytest" read "ran, nothing passed" when only a node test had run.
    const nodeTest = receipt({ checks: [{ kind: 'test', label: 'node test_app.mjs', ok: false, exitCode: 1, runs: 1 }] })
    const pytest = receipt({ checks: [{ kind: 'test', label: 'cd api && python -m pytest -q', ok: true, exitCode: 0, runs: 1 }] })
    const status = (receipts: TurnReceipt[]): string =>
      planProgress({ plan: { ...accepted, checks: ['pytest'] }, receipts, workspace: '/ws', userText: '', stat: () => undefined }).checks[0]
        .status
    expect(status([nodeTest])).toBe('not-run')
    expect(status([nodeTest, pytest])).toBe('passed')
  })

  it('counts a planned file changed on disk after acceptance, as a shell command would', () => {
    const stat = (p: string): { mtimeMs: number } | undefined =>
      p.endsWith('App.jsx') ? { mtimeMs: 2000 } : p.endsWith('test_app.py') ? { mtimeMs: 500 } : undefined
    const p = planProgress({ plan: accepted, acceptedAt: 1000, receipts: [receipt({ filesChanged: ['app.py'] })], workspace: '/ws', userText: '', stat })
    // test_app.py existed before the plan and was not touched since.
    expect(p.filesPending).toEqual(['test_app.py'])
  })

  it('marks the checks skipped when the user asked to leave them out', () => {
    const p = planProgress({ plan: accepted, receipts: [], workspace: '/ws', userText: "finish it, but don't run the tests", stat: () => undefined })
    expect(p.checks.map((c) => c.status)).toEqual(['skipped', 'skipped', 'skipped'])
  })

  it('is complete when every planned file changed and every check passed', () => {
    const p = planProgress({
      plan: { ...accepted, checks: ['pytest'] },
      receipts: [
        receipt({
          filesChanged: ['app.py', 'test_app.py', 'web/App.jsx'],
          checks: [{ kind: 'test', label: 'pytest', ok: true, exitCode: 0, runs: 1 }]
        })
      ],
      workspace: '/ws',
      userText: '',
      stat: () => undefined
    })
    expect(p.complete).toBe(true)
  })
})

describe('planStillOpen', () => {
  const turns = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, content: `q${i}` },
      { role: 'assistant' as const, content: 'a' }
    ]).flat()
  const log = (extra: ChatMessage[]): ChatMessage[] => [{ role: 'user', content: 'plan' }, plan('p1', {}), result('p1', ACCEPTED), ...extra]

  it('stays open for the turns that carry it out', () => {
    expect(planStillOpen(log(turns(2)), accepted, [], null)).toBe(true)
  })

  it('closes once a turn has shown it complete', () => {
    const done = receipt({ plan: { title: 'x', filesTotal: 1, filesPending: [], filesPendingCount: 0, checks: [], complete: true } })
    expect(planStillOpen(log(turns(1)), accepted, [done], null)).toBe(false)
  })

  it('closes when the chat has moved on, unless this turn touched a planned file', () => {
    expect(planStillOpen(log(turns(6)), accepted, [], receipt({ filesChanged: ['README.md'] }))).toBe(false)
    expect(planStillOpen(log(turns(6)), accepted, [], receipt({ filesChanged: ['web/App.jsx'] }))).toBe(true)
  })
})
