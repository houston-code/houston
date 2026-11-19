import { describe, expect, it, vi } from 'vitest'
import { version as PKG_VERSION } from '../../../package.json'
import { McpRpcError } from './protocol'
import { McpUnsupportedProtocolError } from './version'
import {
  MAX_INPUT_ROUNDS,
  MODERN_PROTOCOL_VERSION,
  headerValue,
  listenFilter,
  mcpParamHeaders,
  modernDiscoverError,
  readDiscoverResult,
  requestMeta,
  resultTypeOf,
  runWithInputs,
  standardRequestHeaders,
  withRequestMeta,
  xMcpHeaderParams
} from './stateless'

describe('per-request _meta', () => {
  it('carries the version, client identity and only the capabilities that are wired', () => {
    expect(requestMeta({ elicitation: true })).toEqual({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'Houston', version: PKG_VERSION },
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }
    })
    expect(requestMeta({ elicitation: false })['io.modelcontextprotocol/clientCapabilities']).toEqual({})
  })

  it('merges into params, keeping a progress token already there', () => {
    const out = withRequestMeta({ name: 't', _meta: { progressToken: 7 } }, { elicitation: false })
    expect(out.name).toBe('t')
    expect(out._meta).toMatchObject({ progressToken: 7, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' })
    expect(withRequestMeta(undefined, { elicitation: false })._meta).toBeDefined()
  })
})

