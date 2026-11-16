/**
 * A small evaluator for GitHub Actions expressions, for workflow tests that check what an
 * expression does rather than how it is spelled: which secret a step is handed, or what a
 * job reports for each way a run can end.
 *
 * It covers the subset the workflows here use: string, number, boolean and null literals,
 * property paths (with the `*` object filter, as in `needs.*.result`), `!`, `==`, `!=`, `&&`,
 * `||`, parentheses, and the functions `always`, `success`, `failure`, `cancelled`,
 * `contains` and `format`. Anything else throws, so a workflow that starts using more fails
 * its test rather than being evaluated wrongly.
 *
 * Semantics follow GitHub's documentation: `&&` and `||` return one of their operands, not a
 * boolean; strings compare without regard to case; operands of different types compare as
 * numbers; a missing property is null; and an `if:` with no status function is ANDed with
 * `success()`.
 */

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value }

export interface ExpressionContext {
  /** The named contexts an expression reads: `github`, `needs`, `inputs`, `secrets` and so on. */
  contexts: Record<string, Value>
  /** Whether the run was cancelled, for the status functions. */
  cancelled?: boolean
}

type Token = { kind: 'str'; value: string } | { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string }

type Node =
  | { kind: 'lit'; value: Value }
  | { kind: 'ctx'; name: string }
  | { kind: 'prop'; of: Node; name: string }
  | { kind: 'call'; fn: string; args: Node[] }
  | { kind: 'not'; of: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }

/** Longest first, so `!=` is never read as `!` then `=`. */
const OPERATORS = ['&&', '||', '==', '!=', '!', '(', ')', ',', '.', '*']
const STATUS_FUNCTIONS = ['always', 'success', 'failure', 'cancelled']

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      let value = ''
      i++
      for (;;) {
        if (i >= src.length) throw new Error(`Unterminated string in expression: ${src}`)
        if (src[i] === "'") {
          if (src[i + 1] !== "'") break
          value += "'"
          i += 2
          continue
        }
        value += src[i++]
      }
      i++
      tokens.push({ kind: 'str', value })
      continue
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i))
    if (num) {
      tokens.push({ kind: 'num', value: Number(num[0]) })
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))
    if (id) {
      tokens.push({ kind: 'id', value: id[0] })
      i += id[0].length
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`Unsupported syntax at '${src.slice(i)}' in expression: ${src}`)
    tokens.push({ kind: 'op', value: op })
    i += op.length
  }
  return tokens
}

function parse(src: string): Node {
  const tokens = tokenize(src)
  let pos = 0
  const peek = (value: string) => tokens[pos]?.kind === 'op' && tokens[pos].value === value
  const expect = (value: string) => {
    if (!peek(value)) throw new Error(`Expected '${value}' at token ${pos} in expression: ${src}`)
    pos++
  }
  const binary = (ops: string[], next: () => Node) => (): Node => {
    let left = next()
    while (ops.some(peek)) {
      const op = (tokens[pos++] as { value: string }).value
      left = { kind: 'bin', op, left, right: next() }
    }
    return left
  }
  const primary = (): Node => {
    const t = tokens[pos++]
    if (!t) throw new Error(`Unexpected end of expression: ${src}`)
    if (t.kind === 'str' || t.kind === 'num') return { kind: 'lit', value: t.value }
    if (t.kind === 'op' && t.value === '(') {
      const inner = or()
      expect(')')
      return inner
    }
    if (t.kind !== 'id') throw new Error(`Unexpected '${t.value}' in expression: ${src}`)
    if (t.value === 'true' || t.value === 'false') return { kind: 'lit', value: t.value === 'true' }
    if (t.value === 'null') return { kind: 'lit', value: null }
    if (!peek('(')) return { kind: 'ctx', name: t.value }
    pos++
    const args: Node[] = []
    while (!peek(')')) {
      if (args.length) expect(',')
      args.push(or())
    }
    pos++
    return { kind: 'call', fn: t.value, args }
  }
  const postfix = (): Node => {
    let node = primary()
    while (peek('.')) {
      pos++
      const t = tokens[pos++]
      if (t?.kind === 'id' || (t?.kind === 'op' && t.value === '*')) node = { kind: 'prop', of: node, name: String(t.value) }
      else throw new Error(`Expected a property name after '.' in expression: ${src}`)
    }
    return node
  }
  const unary = (): Node => {
    if (!peek('!')) return postfix()
    pos++
    return { kind: 'not', of: unary() }
  }
  const eq = binary(['==', '!='], unary)
  const and = binary(['&&'], eq)
  const or = binary(['||'], and)
  const node = or()
  if (pos !== tokens.length) throw new Error(`Unexpected trailing tokens in expression: ${src}`)
  return node
}

/** The result of the `*` filter: property access on it maps over its items. */
class Filtered {
  constructor(readonly items: Value[]) {}
}
type Evaluated = Value | Filtered

const isObject = (v: Evaluated): v is { [key: string]: Value } =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Filtered)

/** Context and property names are case-insensitive. */
function property(of: Value, name: string): Value {
  if (!isObject(of)) return null
  const key = Object.keys(of).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? null : of[key]
}

const plain = (v: Evaluated): Value => (v instanceof Filtered ? v.items : v)

export function truthy(v: Evaluated): boolean {
  return !(v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && Number.isNaN(v)))
}

function toNumber(v: Value): number {
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v)
  return NaN
}

