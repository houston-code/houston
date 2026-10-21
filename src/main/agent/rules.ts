import { promises as fs, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKIP_DIRS } from './search'

/**
 * Project-level agent instructions. Many repos ship an `AGENTS.md` (the emerging
 * cross-tool standard) or a `CLAUDE.md` describing conventions, build/test
 * commands, and house rules. Loading them into the system prompt lets the agent
 * follow a project's conventions without the user re-explaining them every time.
 *
 * Houston assembles a small hierarchy, lowest precedence first:
 *   1. Global user rules at `~/.houston/AGENTS.md` (apply to every project).
 *      Houston's own file: a rules file another tool keeps under its own home
 *      directory is written for that tool, so it is never loaded implicitly.
 *      Anyone who wants one shared can `@import` it from here (see
 *      ../globalRules.ts, which offers exactly that once).
 *   2. Project rules: `AGENTS.md` then `CLAUDE.md` at the workspace root.
 *   3. Nested rules: `AGENTS.md`/`CLAUDE.md` discovered in subdirectories
 *      (shallowest first), so per-package conventions in a monorepo are picked
 *      up without being explicitly imported.
 *
 * Any loaded file may also pull in other files with `@path` imports (relative to
 * the importing file, `~/…` for home, or absolute) — a way to split a large
 * rules file into shared pieces. Imports are expanded recursively with a
 * depth cap and cycle protection.
 */

/** Filenames read from each directory, in precedence order. */
export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Houston's per-user directory under the home dir, holding the global rules file. */
export const GLOBAL_RULES_DIRNAME = '.houston'

/** The global rules filename inside {@link GLOBAL_RULES_DIRNAME}. */
export const GLOBAL_RULES_FILE = 'AGENTS.md'

/** How the global rules file is labeled in the prompt and in `files`. */
export const GLOBAL_RULES_LABEL = `~/${GLOBAL_RULES_DIRNAME}/${GLOBAL_RULES_FILE} (global)`

/** Cap the combined rules text so a huge file can't crowd out the context window. */
export const MAX_RULES_CHARS = 32_000

/** Maximum @import nesting depth. */
export const MAX_IMPORT_DEPTH = 5

/** How deep below the workspace root to look for nested rules files. */
export const MAX_NESTED_DEPTH = 4

/** Cap how many nested rules files we discover, so a huge monorepo can't explode. */
export const MAX_NESTED_RULES_FILES = 25

export interface ProjectRules {
  /** Combined, section-headed rules text (empty when no rules files exist). */
  text: string
  /** The rule sources whose text made it into `text`, in whole or in part (labels, in order). */
  files: string[]
  /** Sources shortened or dropped to fit MAX_RULES_CHARS (labels, in order). Empty when all fit. */
  truncated: string[]
}

export interface LoadRulesOptions {
  /** Directory holding the global user rules file (default `~/.houston`). */
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

/** Canonical path of an existing file, or null when it can't be resolved. */
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Whether `abs` (canonical) is `root` itself or lives inside it. */
function isWithinRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * For a confined (workspace-sourced) import chain, whether `abs` is allowed: its
 * canonical path must stay inside `confineRoot`. A workspace `AGENTS.md`/`CLAUDE.md`
 * is attacker-controlled when an untrusted repo is opened, and its expanded text
 * goes straight into the system prompt sent to the model — so a `@~/.ssh/id_rsa`,
 * `@/etc/passwd`, `@../../secret`, or a symlink pointing out of the tree must NOT
 * be readable, or opening a repo would exfiltrate host files. realpath defeats
 * symlink escapes. `confineRoot === null` means a trusted source (the global
 * ~/.houston/AGENTS.md), which may import from anywhere.
 */
function importAllowed(abs: string, confineRoot: string | null): boolean {
  if (confineRoot === null) return true
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return false // missing/unreadable — nothing to import anyway
  }
  return isWithinRoot(confineRoot, real)
}

