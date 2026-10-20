#!/usr/bin/env node
// Put one version's section into CHANGELOG.md: replace the `## v<version>` section if it is
// already there, otherwise insert it in version order (newest first). Used by
// release-prepare.yml, where "Update pending release" re-cuts a version whose section may
// already exist on its line, and by release-publish.yml's sync to main, where a patch to an
// older line belongs below newer releases rather than at the top.
//
// Usage: node scripts/changelog-upsert.mjs <version> <section-file> [CHANGELOG.md]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { compareVersions, normalizeVersion } from './release-source.mjs'

const HEADING = /^## v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\s|$)/gm

/** Return `changelog` with `section` (which starts with its `## v<version>` heading) placed. */
export function upsertSection(changelog, section, version) {
  const text = (changelog || '# Changelog\n').replace(/\r\n/g, '\n')
  const body = section.trim() + '\n'
  const headings = [...text.matchAll(HEADING)].map((m) => ({ version: m[1], index: m.index }))

  const own = headings.findIndex((h) => h.version === version)
  if (own !== -1) {
    const end = own + 1 < headings.length ? headings[own + 1].index : text.length
    return (text.slice(0, headings[own].index) + body + (end < text.length ? '\n' + text.slice(end) : '')).trimEnd() + '\n'
  }

  const below = headings.find((h) => compareVersions(h.version, version) < 0)
  if (below) return text.slice(0, below.index) + body + '\n' + text.slice(below.index)
  return text.trimEnd() + '\n\n' + body
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [typed, sectionFile, path = 'CHANGELOG.md'] = process.argv.slice(2)
  const version = normalizeVersion(typed)
  if (!version || !sectionFile) {
    console.error('usage: node scripts/changelog-upsert.mjs <version> <section-file> [CHANGELOG.md]')
    process.exit(2)
  }
  const section = readFileSync(sectionFile, 'utf8')
  if (!new RegExp(`^## v${version.replace(/\./g, '\\.')}(\\s|$)`).test(section.trim())) {
    console.error(`::error::${sectionFile} must start with a "## v${version}" heading.`)
    process.exit(1)
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, upsertSection(existing, section, version))
}
