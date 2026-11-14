import { describe, expect, it } from 'vitest'
import { lowerJsonSchema, normalizeMcpInputSchema } from './tool-exposure'

describe('lowerJsonSchema (JSON Schema 2020-12 to what every provider accepts)', () => {
  it('inlines local $defs references and drops the definitions', () => {
    const { schema, note } = lowerJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { where: { $ref: '#/$defs/Place', description: 'Where to look' }, legacy: { $ref: '#/definitions/Id' } },
      $defs: { Place: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
      definitions: { Id: { type: 'integer' } }
    })
    expect(note).toBeUndefined()
    expect(schema).toEqual({
      type: 'object',
      properties: {
        where: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], description: 'Where to look' },
        legacy: { type: 'integer' }
      }
    })
  })

  it('turns a cyclic, missing, root or remote reference into an open schema, with a note', () => {
    const { schema, note } = lowerJsonSchema({
      type: 'object',
      properties: {
        tree: { $ref: '#/$defs/Node' },
        gone: { $ref: '#/$defs/Missing' },
        self: { $ref: '#' },
        remote: { $ref: 'https://example.com/schema.json' }
      },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }
    })
    expect(schema).toEqual({
      type: 'object',
      properties: {
        tree: { type: 'object', properties: { child: {} } },
        gone: {},
        self: {},
        remote: {}
      }
    })
    expect(note).toMatch(/could not be resolved/)
  })

  it('turns const into a one-value enum and prefixItems into items', () => {
    const { schema } = lowerJsonSchema({
      type: 'object',
      properties: {
        kind: { const: 'fixed' },
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false, minItems: 2 },
        head: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'boolean' } },
        one: { type: 'array', prefixItems: [{ type: 'string' }] }
      }
    })
    expect(schema?.properties).toEqual({
      kind: { enum: ['fixed'] },
      pair: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 2 },
      head: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } },
      one: { type: 'array', items: { type: 'string' } }
    })
  })

  it('drops identifiers, annotations and conditionals, noting when constraints were lost', () => {
    const { schema, note } = lowerJsonSchema({
      $id: 'urn:x',
      $comment: 'internal',
      type: 'object',
      properties: { a: { type: 'string', $anchor: 'a' } },
      if: { properties: { a: { const: 'x' } } },
      then: { required: ['b'] },
      unevaluatedProperties: false,
      dependentRequired: { a: ['b'] }
    })
    expect(schema).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(note).toMatch(/could not be resolved/)
  })

  it('leaves data keywords alone (enum, default and examples are values, not schemas)', () => {
    const { schema } = lowerJsonSchema({
      type: 'object',
      properties: { mode: { enum: [{ $ref: '#/x' }], default: { const: 1 }, examples: [{ if: true }] } }
    })
    expect(schema?.properties).toEqual({ mode: { enum: [{ $ref: '#/x' }], default: { const: 1 }, examples: [{ if: true }] } })
  })

  it('gives up on a schema too deep or too large to lower', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { n: deep } }
    expect(lowerJsonSchema(deep).schema).toBeNull()
    // References that fan out: each level doubles.
    const defs: Record<string, unknown> = { L0: { type: 'string' } }
    for (let i = 1; i <= 20; i++) defs[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/$defs/L${i - 1}` }, b: { $ref: `#/$defs/L${i - 1}` } } }
    expect(lowerJsonSchema({ type: 'object', properties: { x: { $ref: '#/$defs/L20' } }, $defs: defs }).schema).toBeNull()
  })
})

describe('normalizeMcpInputSchema with 2020-12 schemas', () => {
  it('produces a provider-safe object schema', () => {
    const { parameters, note } = normalizeMcpInputSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { q: { $ref: '#/$defs/Q' } },
      required: ['q'],
      $defs: { Q: { type: 'string', const: 'x' } }
    })
    expect(note).toBeUndefined()
    expect(parameters).toEqual({ type: 'object', properties: { q: { type: 'string', enum: ['x'] } }, required: ['q'] })
  })

  it('accepts any arguments when lowering gives up, and says so', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { n: deep } }
    expect(normalizeMcpInputSchema(deep)).toEqual({
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      note: 'its input schema was too complex to send, so any arguments are accepted'
    })
  })

  it('carries the lowering note', () => {
    expect(normalizeMcpInputSchema({ type: 'object', properties: { r: { $ref: 'https://x.test/s' } } }).note).toMatch(
      /could not be resolved/
    )
  })
})
