#!/usr/bin/env node
// Pull a single version's section out of CHANGELOG.md — the text under `## v<version>`
// up to (but not including) the next `## v` heading or EOF. release-publish.yml uses this
// as the GitHub Release body. Kept as a tested script rather than an inline `node -e`
// because the regex escaping is too easy to get wrong through layers of shell quoting.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Return the body of the `## v<version>` section (heading excluded), trimmed. Empty string
// if that version isn't found. Implemented by slicing on heading boundaries rather than one
// multiline regex: a `$` under the `m` flag matches at every blank line, which would
// truncate the body to nothing. The `(?:\s|$)` after the version is a boundary so `0.2.0`
// can't match a heading like `## v0.2.01`.
export function extractSection(changelog, version) {
  const text = changelog || ''
  const escaped = version.replace(/\./g, '\\.')
  const heading = new RegExp(`^## v${escaped}(?:\\s|$)`, 'm').exec(text)
  if (!heading) return ''
  const bodyStart = text.indexOf('\n', heading.index)
  if (bodyStart === -1) return ''
  const rest = text.slice(bodyStart + 1)
  const next = rest.search(/\n## v/)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const version = process.env.VERSION
  if (!version) {
    console.error('extract-changelog-section: VERSION env is required')
    process.exit(1)
  }
  const path = process.argv[2] || 'CHANGELOG.md'
  const changelog = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const section = extractSection(changelog, version)
  // Fall back to a minimal body so a release never ships with empty notes.
  process.stdout.write((section || `Release v${version}`) + '\n')
}
