import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Inline docs/houston-guide.md into a TS constant (src/main/agent/guide-content.ts)
 * so the product guide ships compiled into every bundle. The standalone CLI is a
 * single self-contained file with no adjacent files to read at runtime, and the
 * guide flows through two different bundlers (Vite for the app, esbuild for the
 * CLI), so a runtime file read or a bundler-specific `?raw` import won't do — a
 * plain generated constant compiles identically everywhere. JSON.stringify handles
 * the escaping (the guide is full of backticks and `${...}`-looking text), so no
 * hand-escaping is needed.
 *
 * docs/houston-guide.md is the source of truth. The generated constant is NOT
 * committed (.gitignore) and is regenerated at every point that consumes it:
 * `postinstall`, `pretypecheck`, `prelint`, `build`, `build:cli`, and Vitest's
 * globalSetup. It used to be committed, and because the whole guide lands on one
 * ~37KB line, any two concurrent PRs that touched the guide conflicted there
 * every time — a conflict with no hunk granularity, where picking a side silently
 * drops the other PR's docs. Generating on demand makes both the conflict and the
 * staleness it was guarding against impossible. Keep it out of git.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = resolve(root, 'docs/houston-guide.md')
const outPath = resolve(root, 'src/main/agent/guide-content.ts')

/**
 * Regenerate src/main/agent/guide-content.ts from docs/houston-guide.md.
 *
 * The write is skipped when the content is unchanged: this runs on every Vitest
 * start, and rewriting an identical file would bump its mtime, retriggering watch
 * mode in a loop. Returns whether the file was actually written.
 *
 * `src`/`out` default to the real paths and are overridden only by gen-guide's own
 * tests, which must not mutate the real generated file — other test files import it
 * concurrently, and clobbering it mid-run would flake them.
 */
export function generateGuide({ src = srcPath, out = outPath } = {}) {
  const guide = readFileSync(src, 'utf8').trim()

  const contents = `// GENERATED FROM docs/houston-guide.md — DO NOT EDIT BY HAND, DO NOT COMMIT.
// Regenerated automatically by postinstall / typecheck / lint / build / vitest.
// \`npm run gen:guide\` does it by hand. See scripts/gen-guide.mjs.

/**
 * Houston's own product guide, inlined from docs/houston-guide.md. Served as the
 * built-in \`houston-guide\` skill so the agent can answer questions about
 * Houston's own features. See scripts/gen-guide.mjs.
 */
export const HOUSTON_GUIDE = ${JSON.stringify(guide)}
`

  let existing = null
  try {
    existing = readFileSync(out, 'utf8')
  } catch {
    // Not generated yet (fresh clone) — fall through and write it.
  }
  if (existing === contents) return { outPath: out, length: guide.length, written: false }

  writeFileSync(out, contents)
  return { outPath: out, length: guide.length, written: true }
}

// Run as a CLI (`npm run gen:guide`), stay quiet when imported by globalSetup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { length, written } = generateGuide()
  console.log(`gen:guide -> ${outPath} (${length} chars${written ? '' : ', unchanged'})`)
}
