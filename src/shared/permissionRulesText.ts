import { permissionRuleKey, type PermissionRule } from './types'

/**
 * The text form of a permission-rule list, for Settings' "Edit as text": a JSON
 * array, one rule per line, holding only the fields the matcher reads (`action`,
 * `tool`, `match`, `exact`). It is the same shape as the `permissionRules` list in
 * settings.json, so rules paste between the two.
 */
export function rulesToText(rules: PermissionRule[]): string {
  if (rules.length === 0) return '[\n]\n'
  const lines = rules.map((r) =>
    JSON.stringify(r.exact ? { action: r.action, tool: r.tool, match: r.match, exact: true } : { action: r.action, tool: r.tool, match: r.match })
  )
  return `[\n  ${lines.join(',\n  ')}\n]\n`
}

export type ParsedRules = { ok: true; rules: PermissionRule[] } | { ok: false; error: string; line?: number }

const ACTIONS = new Set(['allow', 'deny', 'ask'])
const FIELDS = new Set(['action', 'tool', 'match', 'exact'])

/** 1-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/** The line a rule's object starts on, found by scanning for its opening brace. */
function ruleLines(text: string): number[] {
  const lines: number[] = []
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') {
      if (c === '{' && depth === 1) lines.push(lineAt(text, i))
      depth++
    } else if (c === '}' || c === ']') depth--
  }
  return lines
}

/**
 * Parse and validate the text form. Strict on purpose: a rule list is a security
 * boundary, so a misspelt field (`"acton"`) or a wrong type is an error naming the
 * rule's line, never something silently dropped or read loosely.
 */
export function parseRulesText(text: string): ParsedRules {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const msg = (e as Error).message
    const pos = /position (\d+)/.exec(msg)
    return {
      ok: false,
      error: 'This is not valid JSON.',
      ...(pos ? { line: lineAt(text, Number(pos[1])) } : {})
    }
  }
  if (!Array.isArray(raw)) return { ok: false, error: 'Expected a list of rules, inside [ and ].' }
  const lines = ruleLines(text)
  const rules: PermissionRule[] = []
  for (const [i, item] of raw.entries()) {
    const at = { line: lines[i] }
    const n = i + 1
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `Rule ${n} is not an object like {"action": …, "tool": …, "match": …}.`, ...at }
    }
    const o = item as Record<string, unknown>
    const unknown = Object.keys(o).find((k) => !FIELDS.has(k))
    if (unknown) return { ok: false, error: `Rule ${n} has an unknown field "${unknown}".`, ...at }
    if (typeof o.action !== 'string' || !ACTIONS.has(o.action)) {
      return { ok: false, error: `Rule ${n} needs "action": "allow", "ask", or "deny".`, ...at }
    }
    if (typeof o.tool !== 'string' || o.tool.trim() === '') {
      return { ok: false, error: `Rule ${n} needs a "tool" (a tool name, or "*" for any).`, ...at }
    }
    if (typeof o.match !== 'string') return { ok: false, error: `Rule ${n} needs a "match" pattern (a string).`, ...at }
    if (o.exact !== undefined && typeof o.exact !== 'boolean') {
      return { ok: false, error: `Rule ${n}'s "exact" must be true or false.`, ...at }
    }
    const rule: PermissionRule = { action: o.action as PermissionRule['action'], tool: o.tool.trim(), match: o.match }
    if (o.exact === true) rule.exact = true
    rules.push(rule)
  }
  return { ok: true, rules }
}

/**
 * Carry each rule's bookkeeping (when and how it was added) over from the list it
 * replaces, matched by what the matcher reads; a rule that is new in the text is
 * stamped as added in Settings now.
 */
export function carryRuleMeta(next: PermissionRule[], prev: PermissionRule[], now: number): PermissionRule[] {
  const pool = new Map<string, PermissionRule[]>()
  for (const r of prev) {
    const k = permissionRuleKey(r)
    pool.set(k, [...(pool.get(k) ?? []), r])
  }
  return next.map((r) => {
    const match = pool.get(permissionRuleKey(r))?.shift()
    if (match) {
      return {
        ...r,
        ...(match.addedAt !== undefined ? { addedAt: match.addedAt } : {}),
        ...(match.source ? { source: match.source } : {})
      }
    }
    return { ...r, addedAt: now, source: 'settings' as const }
  })
}

/** What applying `next` over `prev` changes: rules added, removed, and whether the order moved. */
export function diffRules(prev: PermissionRule[], next: PermissionRule[]): { added: number; removed: number; reordered: boolean } {
  const count = (list: PermissionRule[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const r of list) m.set(permissionRuleKey(r), (m.get(permissionRuleKey(r)) ?? 0) + 1)
    return m
  }
  const a = count(prev)
  const b = count(next)
  let added = 0
  let removed = 0
  for (const [k, n] of b) added += Math.max(0, n - (a.get(k) ?? 0))
  for (const [k, n] of a) removed += Math.max(0, n - (b.get(k) ?? 0))
  // Reordered: the rules both lists keep appear in a different relative order.
  const kept = (list: PermissionRule[], other: Map<string, number>): string[] => {
    const left = new Map(other)
    return list
      .map(permissionRuleKey)
      .filter((k) => {
        const n = left.get(k) ?? 0
        if (n === 0) return false
        left.set(k, n - 1)
        return true
      })
  }
  const pa = kept(prev, b)
  const pb = kept(next, a)
  const reordered = pa.length === pb.length && pa.some((k, i) => k !== pb[i])
  return { added, removed, reordered }
}
