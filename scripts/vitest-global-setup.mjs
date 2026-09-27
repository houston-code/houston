import { generateGuide } from './gen-guide.mjs'
import { generateReleaseHighlights } from './gen-release-highlights.mjs'

/**
 * Runs once before any test file is collected.
 *
 * src/main/agent/guide-content.ts (from docs/houston-guide.md) and
 * src/shared/release-highlights.ts (from CHANGELOG.md) are generated and are
 * not committed, so it has to exist (and be current) before anything imports it.
 * Doing it here rather than in a `pretest` script covers every Vitest entry point
 * — `npm test`, `npm run eval`, `npm run goldens:update`, and a bare `npx vitest`
 * on a single file — none of which run npm's pre-hooks.
 */
export function setup() {
  generateGuide()
  generateReleaseHighlights()
}
