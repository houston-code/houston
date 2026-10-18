import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATE_COMMANDS, REVIEW_TEMPLATE, type Command } from './commands'
import {
  agentTurn,
  commandTurn,
  invocationText,
  sanitizeInvocation,
  shipTurn,
  spawnedTurn
} from './promptInvocation'
import { chooseShipAction, type RepoShipState } from './shipAction'

describe('sanitizeInvocation', () => {
  it('keeps a well-formed record', () => {
    const inv = { kind: 'command', label: '/review', detail: 'Adversarial review', typed: '/review' }
    expect(sanitizeInvocation(inv)).toEqual(inv)
  })

  it.each([
    ['null', null],
    ['a string', '/review'],
    ['an unknown kind', { kind: 'system', label: 'x' }],
    ['no label', { kind: 'command' }],
    ['a blank label', { kind: 'command', label: '   ' }],
    ['a non-string label', { kind: 'action', label: 42 }]
  ])('drops %s', (_name, raw) => {
    expect(sanitizeInvocation(raw)).toBeUndefined()
  })

  it('drops unknown fields and non-string optionals, and clamps long text', () => {
    const out = sanitizeInvocation({
      kind: 'action',
      label: 'x'.repeat(500),
      detail: 7,
      typed: '',
      html: '<img src=x onerror=alert(1)>'
    })
    expect(out).toEqual({ kind: 'action', label: `${'x'.repeat(119)}…` })
  })
})

describe('commandTurn', () => {
  const review: Command = { name: 'review', description: 'Review it', template: 'Do $ARGUMENTS now.' }

  it('expands the template and labels the turn with the command', () => {
    expect(commandTurn(review, 'the diff', '  /review the diff ')).toEqual({
      text: 'Do the diff now.',
      invokedAs: { kind: 'command', label: '/review', detail: 'Review it', typed: '/review the diff' }
    })
  })

  it('is null for an action command with no template', () => {
    expect(commandTurn({ name: 'new', description: 'Start a new chat' }, '', '/new')).toBeNull()
  })

  // A first-party template command added to the catalog later is covered without
  // anyone remembering to tag it: both clients build its turn through commandTurn.
  it.each(BUILTIN_TEMPLATE_COMMANDS.map((c) => [c.name, c] as const))(
    'gives built-in /%s a chip with a description',
    (_name, cmd) => {
      const turn = commandTurn(cmd, '', `/${cmd.name}`)
      expect(turn?.invokedAs.label).toBe(`/${cmd.name}`)
      expect(turn?.invokedAs.detail).toBeTruthy()
      expect(turn?.text.length).toBeGreaterThan(0)
    }
  )

  it('sends /review the shared review prompt', () => {
    const cmd = BUILTIN_TEMPLATE_COMMANDS.find((c) => c.name === 'review')!
    expect(commandTurn(cmd, '', '/review')?.text).toBe(REVIEW_TEMPLATE)
  })
})

describe('agentTurn', () => {
  it('labels the dispatch with the agent and carries the task as detail', () => {
    const turn = agentTurn('reviewer check the auth diff', '/agent reviewer check the auth diff')
    expect(turn?.text).toContain('`reviewer` subagent')
    expect(turn?.text).toContain('check the auth diff')
    expect(turn?.invokedAs).toEqual({
      kind: 'command',
      label: '/agent reviewer',
      detail: 'check the auth diff',
      typed: '/agent reviewer check the auth diff'
    })
  })

  it('has no detail when no task is given', () => {
    expect(agentTurn('reviewer', '/agent reviewer')?.invokedAs).toEqual({
      kind: 'command',
      label: '/agent reviewer',
      typed: '/agent reviewer'
    })
  })

  it('is null when the argument does not name an agent', () => {
    expect(agentTurn('', '/agent')).toBeNull()
    expect(agentTurn('../etc/passwd go', '/agent ../etc/passwd go')).toBeNull()
  })
})

describe('shipTurn', () => {
  // Every state the Changes panel can be in: each action it offers gets a chip
  // named by its button label, so a new ship action is covered the day it's added.
  const states: [string, RepoShipState | undefined][] = [
    ['unknown state', undefined],
    ['no remote', { hasCommits: true, remote: null }],
    ['no commits', { hasCommits: false, remote: { name: 'origin', host: 'github' } }],
    ['github remote', { hasCommits: true, remote: { name: 'origin', host: 'github' } }],
    ['other remote', { hasCommits: true, remote: { name: 'origin', host: 'other' } }]
  ]
  it.each(states)('labels the %s action with its button text', (_name, state) => {
    const action = chooseShipAction(state)
    expect(shipTurn(action)).toEqual({
      text: action.prompt,
      invokedAs: { kind: 'action', label: action.label, detail: action.hint }
    })
  })
})

describe('spawnedTurn', () => {
  it('uses the brief opening line as the detail and keeps the whole brief as text', () => {
    const brief = 'Add OAuth login.\n\nWire the callback route and add tests.'
    expect(spawnedTurn(brief)).toEqual({
      text: brief,
      invokedAs: { kind: 'spawned', label: 'Handed-off task', detail: 'Add OAuth login.' }
    })
  })

  it('clamps a very long opening line', () => {
    const detail = spawnedTurn('x'.repeat(400)).invokedAs.detail ?? ''
    expect(detail.length).toBe(160)
    expect(detail.endsWith('…')).toBe(true)
  })
})

describe('invocationText', () => {
  it('prefers what the user typed, else the label', () => {
    expect(invocationText({ kind: 'command', label: '/review', typed: '/review now' })).toBe('/review now')
    expect(invocationText({ kind: 'action', label: 'Create PR' })).toBe('Create PR')
  })
})