function equals(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (typeof a === 'object' && a !== null) return a === b
  if (typeof b === 'object' && b !== null) return false
  if (typeof a === typeof b) return a === b
  return toNumber(a) === toNumber(b)
}

function toText(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'object') throw new Error('An object or array cannot be converted to a string here')
  return String(v)
}

function needResults(ctx: ExpressionContext): string[] {
  const needs = ctx.contexts.needs
  return isObject(needs) ? Object.values(needs).map((n) => toText(property(n, 'result'))) : []
}

function call(fn: string, args: Value[], ctx: ExpressionContext): Value {
  switch (fn) {
    case 'always':
      return true
    case 'cancelled':
      return Boolean(ctx.cancelled)
    case 'success':
      return !ctx.cancelled && needResults(ctx).every((r) => r === 'success')
    case 'failure':
      return needResults(ctx).includes('failure')
    case 'contains': {
      const [search, item] = args
      if (Array.isArray(search)) return search.some((el) => equals(el, item))
      return toText(search).toLowerCase().includes(toText(item).toLowerCase())
    }
    case 'format': {
      const [fmt, ...rest] = args
      return toText(fmt).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, n?: string) => {
        if (m === '{{') return '{'
        if (m === '}}') return '}'
        if (Number(n) >= rest.length) throw new Error(`format() has no argument {${n}}`)
        return toText(rest[Number(n)])
      })
    }
    default:
      throw new Error(`Unsupported function ${fn}()`)
  }
}

function evalNode(node: Node, ctx: ExpressionContext): Evaluated {
  switch (node.kind) {
    case 'lit':
      return node.value
    case 'ctx':
      return property(ctx.contexts, node.name)
    case 'prop': {
      const of = evalNode(node.of, ctx)
      if (node.name === '*') {
        const items = plain(of)
        if (Array.isArray(items)) return new Filtered(items)
        return new Filtered(isObject(items) ? Object.values(items) : [])
      }
      if (of instanceof Filtered) return new Filtered(of.items.map((i) => property(i, node.name)).filter((v) => v !== null))
      return property(of, node.name)
    }
    case 'call':
      return call(
        node.fn,
        node.args.map((a) => plain(evalNode(a, ctx))),
        ctx
      )
    case 'not':
      return !truthy(evalNode(node.of, ctx))
    case 'bin': {
      const left = evalNode(node.left, ctx)
      if (node.op === '&&') return truthy(left) ? evalNode(node.right, ctx) : left
      if (node.op === '||') return truthy(left) ? left : evalNode(node.right, ctx)
      const same = equals(plain(left), plain(evalNode(node.right, ctx)))
      return node.op === '==' ? same : !same
    }
  }
}

/** Each `${{ … }}` in a value, scanning past string literals so a `}}` inside one doesn't end it. */
function expressions(value: string): { start: number; end: number; src: string }[] {
  const found: { start: number; end: number; src: string }[] = []
  let start = value.indexOf('${{')
  while (start !== -1) {
    let i = start + 3
    while (!value.startsWith('}}', i)) {
      if (i >= value.length) throw new Error(`Unterminated \${{ in: ${value}`)
      if (value[i] !== "'") {
        i++
        continue
      }
      // A string literal, where '' is an escaped quote.
      i++
      while (i < value.length && !(value[i] === "'" && value[i + 1] !== "'")) i += value[i] === "'" ? 2 : 1
      i++
    }
    found.push({ start, end: i + 2, src: value.slice(start + 3, i) })
    start = value.indexOf('${{', i + 2)
  }
  return found
}

/** The expression a value consists of, when it is exactly one `${{ … }}` and nothing else. */
function wholeExpression(value: string): string | undefined {
  const found = expressions(value)
  if (found.length !== 1) return undefined
  const [{ start, end, src }] = found
  return value.slice(0, start).trim() === '' && value.slice(end).trim() === '' ? src : undefined
}

/**
 * Evaluate a workflow value as GitHub does: a value that is exactly one `${{ … }}` gives the
 * expression's own value (a boolean stays a boolean), a value with expressions inside text
 * interpolates each as a string, and a value with none is the literal text.
 */
export function evaluate(value: string, ctx: ExpressionContext): Value {
  const whole = wholeExpression(value)
  if (whole !== undefined) return plain(evalNode(parse(whole), ctx))
  let out = ''
  let at = 0
  for (const { start, end, src } of expressions(value)) {
    out += value.slice(at, start) + toText(plain(evalNode(parse(src), ctx)))
    at = end
  }
  return out + value.slice(at)
}

/**
 * Evaluate a job's or step's `if:`, written with or without `${{ }}`. Absent, it is
 * `success()`; with no status function in it, GitHub ANDs it with `success()`.
 */
export function evaluateIf(condition: string | undefined, ctx: ExpressionContext): boolean {
  let src = condition ?? 'success()'
  if (src.includes('${{')) {
    const whole = wholeExpression(src)
    if (whole === undefined) throw new Error(`An if: holding text beside its expression is not modelled: ${src}`)
    src = whole
  }
  const node = parse(src)
  const hasStatus = (n: Node): boolean =>
    n.kind === 'call'
      ? STATUS_FUNCTIONS.includes(n.fn) || n.args.some(hasStatus)
      : n.kind === 'prop' || n.kind === 'not'
        ? hasStatus(n.of)
        : n.kind === 'bin'
          ? hasStatus(n.left) || hasStatus(n.right)
          : false
  const result = truthy(evalNode(node, ctx))
  return hasStatus(node) ? result : result && truthy(call('success', [], ctx))
}
