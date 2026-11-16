import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@shared/agent'
import { abGateHash, hashCensus, hashGap, promptHash, sharedHash, sharedPromptId } from './stamp'

const tool = (description: string): ToolSchema =>
  ({ name: 'read_file', description, parameters: { type: 'object', properties: {} } }) as unknown as ToolSchema

const req = (ws: string, date = '2026-10-24') => ({
  system: `You are working in ${ws}.\nToday's date: ${date}.`,
  tools: [tool(`Read a file under ${ws}`)]
})

describe('promptHash', () => {
  it('is a 12-hex digest', () => {
    expect(promptHash(req('/tmp/a'), ['/tmp/a'])).toMatch(/^[0-9a-f]{12}$/)
  })

  // Every eval task gets its own throwaway workspace; the hash must not see it.
  it('ignores the workspace path, in the prompt and in the tools', () => {
    expect(promptHash(req('/tmp/houston-eval-1/ws'), ['/tmp/houston-eval-1/ws'])).toBe(
      promptHash(req('/tmp/houston-eval-2/ws'), ['/tmp/houston-eval-2/ws'])
    )
  })

  // macOS: /var/folders/... and /private/var/folders/... are the same directory.
  it('scrubs every spelling of the workspace, the longer one first', () => {
    const short = '/var/folders/x/ws'
    const long = '/private/var/folders/x/ws'
    const mixed = { system: `cwd ${long}, also ${short}`, tools: [] }
    const other = { system: `cwd /private/var/folders/y/ws, also /var/folders/y/ws`, tools: [] }
    expect(promptHash(mixed, [short, long])).toBe(promptHash(other, ['/var/folders/y/ws', '/private/var/folders/y/ws']))
  })

  // A Windows path is escaped inside JSON, so the tools must be scrubbed before serializing.
  it('scrubs a Windows workspace inside tool descriptions', () => {
    const a = 'C:\\Users\\me\\AppData\\Local\\Temp\\eval-1'
    const b = 'C:\\Users\\me\\AppData\\Local\\Temp\\eval-2'
    expect(promptHash(req(a), [a])).toBe(promptHash(req(b), [b]))
  })

  // The prompt states today's date; a baseline from last week must not look like a prompt change.
  it('ignores the date', () => {
    expect(promptHash(req('/w', '2026-10-24'), ['/w'])).toBe(promptHash(req('/w', '2027-01-02'), ['/w']))
  })

  it('changes when the prompt text changes', () => {
    const base = req('/w')
    expect(promptHash({ ...base, system: `${base.system}\nBe brief.` }, ['/w'])).not.toBe(promptHash(base, ['/w']))
  })

  it('changes when a tool description changes', () => {
    const base = req('/w')
    expect(promptHash({ ...base, tools: [tool('Read any file')] }, ['/w'])).not.toBe(promptHash(base, ['/w']))
  })

  it('does not depend on key order in the tool schemas', () => {
    const t1 = { name: 'x', description: 'd', parameters: { a: 1, b: 2 } } as unknown as ToolSchema
    const t2 = { parameters: { b: 2, a: 1 }, description: 'd', name: 'x' } as unknown as ToolSchema
    expect(promptHash({ system: 's', tools: [t1] }, [])).toBe(promptHash({ system: 's', tools: [t2] }, []))
  })

  it('treats a missing system prompt and tool list as empty', () => {
    expect(promptHash({}, [])).toBe(promptHash({ system: '', tools: [] }, []))
  })
})

describe('abGateHash', () => {
  it('is a 12-hex digest', () => {
    expect(abGateHash('aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toMatch(/^[0-9a-f]{12}$/)
  })

  // Either half moving means the model is told something different, and must reach the A/B.
  it('changes when either half changes', () => {
    const base = abGateHash('aaaaaaaaaaaa', 'bbbbbbbbbbbb')
    expect(abGateHash('aaaaaaaaaaac', 'bbbbbbbbbbbb')).not.toBe(base)
    expect(abGateHash('aaaaaaaaaaaa', 'bbbbbbbbbbbc')).not.toBe(base)
    expect(abGateHash('aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toBe(base)
  })

  it('keeps the halves apart, so moving text between them still changes it', () => {
    expect(abGateHash('ab', 'c')).not.toBe(abGateHash('a', 'bc'))
  })
})

describe('sharedHash', () => {
  it('returns the hash every attempt agrees on', () => {
    expect(sharedHash(['abc', 'abc', 'abc'])).toBe('abc')
  })

  // Disagreement means a normalization gap; stamping one of them would mislabel the run.
  it('returns nothing when the attempts disagree', () => {
    expect(sharedHash(['abc', 'def'])).toBeUndefined()
  })

  it('returns nothing when an attempt had no hash', () => {
    expect(sharedHash(['abc', undefined])).toBeUndefined()
  })

  it('returns nothing for no attempts', () => {
    expect(sharedHash([])).toBeUndefined()
  })
})

describe('sharedPromptId', () => {
  // An attempt whose first request failed saved no reply to carry the id, though it made
  // a request; the run is still labeled by the id every other attempt reported.
  it('takes the id the attempts that report one agree on', () => {
    expect(sharedPromptId(['abc', 'abc', undefined])).toBe('abc')
    expect(sharedPromptId(['abc', 'abc', 'abc'])).toBe('abc')
  })

  it('returns nothing when those attempts disagree, or none reported one', () => {
    expect(sharedPromptId(['abc', 'def', undefined])).toBeUndefined()
    expect(sharedPromptId([undefined, undefined])).toBeUndefined()
    expect(sharedPromptId([])).toBeUndefined()
  })
})

describe('hashCensus', () => {
  it('counts the attempts with no hash apart from the different hashes', () => {
    expect(hashCensus(['abc', undefined, 'def', 'abc', undefined])).toEqual({ attempts: 5, missing: 2, distinct: 2 })
    expect(hashCensus([])).toEqual({ attempts: 0, missing: 0, distinct: 0 })
  })
})

// sharedHash is undefined for two different reasons, and the scorecard has to say which.
describe('hashGap', () => {
  const gap = (hashes: (string | undefined)[]): string | undefined => hashGap(hashCensus(hashes))

  it('says nothing when the attempts share a hash, or when none ran', () => {
    expect(gap(['abc', 'abc'])).toBeUndefined()
    expect(gap([])).toBeUndefined()
  })

  it('names a normalization gap when the attempts disagree', () => {
    expect(gap(['abc', 'def', 'abc', 'ghi'])).toBe(
      'no prompt hash: the 4 attempts saw 3 different prompts (a normalization gap in stamp.ts)'
    )
  })

  it('names the attempts that made no model request', () => {
    expect(gap(['abc', undefined, 'abc'])).toBe(
      'no prompt hash: 1 of 3 attempts made no model request to hash (the other 2 agree)'
    )
    expect(gap([undefined, undefined])).toBe('no prompt hash: none of the 2 attempts made a model request to hash')
  })

  it('names both when both happened', () => {
    expect(gap(['abc', undefined, 'def'])).toBe(
      'no prompt hash: 1 of 3 attempts made no model request to hash, and the rest saw 2 different prompts ' +
        '(a normalization gap in stamp.ts)'
    )
  })

  // The two functions must agree on when there is a hash.
  it('is silent exactly when sharedHash has one', () => {
    for (const hashes of [['a'], ['a', 'a'], ['a', 'b'], ['a', undefined], [undefined], []]) {
      expect(gap(hashes) === undefined, JSON.stringify(hashes)).toBe(sharedHash(hashes) !== undefined || !hashes.length)
    }
  })
})
