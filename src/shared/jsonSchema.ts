/**
 * A small, dependency-free JSON Schema validator for the documents Houston itself
 * checks: the headless `--output-schema` a caller passes, and the `--json` event
 * schema the tests hold every emitted line to.
 *
 * It covers the assertion keywords of draft 2020-12 (and draft-07's tuple `items`)
 * that such schemas use: types, enums and consts, object properties and their
 * counts, array items and their counts, string length and pattern, number bounds,
 * the `allOf`/`anyOf`/`oneOf`/`not`/`if` combinators, and local `$ref`s. It is
 * strict about what it does not cover: {@link schemaProblems} names any keyword it
 * would not enforce, so a caller's schema is refused up front rather than silently
 * passing values the caller meant to reject. Annotation keywords (`title`,
 * `description`, `default`, `examples`, `format`, ...) are accepted and ignored,
 * as the spec allows.
 */

export type JsonSchema = boolean | { [keyword: string]: unknown }

/** One reason a value failed its schema, at a JSON-pointer-like path (`$` is the root). */
export interface SchemaError {
  path: string
  message: string
}

/** Keywords that assert something; each is enforced by {@link validateJson}. */
const ASSERTIONS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'dependentRequired',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  '$ref'
])

/** Keywords that only describe or organize a schema; they assert nothing. */
const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'definitions',
  '$anchor',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
  'contentEncoding',
  'contentMediaType'
])

const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])

/** Most errors {@link validateJson} collects before it stops looking. */
const MAX_ERRORS = 20
/** How deep `$ref`s and nesting may go before the schema is treated as cyclic. */
const MAX_DEPTH = 64

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Problems that make `schema` unusable here: not a schema at all, an unsupported
 * keyword, a malformed keyword value, a `$ref` that doesn't resolve inside the
 * document, or a `pattern` that isn't a valid regular expression. Empty when the
 * schema can be enforced in full.
 */
export function schemaProblems(schema: unknown): string[] {
  const problems: string[] = []
  if (!isObject(schema) && typeof schema !== 'boolean') return ['the schema must be a JSON object']
  const walk = (s: unknown, path: string, depth: number): void => {
    if (problems.length >= MAX_ERRORS) return
    if (depth > MAX_DEPTH) {
      problems.push(`${path}: nested too deeply`)
      return
    }
    if (typeof s === 'boolean') return
    if (!isObject(s)) {
      problems.push(`${path}: a schema must be an object or a boolean`)
      return
    }
    for (const [k, v] of Object.entries(s)) {
      const at = `${path}/${k}`
      if (ANNOTATIONS.has(k)) {
        if ((k === '$defs' || k === 'definitions') && isObject(v)) {
          for (const [name, sub] of Object.entries(v)) walk(sub, `${at}/${name}`, depth + 1)
        }
        continue
      }
      if (!ASSERTIONS.has(k)) {
        problems.push(`${at}: the "${k}" keyword is not supported`)
        continue
      }
      switch (k) {
        case 'type': {
          const list = Array.isArray(v) ? v : [v]
          if (!list.length || !list.every((t) => typeof t === 'string' && TYPES.has(t))) {
            problems.push(`${at}: must be one of ${[...TYPES].join(', ')} (or a list of them)`)
          }
          break
        }
        case 'enum':
          if (!Array.isArray(v)) problems.push(`${at}: must be an array`)
          break
        case 'required':
          if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) problems.push(`${at}: must be an array of strings`)
          break
        case 'properties':
        case 'patternProperties':
        case 'dependentRequired':
          if (!isObject(v)) {
            problems.push(`${at}: must be an object`)
            break
          }
          for (const [name, sub] of Object.entries(v)) {
            if (k === 'patternProperties' && !compiles(name)) problems.push(`${at}/${name}: not a valid regular expression`)
            if (k === 'dependentRequired') {
              if (!Array.isArray(sub) || !sub.every((x) => typeof x === 'string')) {
                problems.push(`${at}/${name}: must be an array of strings`)
              }
            } else {
              walk(sub, `${at}/${name}`, depth + 1)
            }
          }
          break
        case 'items':
          if (Array.isArray(v)) v.forEach((sub, i) => walk(sub, `${at}/${i}`, depth + 1))
          else walk(v, at, depth + 1)
          break
        case 'prefixItems':
        case 'allOf':
        case 'anyOf':
        case 'oneOf':
          if (!Array.isArray(v) || (k !== 'prefixItems' && v.length === 0)) {
            problems.push(`${at}: must be a non-empty array of schemas`)
            break
          }
          v.forEach((sub, i) => walk(sub, `${at}/${i}`, depth + 1))
          break
        case 'additionalProperties':
        case 'additionalItems':
        case 'propertyNames':
        case 'contains':
        case 'not':
        case 'if':
        case 'then':
        case 'else':
          walk(v, at, depth + 1)
          break
        case 'pattern':
          if (typeof v !== 'string' || !compiles(v)) problems.push(`${at}: not a valid regular expression`)
          break
        case 'minLength':
        case 'maxLength':
        case 'minItems':
        case 'maxItems':
        case 'minProperties':
        case 'maxProperties':
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) problems.push(`${at}: must be a whole number`)
          break
        case 'minimum':
        case 'maximum':
        case 'exclusiveMinimum':
        case 'exclusiveMaximum':
          if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at}: must be a number`)
          break
        case 'multipleOf':
          if (typeof v !== 'number' || !(v > 0)) problems.push(`${at}: must be a positive number`)
          break
        case 'uniqueItems':
          if (typeof v !== 'boolean') problems.push(`${at}: must be true or false`)
          break
        case '$ref':
          if (typeof v !== 'string' || resolveRef(schema, v) === undefined) {
            problems.push(`${at}: only references inside this schema ("#", "#/$defs/name") are supported`)
          }
          break
        case 'const':
          break
      }
    }
  }
  walk(schema, '#', 0)
  return problems
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u')
    return true
  } catch {
    return false
  }
}

/** Resolve a document-local `$ref` (`#`, `#/$defs/x`, `#/definitions/x`, any JSON pointer). */
function resolveRef(root: unknown, ref: string): JsonSchema | undefined {
  if (ref === '#') return root as JsonSchema
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(node) && !Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
    if (node === undefined) return undefined
  }
  return isObject(node) || typeof node === 'boolean' ? node : undefined
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'object':
      return isObject(v)
    default:
      return typeOf(v) === t
  }
}

