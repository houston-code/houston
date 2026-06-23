import { describe, expect, it } from 'vitest'
import {
  expandTemplate,
  matchCommands,
  mergeCommands,
  parseSlashCommand,
  resolveCommand,
  type Command
} from './commands'

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
