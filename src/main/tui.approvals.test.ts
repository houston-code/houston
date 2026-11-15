import { describe, expect, it } from 'vitest'
import type { AgentEvent, ToolApprovalDecision } from '@shared/agent'
import type { AppSettings, PermissionRule, RecentDenial } from '@shared/types'
import {
  APPROVAL_OPTIONS,
  ApprovalCounter,
  approvalOptionsFor,
  approvalOutcome,
  confirmsDiscard,
  makePainter,
  parseApprovalAnswer,
  parseNoteScope,
  parseSlashCommand,
  renderApprovalPrompt,
  runTui,
  type TuiDeps,
  type TuiIo
} from './tui'
import type { PickerOutcome, PickerSpec } from './tui-picker'

// Approvals with a note, the "2 of 5" count, the typed confirmation for commands that
// can throw away work, and /permissions' recently denied list.

type Approval = Extract<AgentEvent, { type: 'tool_approval' }>
const ESC = String.fromCharCode(27)

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }], defaultModel: 'claude' }],
    selected: { providerId: 'anthropic', model: 'claude' },
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...over
  }) as unknown as AppSettings

const opts = { cwd: '/proj', approvalPolicy: 'ask' as const, color: false }

const approval = (over: Partial<Approval> = {}): Approval => ({
  runId: 'x',
  type: 'tool_approval',
  callId: 'c1',
  name: 'run_shell',
  summary: 'npm test',
  args: { command: 'npm test' },
  kind: 'shell',
  ...over
})

/** A scripted terminal: reads drain `inputs`, the picker answers from `picks`. */
function harness(events: AgentEvent[], inputs: Array<string | null>, picks?: PickerOutcome[], over: Partial<AppSettings> = {}) {
  const out: string[] = []
  const reads: string[] = []
  const specs: PickerSpec[] = []
  const approvals: Array<[string, ToolApprovalDecision, string | undefined]> = []
  let i = 0
  let p = 0
  const io: TuiIo = {
    out: (s) => out.push(s),
    clearLine: () => {},
    readLine: async (prompt) => {
      reads.push(prompt)
      return i < inputs.length ? inputs[i++] : null
    },
    onInterrupt: () => {},
    cancelRead: () => {},
    startSpinner: () => {},
    setSpinnerLabel: () => {},
    stopSpinner: () => {},
    ...(picks
      ? {
          select: async (spec: PickerSpec): Promise<PickerOutcome> => {
            specs.push(spec)
            return picks[p++] ?? { kind: 'cancel' }
          }
        }
      : {})
  }
  let runs = 0
  const d: TuiDeps = {
    getSettings: () => settings(over),
    startRun: async (req, send, onMessages) => {
      for (const e of events) send({ ...e, runId: req.runId } as AgentEvent)
      onMessages?.(req.messages)
    },
    resolveApproval: (_r, c, dec, note) => approvals.push([c, dec, note]),
    resolveQuestion: () => {},
    resolvePlan: () => {},
    resolveElicitation: () => {},
    cancelRun: () => {},
    io,
    newId: () => `run-${++runs}`
  }
  return { d, out, reads, specs, approvals, text: () => out.join('') }
}

const done: AgentEvent = { runId: 'x', type: 'done', stopReason: 'end_turn' }