describe('reading server/discover', () => {
  it('accepts a result that lists 2026-07-28, and keeps its capabilities', () => {
    expect(
      readDiscoverResult({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
    ).toEqual({ capabilities: { tools: {} } })
  })

  it('treats anything else as an older server', () => {
    expect(readDiscoverResult({})).toBeNull()
    expect(readDiscoverResult(null)).toBeNull()
    expect(readDiscoverResult({ supportedVersions: ['2099-01-01'] })).toBeNull()
    expect(readDiscoverResult({ supportedVersions: '2026-07-28' })).toBeNull()
  })

  it('reads the revision\'s own errors as a modern server, and others as legacy', () => {
    const unsupported = modernDiscoverError(new McpRpcError({ code: -32022, message: 'no', data: { supported: ['2027-01-01'] } }))
    expect(unsupported).toBeInstanceOf(McpUnsupportedProtocolError)
    expect(unsupported?.message).toContain('2027-01-01')
    const mismatch = new McpRpcError({ code: -32020, message: 'Header mismatch' })
    expect(modernDiscoverError(mismatch)).toBe(mismatch)
    expect(modernDiscoverError(new McpRpcError({ code: -32021, message: 'cap' }))).toBeInstanceOf(McpRpcError)
    // Legacy servers answer an unknown pre-initialize request with codes of their own.
    for (const code of [-32601, -32602, -32600, -32000]) {
      expect(modernDiscoverError(new McpRpcError({ code, message: 'x' }))).toBeNull()
    }
    expect(modernDiscoverError(new Error('MCP server/discover timed out'))).toBeNull()
  })
})

describe('resultType', () => {
  it('treats a missing resultType as complete', () => {
    expect(resultTypeOf({ content: [] })).toBe('complete')
    expect(resultTypeOf(undefined)).toBe('complete')
    expect(resultTypeOf({ resultType: 'input_required' })).toBe('input_required')
  })
})

describe('runWithInputs (multi round-trip requests)', () => {
  const ask = (requestState?: string): unknown => ({
    resultType: 'input_required',
    inputRequests: {
      who: {
        method: 'elicitation/create',
        params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }
      }
    },
    ...(requestState ? { requestState } : {})
  })

  it('returns a complete result at once', async () => {
    const send = vi.fn(async () => ({ resultType: 'complete', content: [] }))
    expect(await runWithInputs(send, { name: 't' }, { method: 'tools/call' })).toEqual({ resultType: 'complete', content: [] })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('answers an elicitation through the responder and retries with its answer and the exact state', async () => {
    const sent: Array<Record<string, unknown>> = []
    const replies = [ask('opaque-1'), { content: [{ type: 'text', text: 'hi Ada' }] }]
    const onElicit = vi.fn(async () => ({ action: 'accept' as const, content: { name: 'Ada' } }))
    const out = await runWithInputs(
      async (p) => {
        sent.push(p)
        return replies.shift()
      },
      { name: 'greet', arguments: { x: 1 } },
      { method: 'tools/call', onElicit }
    )
    expect(out).toEqual({ content: [{ type: 'text', text: 'hi Ada' }] })
    expect(onElicit).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name?' }))
    expect(sent[1]).toEqual({
      name: 'greet',
      arguments: { x: 1 },
      inputResponses: { who: { action: 'accept', content: { name: 'Ada' } } },
      requestState: 'opaque-1'
    })
  })

  it('sends back only the latest round\'s answers and state', async () => {
    const sent: Array<Record<string, unknown>> = []
    const replies = [ask('s1'), { resultType: 'input_required', requestState: 's2' }, { content: [] }]
    await runWithInputs(
      async (p) => {
        sent.push(p)
        return replies.shift()
      },
      { name: 't' },
      { method: 'tools/call', onElicit: async () => ({ action: 'decline' }) }
    )
    expect(sent[2]).toEqual({ name: 't', requestState: 's2' })
  })

  it('omits requestState when the server gave none', async () => {
    const sent: Array<Record<string, unknown>> = []
    const replies = [ask(), { content: [] }]
    await runWithInputs(
      async (p) => {
        sent.push(p)
        return replies.shift()
      },
      { name: 't' },
      { method: 'tools/call', onElicit: async () => ({ action: 'cancel' }) }
    )
    expect('requestState' in sent[1]).toBe(false)
  })

  it('answers cancel when the responder fails (the run stopped)', async () => {
    const sent: Array<Record<string, unknown>> = []
    const replies = [ask(), { content: [] }]
    await runWithInputs(
      async (p) => {
        sent.push(p)
        return replies.shift()
      },
      { name: 't' },
      {
        method: 'tools/call',
        onElicit: async () => {
          throw new Error('stopped')
        }
      }
    )
    expect(sent[1].inputResponses).toEqual({ who: { action: 'cancel' } })
  })

  it('fails on a request Houston never declared, or without a responder, or in URL mode', async () => {
    const sampling = { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: {} } } }
    await expect(
      runWithInputs(async () => sampling, {}, { method: 'tools/call', onElicit: async () => ({ action: 'accept' }) })
    ).rejects.toThrow('asked for sampling/createMessage, which Houston does not offer')
    await expect(runWithInputs(async () => ask(), {}, { method: 'tools/call' })).rejects.toThrow('does not offer')
    const url = { resultType: 'input_required', inputRequests: { u: { method: 'elicitation/create', params: { mode: 'url', url: 'https://x' } } } }
    await expect(
      runWithInputs(async () => url, {}, { method: 'tools/call', onElicit: async () => ({ action: 'accept' }) })
    ).rejects.toThrow('does not offer')
  })

  it('hands a task result to onTask, and treats it as unknown without one', async () => {
    const onTask = vi.fn(async () => ({ content: ['done'] }))
    expect(await runWithInputs(async () => ({ resultType: 'task', taskId: 't' }), {}, { method: 'tools/call', onTask })).toEqual({
      content: ['done']
    })
    expect(onTask).toHaveBeenCalledWith({ resultType: 'task', taskId: 't' })
    await expect(runWithInputs(async () => ({ resultType: 'task' }), {}, { method: 'resources/read' })).rejects.toThrow('unknown type')
  })

  it('rejects an unknown resultType', async () => {
    await expect(runWithInputs(async () => ({ resultType: 'weird' }), {}, { method: 'tools/call' })).rejects.toThrow(
      'unknown type'
    )
  })

  it(`stops after ${MAX_INPUT_ROUNDS} rounds`, async () => {
    const send = vi.fn(async () => ask('again'))
    await expect(
      runWithInputs(send, {}, { method: 'tools/call', onElicit: async () => ({ action: 'decline' }) })
    ).rejects.toThrow(`asked for more input ${MAX_INPUT_ROUNDS} times`)
    expect(send).toHaveBeenCalledTimes(MAX_INPUT_ROUNDS)
  })

  it('does not retry once the run was stopped', async () => {
    const stop = new AbortController()
    const send = vi.fn(async () => ask())
    await expect(
      runWithInputs(send, {}, {
        method: 'tools/call',
        signal: stop.signal,
        onElicit: async () => {
          stop.abort()
          return { action: 'cancel' }
        }
      })
    ).rejects.toThrow('cancelled')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses too many inputs in one round', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`k${i}`, { method: 'elicitation/create', params: { message: 'x' } }])
    )
    await expect(
      runWithInputs(async () => ({ resultType: 'input_required', inputRequests: many }), {}, {
        method: 'tools/call',
        onElicit: async () => ({ action: 'decline' })
      })
    ).rejects.toThrow('limit is 16')
  })
})

