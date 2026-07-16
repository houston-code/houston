/**
 * Version comparison for the update check. A tiny, dependency-free semver subset:
 * Houston's own versions are plain `major.minor.patch` (the release pipeline bumps
 * the patch on every merge), so this only needs to order those correctly and
 * refuse to guess about anything it doesn't recognize.
 *
 * Deliberately NOT a full semver implementation: an update prompt is a nudge, and
 * the failure mode that matters is nagging someone about a version that isn't
 * newer. Anything unparseable compares as "not newer" and the nudge stays quiet.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** A prerelease tag (`-beta.1`); any prerelease sorts BELOW the same release. */
  prerelease?: string
}

/** Parse `1.2.3`, `v1.2.3`, or `1.2.3-beta.1`; null when it isn't that shape. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    ...(m[4] ? { prerelease: m[4] } : {})
  }
}

/**
 * True when `candidate` is strictly newer than `current`. Unparseable input on
 * either side returns false: never nag on a version we can't reason about (a `dev`
 * build, a hand-built binary, a tag that isn't a version).
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  if (a.patch !== b.patch) return a.patch > b.patch
  // Same numbers: a release beats a prerelease of itself, never the reverse.
  if (a.prerelease && !b.prerelease) return false
  if (!a.prerelease && b.prerelease) return true
  return false
}
