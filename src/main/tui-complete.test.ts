import { describe, it, expect } from 'vitest'
import { mentionQuery, commandQuery, completeInput, makeCompleter, COMMANDS } from './tui-complete'

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