describe('streamable HTTP headers', () => {
  it('encodes header values as the revision requires', () => {
    expect(headerValue('us-west1')).toBe('us-west1')
    expect(headerValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=')
    expect(headerValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=')
    expect(headerValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=')
    expect(headerValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')
    expect(headerValue('')).toBe('=?base64??=')
  })

  it('sends Mcp-Method always and Mcp-Name for named requests', () => {
    expect(standardRequestHeaders('tools/call', { name: 'get_weather' })).toEqual({
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'get_weather'
    })
    expect(standardRequestHeaders('resources/read', { uri: 'file:///a b' })['mcp-name']).toBe('file:///a b')
    expect(standardRequestHeaders('prompts/get', { name: 'révise' })['mcp-name']).toMatch(/^=\?base64\?/)
    expect(standardRequestHeaders('tools/list', {})).toEqual({
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': 'tools/list'
    })
  })

  it('reads x-mcp-header annotations, nested ones included', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        opts: { type: 'object', properties: { dry: { type: 'boolean', 'x-mcp-header': 'Dry-Run' } } },
        query: { type: 'string' }
      }
    }
    const read = xMcpHeaderParams(schema)
    expect(read).toEqual({
      params: [
        { name: 'Region', path: ['region'] },
        { name: 'Dry-Run', path: ['opts', 'dry'] }
      ]
    })
    if (!('params' in read)) throw new Error('expected params')
    expect(mcpParamHeaders(read.params, { region: 'us-west1', opts: { dry: true }, query: 'x' })).toEqual({
      'mcp-param-region': 'us-west1',
      'mcp-param-dry-run': 'true'
    })
    // No value, or null: no header.
    expect(mcpParamHeaders(read.params, { opts: { dry: null } })).toEqual({})
    expect(mcpParamHeaders([{ name: 'N', path: ['n'] }], { n: 42 })).toEqual({ 'mcp-param-n': '42' })
    expect(mcpParamHeaders([{ name: 'N', path: ['n'] }], { n: 1.5 })).toEqual({})
    expect(xMcpHeaderParams(undefined)).toEqual({ params: [] })
  })

  it('rejects annotations the revision forbids', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ properties: { a: { type: 'number', 'x-mcp-header': 'A' } } }, /not a string, integer or boolean/],
      [{ properties: { a: { type: 'string', 'x-mcp-header': 'has space' } } }, /not a valid header name/],
      [{ properties: { a: { type: 'string', 'x-mcp-header': '' } } }, /not a valid header name/],
      [
        { properties: { a: { type: 'string', 'x-mcp-header': 'X' }, b: { type: 'string', 'x-mcp-header': 'x' } } },
        /used more than once/
      ],
      [{ properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'I' } } } }, /reachable through properties alone/],
      [{ oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] }, /reachable through properties alone/],
      [{ type: 'string', 'x-mcp-header': 'Root' }, /reachable through properties alone/]
    ]
    for (const [schema, problem] of bad) {
      const read = xMcpHeaderParams(schema)
      expect('problem' in read && read.problem).toMatch(problem)
    }
  })
})

describe('listenFilter', () => {
  it('asks only for the lists the server declared', () => {
    expect(listenFilter({ tools: true, resources: false, prompts: true })).toEqual({
      toolsListChanged: true,
      promptsListChanged: true
    })
    expect(listenFilter({ tools: false, resources: false, prompts: false })).toEqual({})
  })
})
