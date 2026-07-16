import { describe, it, expect } from 'vitest'
import { mentionQuery, commandQuery, completeInput, makeCompleter, COMMANDS, commandMenu, renderCommandMenu, MENU_LIMIT, type CommandSpec } from './tui-complete'

describe('mentionQuery', () => {
  it('extracts an @token at the end of the line', () => {
    expect(mentionQuery('look at @src/fo')).toBe('src/fo')
    expect(mentionQuery('@x')).toBe('x')
    expect(mentionQuery('@')).toBe('')
  })
  it('returns null when not in a mention', () => {
    expect(mentionQuery('plain text')).toBeNull()
    expect(mentionQuery('email a@b then ')).toBeNull() // trailing space closes it
  })
})

describe('commandQuery', () => {
  it('matches a single slash-command word', () => {
    expect(commandQuery('/mod')).toBe('mod')
    expect(commandQuery('/')).toBe('')
  })
  it('returns null once there is a space (args) or non-command', () => {
    expect(commandQuery('/model claude')).toBeNull()
    expect(commandQuery('hello')).toBeNull()
  })
})

describe('completeInput', () => {
  it('completes command names by prefix', () => {
    const [hits, sub] = completeInput('/c', [])
    expect(hits).toContain('/clear ')
    expect(hits).toContain('/cost ')
    expect(hits).toContain('/cwd ')
    expect(sub).toBe('/c')
  })

  it('completes @-file mentions from the provided files', () => {
    const [hits, sub] = completeInput('edit @sr', ['src/a.ts', 'src/b.ts'])
    expect(hits).toEqual(['@src/a.ts ', '@src/b.ts '])
    expect(sub).toBe('@sr')
  })

  it('returns no completions for ordinary text', () => {
    expect(completeInput('just typing', [])).toEqual([[], 'just typing'])
  })

  it('every built-in command has a description', () => {
    expect(COMMANDS.every((c) => c.name && c.description)).toBe(true)
  })
})

describe('makeCompleter', () => {
  it('only hits the file finder for @-mentions', async () => {
    let calls = 0
    const finder = async (q: string): Promise<string[]> => {
      calls++
      return [`${q}x.ts`]
    }
    const completer = makeCompleter(finder)

    const cmd = await new Promise<[string[], string]>((res) => completer('/mo', (_e, r) => res(r)))
    expect(calls).toBe(0) // command completion needs no I/O
    expect(cmd[0]).toContain('/model ')

    const mention = await new Promise<[string[], string]>((res) => completer('use @a', (_e, r) => res(r)))
    expect(calls).toBe(1)
    expect(mention[0]).toEqual(['@ax.ts '])
  })

  it('degrades to no completions when the finder throws', async () => {
    const completer = makeCompleter(async () => {
      throw new Error('boom')
    })
    const r = await new Promise<[string[], string]>((res) => completer('@x', (_e, out) => res(out)))
    expect(r).toEqual([[], '@x'])
  })
})

// Tab completion printed bare names with no descriptions, no argument hints, and —
// because the completer only knew the BUILT-IN list — no sign that a workspace's
// own .houston/commands existed. You had to know a name to discover it.
describe('commandMenu', () => {
  const cmds: CommandSpec[] = [
    { name: 'help', description: 'List the available commands' },
    { name: 'hooks', description: 'List configured hooks' },
    { name: 'model', description: 'List or switch the active model' },
    { name: 'ship-it', description: 'A project command from .houston/commands' }
  ]
  const paint = (s: string): string => s

  it('offers everything for a bare slash — the "what can I do?" gesture', () => {
    expect(commandMenu('/', cmds)).toHaveLength(4)
  })

  it('filters as you type', () => {
    expect(commandMenu('/ho', cmds)?.map((c) => c.name)).toEqual(['hooks'])
    expect(commandMenu('/h', cmds)?.map((c) => c.name)).toEqual(['help', 'hooks'])
  })

  it('includes a workspace command, which the old completer never saw', () => {
    expect(commandMenu('/ship', cmds)?.map((c) => c.name)).toEqual(['ship-it'])
  })

  it('is not a menu once the command has arguments', () => {
    expect(commandMenu('/model gpt-5', cmds)).toBeNull()
    expect(commandMenu('fix the bug', cmds)).toBeNull()
    expect(commandMenu('', cmds)).toBeNull()
  })

  it('renders each row with its description', () => {
    const rows = renderCommandMenu(commandMenu('/h', cmds) as CommandSpec[], paint)
    expect(rows.join('\n')).toContain('/help')
    expect(rows.join('\n')).toContain('List the available commands')
  })

  it('says when nothing matches, instead of showing an empty menu', () => {
    expect(renderCommandMenu([], paint).join('')).toContain('no matching command')
  })

  it('caps the list and says how many it left out', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, description: 'x' }))
    const rows = renderCommandMenu(many, paint)
    expect(rows).toHaveLength(MENU_LIMIT + 1)
    expect(rows.at(-1)).toContain(`${20 - MENU_LIMIT} more`)
  })
})
