import { describe, it, expect } from 'vitest'
import { classifyLead, parseTextToolCalls } from './tool-call-fallback'

const KNOWN = new Set(['read_file', 'dispatch_agent'])

describe('parseTextToolCalls', () => {
  it('recovers a bare JSON object whose name is a known tool', () => {
    const out = parseTextToolCalls('{"name":"read_file","arguments":{"path":"TODO.md"}}', KNOWN)
    expect(out).toEqual([{ name: 'read_file', arguments: { path: 'TODO.md' } }])
  })

  it('recovers an array of calls', () => {
    const out = parseTextToolCalls(
      '[{"name":"read_file","arguments":{"path":"a"}},{"name":"dispatch_agent","arguments":{}}]',
      KNOWN
    )
    expect(out).toEqual([
      { name: 'read_file', arguments: { path: 'a' } },
      { name: 'dispatch_agent', arguments: {} }
    ])
  })

  it('recovers one or more <tool_call> blocks', () => {
    expect(
      parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>', KNOWN)
    ).toEqual([{ name: 'read_file', arguments: { path: 'x' } }])

    const two = parseTextToolCalls(
      'thinking…<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>' +
        '<tool_call>{"name":"dispatch_agent","arguments":{"q":"y"}}</tool_call>',
      KNOWN
    )
    expect(two).toHaveLength(2)
    expect(two?.[1]).toEqual({ name: 'dispatch_agent', arguments: { q: 'y' } })
  })

  it('accepts the `parameters` alias and arguments-as-JSON-string', () => {
    expect(parseTextToolCalls('{"name":"read_file","parameters":{"path":"p"}}', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'p' } }
    ])
    expect(parseTextToolCalls('{"name":"read_file","arguments":"{\\"path\\":\\"p\\"}"}', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'p' } }
    ])
  })

  it('treats a missing/empty arguments field as no arguments', () => {
    expect(parseTextToolCalls('{"name":"dispatch_agent"}', KNOWN)).toEqual([
      { name: 'dispatch_agent', arguments: {} }
    ])
    expect(parseTextToolCalls('{"name":"dispatch_agent","arguments":""}', KNOWN)).toEqual([
      { name: 'dispatch_agent', arguments: {} }
    ])
  })

  it('returns null when the name is not a tool the request offered', () => {
    expect(parseTextToolCalls('{"name":"format_disk","arguments":{}}', KNOWN)).toBeNull()
    // An array is all-or-nothing: one unknown name rejects the whole batch.
    expect(
      parseTextToolCalls('[{"name":"read_file","arguments":{}},{"name":"nope","arguments":{}}]', KNOWN)
    ).toBeNull()
  })

  it('returns null for plain text, non-tool JSON, or empty input', () => {
    expect(parseTextToolCalls('Here are the gaps vs competitors…', KNOWN)).toBeNull()
    expect(parseTextToolCalls('{"summary":"no name field here"}', KNOWN)).toBeNull()
    expect(parseTextToolCalls('```json\n{"name":"read_file"}\n```', KNOWN)).toBeNull() // fenced: not bare JSON
    expect(parseTextToolCalls('   ', KNOWN)).toBeNull()
  })
})

describe('classifyLead', () => {
  it('flags tool-call starts to hold', () => {
    expect(classifyLead('{"name":"read_file"')).toBe('tool')
    expect(classifyLead('<tool_call>{')).toBe('tool')
    expect(classifyLead('[{"name"')).toBe('tool')
  })

  it('waits on ambiguous prefixes until they resolve', () => {
    expect(classifyLead('<')).toBe('wait')
    expect(classifyLead('<tool')).toBe('wait')
    expect(classifyLead('[')).toBe('wait')
  })

  it('streams ordinary prose (including non-object bracket/angle starts)', () => {
    expect(classifyLead('Here are the gaps')).toBe('text')
    expect(classifyLead('<html>')).toBe('text')
    expect(classifyLead('[1] first footnote')).toBe('text')
  })
})
