import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractSection } from './extract-changelog-section.mjs'
import { SENTENCE_BREAK, SUMMARY_MAX } from './check-changelog-summary.mjs'

/**
 * Bundle this version's "What's new" text into the app: the one-sentence summary that
 * opens its CHANGELOG.md section (written by ai-release-notes.mjs in Release - prepare and
 * reviewed in the release PR), into src/shared/release-highlights.ts. The post-update popup
 * shows it, so the popup and the release notes say the same thing and no separate list has
 * to be kept up to date.
 *
 * Only the running version's text is needed: the popup appears once, right after updating
 * to this build. Like guide-content.ts, the output is NOT committed (.gitignore) and is
 * regenerated wherever it's consumed: postinstall, pretypecheck, prelint, build, build:cli,
 * and Vitest's globalSetup.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = resolve(root, 'src/shared/release-highlights.ts')

/**
 * The popup text for a section body: the first sentence of its opening paragraph as plain
 * text, if that fits in SUMMARY_MAX characters. null when there's no usable summary (the
 * fallback placeholder, a section that opens with a heading or list, or an over-long
 * sentence), in which case the popup simply doesn't show.
 */
export function popupSummary(section) {
  const first = (section || '').split(/\n\s*\n/).map((p) => p.trim()).find(Boolean) ?? ''
  if (!first || /^(<!--|#|- |\* |\||>)/.test(first)) return null
  const text = first
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = text.split(SENTENCE_BREAK)[0]
  return sentence.length <= SUMMARY_MAX ? sentence : null
}

/**
 * Regenerate the module. Skips the write when unchanged (this runs on every Vitest start,
 * and a rewrite would retrigger watch mode). `changelogPath`/`packagePath`/`out` are
 * overridable for the generator's own tests.
 */
export function generateReleaseHighlights({
  changelogPath = resolve(root, 'CHANGELOG.md'),
  packagePath = resolve(root, 'package.json'),
  out = outPath,
} = {}) {
  const version = JSON.parse(readFileSync(packagePath, 'utf8')).version
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
  const summary = popupSummary(extractSection(changelog, version))
  const value = summary ? JSON.stringify({ version, summary }, null, 2) : 'null'

  const contents = `// GENERATED FROM CHANGELOG.md — DO NOT EDIT BY HAND, DO NOT COMMIT.
// Regenerated automatically by postinstall / typecheck / lint / build / vitest.
// \`npm run gen:highlights\` does it by hand. See scripts/gen-release-highlights.mjs.

/** This build's "What's new" text: the summary sentence of its CHANGELOG section. */
export const RELEASE_SUMMARY: { version: string; summary: string } | null = ${value}
`
  let existing = null
  try {
    existing = readFileSync(out, 'utf8')
  } catch {
    // Not generated yet (fresh clone): fall through and write it.
  }
  if (existing !== contents) writeFileSync(out, contents)
  return { outPath: out, version, summary, written: existing !== contents }
}

// Run as a CLI (`npm run gen:highlights`), stay quiet when imported by globalSetup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, summary, written } = generateReleaseHighlights()
  console.log(`gen:highlights -> v${version}: ${summary ? JSON.stringify(summary) : '(no summary, popup off)'}${written ? '' : ' (unchanged)'}`)
}
