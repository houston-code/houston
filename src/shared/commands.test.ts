import { describe, expect, it } from 'vitest'
import {
  agentInvocationPrompt,
  builtinCommands,
  expandTemplate,
  matchCommands,
  mergeCommands,
  parseAgentInvocation,
  parseSlashCommand,
  resolveCommand,
  type Command
} from './commands'

describe('BUILTIN_COMMAND_CATALOG ↔ TUI parity', () => {
  // Every first-class command the interactive TUI (src/main/tui.ts parseSlashCommand)
  // handles and HELP_TEXT documents must be a catalog 'tui' entry, or it won't be
  // tab-completable and Houston's self-knowledge (the guide) will be wrong about it.
  // Adding a command to the TUI without cataloging it should fail here.
  const TUI_COMMANDS = [
    'new', 'clear', 'compact', 'plan', 'model', 'login', 'settings', 'approval',
    'resume', 'fork', 'cost', 'skills', 'agents', 'mcp', 'hooks', 'theme', 'image',
    'cwd', 'help', 'review', 'exit', 'quit'
  ]

  it('lists every TUI command in the catalog for the tui client', () => {
    const tui = new Set(builtinCommands('tui').map((c) => c.name))
    for (const name of TUI_COMMANDS) {
      expect(tui.has(name), `/${name} must be a catalog 'tui' entry (tab-completion + guide)`).toBe(true)
    }
  })
})

describe('parseSlashCommand', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', args: '' })
  })

  it('parses a command with arguments', () => {
    expect(parseSlashCommand('/review the auth module')).toEqual({
      name: 'review',
      args: 'the auth module'
    })
  })

  it('returns null when the text is not a slash command', () => {
    expect(parseSlashCommand('hello /new')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
  })
})

describe('expandTemplate', () => {
  it('substitutes every $ARGUMENTS occurrence', () => {
    expect(expandTemplate('Review $ARGUMENTS for bugs in $ARGUMENTS', 'auth.ts')).toBe(
      'Review auth.ts for bugs in auth.ts'
    )
  })

  it('appends args when there is no placeholder', () => {
    expect(expandTemplate('Run the linter.', 'on src/')).toBe('Run the linter.\n\non src/')
  })

  it('leaves the template alone when there are no args and no placeholder', () => {
    expect(expandTemplate('Summarize the repo.', '')).toBe('Summarize the repo.')
  })
})

describe('matchCommands', () => {
  const cmds: Command[] = [
    { name: 'new', description: 'New chat' },
    { name: 'review', description: 'Review' },
    { name: 'refactor', description: 'Refactor' }
  ]
  it('filters by case-insensitive name prefix', () => {
    expect(matchCommands(cmds, 're').map((c) => c.name)).toEqual(['review', 'refactor'])
    expect(matchCommands(cmds, 'N').map((c) => c.name)).toEqual(['new'])
    expect(matchCommands(cmds, '')).toHaveLength(3)
  })
})

describe('resolveCommand', () => {
  const cmds: Command[] = [{ name: 'new', description: '' }, { name: 'Review', description: '' }]
  it('resolves by exact name, case-insensitively', () => {
    expect(resolveCommand(cmds, 'NEW')?.name).toBe('new')
    expect(resolveCommand(cmds, 'review')?.name).toBe('Review')
  })
  it('returns undefined for an unknown command', () => {
    expect(resolveCommand(cmds, 'nope')).toBeUndefined()
  })
})

describe('mergeCommands', () => {
  it('drops custom commands that collide with a built-in name (built-in wins)', () => {
    const merged = mergeCommands(
      [{ name: 'new', description: 'built-in' }],
      [
        { name: 'new', description: 'custom', template: 'x' },
        { name: 'review', description: 'custom', template: 'y' }
      ]
    )
    expect(merged.map((c) => c.name)).toEqual(['new', 'review'])
    expect(merged.find((c) => c.name === 'new')?.description).toBe('built-in')
  })
})

describe('expandTemplate — positional arguments', () => {
  // A command that wants "the second word" had to make the user re-type it in the
  // right shape, or parse $ARGUMENTS in prose and hope.
  it('fills $1, $2 from the words the user typed', () => {
    expect(expandTemplate('deploy $1 at version $2', 'staging v2')).toBe('deploy staging at version v2')
  })

  it('leaves an unsupplied positional empty rather than printing $2', () => {
    expect(expandTemplate('deploy $1 at $2', 'staging')).toBe('deploy staging at ')
  })

  it('does not append the args again once positionals consumed them', () => {
    expect(expandTemplate('check $1', 'auth')).toBe('check auth')
  })

  it('still supports $ARGUMENTS, and both together', () => {
    expect(expandTemplate('do $ARGUMENTS', 'a b')).toBe('do a b')
    expect(expandTemplate('first=$1 all=$ARGUMENTS', 'a b')).toBe('first=a all=a b')
  })

  it('appends the args when the template has no placeholder at all', () => {
    expect(expandTemplate('Review this', 'the diff')).toBe('Review this\n\nthe diff')
  })

  it('collapses extra whitespace between words', () => {
    expect(expandTemplate('$1|$2', '  a   b  ')).toBe('a|b')
  })
})

describe('parseAgentInvocation', () => {
  it('splits a name and its task', () => {
    expect(parseAgentInvocation('reviewer check the diff')).toEqual({
      name: 'reviewer',
      task: 'check the diff'
    })
    expect(parseAgentInvocation('reviewer')).toEqual({ name: 'reviewer', task: '' })
    expect(parseAgentInvocation('  spacing-agent   do a thing  ')).toEqual({
      name: 'spacing-agent',
      task: 'do a thing'
    })
  })

  it('rejects an empty arg or a name that could not be an agent file', () => {
    expect(parseAgentInvocation('')).toBeNull()
    expect(parseAgentInvocation('   ')).toBeNull()
    // Agents are `.houston/agents/<name>.md`, so a path is never a valid name.
    expect(parseAgentInvocation('../etc/passwd')).toBeNull()
    expect(parseAgentInvocation('a/b run')).toBeNull()
  })
})

describe('agentInvocationPrompt', () => {
  it('phrases a dispatch that names the agent and carries the task', () => {
    const p = agentInvocationPrompt('reviewer', 'check the auth diff')
    expect(p).toContain('`reviewer` subagent')
    expect(p).toContain('check the auth diff')
  })

  it('stands in a default task when none is given', () => {
    expect(agentInvocationPrompt('reviewer', '')).toContain('Use your judgment')
  })
})
