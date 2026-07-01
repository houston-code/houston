import type { JSONSchema } from '@shared/agent'

/**
 * Lightweight, dependency-free validation of a tool call's arguments against the
 * tool's declared JSON parameter schema (ToolSchema.parameters). It runs *before*
 * we dispatch a tool, so a malformed call never reaches `tool.execute` — instead
 * the loop turns the failure into a model-friendly repair message (see
 * `validationError`), letting the model self-correct on the next turn. This is
 * especially valuable for weaker local models that fumble structured arguments.
 *
 * DESIGN — deliberately shallow and lenient. The tools coerce arguments leniently
 * inside `execute` (str()/num() tolerate missing/loose values; ask_user's
 * `parseQuestionOptions` accepts a plain string[] *or* {label,description} objects
 * for what the schema declares as an array of objects). Validating deeply against
 * `additionalProperties:false` array/object item schemas would therefore *reject
 * arguments the tools already accept and handle correctly*. So we only check what
 * the model is genuinely likely to get wrong in a way that breaks execution:
 *
 *   1. required top-level keys are present (not undefined/null), and
 *   2. each *present* top-level property has the declared primitive/array/object
 *      shape (string / number / integer / boolean / array / object).
 *
 * We do NOT recurse into array items or nested object properties, do NOT enforce
 * enums, and do NOT reject unknown extra keys — matching the tools' existing
 * tolerance. The schemas the tools actually declare are a small JSON-Schema subset
 * built by `objectSchema` (tools.ts): a top-level object with `properties`,
 * `required`, and per-property `{ type: 'string' | 'number' | 'boolean' | 'array'
 * | 'object' }` (occasionally with `enum`, which we intentionally ignore here).
 */

/** A single problem found while validating arguments against a schema. */
export interface ArgValidationIssue {
  /** The property that was wrong. */
  key: string
  /** Human/model-readable description of what was wrong. */
  message: string
}

/** JSON Schema primitive type names we understand (the subset the tools use). */
type SchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

/**
 * The runtime "type" of a value, in JSON-Schema terms. `null` is reported as
 * `'null'` so a null where a value is required reads sensibly in the error.
 */
function runtimeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v // 'string' | 'number' | 'boolean' | 'object' | 'undefined' | ...
}

/**
 * Whether `v` satisfies the declared JSON-Schema `type`. Kept intentionally loose:
 *  - 'integer' accepts any finite number (the tools' `num()` extractor doesn't
 *    distinguish integers from floats, so rejecting `3.0` here would be stricter
 *    than execution and could break a working call).
 *  - 'object' means a plain object, i.e. not an array and not null.
 */
function matchesType(v: unknown, type: SchemaTypeName): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string'
    case 'number':
    case 'integer':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'array':
      return Array.isArray(v)
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    default:
      return true // unknown/unsupported type keyword — don't reject on our account
  }
}

/**
 * Read the declared type of a property schema. A property may legitimately omit
 * `type` (e.g. it only constrains via `enum`), in which case we return null and
 * skip the type check for it.
 */
function declaredType(propSchema: unknown): SchemaTypeName | null {
  if (!propSchema || typeof propSchema !== 'object') return null
  const t = (propSchema as Record<string, unknown>).type
  if (
    t === 'string' ||
    t === 'number' ||
    t === 'integer' ||
    t === 'boolean' ||
    t === 'array' ||
    t === 'object'
  ) {
    return t
  }
  return null
}

/**
 * Validate `args` against `schema` (a tool's `parameters`). Returns the list of
 * issues found — empty when the arguments are acceptable. Never throws: an
 * unrecognized/absent schema is treated as "no constraints" so a tool without a
 * declared object schema (or an MCP tool with a freeform schema) always passes.
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema: JSONSchema | undefined
): ArgValidationIssue[] {
  const issues: ArgValidationIssue[] = []
  if (!schema || typeof schema !== 'object') return issues

  const s = schema as Record<string, unknown>
  // Only object schemas carry `properties`/`required`; anything else (or a schema
  // with no properties block) imposes no checkable top-level constraints.
  if (s.type !== undefined && s.type !== 'object') return issues

  const properties =
    s.properties && typeof s.properties === 'object'
      ? (s.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(s.required) ? (s.required as unknown[]) : []

  // (1) Required keys must be present with a non-null value. A missing required
  // field is the single most common malformed-call failure for weak models.
  for (const key of required) {
    if (typeof key !== 'string') continue
    const v = args[key]
    if (v === undefined || v === null) {
      issues.push({ key, message: `missing required "${key}"` })
    }
  }

  // (2) Each *present* property must match its declared primitive/array/object
  // type. Absent optional properties are fine; unknown extra keys are tolerated.
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in args)) continue
    const v = args[key]
    // A present-but-null value only matters if the key is required (handled
    // above); an explicit null for an optional field is treated as "omitted".
    if (v === null) continue
    const type = declaredType(propSchema)
    if (type && !matchesType(v, type)) {
      issues.push({
        key,
        message: `"${key}" should be ${type}, got ${runtimeType(v)}`
      })
    }
  }

  return issues
}

/**
 * Render a compact, model-friendly repair message from validation issues plus the
 * expected shape, so the model can fix its arguments on the next turn. Returned as
 * the tool_result output (with ok:false) instead of executing the tool. Includes
 * the required keys and a `key: type` summary of the declared properties so the
 * model sees the target shape without us dumping the raw JSON schema.
 */
export function validationError(
  toolName: string,
  schema: JSONSchema | undefined,
  issues: ArgValidationIssue[]
): string {
  const problems = issues.map((i) => i.message).join('; ')
  const lines = [
    `Invalid arguments for tool "${toolName}": ${problems}.`,
    expectedShapeSummary(schema)
  ].filter(Boolean)
  return lines.join('\n')
}

/**
 * A one-line description of the expected argument shape derived from the schema:
 * the required keys and a `key: type` list of the declared properties. Empty
 * string when the schema declares nothing useful.
 */
function expectedShapeSummary(schema: JSONSchema | undefined): string {
  if (!schema || typeof schema !== 'object') return ''
  const s = schema as Record<string, unknown>
  const properties =
    s.properties && typeof s.properties === 'object'
      ? (s.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(s.required)
    ? (s.required as unknown[]).filter((k): k is string => typeof k === 'string')
    : []

  const propList = Object.entries(properties)
    .map(([key, propSchema]) => {
      const type = declaredType(propSchema)
      const req = required.includes(key) ? ' (required)' : ''
      return `${key}: ${type ?? 'any'}${req}`
    })
    .join(', ')

  if (!propList) return ''
  const requiredNote = required.length ? ` Required: ${required.join(', ')}.` : ''
  return `Expected shape — ${propList}.${requiredNote}`
}
