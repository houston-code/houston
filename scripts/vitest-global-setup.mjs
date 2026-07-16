import { generateGuide } from './gen-guide.mjs'

/**
 * Runs once before any test file is collected.
 *
 * src/main/agent/guide-content.ts is generated from docs/houston-guide.md and is
 * not committed, so it has to exist (and be current) before anything imports it.
 * Doing it here rather than in a `pretest` script covers every Vitest entry point
 * — `npm test`, `npm run eval`, `npm run goldens:update`, and a bare `npx vitest`
 * on a single file — none of which run npm's pre-hooks.
 */
export function setup() {
  generateGuide()
}
