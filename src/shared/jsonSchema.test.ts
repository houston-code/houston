import { describe, expect, it } from 'vitest'
import { formatSchemaErrors, schemaProblems, validateJson, type JsonSchema } from './jsonSchema'

const ok = (schema: JsonSchema, value: unknown): void => {
  expect(validateJson(schema, value)).toEqual([])
}
const bad = (schema: JsonSchema, value: unknown, message: RegExp): void => {
  const errors = validateJson(schema, value)
  expect(errors.length).toBeGreaterThan(0)
  expect(formatSchemaErrors(errors)).toMatch(message)
}

describe('validateJson', () => {
  it('checks types, with integer stricter than number and null distinct', () => {
    ok({ type: 'integer' }, 3)
    bad({ type: 'integer' }, 3.5, /expected integer, got number/)
    ok({ type: ['string', 'null'] }, null)
    bad({ type: 'object' }, [], /expected object, got array/)
    bad({ type: 'number' }, '1', /expected number, got string/)
    ok(true, 'anything')
    bad(false, 1, /no value is allowed/)
  })

  it('checks enum and const structurally', () => {
    ok({ enum: [{ a: 1 }, 'x'] }, { a: 1 })
    bad({ enum: ['a', 'b'] }, 'c', /one of "a", "b"/)
    ok({ const: [1, { b: 2 }] }, [1, { b: 2 }])
    bad({ const: 1 }, 2, /must equal 1/)
  })

  it('checks object properties, required, additionalProperties, and counts', () => {
    const schema = {
      type: 'object',
      required: ['summary', 'risk'],
      properties: { summary: { type: 'string', minLength: 1 }, risk: { enum: ['low', 'high'] } },
      additionalProperties: false
    }
    ok(schema, { summary: 'ok', risk: 'low' })
    bad(schema, { summary: 'ok' }, /missing required property "risk"/)
    bad(schema, { summary: '', risk: 'low' }, /\$\/summary: must be at least 1 characters/)
    bad(schema, { summary: 'x', risk: 'low', extra: 1 }, /unexpected property "extra"/)
    bad({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 }, /at most 1 properties/)
    ok({ patternProperties: { '^x-': { type: 'string' } }, additionalProperties: false }, { 'x-a': 'v' })
    bad({ patternProperties: { '^x-': { type: 'string' } } }, { 'x-a': 1 }, /\$\/x-a: expected string/)
    bad({ propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 }, /must match/)
    bad({ dependentRequired: { a: ['b'] } }, { a: 1 }, /"a" requires "b"/)
  })

  it('checks arrays: items, tuples, counts, uniqueness, contains', () => {
    ok({ type: 'array', items: { type: 'string' } }, ['a', 'b'])
    bad({ type: 'array', items: { type: 'string' } }, ['a', 2], /\$\/1: expected string/)
    ok({ prefixItems: [{ type: 'number' }, { type: 'string' }], items: false }, [1, 'a'])
    bad({ prefixItems: [{ type: 'number' }], items: false }, [1, 'a'], /\$\/1: no value is allowed/)
    bad({ items: [{ type: 'number' }], additionalItems: false }, [1, 2], /\$\/1: no value is allowed/)
    bad({ minItems: 2 }, [1], /at least 2 items/)
    bad({ uniqueItems: true }, [{ a: 1 }, { a: 1 }], /unique/)
    bad({ contains: { const: 3 } }, [1, 2], /contain a matching item/)
  })

  it('checks strings and numbers', () => {
    bad({ maxLength: 2 }, 'héllo', /at most 2 characters/)
    bad({ pattern: '^v\\d+$' }, 'x1', /must match/)
    bad({ minimum: 1 }, 0, />= 1/)
    bad({ exclusiveMaximum: 1 }, 1, /< 1/)
    ok({ multipleOf: 0.1 }, 0.3)
    bad({ multipleOf: 2 }, 3, /multiple of 2/)
  })

  it('checks combinators and conditionals', () => {
    const either = { anyOf: [{ type: 'string' }, { type: 'number' }] }
    ok(either, 1)
    bad(either, true, /anyOf/)
    bad({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1, /more than one/)
    ok({ oneOf: [{ type: 'number' }, { type: 'string' }] }, 1)
    bad({ not: { type: 'null' } }, null, /must not match/)
    bad({ allOf: [{ type: 'number' }, { minimum: 5 }] }, 3, />= 5/)
    const cond = { if: { properties: { kind: { const: 'a' } } }, then: { required: ['x'] }, else: { required: ['y'] } }
    bad(cond, { kind: 'a' }, /"x"/)
    bad(cond, { kind: 'b' }, /"y"/)
  })

  it('follows local $refs, including recursive ones, without looping forever', () => {
    const tree = {
      $defs: { node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/node' } } } } },
      $ref: '#/$defs/node'
    }
    ok(tree, { children: [{ children: [] }] })
    bad(tree, { children: [{ children: 'no' }] }, /\$\/children\/0\/children: expected array/)
    const loop = { $ref: '#' }
    expect(validateJson(loop, 1).length).toBeGreaterThan(0)
  })

  it('caps how many errors it reports', () => {
    const errors = validateJson({ type: 'array', items: { type: 'string' } }, Array.from({ length: 100 }, () => 1))
    expect(errors.length).toBeLessThanOrEqual(20)
  })
})

describe('schemaProblems', () => {
  it('accepts a schema it can enforce in full, annotations included', () => {
    expect(
      schemaProblems({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Review',
        description: 'x',
        type: 'object',
        properties: { when: { type: 'string', format: 'date' } },
        $defs: { a: { type: 'string' } }
      })
    ).toEqual([])
  })

  it('names keywords it would not enforce, rather than ignoring them', () => {
    expect(schemaProblems({ type: 'object', unevaluatedProperties: false })).toEqual([
      '#/unevaluatedProperties: the "unevaluatedProperties" keyword is not supported'
    ])
    expect(schemaProblems({ properties: { a: { $dynamicRef: '#x' } } })[0]).toMatch(/\$dynamicRef/)
  })

  it('refuses malformed keyword values, bad patterns, and outside references', () => {
    expect(schemaProblems('nope')).toEqual(['the schema must be a JSON object'])
    expect(schemaProblems({ type: 'text' })[0]).toMatch(/#\/type: must be one of/)
    expect(schemaProblems({ required: 'a' })[0]).toMatch(/array of strings/)
    expect(schemaProblems({ pattern: '(' })[0]).toMatch(/not a valid regular expression/)
    expect(schemaProblems({ $ref: 'https://example.com/s.json' })[0]).toMatch(/only references inside this schema/)
    expect(schemaProblems({ $ref: '#/$defs/missing' })[0]).toMatch(/only references inside/)
    expect(schemaProblems({ anyOf: [] })[0]).toMatch(/non-empty array/)
    expect(schemaProblems({ minItems: -1 })[0]).toMatch(/whole number/)
  })
})
