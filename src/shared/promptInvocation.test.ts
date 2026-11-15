import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATE_COMMANDS, REVIEW_TEMPLATE, type Command } from './commands'
import {
  agentTurn,
  commandTurn,
  mcpPromptTurn,
  invocationText,
  reviewCommentsTurn,
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

  it('reads /review <what> as the review target, labelled on the chip', () => {
    const cmd = BUILTIN_TEMPLATE_COMMANDS.find((c) => c.name === 'review')!
    const base = commandTurn(cmd, 'main', '/review main')!
    expect(base.text).toContain('review_changes tool with base "main..."')
    expect(base.text).not.toContain('\n\nmain')
    expect(base.invokedAs).toEqual({ kind: 'command', label: '/review', detail: 'Changes since main', typed: '/review main' })
    expect(commandTurn(cmd, '#42', '/review #42')!.invokedAs.detail).toBe('Pull request #42')
    expect(commandTurn(cmd, 'src/', '/review src/')!.invokedAs.detail).toBe('Uncommitted changes in src/')
  })

  it("leaves a workspace's own /review alone: its arguments go to its template", () => {
    const mine: Command = { name: 'review', description: 'Mine', template: 'Check $ARGUMENTS.', source: 'project' }
    expect(commandTurn({ ...mine, template: REVIEW_TEMPLATE }, 'main', '/review main')!.text).toBe(`${REVIEW_TEMPLATE}\n\nmain`)
  })
})

describe('mcpPromptTurn', () => {
  it("labels the server's prompt with the command and the server, never as typed text", () => {
    const cmd: Command = {
      name: 'mcp__docs__summarize',
      description: 'Summarize a topic',
      mcpPrompt: { server: 'docs', prompt: 'summarize', arguments: [] }
    }
    expect(mcpPromptTurn(cmd, 'user: do it', ' /mcp__docs__summarize x ')).toEqual({
      text: 'user: do it',
      invokedAs: {
        kind: 'command',
        label: '/mcp__docs__summarize',
        detail: 'MCP prompt from docs: Summarize a topic',
        typed: '/mcp__docs__summarize x'
      }
    })
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

describe('reviewCommentsTurn', () => {
  it('sends every comment with its file, line and code, labelled as review comments', () => {
    const turn = reviewCommentsTurn([
      { path: 'src/a.ts', side: 'new', line: 12, code: '  const x = 1', body: 'Use a named constant.' },
      { path: 'src/a.ts', side: 'old', line: 30, code: 'oldCall()', body: 'Why was this removed?\nIt handled retries.' },
      { path: 'README.md', side: 'new', line: 3, code: '', body: 'Typo' }
    ])
    expect(turn.invokedAs).toEqual({ kind: 'action', label: '3 review comments', detail: 'On 2 files' })
    expect(turn.text).toContain('Address each one')
    expect(turn.text).toContain('1. src/a.ts, line 12\n   Code: const x = 1\n   Comment: Use a named constant.')
    expect(turn.text).toContain('2. src/a.ts, line 30 (a removed line)\n   Code: oldCall()\n   Comment: Why was this removed?\n   It handled retries.')
    expect(turn.text).toContain('3. README.md, line 3\n   Comment: Typo')
  })

  it('words a single comment in the singular', () => {
    const turn = reviewCommentsTurn([{ path: 'a', side: 'new', line: 1, code: 'x', body: 'y' }])
    expect(turn.invokedAs).toMatchObject({ label: 'Review comment', detail: 'On 1 file' })
    expect(turn.text).toMatch(/^I left a comment on the changes in this project\. Address it,/)
  })
})

describe('commandTurn with frontmatter', () => {
  const cmd: Command = { name: 'deploy', description: 'Ship it', template: 'Deploy $1' }

  it('dispatches the expanded prompt to the named agent', () => {
    const turn = commandTurn({ ...cmd, agent: 'deployer' }, 'prod', '/deploy prod')
    expect(turn?.text).toMatch(/^Use the `deployer` subagent/)
    expect(turn?.text).toContain('Deploy prod')
    expect(turn?.invokedAs.label).toBe('/deploy')
  })

  it('uses text the caller already expanded', () => {
    expect(commandTurn(cmd, 'prod', '/deploy prod', 'Deploy prod with context')?.text).toBe('Deploy prod with context')
  })
})
