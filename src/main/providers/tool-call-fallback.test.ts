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
    // A fence around JSON that is not a call, or a fence with prose after it, stays text.
    expect(parseTextToolCalls('```json\n{"summary":"x"}\n```', KNOWN)).toBeNull()
    expect(parseTextToolCalls('```json\n{"name":"read_file"}\n```\nThat is the call.', KNOWN)).toBeNull()
    expect(parseTextToolCalls('   ', KNOWN)).toBeNull()
  })
})

describe('parseTextToolCalls: local model formats', () => {
  it('skips a leading <think> block', () => {
    expect(parseTextToolCalls('<think>\nI should read it.\n</think>\n{"name":"read_file","arguments":{"path":"a"}}', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'a' } }
    ])
  })

  it('reads a fenced JSON call', () => {
    expect(parseTextToolCalls('```json\n{"name":"read_file","arguments":{"path":"a"}}\n```', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'a' } }
    ])
    expect(parseTextToolCalls('```\n[{"name":"read_file","arguments":{}}]\n```', KNOWN)).toEqual([
      { name: 'read_file', arguments: {} }
    ])
  })

  it('reads Qwen3-Coder XML calls, wrapped or not, with JSON or string values', () => {
    const xml =
      '<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>'
    expect(parseTextToolCalls(xml, KNOWN)).toEqual([{ name: 'read_file', arguments: { path: 'src/a.ts', limit: 20 } }])
    expect(parseTextToolCalls('<function=read_file><parameter=path>b</parameter></function>', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'b' } }
    ])
    expect(
      parseTextToolCalls(
        '<function=read_file><parameter=path>a</parameter></function>\n<function=dispatch_agent><parameter=opts>{"x":1}</parameter></function>',
        KNOWN
      )
    ).toEqual([
      { name: 'read_file', arguments: { path: 'a' } },
      { name: 'dispatch_agent', arguments: { opts: { x: 1 } } }
    ])
  })

  it('keeps XML that is mixed with prose, or names an unknown tool, as text', () => {
    expect(parseTextToolCalls('Use <function=read_file><parameter=path>a</parameter></function> like this.', KNOWN)).toBeNull()
    expect(parseTextToolCalls('<function=rm_rf><parameter=path>/</parameter></function>', KNOWN)).toBeNull()
    expect(parseTextToolCalls('<function=read_file>stray<parameter=path>a</parameter></function>', KNOWN)).toBeNull()
  })

  it('reads Mistral [TOOL_CALLS] in both forms', () => {
    expect(parseTextToolCalls('[TOOL_CALLS][{"name":"read_file","arguments":{"path":"a"}}]', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'a' } }
    ])
    expect(parseTextToolCalls('[TOOL_CALLS]read_file[ARGS]{"path":"a"}', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'a' } }
    ])
    expect(parseTextToolCalls('[TOOL_CALLS]read_file[ARGS]{"path":"a"}[TOOL_CALLS]dispatch_agent[ARGS]{}', KNOWN)).toEqual([
      { name: 'read_file', arguments: { path: 'a' } },
      { name: 'dispatch_agent', arguments: {} }
    ])
    expect(parseTextToolCalls('[TOOL_CALLS]read_file[ARGS]{not json', KNOWN)).toBeNull()
  })
})

describe('classifyLead: local model formats', () => {
  it('holds the starts of XML, Mistral and fenced calls, and waits on their prefixes', () => {
    expect(classifyLead('<function=read_file>')).toBe('tool')
    expect(classifyLead('[TOOL_CALLS]')).toBe('tool')
    expect(classifyLead('```json\n{')).toBe('tool')
    for (const p of ['<fun', '[TOOL', '`', '```', '```json', '```json\n']) expect(classifyLead(p), p).toBe('wait')
  })

  it('streams ordinary prose and ordinary code fences', () => {
    expect(classifyLead('[1] a note')).toBe('text')
    expect(classifyLead('```ts\nconst x = 1')).toBe('text')
    expect(classifyLead('`code` here')).toBe('text')
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