describe('approval prompt: notes, counts and discards (pure)', () => {
  it('offers a note with an allow, and parses the typed key for it', () => {
    expect(APPROVAL_OPTIONS.find((o) => o.value === 'allow-note')?.label).toBe('Allow with a note…')
    expect(parseApprovalAnswer('c')).toEqual({ decision: 'allow', askNote: true })
    expect(parseApprovalAnswer('note')).toEqual({ decision: 'allow', askNote: true })
    // A sentence is still a denial with a reason.
    expect(parseApprovalAnswer('use the staging bucket')).toEqual({ decision: 'deny', note: 'use the staging bucket' })
    expect(parseNoteScope('y')).toBe('allow')
    expect(parseNoteScope('a')).toBe('always')
    expect(parseNoteScope('2')).toBe('always')
    expect(parseNoteScope('')).toBe('deny')
    expect(parseNoteScope(null)).toBe('deny')
    expect(renderApprovalPrompt(approval(), makePainter(false))).toContain('[c] allow with a note')
  })

  it('words an allow that carried a note', () => {
    expect(approvalOutcome('allow', { note: 'keep the old file' })).toBe('Allowed, with a note: keep the old file')
    expect(approvalOutcome('always', { note: 'x' })).toBe('Allowed for this chat, with a note: x')
    expect(approvalOutcome('allow')).toBe('Allowed')
  })

  it('numbers approvals waiting at once, oldest first, and starts over once none waits', () => {
    const c = new ApprovalCounter()
    c.arrived('a')
    expect(c.position()).toBeNull()
    c.arrived('b')
    c.arrived('c')
    expect(c.position()).toEqual({ index: 1, total: 3 })
    c.done('a')
    expect(c.position()).toEqual({ index: 2, total: 3 })
    c.arrived('d')
    expect(c.position()).toEqual({ index: 2, total: 4 })
    c.done('b')
    c.done('c')
    c.done('d')
    c.arrived('e')
    expect(c.position()).toBeNull()
    // Done twice, or for an id that never arrived, counts nothing.
    c.done('zzz')
    expect(c.position()).toBeNull()
    expect(renderApprovalPrompt(approval(), makePainter(false), { position: { index: 2, total: 5 } })).toContain('2 of 5')
  })

  it('drops "Allow for this chat" for a command that can throw away work, and says why', () => {
    const ev = approval({ summary: 'git reset --hard', args: { command: 'git reset --hard' }, discardsWork: true })
    expect(approvalOptionsFor(ev).map((o) => o.value)).not.toContain('always')
    expect(approvalOptionsFor(approval()).map((o) => o.value)).toContain('always')
    const p = renderApprovalPrompt(ev, makePainter(false))
    expect(p).toContain('can throw away work in the project')
    expect(p).toContain('type yes to confirm')
    expect(p).not.toContain('[a] allow for this chat')
    expect(p).toContain('[y] allow once')
    expect(p).not.toContain('—')
    expect(confirmsDiscard(' YES ')).toBe(true)
    expect(confirmsDiscard('y')).toBe(false)
    expect(confirmsDiscard(null)).toBe(false)
  })
})

