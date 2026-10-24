import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@shared/agent'
import { promptHash, sharedHash } from './stamp'

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
