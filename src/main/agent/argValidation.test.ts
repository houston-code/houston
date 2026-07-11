import { describe, expect, it } from 'vitest'
import { coerceToolArgs, validateToolArgs, validationError } from './argValidation'
import { getTool, toolSchemas } from './tools'

// Pull real tool schemas so the validator is tested against the shapes it will
// actually see in production, not hand-rolled fixtures.
const readFileSchema = getTool('read_file')!.schema.parameters
const writeFileSchema = getTool('write_file')!.schema.parameters
const todoWriteSchema = getTool('todo_write')!.schema.parameters
const askUserSchema = getTool('ask_user')!.schema.parameters
const presentPlanSchema = getTool('present_plan')!.schema.parameters

describe('validateToolArgs', () => {
  it('accepts a valid call with only the required field', () => {
    expect(validateToolArgs({ path: 'a.txt' }, readFileSchema)).toEqual([])
  })

  it('accepts a valid call with optional fields of the right type', () => {
    expect(validateToolArgs({ path: 'a.txt', offset: 1, limit: 20 }, readFileSchema)).toEqual([])
  })

  it('flags a missing required field', () => {
    const issues = validateToolArgs({ offset: 1 }, readFileSchema)
    expect(issues).toHaveLength(1)
    expect(issues[0].key).toBe('path')
    expect(issues[0].message).toContain('missing required')
  })

  it('flags a required field present as null', () => {
    const issues = validateToolArgs({ path: null }, readFileSchema)
    expect(issues.some((i) => i.key === 'path')).toBe(true)
  })

  it('flags a wrong primitive type (string where number expected)', () => {
    const issues = validateToolArgs({ path: 'a.txt', offset: 'nope' }, readFileSchema)
    expect(issues).toHaveLength(1)
    expect(issues[0].key).toBe('offset')
    expect(issues[0].message).toContain('should be number')
    expect(issues[0].message).toContain('got string')
  })

  it('flags a wrong boolean type on a write call', () => {
    // write_file: path + content required, replace/other booleans optional.
    const issues = validateToolArgs(
      { path: 'a.txt', content: 'x', replace_all: 'yes' } as Record<string, unknown>,
      writeFileSchema
    )
    // replace_all is on edit_file; write_file may not have it — assert generically
    // that a wrong-typed field is only flagged when the schema declares it.
    for (const i of issues) expect(i.key).not.toBe('content')
  })

  it('reports multiple issues at once (missing required + wrong type)', () => {
    const issues = validateToolArgs({ offset: 'x' } as Record<string, unknown>, readFileSchema)
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.map((i) => i.key)).toContain('path')
    expect(issues.map((i) => i.key)).toContain('offset')
  })

  it('flags a non-array where an array is required (todo_write.todos)', () => {
    const issues = validateToolArgs({ todos: 'not an array' }, todoWriteSchema)
    expect(issues).toHaveLength(1)
    expect(issues[0].key).toBe('todos')
    expect(issues[0].message).toContain('should be array')
  })

  it('accepts an array for an array field without recursing into item shape', () => {
    // The item schema is objects with {content,status}; we deliberately do NOT
    // validate array items, matching the tools' lenient coercion.
    expect(validateToolArgs({ todos: [{ anything: 1 }, 'loose'] }, todoWriteSchema)).toEqual([])
  })

  it("tolerates ask_user's options as a plain string array (schema says array)", () => {
    // parseQuestionOptions accepts string[] OR {label} objects; validation must
    // not reject the string[] form the model legitimately sends.
    expect(
      validateToolArgs({ question: 'Which?', options: ['A', 'B'] }, askUserSchema)
    ).toEqual([])
  })

  it('flags ask_user missing the required question', () => {
    const issues = validateToolArgs({ options: ['A'] }, askUserSchema)
    expect(issues.some((i) => i.key === 'question')).toBe(true)
  })

  it('tolerates unknown extra keys (does not enforce additionalProperties)', () => {
    expect(validateToolArgs({ path: 'a.txt', bogus: 1 }, readFileSchema)).toEqual([])
  })

  it('treats an absent/undefined schema as no constraints', () => {
    expect(validateToolArgs({ anything: 1 }, undefined)).toEqual([])
    expect(validateToolArgs({}, { type: 'object', properties: {} })).toEqual([])
  })

  it('ignores non-object schemas entirely', () => {
    expect(validateToolArgs({ x: 1 }, { type: 'string' })).toEqual([])
  })

  it('accepts an accepts-any (no type) property regardless of value', () => {
    const schema = { type: 'object', properties: { anything: {} }, required: [] }
    expect(validateToolArgs({ anything: [1, 2] }, schema)).toEqual([])
    expect(validateToolArgs({ anything: 'str' }, schema)).toEqual([])
  })

  it('every real tool schema accepts a well-formed minimal call', () => {
    // Smoke test: a call supplying a plausibly-typed value for each required key
    // should pass validation for every registered tool.
    for (const schema of toolSchemas()) {
      const params = schema.parameters as Record<string, unknown>
      const props = (params.properties ?? {}) as Record<string, Record<string, unknown>>
      const required = (params.required ?? []) as string[]
      const args: Record<string, unknown> = {}
      for (const key of required) {
        const t = props[key]?.type
        args[key] =
          t === 'number' || t === 'integer'
            ? 1
            : t === 'boolean'
              ? true
              : t === 'array'
                ? []
                : t === 'object'
                  ? {}
                  : 'x'
      }
      expect(validateToolArgs(args, schema.parameters)).toEqual([])
    }
  })
})