// A candidate @import: "@" at line start or after whitespace, followed by a
// path-like token (contains a "/" or starts with "~"). This skips bare mentions
// like "@param" or an "@scope/pkg" that doesn't resolve to a file (the read
// simply fails and the token is left untouched). Trailing punctuation is trimmed
// before resolving so "see @./notes.md." still works.
const IMPORT_RE = /(^|\s)@([^\s`]*\/[^\s`]*|~[^\s`]*)/g

/** Trim the trailing punctuation an import token may carry ("see @./notes.md."). */
function trimSpec(rawSpec: string): string {
  return rawSpec.replace(/[.,;:!?)\]}]+$/, '')
}

/**
 * Make any @import tokens in `text` inert by wrapping each in inline code, so the
 * text reads the same but the loader leaves it alone (an `@` right after a backtick
 * isn't an import). Used for `#` notes: a note that merely MENTIONS a path, like
 * "keys live in @~/.aws/credentials", must not pull that file into every prompt,
 * least of all from the trusted global file, whose imports are unconfined.
 */
export function neutralizeImports(text: string): string {
  return text.replace(IMPORT_RE, (_full, lead: string, spec: string) => `${lead}\`@${spec}\``)
}

/**
 * The absolute paths `text`'s own @imports point at (not transitively), skipping
 * fenced code exactly as the expander does. Used to ask "does this file already
 * import X?" without loading anything.
 */
export function importTargets(text: string, baseDir: string, home: string): string[] {
  const targets: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.includes('@')) continue
    for (const m of line.matchAll(IMPORT_RE)) {
      const spec = trimSpec(m[2])
      if (spec) targets.push(resolveImport(spec, baseDir, home))
    }
  }
  return targets
}

/**
 * Expand @import tokens in `text`, recursively. Missing/oversized/cyclic imports
 * are skipped — as are imports that escape `confineRoot` (when set), so a
 * workspace rules file can't pull in host files. `confineRoot === null` (the
 * trusted global file) imposes no path confinement.
 */
