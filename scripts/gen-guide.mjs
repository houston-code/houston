import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Inline docs/houston-guide.md into a committed TS constant
 * (src/main/agent/guide-content.ts) so the product guide ships compiled into
 * every bundle. The standalone CLI is a single self-contained file with no
 * adjacent files to read at runtime, and the guide flows through two different
 * bundlers (Vite for the app, esbuild for the CLI), so a runtime file read or a
 * bundler-specific `?raw` import won't do — a plain generated constant compiles
 * identically everywhere. JSON.stringify handles the escaping (the guide is full
 * of backticks and `${...}`-looking text), so no hand-escaping is needed.
 *
 * docs/houston-guide.md is the source of truth; this file is generated. A unit
 * test (skills.test.ts) asserts the constant matches the Markdown, so editing the
 * doc without regenerating fails CI. `npm run gen:guide` regenerates; it also runs
 * automatically before `build` and `build:cli`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = resolve(root, 'docs/houston-guide.md')
const outPath = resolve(root, 'src/main/agent/guide-content.ts')

const guide = readFileSync(srcPath, 'utf8').trim()

const contents = `// GENERATED FROM docs/houston-guide.md — DO NOT EDIT BY HAND.
// Regenerate with \`npm run gen:guide\` (runs automatically before build / build:cli).

/**
 * Houston's own product guide, inlined from docs/houston-guide.md. Served as the
 * built-in \`houston-guide\` skill so the agent can answer questions about
 * Houston's own features. See scripts/gen-guide.mjs.
 */
export const HOUSTON_GUIDE = ${JSON.stringify(guide)}
`

writeFileSync(outPath, contents)
console.log(`gen:guide -> ${outPath} (${guide.length} chars)`)