describe('approval prompt: notes, counts and discards (driver)', () => {
  it('allows with a note from the picker, then asks how long the allow lasts', async () => {
    const t = harness([approval(), done], ['go', 'keep the old build', null], [
      { kind: 'commit', value: 'allow-note' },
      { kind: 'commit', value: 'always' }
    ])
    await runTui(opts, t.d)
    expect(t.reads).toContain('Note for the agent: ')
    expect(t.specs[1].options.map((o) => o.value)).toEqual(['allow', 'always'])
    expect(t.approvals).toEqual([['c1', 'always', 'keep the old build']])
    expect(t.text()).toContain('↳ Allowed for this chat, with a note: keep the old build')
  })

  it('allows with a note by typed keys when there is no picker', async () => {
    const t = harness([approval(), done], ['go', 'c', 'run it twice', 'y', null])
    await runTui(opts, t.d)
    expect(t.approvals).toEqual([['c1', 'allow', 'run it twice']])
  })

  it('denies when the note step is abandoned', async () => {
    const t = harness([approval(), done], ['go', 'c', 'x', null])
    await runTui(opts, t.d)
    // No answer to "once or for this chat?" is not an allow, and the note written for
    // an approval is not sent as a reason for a denial.
    expect(t.approvals).toEqual([['c1', 'deny', undefined]])
    const cut = harness([approval(), done], ['go', 'c', null])
    await runTui(opts, cut.d)
    expect(cut.approvals).toEqual([['c1', 'deny', undefined]])
    // "c" at the network question grants nothing.
    const net = harness([approval({ shellNetwork: true }), done], ['go', 'c', null])
    await runTui(opts, net.d)
    expect(net.approvals).toEqual([['c1', 'deny', undefined]])
  })

  it('runs a work-discarding command only once "yes" is typed, and never offers the chat grant', async () => {
    const ev = approval({ summary: 'git reset --hard', args: { command: 'git reset --hard' }, discardsWork: true })
    const ok = harness([ev, done], ['go', 'yes', null], [{ kind: 'commit', value: 'allow' }])
    await runTui(opts, ok.d)
    expect(ok.specs[0].options.map((o) => o.label)).not.toContain('Allow for this chat')
    expect(ok.reads).toContain('Type yes to run it (anything else denies): ')
    expect(ok.approvals).toEqual([['c1', 'allow', undefined]])

    const no = harness([ev, done], ['go', 'y', null], [{ kind: 'commit', value: 'rule-allow' }])
    await runTui(opts, no.d)
    expect(no.approvals).toEqual([['c1', 'deny', undefined]])
    expect(no.text()).toContain('↳ Denied: not confirmed')

    // Typed: a chat grant typed at it runs it once, after the same confirmation.
    const typed = harness([ev, done], ['go', 'a', 'yes', null])
    await runTui(opts, typed.d)
    expect(typed.approvals).toEqual([['c1', 'allow', undefined]])

    // A note on it skips the "once or for this chat" question: once is all there is.
    const noted = harness([ev, done], ['go', 'keep a backup', 'yes', null], [{ kind: 'commit', value: 'allow-note' }])
    await runTui(opts, noted.d)
    expect(noted.specs).toHaveLength(1)
    expect(noted.approvals).toEqual([['c1', 'allow', 'keep a backup']])

    // A denial asks for no confirmation.
    const deny = harness([ev, done], ['go', 'n', null])
    await runTui(opts, deny.d)
    expect(deny.reads.filter((r) => r.startsWith('Type yes'))).toEqual([])
    expect(deny.approvals).toEqual([['c1', 'deny', undefined]])
  })

  it('says "n of m" on each of several approvals waiting at once', async () => {
    const t = harness(
      [approval({ callId: 'a' }), approval({ callId: 'b' }), approval({ callId: 'c' }), done],
      ['go', 'y', 'n', 'y', null]
    )
    await runTui(opts, t.d)
    const text = t.text()
    expect(text).toContain('1 of 3')
    expect(text).toContain('2 of 3')
    expect(text).toContain('3 of 3')
    expect(text.indexOf('1 of 3')).toBeLessThan(text.indexOf('2 of 3'))
    expect(t.approvals.map((a) => a[0])).toEqual(['a', 'b', 'c'])
    // A single prompt carries no count.
    const one = harness([approval(), done], ['go', 'y', null])
    await runTui(opts, one.d)
    expect(one.text()).not.toMatch(/\d of \d/)
  })

  it('in screen-reader mode says the count and the confirmation as plain lines', async () => {
    const ev = approval({ callId: 'b', summary: 'rm -r src', args: { command: 'rm -r src' }, discardsWork: true })
    const t = harness([approval({ callId: 'a' }), ev, done], ['go', 'y', 'y', 'yes', null])
    await runTui({ ...opts, color: true, screenReader: true }, t.d)
    const text = t.text()
    expect(text).not.toContain(ESC)
    expect(text).toContain('waiting for approval, 1 of 2')
    expect(text).toContain('waiting for approval, 2 of 2')
    expect(text).toContain('can throw away work in the project')
    expect(t.approvals).toEqual([
      ['a', 'allow', undefined],
      ['b', 'allow', undefined]
    ])
  })
})

