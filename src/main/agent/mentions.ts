import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { SKIP_DIRS } from './search'
import { runGitCapture } from './gitRead'

/**
 * Workspace file search for the composer's `@`-mention autocomplete.
 *
 * What it used to be, and why each part was wrong:
 *
 *  - **A blanket dotfile skip.** `.github/workflows/ci.yml` — a file people
 *    genuinely want to hand the agent — was unreachable, and no amount of typing
 *    would surface it.
 *  - **A hardcoded skip list** rather than the project's own .gitignore, so build
 *    output and vendored trees flooded the results in any project whose layout the
 *    list did not anticipate.
 *  - **Files only.** `@src/components` is a perfectly good thing to point at.
 *  - **Substring matching**, so `@tuieditor` found nothing at all.
 *  - **A full walk on every keystroke**, which is what made a big repo feel janky.
 *
 * Now: git decides what is ignored (it is the project's own answer, and free),
 * matching is fuzzy and scored, directories are offered, and the listing is cached
 * for a few seconds so typing costs nothing.
 */

/** Stop scanning once this many paths are collected (the fallback walk only). */
const MAX_CANDIDATES = 4000

/** How long a workspace's listing is reused. Long enough to type a word. */
export const CACHE_TTL_MS = 5000

const cache = new Map<string, { paths: string[]; at: number }>()

/** Drop cached listings (used by tests, and after a workspace changes). */
export function clearMentionCache(): void {
  cache.clear()
}

/**
 * Every path git knows about: tracked plus untracked, minus anything ignored.
 * This is the project's OWN answer to "what counts", which is why it beats any
 * list we could hardcode. Null when this is not a repo.
 */
async function gitListing(workspace: string): Promise<string[] | null> {
  const res = await runGitCapture(['ls-files', '--cached', '--others', '--exclude-standard'], workspace)
  if (!res.ok) return null
  const paths = res.stdout.split('\n').filter(Boolean)
  return paths.length ? paths : null
}

/** Walk the tree ourselves, for a workspace git does not cover. */
async function walkListing(workspace: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_CANDIDATES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_CANDIDATES) return
      // `.git` is noise; other dotfiles are not — this is where `.github` used to
      // disappear.
      if (e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full)
      } else if (e.isFile()) {
        out.push(relative(workspace, full))
      }
    }
  }
  await walk(workspace)
  return out
}

/** The workspace's paths (files + their directories), cached briefly. */
async function listing(workspace: string, now: number): Promise<string[]> {
  const hit = cache.get(workspace)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.paths
  const files = (await gitListing(workspace)) ?? (await walkListing(workspace))
  // Offer directories too: pointing at a folder is a normal thing to want.
  const dirs = new Set<string>()
  for (const p of files) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const all = [...files, ...dirs]
  cache.set(workspace, { paths: all, at: now })
  return all
}

/**
 * Score `path` against a fuzzy `query`, or null when the query's characters do not
 * appear in order. Lower is better.
 *
 * The weights encode what people mean when they type: a run of consecutive
 * characters is a real prefix of a word rather than letters scattered across the
 * path, and a match in the FILENAME is almost always the intent — `@editor` means
 * `tui-editor.ts`, not `src/editor-legacy/very/deep/thing.ts`.
 */
export function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  let from = 0
  let score = 0
  let lastHit = -1
  for (const ch of q) {
    const at = p.indexOf(ch, from)
    if (at === -1) return null // not a subsequence: not a match at all
    if (lastHit >= 0) score += at - lastHit - 1 // gaps cost; adjacency is free
    lastHit = at
    from = at + 1
  }
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (!base.includes(q)) score += 40 // the query isn't in the filename: probably not it
  else if (base.startsWith(q)) score -= 10 // the filename starts with it: probably is
  score += Math.floor(p.length / 20) // mild nudge toward shallower paths
  return score
}

/**
 * Workspace paths matching `query`, best first. `@` with no query lists the
 * shallowest paths, which is a usable start rather than an empty menu.
 */
export async function findFiles(
  workspace: string,
  query: string,
  max = 20,
  now: number = Date.now()
): Promise<string[]> {
  const paths = await listing(workspace, now)
  const scored: { path: string; score: number }[] = []
  for (const p of paths) {
    const score = fuzzyScore(p, query)
    if (score !== null) scored.push({ path: p, score })
  }
  scored.sort(
    (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return scored.slice(0, max).map((s) => s.path)
}
