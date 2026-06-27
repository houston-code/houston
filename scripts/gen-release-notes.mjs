#!/usr/bin/env node
// Generate a draft, user-facing CHANGELOG section for a release from the set of PRs
// merged since the previous release. release-prepare.yml collects merged PRs via `gh`
// and pipes them in as JSON; this turns them into grouped Markdown that a human then
// SHARPENS in the approval PR (the top-line summary + Required steps are deliberately
// left as prompts to fill in — CI can't judge what matters to an end user).
//
// Pure functions (categorize/buildNotes) are exported for unit tests; the CLI wrapper at
// the bottom runs only when invoked directly (scripts/gen-release-notes.test.mjs covers
// the logic without spawning the CLI).

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Conventional-commit type → user-facing section. Types absent from this map (chore,
// docs, test, ci, build, style, etc.) are NOT shown to end users and are dropped — a
// release note is "what changed for you," not the full commit log. A breaking marker
// overrides the type and routes the entry to the Breaking section regardless.
const TYPE_TO_SECTION = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Changed',
  refactor: 'Changed',
  revert: 'Changed'
}

const SECTION_ORDER = ['Breaking', 'Added', 'Fixed', 'Changed']

// Parse a conventional-commit-style PR title into { type, breaking, summary }.
// `type(scope)!: summary` → {type:'feat', breaking:true, summary:'summary'}. A title with
// no recognizable `type:` prefix yields type=null (caller decides how to treat it).
export function parseTitle(title) {
  const m = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/.exec(title.trim())
  if (!m) return { type: null, breaking: false, summary: title.trim() }
  return { type: m[1].toLowerCase(), breaking: Boolean(m[3]), summary: m[4].trim() }
}

// Decide which section a PR belongs in, or null to omit it from user-facing notes.
// `breaking` wins over type. A `breaking` label or a "BREAKING CHANGE" body footer also
// promotes an entry to the Breaking section even when the title has no `!`.
export function categorize(pr) {
  const { type, breaking, summary } = parseTitle(pr.title || '')
  const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase())
  const isBreaking =
    breaking || labels.includes('breaking') || /BREAKING[ -]CHANGE/.test(pr.body || '')
  if (isBreaking) return { section: 'Breaking', summary }
  const section = type ? TYPE_TO_SECTION[type] : null
  return section ? { section, summary } : null
}

function bullet(pr, summary) {
  // Capitalize the first letter; link the PR number so the note is traceable to its diff.
  const text = summary.charAt(0).toUpperCase() + summary.slice(1)
  return pr.number ? `- ${text} (#${pr.number})` : `- ${text}`
}

// Build the full Markdown section for one release. `prs` is the merged-PR list; `version`
// is the tag-less version (e.g. "0.2.0"); `date` is an ISO yyyy-mm-dd string (injected so
// the function stays deterministic under test).
export function buildNotes({ version, date, prs }) {
  const groups = Object.fromEntries(SECTION_ORDER.map((s) => [s, []]))
  for (const pr of prs || []) {
    const cat = categorize(pr)
    if (cat) groups[cat.section].push(bullet(pr, cat.summary))
  }

  const out = [`## v${version} — ${date}`, '']
  out.push('<!-- Replace this line with a 2–3 sentence plain-English summary of the release. -->', '')

  const breaking = groups.Breaking
  out.push('### Breaking changes')
  out.push(breaking.length ? breaking.join('\n') : '_None._')
  out.push('')

  out.push('### Required steps')
  out.push('_None._ <!-- Edit if this release needs a migration or manual step. -->')
  out.push('')

  for (const section of ['Added', 'Fixed', 'Changed']) {
    if (groups[section].length) {
      out.push(`### ${section}`, groups[section].join('\n'), '')
    }
  }

  return out.join('\n').trimEnd() + '\n'
}

// Prepend a freshly built section above any existing CHANGELOG body, keeping a stable
// "# Changelog" H1. Used by the CLI; pure so it's unit-testable.
export function prependToChangelog(existing, section) {
  const header = '# Changelog'
  const body = (existing || '').replace(/^# Changelog\s*\n+/, '').trimStart()
  return `${header}\n\n${section.trimEnd()}\n${body ? '\n' + body : ''}`.trimEnd() + '\n'
}

// CLI: reads merged-PR JSON from stdin, VERSION from env, writes the CHANGELOG section to
// stdout. Runs only when this file is the entrypoint, never on import (tests stay pure).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  const prs = raw ? JSON.parse(raw) : []
  const version = process.env.VERSION
  if (!version) {
    console.error('gen-release-notes: VERSION env is required')
    process.exit(1)
  }
  const date = process.env.RELEASE_DATE || new Date().toISOString().slice(0, 10)
  process.stdout.write(buildNotes({ version, date, prs }))
}
