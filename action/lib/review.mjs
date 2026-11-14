// Turning a review run's findings into inline comments on the pull request's diff. Pure:
// the diff text, the findings, and the comments already on the pull request come in, the
// comments to post come out, so what lands on which line is pinned by unit tests.

import { createHash } from 'node:crypto'

/** The most inline comments one review posts; the rest stay in the review body. */
export const MAX_INLINE_COMMENTS = 30

/** One inline comment's longest body, well under GitHub's limit. */
const MAX_COMMENT = 8000

const MARKER = /<!-- houston-finding:([0-9a-f]{16}) -->/g

/** Authors whose comments can mark a finding as already posted. Strangers cannot hide one. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/**
 * A finding's `path:line` (or `path:start-end`) location as `{ path, line }`, or null.
 * The path is repository-relative as the diff names it.
 */
export function parseLocation(location) {
  if (typeof location !== 'string') return null
  const m = /^(.+?):(\d+)(?:\s*[-–]\s*\d+)?$/.exec(location.trim())
  if (!m) return null
  const path = m[1].replace(/^\.\//, '')
  const line = Number(m[2])
  if (!path || path.startsWith('/') || path.split('/').includes('..') || !Number.isSafeInteger(line) || line < 1) return null
  return { path, line }
}

/**
 * The new-side lines of a unified diff that GitHub accepts an inline comment on: every
 * added or context line inside a hunk, per file. Deleted files have none.
 */
export function commentableLines(diff) {
  const files = new Map()
  let lines = null
  let next = 0
  // Lines left in the current hunk, old and new side. Inside a hunk a line is content even
  // when it looks like a header (an added line `++ x` reads as `+++ x`).
  let oldLeft = 0
  let newLeft = 0
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('\\')) continue // "\ No newline at end of file"
      const tag = raw[0]
      if (tag === '+' || tag === ' ') {
        lines?.add(next++)
        newLeft--
      }
      if (tag === '-' || tag === ' ') oldLeft--
      if (tag !== '+' && tag !== '-' && tag !== ' ') oldLeft = newLeft = 0
      continue
    }
    if (raw.startsWith('diff --git ')) {
      lines = null
      continue
    }
    if (raw.startsWith('+++ ')) {
      // git quotes a path with unusual characters; those files get no inline comments.
      const target = raw.slice(4).replace(/\t$/, '')
      lines = null
      if (!target.startsWith('b/')) continue
      const path = target.slice(2)
      lines = files.get(path) ?? new Set()
      files.set(path, lines)
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      next = Number(hunk[2])
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
    }
  }
  return files
}

/** A finding's stable marker key: its file and its problem statement, not its line (which moves). */
export function findingKey(path, title) {
  return createHash('sha256')
    .update(`${path}\n${String(title).trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * The marker keys on the pull request's existing review comments. Each row is one
 * comment as `{ body, userType, association }`; only a GitHub App (Houston posting with
 * the workflow token or an App token) or a collaborator can mark a finding as posted.
 */
export function postedKeys(rows) {
  const keys = new Set()
  for (const r of rows) {
    if (typeof r?.body !== 'string') continue
    if (r.userType !== 'Bot' && !TRUSTED_ASSOCIATIONS.has(r.association)) continue
    for (const m of r.body.matchAll(MARKER)) keys.add(m[1])
  }
  return keys
}

/** Model text in a comment: an HTML comment opener is escaped so no text can pose as a marker. */
function plain(text) {
  return String(text ?? '').replace(/<!--/g, '&lt;!--').trim()
}

/**
 * The inline comments to post: each finding the verifier kept whose location is a
 * commentable diff line, minus the ones already posted, at most {@link MAX_INLINE_COMMENTS}.
 * `skipped` counts kept findings left out because they were already posted.
 */
export function inlineComments(findings, lines, posted = new Set()) {
  const comments = []
  const seen = new Set()
  let skipped = 0
  for (const f of findings) {
    if (!f || f.status === 'rejected' || f.status === 'merged') continue
    const at = parseLocation(f.location)
    if (!at || !lines.get(at.path)?.has(at.line)) continue
    const key = findingKey(at.path, f.title)
    if (seen.has(key)) continue
    seen.add(key)
    if (posted.has(key)) {
      skipped++
      continue
    }
    if (comments.length >= MAX_INLINE_COMMENTS) continue
    const severity = typeof f.severity === 'string' ? f.severity.toUpperCase() : 'NOTE'
    let text = `**${severity}** ${plain(f.title)}`
    const detail = plain(f.detail)
    if (detail) text += `\n\n${detail}`
    if (text.length > MAX_COMMENT) text = `${text.slice(0, MAX_COMMENT)}\n\n(truncated)`
    comments.push({ path: at.path, line: at.line, side: 'RIGHT', body: `${text}\n\n<!-- houston-finding:${key} -->` })
  }
  return { comments, skipped }
}