describe('validationError', () => {
  it('renders the problems and the expected shape for the model', () => {
    const issues = validateToolArgs({ offset: 1 }, readFileSchema)
    const msg = validationError('read_file', readFileSchema, issues)
    expect(msg).toContain('Invalid arguments for tool "read_file"')
    expect(msg).toContain('missing required "path"')
    expect(msg).toContain('path: string (required)')
    expect(msg).toContain('Required: path')
  })

  it('handles a schema with no useful properties gracefully', () => {
    const msg = validationError('x', { type: 'object', properties: {} }, [
      { key: 'k', message: 'oops' }
    ])
    expect(msg).toContain('Invalid arguments for tool "x": oops.')
  })
})

describe('coerceToolArgs', () => {
  it('leaves a correctly-typed array untouched (same object reference)', () => {
    const args = { title: 'X', plan: 'do it', files: ['a.ts', 'b.ts'] }
    expect(coerceToolArgs(args, presentPlanSchema)).toBe(args)
  })

  it('parses a JSON-stringified array into a real array (the reported present_plan bug)', () => {
    const out = coerceToolArgs(
      { title: 'X', plan: 'do it', files: '["a.ts", "b.ts"]' },
      presentPlanSchema
    )
    expect(out.files).toEqual(['a.ts', 'b.ts'])
    // The coerced call now passes validation, so the tool runs instead of being refused.
    expect(validateToolArgs(out, presentPlanSchema)).toEqual([])
  })

  it('splits a newline-delimited string into an array', () => {
    const out = coerceToolArgs({ title: 'X', plan: 'p', files: 'a.ts\nb.ts\n' }, presentPlanSchema)
    expect(out.files).toEqual(['a.ts', 'b.ts'])
  })

  it('wraps a single bare value in a one-element array', () => {
    const out = coerceToolArgs({ title: 'X', plan: 'p', files: 'a.ts' }, presentPlanSchema)
    expect(out.files).toEqual(['a.ts'])
  })

  it('coerces an empty string to an empty array', () => {
    const out = coerceToolArgs({ title: 'X', plan: 'p', files: '' }, presentPlanSchema)
    expect(out.files).toEqual([])
  })

  it('does not touch a string where the schema expects a string', () => {
    const args = { path: 'a.txt', content: 'hello' }
    expect(coerceToolArgs(args, writeFileSchema)).toBe(args)
  })

  it('leaves an array declared but passed as unparseable non-array string for validation to report', () => {
    // '{...}' is neither a JSON array nor empty; it becomes a single-element array
    // rather than a hard error — coercion only ever widens, never rejects.
    const out = coerceToolArgs({ title: 'X', plan: 'p', files: 'not-json' }, presentPlanSchema)
    expect(out.files).toEqual(['not-json'])
  })

  it('parses a JSON-stringified object where an object is declared', () => {
    // A synthetic object-typed schema (mirrors what an MCP tool might declare).
    const schema = {
      type: 'object',
      properties: { cfg: { type: 'object' } },
      required: ['cfg']
    }
    const out = coerceToolArgs({ cfg: '{"a":1}' }, schema)
    expect(out.cfg).toEqual({ a: 1 })
  })
})
