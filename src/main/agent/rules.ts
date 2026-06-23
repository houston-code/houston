import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { SKIP_DIRS } from './search'

/**
 * Project-level agent instructions. Many repos ship an `AGENTS.md` (the emerging
 * cross-tool standard) or a `CLAUDE.md` describing conventions, build/test
 * commands, and house rules. Loading them into the system prompt lets the agent
 * follow a project's conventions without the user re-explaining them every time.
 *
 * Houston assembles a small hierarchy, lowest precedence first:
 *   1. Global user rules at `~/.claude/CLAUDE.md` (apply to every project).
 *   2. Project rules: `AGENTS.md` then `CLAUDE.md` at the workspace root.
 *   3. Nested rules: `AGENTS.md`/`CLAUDE.md` discovered in subdirectories
 *      (shallowest first), so per-package conventions in a monorepo are picked
 *      up without being explicitly imported.
 *
 * Any loaded file may also pull in other files with `@path` imports (relative to
 * the importing file, `~/…` for home, or absolute) — the same mechanism Claude
 * Code uses to split a large memory file. Imports are expanded recursively with a
 * depth cap and cycle protection.
 */

/** Filenames read from each directory, in precedence order. */
export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Cap the combined rules text so a huge file can't crowd out the context window. */
export const MAX_RULES_CHARS = 32_000

/** Maximum @import nesting depth (matches Claude Code). */
export const MAX_IMPORT_DEPTH = 5

/** How deep below the workspace root to look for nested rules files. */
export const MAX_NESTED_DEPTH = 4

/** Cap how many nested rules files we discover, so a huge monorepo can't explode. */
export const MAX_NESTED_RULES_FILES = 25

export interface ProjectRules {
  /** Combined, section-headed rules text (empty when no rules files exist). */
  text: string
  /** The rule sources that were actually loaded (labels, in order). */
  files: string[]
}

export interface LoadRulesOptions {
  /** Directory holding the global user rules file (default `~/.claude`). */
  globalDir?: string
  /** Home directory used to resolve `~/…` in @imports (default `os.homedir()`). */
  home?: string
  /** Max subdirectory depth to scan for nested rules (default MAX_NESTED_DEPTH; 0 disables). */
  maxNestedDepth?: number
  /** Max number of nested rules files to load (default MAX_NESTED_RULES_FILES). */
  maxNestedFiles?: number
}

/**
 * Walk the workspace subtree for nested `AGENTS.md`/`CLAUDE.md` files (excluding
 * the root, which is loaded separately). Skips dotdirs and build/vendor dirs,
 * and is bounded by depth and count. Returns `{ path, label }` sorted shallowest
 * first then alphabetically, so deeper (more specific) rules land later — and
 * thus at higher precedence — in the assembled output.
 */
async function discoverNestedRules(
  workspace: string,
  maxDepth: number,
  maxFiles: number
): Promise<{ path: string; label: string }[]> {
  const found: { path: string; label: string; depth: number }[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= maxFiles) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (dir !== workspace) {
      for (const name of RULES_FILES) {
        if (found.length >= maxFiles) break
        if (entries.some((e) => e.isFile() && e.name === name)) {
          const path = join(dir, name)
          found.push({ path, label: relative(workspace, path), depth })
        }
      }
    }
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (found.length >= maxFiles) break
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
        await walk(join(dir, e.name), depth + 1)
      }
    }
  }

  await walk(workspace, 0)
  found.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label))
  return found.map(({ path, label }) => ({ path, label }))
}

/** Resolve an @import spec against the importing file's directory; `~` is home. */
function resolveImport(spec: string, baseDir: string, home: string): string {
  if (spec === '~') return home
  if (spec.startsWith('~/')) return join(home, spec.slice(2))
  if (isAbsolute(spec)) return spec
  return resolve(baseDir, spec)
}

