import { compare, parse } from './version.mjs'

/**
 * Ranges as npm writes them: comparators (">=1.2.3 <2.0.0"), x-ranges ("1.2.x",
 * "1", "*"), tilde and caret ranges, hyphen ranges ("1.2.3 - 2.3.4"), and "||"
 * between alternatives. Each alternative becomes a list of plain comparators,
 * [op, version], all of which must hold.
 */

const PARTIAL = /^v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/

/** "1.2" -> { major: 1, minor: 2, patch: null } (null = wildcard / missing). */
function partial(text) {
  const m = PARTIAL.exec(text)
  if (!m) throw new Error(`invalid version in range: ${text}`)
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s))
  const major = num(m[1])
  const minor = major === null ? null : num(m[2])
  const patch = minor === null ? null : num(m[3])
  return { major, minor, patch, pre: m[4] ? m[4].split('.') : [] }
}

const v = (major, minor, patch, pre = []) => ({ major, minor, patch, pre })

/** The lowest version a partial covers: "1.2" -> 1.2.0. */
const floor = (p) => v(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre)

/** x-range: "1.2.x" -> >=1.2.0 <1.3.0, "1" -> >=1.0.0 <2.0.0, "*" -> anything. */
function xRange(p) {
  if (p.major === null) return []
  if (p.minor === null) return [['>=', floor(p)], ['<', v(p.major + 1, 0, 0)]]
  if (p.patch === null) return [['>=', floor(p)], ['<', v(p.major, p.minor + 1, 0)]]
  return [['=', floor(p)]]
}

/** ~1.2.3 -> >=1.2.3 <1.3.0; ~1 -> >=1.0.0 <2.0.0. */
function tilde(p) {
  if (p.major === null) return []
  if (p.minor === null) return [['>=', floor(p)], ['<', v(p.major + 1, 0, 0)]]
  return [['>=', floor(p)], ['<', v(p.major, p.minor + 1, 0)]]
}

/** ^1.2.3 -> >=1.2.3 <2.0.0: changes that don't touch the left-most non-zero part. */
function caret(p) {
  if (p.major === null) return []
  return [['>=', floor(p)], ['<', v(p.major + 1, 0, 0)]]
}

/** "1.2.3 - 2.3.4" -> >=1.2.3 <=2.3.4. */
function hyphen(lo, hi) {
  return [['>=', floor(lo)], ['<=', floor(hi)]]
}

function comparator(token) {
  const m = /^(<=|>=|<|>|=|~|\^)?\s*(.*)$/.exec(token)
  const op = m[1] ?? ''
  const p = partial(m[2])
  if (op === '~') return tilde(p)
  if (op === '^') return caret(p)
  if (op === '' || op === '=') return xRange(p)
  // Comparing against a partial: ">=1.2" is ">=1.2.0", "<1.2" is "<1.2.0".
  return [[op, floor(p)]]
}

/** Parse a range into its alternatives. */
export function parseRange(range) {
  return range.split('||').map((alt) => {
    const text = alt.trim().replace(/(<=|>=|<|>|=|~|\^)\s+/g, '$1')
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (h) return hyphen(partial(h[1]), partial(h[2]))
    return text === '' ? [] : text.split(/\s+/).flatMap(comparator)
  })
}

function test(op, version, bound) {
  const c = compare(version, bound)
  switch (op) {
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    case '>':
      return c > 0
    case '>=':
      return c >= 0
    default:
      return c === 0
  }
}

/** Does `version` satisfy `range`? */
export function satisfies(version, range) {
  const ver = typeof version === 'string' ? parse(version) : version
  if (!ver) return false
  return parseRange(range).some((set) => set.every(([op, bound]) => test(op, ver, bound)))
}

/** The highest of `versions` that satisfies `range`, or null. */
export function maxSatisfying(versions, range) {
  let best = null
  for (const text of versions) {
    const ver = parse(text)
    if (ver && satisfies(ver, range) && (!best || compare(ver, best) > 0)) best = ver
  }
  return best ? best.text : null
}