async function expandImports(
  text: string,
  baseDir: string,
  home: string,
  visited: Set<string>,
  depth: number,
  confineRoot: string | null
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
      const trimmed = trimSpec(rawSpec)
      if (!trimmed) continue
      const abs = resolveImport(trimmed, baseDir, home)
      if (visited.has(abs)) continue
      // Confine workspace-sourced imports to the workspace; a trusted global file
      // (confineRoot === null) is unrestricted.
      if (!importAllowed(abs, confineRoot)) continue
      let content: string | null
      try {
        content = await fs.readFile(abs, 'utf8')
      } catch {
        content = null // missing/unreadable — leave the token as written
      }
      if (content === null) continue
      visited.add(abs)
      const expanded = await expandImports(content.trim(), dirname(abs), home, visited, depth + 1, confineRoot)
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
  visited: Set<string>,
  confineRoot: string | null
): Promise<string | null> {
  // The rules file itself is held to the same confinement as its imports: a workspace
  // AGENTS.md that is a symlink out of the tree (`AGENTS.md -> ~/.ssh/id_rsa`) would
  // otherwise put that file in the system prompt. A symlink within the tree
  // (`CLAUDE.md -> AGENTS.md`) still resolves inside it and loads.
  if (!importAllowed(path, confineRoot)) return null
  let raw: string
  try {
    raw = (await fs.readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
  if (!raw) return null
  visited.add(resolve(path)) // a file can't import itself
  const expanded = await expandImports(raw, dirname(path), home, visited, 1, confineRoot)
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
  const globalDir = opts.globalDir ?? join(home, GLOBAL_RULES_DIRNAME)
  const maxNestedDepth = opts.maxNestedDepth ?? MAX_NESTED_DEPTH
  const maxNestedFiles = opts.maxNestedFiles ?? MAX_NESTED_RULES_FILES
  const visited = new Set<string>()
  const parts: string[] = []
  const files: string[] = []

  const nested =
    maxNestedDepth > 0 ? await discoverNestedRules(workspace, maxNestedDepth, maxNestedFiles) : []

  // Canonical workspace root used to confine workspace-sourced @imports. Only the
  // global ~/.houston/AGENTS.md is trusted to import from outside the workspace
  // (confineRoot null); project + nested files are attacker-controlled in an
  // untrusted repo and may import only files inside the tree.
  let confineRoot = workspace
  try {
    confineRoot = realpathSync(workspace)
  } catch {
    // workspace missing/unreadable — keep the raw path; imports will resolve nothing
  }

  const sources: { path: string; label: string; confineRoot: string | null }[] = [
    { path: join(globalDir, GLOBAL_RULES_FILE), label: GLOBAL_RULES_LABEL, confineRoot: null },
    ...RULES_FILES.map((name) => ({ path: join(workspace, name), label: name, confineRoot })),
    ...nested.map((n) => ({ ...n, confineRoot }))
  ]

  // The same rules reached twice (a `CLAUDE.md` symlinked to `AGENTS.md`, or kept as
  // an identical copy, a common way to serve several tools) load once: a second copy
  // only spends the budget and states every rule twice. The first, lowest-precedence
  // copy is kept; with identical text nothing is lost by dropping the later one.
  const loadedReal = new Set<string>()
  const loadedBodies = new Set<string>()
  for (const { path, label, confineRoot: cr } of sources) {
    const real = realpathOrNull(path)
    if (real !== null && loadedReal.has(real)) continue
    const block = await loadOne(path, label, home, visited, cr)
    if (block) {
      const body = block.slice(block.indexOf('\n') + 1)
      if (loadedBodies.has(body)) continue
      loadedBodies.add(body)
      if (real !== null) loadedReal.add(real)
      parts.push(block)
      files.push(label)
    }
  }

  return fitRules(
    parts.map((block, i) => ({ label: files[i], block })),
    MAX_RULES_CHARS
  )
}

const RULES_SEP = '\n\n'
const TRUNCATED_MARK = '\n[truncated]'
/** Shortest useful slice of a shrunk global block; below this it's dropped instead. */
const MIN_GLOBAL_KEEP = 200

/**
 * Fit the loaded rule blocks (lowest precedence first) into `cap` characters.
 *
 * The global block gives way first: it is the least specific, and a long personal
 * file (one that grows with every "Everywhere" note) must not push the project's
 * own rules out of the prompt. It is shortened, or dropped when too little of it
 * would be left. If the project and nested rules alone still don't fit, the tail is
 * cut as before. `files` names only what made it in; `truncated` names what was
 * shortened or dropped, so a caller can tell the user. Exported for tests.
 */
export function fitRules(
  parts: Array<{ label: string; block: string }>,
  cap: number
): ProjectRules {
  const size = (ps: typeof parts): number =>
    ps.reduce((n, p) => n + p.block.length, 0) + RULES_SEP.length * Math.max(0, ps.length - 1)
  let kept = parts.slice()
  const truncated: string[] = []
  if (size(kept) > cap && kept.length > 1 && kept[0].label === GLOBAL_RULES_LABEL) {
    const over = size(kept) - cap
    const room = kept[0].block.length - over - TRUNCATED_MARK.length
    truncated.push(kept[0].label)
    kept =
      room >= MIN_GLOBAL_KEEP
        ? [{ ...kept[0], block: kept[0].block.slice(0, room) + TRUNCATED_MARK }, ...kept.slice(1)]
        : kept.slice(1)
  }
  if (size(kept) > cap) {
    const fitted: typeof parts = []
    let used = 0
    for (const p of kept) {
      const sep = fitted.length ? RULES_SEP.length : 0
      if (used + sep + p.block.length <= cap) {
        fitted.push(p)
        used += sep + p.block.length
        continue
      }
      const room = cap - used - sep
      if (room > 0) fitted.push({ ...p, block: p.block.slice(0, room) + TRUNCATED_MARK })
      for (const rest of kept.slice(kept.indexOf(p))) {
        if (!truncated.includes(rest.label)) truncated.push(rest.label)
      }
      break
    }
    kept = fitted
  }
  const cut = parts.map((p) => p.label).filter((l) => truncated.includes(l))
  let text = kept.map((p) => p.block).join(RULES_SEP)
  // Say what's missing, so the model knows its instructions are incomplete rather
  // than silently working from a partial set.
  if (cut.length) text += `${RULES_SEP}[Rules over the ${cap}-character limit; shortened or left out: ${cut.join(', ')}]`
  return { text, files: kept.map((p) => p.label), truncated: cut }
}
