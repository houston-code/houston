/**
 * Semantic versions: MAJOR.MINOR.PATCH, an optional pre-release ("-beta.2") and
 * optional build metadata ("+sha.5114f85", ignored for ordering).
 */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parse(text) {
  const m = VERSION.exec(text.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    text: text.trim()
  }
}

/** -1, 0 or 1, by semver precedence. */
export function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  // A pre-release sorts before the release it leads up to.
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
