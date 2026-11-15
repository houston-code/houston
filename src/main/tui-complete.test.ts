import { describe, it, expect } from 'vitest'
import { folderArgQuery, folderCompletions, type FolderEntry } from './tui-complete'
import { mentionQuery, commandQuery, inlineCommandQuery, completeInput, makeCompleter, COMMANDS, commandMenu, renderCommandMenu, renderMentionMenu, makeMentionMenu, MENU_LIMIT, type CommandSpec } from './tui-complete'

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
    // Custom command names: digits, hyphens, underscores, capitals.
    expect(commandQuery('/fix-')).toBe('fix-')
    expect(commandQuery('/Deploy_2')).toBe('Deploy_2')
    // A namespaced command (.houston/commands/git/commit.md) keeps its menu open.
    expect(commandQuery('/git:com')).toBe('git:com')
    expect(inlineCommandQuery('then run /git:c')).toBe('git:c')
    expect(completeInput('/git:c', [], [{ name: 'git:commit', description: 'x' }])).toEqual([['/git:commit '], '/git:c'])
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

  it('never completes an exact name into a longer one (/agent stays /agent)', () => {
    // Tab inserts the candidates' common prefix: with /agent among them, that is
    // /agent itself, so Tab can't turn it into /agents; Enter then runs /agent.
    const [hits] = completeInput('/agent', [])
    expect(hits).toEqual(expect.arrayContaining(['/agent ', '/agents ']))
    expect(hits.every((h) => h.startsWith('/agent'))).toBe(true)
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
describe('custom command completion', () => {
  const custom: CommandSpec[] = [...COMMANDS, { name: 'fix-tests', description: 'Fix the failing tests' }]

  it('keeps matching a hyphenated custom command in the menu as it is typed', () => {
    expect(commandMenu('/fix-', custom)?.map((c) => c.name)).toEqual(['fix-tests'])
  })

  it('tab-completes commands loaded after the completer was built', async () => {
    let commands: CommandSpec[] = [...COMMANDS]
    const completer = makeCompleter(async () => [], () => commands)
    commands = custom
    const result = await new Promise<[string[], string]>((resolve) =>
      completer('/fix', (_err, r) => resolve(r))
    )
    expect(result[0]).toEqual(['/fix-tests '])
  })
})

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

describe('the @ mention dropdown', () => {
  const plain = (x: string): string => x

  it('renders matching paths, capped, with the Tab hint', () => {
    expect(renderMentionMenu(['src/a.ts', 'src/'], plain)).toEqual(['  @src/a.ts', '  @src/', '  Tab completes'])
    const many = Array.from({ length: MENU_LIMIT + 3 }, (_, i) => `f${i}`)
    const rows = renderMentionMenu(many, plain)
    expect(rows).toContain('  … 3 more')
    expect(renderMentionMenu([], plain)).toEqual(['  (no matching file)'])
  })

  it('looks the files up once per query and repaints when they arrive', async () => {
    const asked: string[] = []
    const menu = makeMentionMenu(async (q) => {
      asked.push(q)
      return [`src/${q}.ts`]
    }, plain)
    let redraws = 0
    const redraw = (): void => {
      redraws++
    }
    expect(menu('look at @gre', redraw)).toEqual([]) // nothing yet: the lookup is async
    expect(menu('look at @gre', redraw)).toEqual([]) // still one lookup in flight
    await Promise.resolve()
    await Promise.resolve()
    expect(redraws).toBe(1)
    expect(menu('look at @gre', redraw)).toEqual(['  @src/gre.ts', '  Tab completes'])
    expect(asked).toEqual(['gre'])
  })

  it('paints its rows with the painter of each call, so a theme change reaches an open menu', async () => {
    const menu = makeMentionMenu(async () => ['a.ts'], plain)
    menu('@a', () => {})
    await Promise.resolve()
    await Promise.resolve()
    const tagged = (s: string, ...styles: string[]): string => `<${styles.join(',')}>${s}`
    expect(menu('@a', () => {}, tagged)?.join('\n')).toContain('<cyan>@a.ts')
    expect(menu('@a', () => {})).toContain('  @a.ts')
  })

  it('is not a mention menu outside an @ token', () => {
    const menu = makeMentionMenu(async () => ['x'], plain)
    expect(menu('plain words', () => {})).toBeNull()
    expect(menu('/model', () => {})).toBeNull()
  })

  it('drops an older query’s late answer', async () => {
    const resolvers: Record<string, (v: string[]) => void> = {}
    const menu = makeMentionMenu((q) => new Promise((res) => (resolvers[q] = res)), plain)
    let redraws = 0
    menu('@a', () => redraws++)
    menu('@ab', () => redraws++)
    resolvers.a(['old.ts'])
    await Promise.resolve()
    await Promise.resolve()
    expect(redraws).toBe(0)
    resolvers.ab(['new.ts'])
    await Promise.resolve()
    await Promise.resolve()
    expect(menu('@ab', () => {})).toEqual(['  @new.ts', '  Tab completes'])
  })

  it('keeps the menu as it was when the lookup fails', async () => {
    const menu = makeMentionMenu(async () => {
      throw new Error('not a repo')
    }, plain)
    expect(menu('@x', () => {})).toEqual([])
    await Promise.resolve()
    await Promise.resolve()
    expect(menu('@x', () => {})).toEqual([])
  })
})

describe('/ completion mid-message', () => {
  const cmds: CommandSpec[] = [
    { name: 'review', description: 'Review' },
    { name: 'pdf', description: 'Work with PDFs', args: '[task]' }
  ]

  it('finds a /token after a space, never at the start or inside a word', () => {
    expect(inlineCommandQuery('then run /rev')).toBe('rev')
    expect(inlineCommandQuery('then run /')).toBe('')
    expect(inlineCommandQuery('/rev')).toBeNull()
    expect(inlineCommandQuery('a/b')).toBeNull()
    expect(inlineCommandQuery('run /rev now')).toBeNull()
  })

  it('completes only the token, leaving the rest of the message alone', () => {
    expect(completeInput('then run /rev', [], cmds)).toEqual([['/review '], '/rev'])
    expect(completeInput('then run /RE', [], cmds)).toEqual([['/review '], '/RE'])
    expect(completeInput('see /usr', [], cmds)).toEqual([[], '/usr'])
  })

  it('lists matches under the composer, and stays quiet for a path in prose', () => {
    expect(commandMenu('then run /p', cmds)?.map((c) => c.name)).toEqual(['pdf'])
    expect(commandMenu('see /usr/lib', cmds)).toBeNull()
    expect(commandMenu('see /zz', cmds)).toBeNull()
  })

  it("shows a command's argument hint dim beside its name", () => {
    const paint = (s: string, ...styles: string[]): string => (styles.includes('dim') ? `<${s}>` : s)
    const rows = renderCommandMenu(cmds, paint)
    expect(rows[1]).toContain('/pdf <[task]>')
    // The descriptions still line up.
    const plain = renderCommandMenu(cmds, (s: string) => s)
    expect(plain[0].indexOf('Review')).toBe(plain[1].indexOf('Work with PDFs'))
  })

  it('drops escape sequences a command file put in its description or hint', () => {
    const rows = renderCommandMenu([{ name: 'x', description: 'hi\x1b]52;c;ZXZpbA==\x07', args: '\x1b[31m<a>' }], (s: string) => s)
    expect(rows.join('')).not.toContain('\x1b')
    expect(rows.join('')).not.toContain('\x07')
  })
})

describe('folder completion for /cd and /add-dir', () => {
  const tree: Record<string, FolderEntry[]> = {
    '/proj': [
      { name: 'src', isDir: true },
      { name: 'scripts', isDir: true },
      { name: 'setup.sh', isDir: false },
      { name: '.git', isDir: true },
      { name: 'my dir', isDir: true },
      { name: 'evil\u001b[2J', isDir: true }
    ],
    '/home/me': [{ name: 'work', isDir: true }],
    '/': [{ name: 'tmp', isDir: true }]
  }
  const readDir = async (dir: string): Promise<FolderEntry[]> => {
    const hit = tree[dir.replace(/\/$/, '') || '/']
    if (!hit) throw new Error('ENOENT')
    return hit
  }

  it('finds the folder argument after /cd and /add-dir only', () => {
    expect(folderArgQuery('/cd sr')).toBe('sr')
    expect(folderArgQuery('/cd ')).toBe('')
    expect(folderArgQuery('/add-dir ../x')).toBe('../x')
    expect(folderArgQuery('/cd')).toBeNull()
    expect(folderArgQuery('/copy 2')).toBeNull()
    expect(folderArgQuery('cd src')).toBeNull()
  })

  it('offers matching folders as typed, plus a slash, and skips files, hidden folders, and unsafe names', async () => {
    expect(await folderCompletions('s', '/proj', '/home/me', readDir)).toEqual(['scripts/', 'src/'])
    expect(await folderCompletions('', '/proj', '/home/me', readDir)).toEqual(['scripts/', 'src/'])
    expect(await folderCompletions('.g', '/proj', '/home/me', readDir)).toEqual(['.git/'])
    expect(await folderCompletions('~/w', '/proj', '/home/me', readDir)).toEqual(['~/work/'])
    expect(await folderCompletions('~', '/proj', '/home/me', readDir)).toEqual(['~/'])
    expect(await folderCompletions('/t', '/proj', '/home/me', readDir)).toEqual(['/tmp/'])
    expect(await folderCompletions('nope/x', '/proj', '/home/me', readDir)).toEqual([])
  })

  it('completes the folder through the composer completer', async () => {
    const complete = makeCompleter(async () => [], COMMANDS, (partial) =>
      folderCompletions(partial, '/proj', '/home/me', readDir)
    )
    const result = await new Promise<[string[], string]>((res) => complete('/cd sr', (_e, r) => res(r)))
    expect(result).toEqual([['src/'], 'sr'])
    // Without a lister, /cd completes nothing rather than a command name.
    const plain = makeCompleter(async () => [], COMMANDS)
    expect(await new Promise<[string[], string]>((res) => plain('/cd sr', (_e, r) => res(r)))).toEqual([[], '/cd sr'])
  })
})
