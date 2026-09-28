#!/usr/bin/env node
// Check that a CHANGELOG section opens with ONE short summary sentence.
//
// The opening line of a release's notes is what people see first: it heads "What's
// changed" on the GitHub Release, and the terminal client shows it as the headline of its
// update notice (src/main/update-check.ts: first sentence, capped at 120 characters). So
// each section must start with a paragraph that is a single sentence of at most 120
// characters, summarizing the whole release. Longer context can follow as a second
// paragraph.
//
// ai-release-notes.mjs writes that sentence and uses this check to ask the model for a fix
// when its draft misses; release-prepare.yml runs it again as a warning. Whether the sentence
// is crisp and representative is for the reviewer of the release PR, which is where the
// notes are finalized; nothing here blocks a merge.
//
//   node scripts/check-changelog-summary.mjs <version> [CHANGELOG.md]
//
// The pure `summaryProblems(section)` is unit-tested.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { extractSection } from './extract-changelog-section.mjs'

export const SUMMARY_MAX = 120

// Same sentence boundary the update notice uses (src/main/update-check.ts shortenHeadline):
// . ! or ? followed by whitespace and a capital, digit or quote. Keep the two in sync.
export const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/

/**
 * Problems with a section body's opening summary (the text under `## v<version>`), as
 * human-readable strings; empty when it passes.
 */
export function summaryProblems(section) {
  const paragraphs = (section || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const first = paragraphs[0] ?? ''
  if (!first) return ['the section is empty: it must open with a one-sentence summary']
  if (first.startsWith('<!--')) return ['the summary is still the placeholder comment: replace it with one sentence']
  if (/^(#|- |\* |\||>)/.test(first)) {
    return ['the section must open with a one-sentence summary paragraph, before any heading, list or table']
  }

  const text = first.replace(/\s+/g, ' ')
  const problems = []
  const sentences = text.split(SENTENCE_BREAK)
  if (sentences.length > 1) {
    problems.push(
      `the opening paragraph has ${sentences.length} sentences: make it one summary sentence and move the rest to a second paragraph`,
    )
  }
  if (!/[.!?]$/.test(text)) problems.push('the summary must be a complete sentence ending in . ! or ?')
  if (sentences[0].length > SUMMARY_MAX) {
    problems.push(`the summary sentence is ${sentences[0].length} characters: keep it to ${SUMMARY_MAX} or fewer`)
  }
  return problems
}

/** Problems for the `version` section of a CHANGELOG. */
export function changelogProblems(changelog, version) {
  const section = extractSection(changelog, version)
  if (!section) return [`CHANGELOG.md has no "## v${version}" section`]
  return summaryProblems(section)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [version, path = 'CHANGELOG.md'] = process.argv.slice(2)
  if (!version) {
    console.error('usage: node scripts/check-changelog-summary.mjs <version> [CHANGELOG.md]')
    process.exit(2)
  }
  const problems = changelogProblems(existsSync(path) ? readFileSync(path, 'utf8') : '', version)
  for (const p of problems) console.error(`::error file=${path}::v${version} summary: ${p}`)
  if (problems.length) process.exit(1)
  console.log(`v${version} opens with a one-sentence summary of at most ${SUMMARY_MAX} characters.`)
}