// A candidate @import: "@" at line start or after whitespace, followed by a
// path-like token (contains a "/" or starts with "~"). This skips bare mentions
// like "@param" or an "@scope/pkg" that doesn't resolve to a file (the read
// simply fails and the token is left untouched). Trailing punctuation is trimmed
// before resolving so "see @./notes.md." still works.
const IMPORT_RE = /(^|\s)@([^\s`]*\/[^\s`]*|~[^\s`]*)/g

/** Expand @import tokens in `text`, recursively. Missing/oversized/cyclic imports are skipped. */
async function expandImports(
  text: string,
  baseDir: string,
  home: string,
  visited: Set<string>,
  depth: number
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return text
  const lines = text.split('\n')
  let inFence = false
  const out: string[] = []

  for (const line of lines) {
    // Don't treat @paths inside fenced code blocks as imports.
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || !line.includes('@')) {
      out.push(line)
      continue
    }

    let result = ''
    let lastIndex = 0
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const [full, lead, rawSpec] = m
      const trimmed = rawSpec.replace(/[.,;:!?)\]}]+$/, '')
      if (!trimmed) continue
      const abs = resolveImport(trimmed, baseDir, home)
      if (visited.has(abs)) continue
      let content: string | null = null
      try {
        content = await fs.readFile(abs, 'utf8')
      } catch {
        content = null // missing/unreadable — leave the token as written
      }
      if (content === null) continue
      visited.add(abs)
      const expanded = await expandImports(content.trim(), dirname(abs), home, visited, depth + 1)
      result += line.slice(lastIndex, m.index) + lead + expanded + rawSpec.slice(trimmed.length)
      lastIndex = m.index + full.length
    }
    result += line.slice(lastIndex)
    out.push(result)
  }

  return out.join('\n')
}

/**
 * Read one rules file, expand its @imports, and return a section-headed block
 * (or null if missing/empty). `visited` prevents a file importing itself and
 * dedupes across files.
 */
async function loadOne(
  path: string,
  label: string,
  home: string,
  visited: Set<string>
): Promise<string | null> {
  let raw: string
  try {
    raw = (await fs.readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
  if (!raw) return null
  visited.add(resolve(path)) // a file can't import itself
  const expanded = await expandImports(raw, dirname(path), home, visited, 1)
  return `### ${label}\n${expanded.trim()}`
}

/**
 * Assemble the rules hierarchy (global → workspace root → nested subdirectories)
 * with @imports expanded, capped to MAX_RULES_CHARS. Nested AGENTS.md/CLAUDE.md
 * are auto-discovered below the root (bounded by depth and count). Never throws.
 */
export async function loadProjectRules(
  workspace: string,
  opts: LoadRulesOptions = {}
): Promise<ProjectRules> {
  const home = opts.home ?? homedir()
  const globalDir = opts.globalDir ?? join(home, '.claude')
  const maxNestedDepth = opts.maxNestedDepth ?? MAX_NESTED_DEPTH
  const maxNestedFiles = opts.maxNestedFiles ?? MAX_NESTED_RULES_FILES
  const visited = new Set<string>()
  const parts: string[] = []
  const files: string[] = []

  const nested =
    maxNestedDepth > 0 ? await discoverNestedRules(workspace, maxNestedDepth, maxNestedFiles) : []

  const sources: { path: string; label: string }[] = [
    { path: join(globalDir, 'CLAUDE.md'), label: '~/.claude/CLAUDE.md (global)' },
    ...RULES_FILES.map((name) => ({ path: join(workspace, name), label: name })),
    ...nested
  ]

  for (const { path, label } of sources) {
    const block = await loadOne(path, label, home, visited)
    if (block) {
      parts.push(block)
      files.push(label)
    }
  }

  let text = parts.join('\n\n')
  if (text.length > MAX_RULES_CHARS) {
    text = `${text.slice(0, MAX_RULES_CHARS)}\n[truncated]`
  }
  return { text, files }
}
