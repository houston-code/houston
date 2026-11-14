import { describe, it, expect } from 'vitest'
import {
  mcpToolName,
  parseMcpToolName,
  isMcpToolName,
  sanitizeServerId,
  flattenMcpContent,
  MAX_EMBEDDED_RESOURCE_CHARS,
  MAX_MCP_IMAGES,
  flattenMcpResourceContents,
  parseHeaderLines,
  parseKeyValueLines,
  parseElicitationFields,
  buildElicitationContent
} from './mcp'

describe('mcp tool naming', () => {
  it('round-trips server id + tool name', () => {
    const full = mcpToolName('fs', 'read_file')
    expect(full).toBe('mcp__fs__read_file')
    expect(parseMcpToolName(full)).toEqual({ serverId: 'fs', toolName: 'read_file' })
  })

  it('keeps the full tool name even when it contains __', () => {
    expect(parseMcpToolName('mcp__git__do__thing')).toEqual({ serverId: 'git', toolName: 'do__thing' })
  })

  it('rejects non-mcp names', () => {
    expect(parseMcpToolName('read_file')).toBeNull()
    expect(isMcpToolName('read_file')).toBe(false)
    expect(isMcpToolName('mcp__fs__x')).toBe(true)
  })

  it('sanitizes server ids to the safe charset', () => {
    expect(sanitizeServerId('My Server!')).toBe('My-Server')
    expect(sanitizeServerId('  a.b/c  ')).toBe('a-b-c')
  })
})

