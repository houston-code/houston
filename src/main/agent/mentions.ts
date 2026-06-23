import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { SKIP_DIRS } from './search'

/**
 * Workspace file search for the composer's `@`-mention autocomplete. Walks the
 * project (skipping the same dirs as glob/search and dotfiles), substring-matches
 * the query against the relative path, and returns the best matches. Bounded so a
 * huge repo can't make typing janky.
 */

/** Stop scanning once this many candidate matches are collected. */
const MAX_CANDIDATES = 400

export async function findFiles(workspace: string, query: string, max = 20): Promise<string[]> {
  const q = query.toLowerCase()
  const matches: string[] = []

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_CANDIDATES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (matches.length >= MAX_CANDIDATES) return
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full)
      } else if (e.isFile()) {
        const rel = relative(workspace, full)
        if (!q || rel.toLowerCase().includes(q)) matches.push(rel)
      }
    }
  }

  await walk(workspace)

  // Rank: basename matches before mid-path matches, then shorter paths, then
  // alphabetical — so the most likely file surfaces first.
  matches.sort((a, b) => {
    const aBase = a.slice(a.lastIndexOf('/') + 1).toLowerCase().includes(q) ? 0 : 1
    const bBase = b.slice(b.lastIndexOf('/') + 1).toLowerCase().includes(q) ? 0 : 1
    if (aBase !== bBase) return aBase - bBase
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })
  return matches.slice(0, max)
}