/** Structural equality over JSON values, for `const`, `enum`, and `uniqueItems`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

const pointer = (path: string, key: string | number): string => `${path}/${String(key)}`

/**
 * Validate `value` against `schema`. Returns the errors found (empty when valid),
 * at most {@link MAX_ERRORS} of them. Call {@link schemaProblems} on a schema from
 * outside first; a keyword this validator doesn't know is otherwise ignored.
 */
export function validateJson(schema: JsonSchema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = []
  const root = schema
  const check = (s: JsonSchema, v: unknown, path: string, depth: number, out: SchemaError[]): void => {
    if (out.length >= MAX_ERRORS) return
    const fail = (message: string): void => {
      out.push({ path, message })
    }
    if (depth > MAX_DEPTH) return fail('the schema nests or references itself too deeply')
    if (s === true) return
    if (s === false) return fail('no value is allowed here')
    // A sub-check that must not add to `out` (anyOf/oneOf/not/if probes).
    const passes = (sub: unknown): boolean => {
      const probe: SchemaError[] = []
      check(sub as JsonSchema, v, path, depth + 1, probe)
      return probe.length === 0
    }

    if (typeof s.$ref === 'string') {
      const target = resolveRef(root, s.$ref)
      if (target === undefined) fail(`unresolvable reference ${s.$ref}`)
      else check(target, v, path, depth + 1, out)
    }
    if (s.type !== undefined) {
      const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[]
      if (!types.some((t) => typeMatches(t, v))) {
        return fail(`expected ${types.join(' or ')}, got ${typeOf(v)}`)
      }
    }
    if ('const' in s && !jsonEqual(s.const, v)) fail(`must equal ${JSON.stringify(s.const)}`)
    if (Array.isArray(s.enum) && !s.enum.some((e) => jsonEqual(e, v))) {
      fail(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    }

    if (typeof v === 'string') {
      const len = [...v].length
      if (typeof s.minLength === 'number' && len < s.minLength) fail(`must be at least ${s.minLength} characters`)
      if (typeof s.maxLength === 'number' && len > s.maxLength) fail(`must be at most ${s.maxLength} characters`)
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) fail(`must match /${s.pattern}/`)
    }

    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) fail(`must be >= ${s.minimum}`)
      if (typeof s.maximum === 'number' && v > s.maximum) fail(`must be <= ${s.maximum}`)
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) fail(`must be > ${s.exclusiveMinimum}`)
      if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) fail(`must be < ${s.exclusiveMaximum}`)
      if (typeof s.multipleOf === 'number') {
        const q = v / s.multipleOf
        if (Math.abs(q - Math.round(q)) > 1e-9) fail(`must be a multiple of ${s.multipleOf}`)
      }
    }

    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) fail(`must have at least ${s.minItems} items`)
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) fail(`must have at most ${s.maxItems} items`)
      // draft 2020-12 `prefixItems` + `items`, or draft-07 tuple `items` + `additionalItems`.
      const prefix = Array.isArray(s.prefixItems)
        ? (s.prefixItems as JsonSchema[])
        : Array.isArray(s.items)
          ? (s.items as JsonSchema[])
          : []
      const rest = (Array.isArray(s.items) ? s.additionalItems : s.items) as JsonSchema | undefined
      v.forEach((item, i) => {
        if (i < prefix.length) check(prefix[i], item, pointer(path, i), depth + 1, out)
        else if (rest !== undefined) check(rest, item, pointer(path, i), depth + 1, out)
      })
      if (s.contains !== undefined && !v.some((item) => {
        const probe: SchemaError[] = []
        check(s.contains as JsonSchema, item, path, depth + 1, probe)
        return probe.length === 0
      })) {
        fail('must contain a matching item')
      }
      if (s.uniqueItems === true && v.some((x, i) => v.findIndex((y) => jsonEqual(x, y)) !== i)) {
        fail('items must be unique')
      }
    }

    if (isObject(v)) {
      const keys = Object.keys(v)
      if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail(`must have at least ${s.minProperties} properties`)
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail(`must have at most ${s.maxProperties} properties`)
      if (Array.isArray(s.required)) {
        for (const k of s.required as string[]) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) fail(`missing required property "${k}"`)
        }
      }
      if (isObject(s.dependentRequired)) {
        for (const [k, deps] of Object.entries(s.dependentRequired)) {
          if (!(k in v) || !Array.isArray(deps)) continue
          for (const d of deps as string[]) if (!(d in v)) fail(`"${k}" requires "${d}"`)
        }
      }
      const props = isObject(s.properties) ? s.properties : {}
      const patterns = isObject(s.patternProperties) ? Object.entries(s.patternProperties) : []
      for (const k of keys) {
        let matched = false
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          matched = true
          check(props[k] as JsonSchema, v[k], pointer(path, k), depth + 1, out)
        }
        for (const [re, sub] of patterns) {
          if (new RegExp(re, 'u').test(k)) {
            matched = true
            check(sub as JsonSchema, v[k], pointer(path, k), depth + 1, out)
          }
        }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) fail(`unexpected property "${k}"`)
          else check(s.additionalProperties as JsonSchema, v[k], pointer(path, k), depth + 1, out)
        }
        if (s.propertyNames !== undefined) check(s.propertyNames as JsonSchema, k, pointer(path, k), depth + 1, out)
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(sub as JsonSchema, v, path, depth + 1, out)
    if (Array.isArray(s.anyOf) && !s.anyOf.some(passes)) fail('must match at least one of the allowed shapes (anyOf)')
    if (Array.isArray(s.oneOf)) {
      const n = s.oneOf.filter(passes).length
      if (n !== 1) fail(n === 0 ? 'must match one of the allowed shapes (oneOf)' : 'matches more than one shape (oneOf)')
    }
    if (s.not !== undefined && passes(s.not)) fail('must not match the excluded shape (not)')
    if (s.if !== undefined) {
      const branch = passes(s.if) ? s.then : s.else
      if (branch !== undefined) check(branch as JsonSchema, v, path, depth + 1, out)
    }
  }
  check(schema, value, '$', 0, errors)
  return errors.slice(0, MAX_ERRORS)
}

/** Errors as one line each, for a person or a model to read. */
export function formatSchemaErrors(errors: SchemaError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('\n')
}