describe('flattenMcpContent', () => {
  it('joins text blocks', () => {
    expect(flattenMcpContent([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }])).toBe(
      'hello\nworld'
    )
  })

  it('notes other non-text blocks by type', () => {
    expect(flattenMcpContent([{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }])).toBe('[audio content]')
    expect(flattenMcpContent([{ type: 'some\nthing' }])).toBe('[some thing content]')
  })

  // 1x1 PNG, and the first bytes of a JPEG, GIF and WebP.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')
  const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1').toString('base64')
  const WEBP = Buffer.from('RIFF\u0010\u0000\u0000\u0000WEBPVP8 ', 'latin1').toString('base64')

  it('attaches a valid image and notes it in the text', () => {
    const attached: unknown[] = []
    const out = flattenMcpContent(
      [
        { type: 'text', text: 'Here is the chart:' },
        { type: 'image', data: PNG, mimeType: 'image/png' }
      ],
      { attachImage: (img) => attached.push(img) }
    )
    expect(attached).toEqual([{ mediaType: 'image/png', data: PNG }])
    expect(out).toBe('Here is the chart:\n[image (image/png, 70 B): attached below]')
  })

  it('sends the type the bytes show, not the one the server claimed', () => {
    const attached: Array<{ mediaType: string }> = []
    for (const [data, claimed] of [
      [JPEG, 'image/png'],
      [GIF, 'image/gif'],
      [WEBP, 'application/octet-stream']
    ]) {
      flattenMcpContent([{ type: 'image', data, mimeType: claimed }], { attachImage: (img) => attached.push(img) })
    }
    expect(attached.map((a) => a.mediaType)).toEqual(['image/jpeg', 'image/gif', 'image/webp'])
  })

  it('refuses images a provider would reject, without attaching them', () => {
    const attached: unknown[] = []
    const opts = { attachImage: (img: unknown) => attached.push(img) }
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]).toString('base64')
    const huge = 'A'.repeat(8 * 1024 * 1024)
    expect(flattenMcpContent([{ type: 'image', data: 'not base64!', mimeType: 'image/png' }], opts)).toBe(
      '[image (image/png) that is not valid base64]'
    )
    expect(flattenMcpContent([{ type: 'image', mimeType: 'image/png' }], opts)).toBe('[image (image/png) with no data]')
    expect(flattenMcpContent([{ type: 'image', data: tiff, mimeType: 'image/tiff' }], opts)).toBe(
      '[image (image/tiff, 8 B) in a format that cannot be shown]'
    )
    expect(flattenMcpContent([{ type: 'image', data: huge, mimeType: 'image/png' }], opts)).toBe(
      '[image (image/png, 6.0 MB): too large to show; the limit is 5 MB]'
    )
    expect(attached).toEqual([])
  })

  it(`attaches at most ${MAX_MCP_IMAGES} images from one result`, () => {
    const attached: unknown[] = []
    const blocks = Array.from({ length: MAX_MCP_IMAGES + 2 }, () => ({ type: 'image', data: PNG, mimeType: 'image/png' }))
    const out = flattenMcpContent(blocks, { attachImage: (img) => attached.push(img) })
    expect(attached).toHaveLength(MAX_MCP_IMAGES)
    expect(out.match(/attached below/g)).toHaveLength(MAX_MCP_IMAGES)
    expect(out.match(/a result can attach at most/g)).toHaveLength(2)
  })

  it('says why an image is not shown when there is nowhere to attach it', () => {
    const block = { type: 'image', data: PNG, mimeType: 'image/png' }
    expect(flattenMcpContent([block], { noImageReason: 'the current model cannot view images' })).toBe(
      '[image (image/png, 70 B): not shown, the current model cannot view images]'
    )
    expect(flattenMcpContent([block])).toBe('[image (image/png, 70 B): not shown, images cannot be shown here]')
  })

  it('inlines embedded resource text, capped, and notes a binary one', () => {
    expect(
      flattenMcpContent([{ type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes' } }])
    ).toBe('[resource file:///notes.md (text/markdown)]\n# Notes')
    const long = flattenMcpContent([
      { type: 'resource', resource: { uri: 'file:///big.txt', text: 'x'.repeat(MAX_EMBEDDED_RESOURCE_CHARS + 5) } }
    ])
    expect(long.length).toBeLessThan(MAX_EMBEDDED_RESOURCE_CHARS + 200)
    expect(long).toContain(`[resource text cut at ${MAX_EMBEDDED_RESOURCE_CHARS} of ${MAX_EMBEDDED_RESOURCE_CHARS + 5} characters]`)
    expect(
      flattenMcpContent([{ type: 'resource', resource: { uri: 'file:///a.zip', mimeType: 'application/zip', blob: 'UEsDBA==' } }])
    ).toBe('[resource file:///a.zip (application/zip), binary, 8 base64 chars, not shown]')
    expect(flattenMcpContent([{ type: 'resource' }])).toBe('[resource content]')
  })

  it('attaches an embedded image resource like an image block', () => {
    const attached: unknown[] = []
    const out = flattenMcpContent(
      [{ type: 'resource', resource: { uri: 'file:///dot.png', mimeType: 'image/png', blob: PNG } }],
      { attachImage: (img) => attached.push(img) }
    )
    expect(attached).toHaveLength(1)
    expect(out).toBe('[resource file:///dot.png (image/png)]\n[image (image/png, 70 B): attached below]')
  })

  it('renders a resource_link as its name, URI and type, on one line', () => {
    expect(
      flattenMcpContent([
        { type: 'resource_link', uri: 'https://x.test/r/1', name: 'report.pdf', mimeType: 'application/pdf', description: 'Q3\nreport' }
      ])
    ).toBe('[resource link: report.pdf <https://x.test/r/1> (application/pdf, Q3 report)]')
    expect(flattenMcpContent([{ type: 'resource_link', uri: 'file:///a' }])).toBe('[resource link <file:///a>]')
    expect(flattenMcpContent([{ type: 'resource_link', uri: 'u', name: 'n'.repeat(2000) }]).length).toBeLessThan(600)
  })

  it('handles strings and junk gracefully', () => {
    expect(flattenMcpContent('raw')).toBe('raw')
    expect(flattenMcpContent(undefined)).toBe('')
    expect(flattenMcpContent(42)).toBe('')
  })
})

describe('parseHeaderLines', () => {
  it('parses "Name: value" lines into a map', () => {
    expect(parseHeaderLines('Authorization: Bearer t\nX-Env: prod')).toEqual({
      Authorization: 'Bearer t',
      'X-Env': 'prod'
    })
  })

  it('keeps colons in the value and trims whitespace', () => {
    expect(parseHeaderLines('  X-Url :  https://a/b:8080 ')).toEqual({ 'X-Url': 'https://a/b:8080' })
  })

  it('skips blank and malformed lines', () => {
    expect(parseHeaderLines('\nnotaheader\n: noKey\nA: 1')).toEqual({ A: '1' })
  })
})

describe('parseKeyValueLines', () => {
  it('returns the lines it could not read, for headers', () => {
    expect(parseKeyValueLines('A: 1\n\nnotaheader\n : noKey \nB=2')).toEqual({
      values: { A: '1' },
      invalid: ['notaheader', ': noKey', 'B=2']
    })
  })

  it('reads env vars written NAME=value, splitting on the first separator', () => {
    expect(
      parseKeyValueLines('GITHUB_TOKEN=ghp_x\nDATABASE_URL=postgres://u:p@h/db?a=b\nOLD_STYLE: a=b', { env: true })
    ).toEqual({
      values: { GITHUB_TOKEN: 'ghp_x', DATABASE_URL: 'postgres://u:p@h/db?a=b', OLD_STYLE: 'a=b' },
      invalid: []
    })
  })

  it('keeps an env line with no name or separator as unreadable', () => {
    expect(parseKeyValueLines('ghp_x\n=value\nOK=1', { env: true })).toEqual({
      values: { OK: '1' },
      invalid: ['ghp_x', '=value']
    })
  })
})

describe('flattenMcpResourceContents', () => {
  it('concatenates text contents', () => {
    const result = { contents: [{ uri: 'a', text: 'hello' }, { uri: 'b', text: 'world' }] }
    expect(flattenMcpResourceContents(result)).toBe('hello\nworld')
  })

  it('notes a binary (blob) content instead of dumping it', () => {
    const result = { contents: [{ uri: 'img://x', mimeType: 'image/png', blob: 'AAAA' }] }
    const out = flattenMcpResourceContents(result)
    expect(out).toContain('binary resource img://x')
    expect(out).toContain('image/png')
    expect(out).not.toContain('AAAA'.repeat(2)) // the raw base64 isn't included
  })

  it('returns empty for a malformed or empty result', () => {
    expect(flattenMcpResourceContents(null)).toBe('')
    expect(flattenMcpResourceContents({})).toBe('')
    expect(flattenMcpResourceContents({ contents: 'nope' })).toBe('')
  })
})

describe('parseElicitationFields', () => {
  it('parses the flat primitive schema into typed fields', () => {
    const fields = parseElicitationFields({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Full name', description: 'As registered' },
        age: { type: 'integer' },
        score: { type: 'number' },
        admin: { type: 'boolean' },
        color: { type: 'string', enum: ['red', 'blue'] },
        email: { type: 'string', format: 'email' }
      },
      required: ['name', 'color']
    })
    expect(fields).toEqual([
      { name: 'name', kind: 'string', title: 'Full name', description: 'As registered', required: true },
      { name: 'age', kind: 'integer' },
      { name: 'score', kind: 'number' },
      { name: 'admin', kind: 'boolean' },
      { name: 'color', kind: 'enum', required: true, options: ['red', 'blue'] },
      { name: 'email', kind: 'string', format: 'email' }
    ])
  })

  it('reads titled single-select enums (2025-11-25 oneOf/anyOf of const options)', () => {
    const fields = parseElicitationFields({
      type: 'object',
      properties: {
        size: {
          type: 'string',
          oneOf: [
            { const: 's', title: 'Small' },
            { const: 'l', title: 'Large' }
          ]
        },
        tone: { type: 'string', anyOf: [{ const: 'warm' }, { const: 3 }, null, { title: 'no const' }] },
        empty: { type: 'string', oneOf: [{ title: 'nothing usable' }] }
      }
    })
    expect(fields).toEqual([
      { name: 'size', kind: 'enum', options: ['s', 'l'] },
      { name: 'tone', kind: 'enum', options: ['warm'] },
      { name: 'empty', kind: 'string' }
    ])
    expect(buildElicitationContent(fields.slice(0, 1), { size: 'L' })).toEqual({ content: { size: 'l' } })
  })

  it('degrades exotic types to string inputs and tolerates junk schemas', () => {
    expect(parseElicitationFields({ properties: { blob: { type: 'array' } } })).toEqual([
      { name: 'blob', kind: 'string' }
    ])
    expect(parseElicitationFields(undefined)).toEqual([])
    expect(parseElicitationFields('nope')).toEqual([])
    expect(parseElicitationFields({ properties: 'nope' })).toEqual([])
  })
})