describe('/permissions: recently denied, allow this, add by typing', () => {
  const denial: RecentDenial = {
    id: 'd7',
    at: Date.now() - 120_000,
    tool: 'run_shell',
    kind: 'shell',
    subject: 'git push --force\x1b[2J',
    reason: 'not on main'
  }

  it('parses the new verbs', () => {
    expect(parseSlashCommand('/permissions allow 2', settings())).toEqual({ kind: 'permissions', allow: 2 })
    expect(parseSlashCommand('/permissions add allow run_shell npm run *', settings())).toEqual({
      kind: 'permissions',
      add: { action: 'allow', tool: 'run_shell', match: 'npm run *', source: 'settings' }
    })
    expect(parseSlashCommand('/permissions add deny exact read_file .env', settings())).toEqual({
      kind: 'permissions',
      add: { action: 'deny', tool: 'read_file', match: '.env', exact: true, source: 'settings' }
    })
    expect(parseSlashCommand('/permissions add maybe run_shell ls', settings())).toEqual({
      kind: 'permissions',
      error: 'usage: /permissions add allow|ask|deny [exact] <tool> <pattern>'
    })
    expect(parseSlashCommand('/permissions add allow ru$n ls', settings())).toEqual({
      kind: 'permissions',
      error: '"ru$n" is not a tool name (or *)'
    })
  })

  it('lists this session\'s denials, saves an allow rule for one, and adds a typed rule', async () => {
    const existing: PermissionRule = { action: 'deny', tool: 'web_fetch', match: 'https://evil.example/*' }
    const t = harness([], ['/permissions', '/permissions allow 1', '/permissions allow 5', '/permissions add ask run_shell git push *', null], undefined, {
      permissionRules: [existing]
    })
    const allowed: string[] = []
    const saved: Array<Partial<AppSettings>> = []
    t.d.recentDenials = () => [denial]
    t.d.allowRecentDenial = (id) => {
      allowed.push(id)
      return { added: [{ action: 'allow', tool: 'run_shell', match: 'git push --force', exact: true }], deniedByRule: true }
    }
    t.d.updateSettings = (patch) => saved.push(patch)
    await runTui(opts, t.d)
    const text = t.text()
    expect(text).toContain('Recently denied this session (newest first):')
    expect(text).toContain('1. run_shell  git push --force<U+001B>[2J')
    expect(text).toContain('(2 min ago, "not on main")')
    expect(text).not.toContain('\x1b[2J')
    expect(text).toContain('/permissions add allow|ask|deny [exact] <tool> <pattern> adds a rule by typing it.')
    expect(allowed).toEqual(['d7'])
    expect(text).toContain('saved: allow run_shell git push --force (exact)')
    expect(text).toContain('a deny rule still matches it')
    expect(text).toContain('no recently denied call 5')
    expect(saved).toHaveLength(1)
    expect(saved[0].permissionRules?.[0]).toEqual(existing)
    expect(saved[0].permissionRules?.[1]).toEqual(
      expect.objectContaining({ action: 'ask', tool: 'run_shell', match: 'git push *', source: 'settings' })
    )
    expect(text).toContain('added rule 2: ask run_shell git push *')
  })

  it('warns when a typed rule allows everything', async () => {
    const t = harness([], ['/permissions add allow run_shell *', null])
    const saved: Array<Partial<AppSettings>> = []
    t.d.updateSettings = (patch) => saved.push(patch)
    await runTui(opts, t.d)
    expect(saved[0].permissionRules).toEqual([expect.objectContaining({ action: 'allow', tool: 'run_shell', match: '*' })])
    expect(t.text()).toContain('note: it approves every run_shell call without asking; /permissions remove 1 drops it')
  })

  it('shows no denials section when nothing was denied, in plain lines for a screen reader', async () => {
    const t = harness([], ['/permissions', null])
    t.d.recentDenials = () => []
    await runTui({ ...opts, color: true, screenReader: true }, t.d)
    expect(t.text()).not.toContain('Recently denied')
    expect(t.text()).not.toContain(ESC)
  })
})
