/**
 * What the engine imports from the agent host (src/main/agentHost.ts), read from source.
 *
 * evals.eval.ts replaces agentHost with a vi.mock factory, and that factory must define
 * every name the engine imports from it: a missing one is no compile error, only a throw
 * at the call site the first time a run reaches it. The suite holds the factory to what
 * this reads. It reads files and nothing else, so it is unit-tested on its own
 * (hostImports.test.ts).
 *
 * A reader of the forms an import takes, not a parser: static imports over any number of
 * lines, `type` imports and specifiers, `as` aliases, default and namespace imports,
 * re-exports and `await import()`. Every other reference to the host is reported as
 * unreadable, so a form it doesn't know fails the check instead of slipping past it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** One module's imports from the host. */
export interface HostImport {
  /** The importing file, relative to the scan root, with forward slashes. */
  file: string
  /**
   * The host exports the module reads at run time, in source order. Type-only imports are
   * left out: the compiler erases them, so the module never asks the mock for them.
   */
  names: string[]
  /** Lines (1-based) that reference the host in a form this reader can't take names from. */
  unreadable: number[]
}

const ID = '[A-Za-z_$][\\w$]*'
/** `import [type] <clause> from '<spec>'`, the clause over any number of lines. A clause holds no quote or semicolon. */
const STATIC_IMPORT = new RegExp(`^[ \\t]*import\\s+(type\\s+)?([^'";]*?)\\s*from\\s*(['"])([^'"\\n]+)\\3`, 'gm')
/** `export [type] { ... } from '<spec>'` and `export * [as ns] from '<spec>'`. */
const RE_EXPORT = new RegExp(
  `^[ \\t]*export\\s+(type\\s+)?(\\{[^}]*\\}|\\*(?:\\s+as\\s+${ID})?)\\s*from\\s*(['"])([^'"\\n]+)\\3`,
  'gm'
)
/** `import '<spec>'`, which binds nothing. */
const BARE_IMPORT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm
/** `const { ... } = await import('<spec>')` and `const ns = await import('<spec>')`. */
const DYNAMIC_IMPORT = new RegExp(
  `\\b(?:const|let|var)\\s+(\\{[^}]*\\}|${ID})\\s*=\\s*await\\s+import\\(\\s*(['"])([^'"\\n]+)\\2\\s*\\)`,
  'g'
)
/** Any quoted relative specifier. One naming the host that none of the forms above read is unreadable. */
const RELATIVE_SPECIFIER = /(['"`])(\.{1,2}\/[\w$@./-]*)\1/g
/** A static import's clause: a default binding, then braces or a namespace, each optional. */
const IMPORT_CLAUSE = new RegExp(`^(?:(${ID})\\s*,?\\s*)?(?:\\{([^}]*)\\}|\\*\\s*as\\s+(${ID}))?$`)
/** One specifier in braces: `name` or `name as alias`, either one after `type` (type-only). */
const BRACED = new RegExp(`^(type\\s+)?(${ID})(?:\\s+as\\s+${ID})?$`)
/** One property of a destructured `await import()`: `name` or `name: alias`. */
const DESTRUCTURED = new RegExp(`^(${ID})(?:\\s*:\\s*${ID})?$`)

/** The 1-based line `index` falls on. */
function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/** Whether the text before `index` on its line opens a comment (`//`, `/*`, or a block comment's `*`). */
function onCommentLine(source: string, index: number): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(source.slice(source.lastIndexOf('\n', index - 1) + 1, index))
}

/** An import clause or brace list without its comments. Neither holds a string, so this can't cut one. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** The comma-separated entries of a brace list, comments and blanks dropped. */
function entries(list: string): string[] {
  return stripComments(list)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Read one module's imports from the host. `isHost` says whether a specifier, as written
 * in this module, names the host.
 */
export function readHostImports(source: string, isHost: (specifier: string) => boolean): Omit<HostImport, 'file'> {
  const names: string[] = []
  const unreadable: number[] = []
  /** The opening quote of every host specifier a form above read. */
  const read = new Set<number>()
  /** Namespace bindings, each with the span of the statement that declared it. */
  const namespaces: Array<{ name: string; from: number; to: number }> = []

  // Marks the statement's specifier read, and returns the line it is on.
  const take = (m: RegExpExecArray, quote: string, spec: string): number => {
    const at = m.index + m[0].lastIndexOf(`${quote}${spec}${quote}`)
    read.add(at)
    return lineAt(source, at)
  }
  const braced = (list: string, line: number): void => {
    for (const entry of entries(list)) {
      const m = BRACED.exec(entry)
      if (!m) unreadable.push(line)
      else if (!m[1]) names.push(m[2])
    }
  }

  for (const m of source.matchAll(STATIC_IMPORT)) {
    const [, typeOnly, clause, quote, spec] = m
    if (!isHost(spec)) continue
    const line = take(m, quote, spec)
    if (typeOnly) continue
    const parts = IMPORT_CLAUSE.exec(stripComments(clause).trim())
    if (!parts || !(parts[1] || parts[2] !== undefined || parts[3])) {
      unreadable.push(line)
      continue
    }
    if (parts[1]) names.push('default')
    if (parts[2] !== undefined) braced(parts[2], line)
    if (parts[3]) namespaces.push({ name: parts[3], from: m.index, to: m.index + m[0].length })
  }
  for (const m of source.matchAll(RE_EXPORT)) {
    const [, typeOnly, clause, quote, spec] = m
    if (!isHost(spec)) continue
    const line = take(m, quote, spec)
    if (typeOnly) continue
    // `export *` passes on whatever the host has, which says nothing about what is used.
    if (clause.startsWith('*')) unreadable.push(line)
    else braced(clause.slice(1, -1), line)
  }
  for (const m of source.matchAll(BARE_IMPORT)) {
    if (isHost(m[2])) take(m, m[1], m[2])
  }
  for (const m of source.matchAll(DYNAMIC_IMPORT)) {
    const [, binding, quote, spec] = m
    if (!isHost(spec)) continue
    const line = take(m, quote, spec)
    if (!binding.startsWith('{')) {
      namespaces.push({ name: binding, from: m.index, to: m.index + m[0].length })
      continue
    }
    for (const entry of entries(binding.slice(1, -1))) {
      const p = DESTRUCTURED.exec(entry)
      if (p) names.push(p[1])
      else unreadable.push(line)
    }
  }
  // A namespace is read through its members (`host.getKey`). Anything else done with it
  // (passing it on, indexing it, spreading it) could reach any export, so it can't be read.
  for (const ns of namespaces) {
    const use = new RegExp(`(?<![\\w$.])${ns.name.replace(/\$/g, '\\$')}(?![\\w$])(?:\\s*\\??\\.\\s*(${ID}))?`, 'g')
    for (const m of source.matchAll(use)) {
      if ((m.index >= ns.from && m.index < ns.to) || onCommentLine(source, m.index)) continue
      if (m[1]) names.push(m[1])
      else unreadable.push(lineAt(source, m.index))
    }
  }
  for (const m of source.matchAll(RELATIVE_SPECIFIER)) {
    if (isHost(m[2]) && !read.has(m.index) && !onCommentLine(source, m.index)) unreadable.push(lineAt(source, m.index))
  }
  return { names: [...new Set(names)], unreadable: [...new Set(unreadable)].sort((a, b) => a - b) }
}

/** A module path without its extension, so `./agentHost` and `./agentHost.js` name the same file. */
function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, '')
}

/**
 * Every module under `dirs` (relative to `root`, searched recursively) that binds
 * something from `hostFile` or references it unreadably, sorted by file. Tests
 * (`*.test.ts`), evals (`*.eval.ts`) and declaration files are left out: none is engine
 * code, and a test's own mock of the host is not an import of it.
 */
export function scanHostImports(root: string, dirs: string[], hostFile: string): HostImport[] {
  const host = withoutExtension(resolve(hostFile))
  const out: HostImport[] = []
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.m?ts$/.test(entry.name) || /\.(test|eval|d)\.m?ts$/.test(entry.name)) continue
      const file = join(entry.parentPath, entry.name)
      const isHost = (spec: string): boolean =>
        spec.startsWith('.') && withoutExtension(resolve(dirname(file), spec)) === host
      const found = readHostImports(readFileSync(file, 'utf8'), isHost)
      if (found.names.length || found.unreadable.length) {
        out.push({ file: relative(root, file).split(sep).join('/'), ...found })
      }
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