describe('buildElicitationContent', () => {
  const fields = parseElicitationFields({
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
      admin: { type: 'boolean' },
      color: { type: 'string', enum: ['Red', 'Blue'] }
    },
    required: ['name']
  })

  it('types values and omits blank optional fields', () => {
    expect(
      buildElicitationContent(fields, { name: 'Ada', age: '36', admin: 'yes', color: 'red' })
    ).toEqual({ content: { name: 'Ada', age: 36, admin: true, color: 'Red' } })
    expect(buildElicitationContent(fields, { name: 'Ada' })).toEqual({ content: { name: 'Ada' } })
  })

  it('rejects a blank required field, bad numbers, bad booleans, and unknown enum values', () => {
    expect(buildElicitationContent(fields, {})).toEqual({ error: '"name" is required.' })
    expect(buildElicitationContent(fields, { name: 'a', age: 'old' })).toEqual({
      error: '"age" must be a number.'
    })
    expect(buildElicitationContent(fields, { name: 'a', age: '3.5' })).toEqual({
      error: '"age" must be an integer.'
    })
    expect(buildElicitationContent(fields, { name: 'a', admin: 'maybe' })).toEqual({
      error: '"admin" must be yes or no.'
    })
    expect(buildElicitationContent(fields, { name: 'a', color: 'green' })).toEqual({
      error: '"color" must be one of: Red, Blue.'
    })
  })
})
