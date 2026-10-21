/**
 * The language-server registry: which servers Houston knows how to drive, which files
 * each covers, and how to find its binary. Like the formatters, none are bundled; a
 * server is used only when its binary is installed, either in the workspace's
 * `node_modules/.bin` (for the Node-based ones) or on PATH. Users can add servers in
 * settings (`lspServers`); a user entry with a built-in's id replaces it.
 */
import { existsSync, readdirSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { resolveBinaryPath, WIN_BASH_EXTENSIONS, type BinLookupOptions } from '../format'
import type { LspServerConfig } from '@shared/types'

/** One way to launch a server: the binary and its argv. */
export interface LspCandidate {
  bin: string
  args: string[]
  /** Also look in each root's `node_modules/.bin` (before PATH) for this binary. */
  nodeLocal?: boolean
}

export interface LspServerSpec {
  /** Stable id, also the key users override with. */
  id: string
  /** Human-readable name for Settings and /doctor. */
  name: string
  /** Lower-cased extension (no dot) → LSP languageId. */
  languages: Record<string, string>
  /** Launch candidates in preference order; the first one installed wins. */
  candidates: LspCandidate[]
  /**
   * Files whose presence at a root means the project uses this language. Used only to
   * decide whether to offer the lsp_* tools; post-edit diagnostics go by extension.
   */
  rootMarkers: string[]
  /** Also count a top-level file with one of `languages`' extensions as a marker. */
  markerByExtension?: boolean
  initializationOptions?: unknown
  /** Answer for `workspace/configuration` sections (by section name), else null. */
  settings?: Record<string, unknown>
  /** Where to send people who want to install it. */
  installHint: string
  /** True for an entry from the user's settings. */
  user?: boolean
}

const TS_LANGS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact'
}

/**
 * Settings both TypeScript servers read. Automatic type acquisition downloads `@types`
 * packages from npm; the server runs with no network, so turn it off rather than let
 * it retry and log failures.
 */
const TS_SETTINGS = {
  typescript: { disableAutomaticTypeAcquisition: true, tsserver: { log: 'off' } },
  javascript: {},
  vtsls: { autoUseWorkspaceTsdk: true }
}

export const BUILTIN_SERVERS: LspServerSpec[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    languages: TS_LANGS,
    candidates: [
      { bin: 'typescript-language-server', args: ['--stdio'], nodeLocal: true },
      { bin: 'vtsls', args: ['--stdio'], nodeLocal: true }
    ],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    initializationOptions: { disableAutomaticTypingAcquisition: true },
    settings: TS_SETTINGS,
    installHint: 'npm install -g typescript-language-server typescript (or @vtsls/language-server)'
  },
  {
    id: 'python',
    name: 'Python',
    languages: { py: 'python', pyi: 'python' },
    candidates: [
      { bin: 'pyright-langserver', args: ['--stdio'], nodeLocal: true },
      { bin: 'basedpyright-langserver', args: ['--stdio'] }
    ],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pyrightconfig.json', 'Pipfile'],
    markerByExtension: true,
    settings: { python: { analysis: { autoSearchPaths: true, diagnosticMode: 'openFilesOnly' } } },
    installHint: 'npm install -g pyright (or pip install basedpyright)'
  },
  {
    id: 'go',
    name: 'Go',
    languages: { go: 'go' },
    candidates: [{ bin: 'gopls', args: [] }],
    rootMarkers: ['go.mod', 'go.work'],
    installHint: 'go install golang.org/x/tools/gopls@latest'
  },
  {
    id: 'rust',
    name: 'Rust',
    languages: { rs: 'rust' },
    candidates: [{ bin: 'rust-analyzer', args: [] }],
    rootMarkers: ['Cargo.toml'],
    installHint: 'rustup component add rust-analyzer'
  },
  {
    id: 'clangd',
    name: 'C / C++',
    languages: {
      c: 'c',
      h: 'c',
      cc: 'cpp',
      cpp: 'cpp',
      cxx: 'cpp',
      hpp: 'cpp',
      hh: 'cpp',
      hxx: 'cpp',
      m: 'objective-c',
      mm: 'objective-cpp'
    },
    candidates: [{ bin: 'clangd', args: [] }],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', 'CMakeLists.txt', '.clangd'],
    installHint: 'install clangd from your package manager or LLVM'
  }
]

/** Lower-cased extension of `path` without the leading dot (empty if none). */
export function extKey(path: string): string {
  return extname(path).replace(/^\./, '').toLowerCase()
}

/** A user's settings entry as a spec. Entries missing a command or extensions are dropped. */
export function userServerSpec(c: LspServerConfig): LspServerSpec | null {
  const id = typeof c.id === 'string' ? c.id.trim() : ''
  const command = typeof c.command === 'string' ? c.command.trim() : ''
  const exts = Array.isArray(c.extensions)
    ? c.extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()).filter(Boolean)
    : []
  if (!id || !command || exts.length === 0) return null
  const languages: Record<string, string> = {}
  for (const ext of exts) languages[ext] = c.languageId?.trim() || ext
  return {
    id,
    name: id,
    languages,
    candidates: [{ bin: command, args: Array.isArray(c.args) ? c.args.map(String) : [] }],
    rootMarkers: Array.isArray(c.rootMarkers) ? c.rootMarkers.map(String) : [],
    markerByExtension: true,
    ...(c.initializationOptions !== undefined ? { initializationOptions: c.initializationOptions } : {}),
    installHint: `configured in settings as ${command}`,
    user: true
  }
}

/**
 * The effective registry: the user's servers first (so they win an extension they share
 * with a built-in), then the built-ins they didn't replace by id.
 */
export function serverRegistry(user: LspServerConfig[] | undefined): LspServerSpec[] {
  const users = (user ?? []).map(userServerSpec).filter((s): s is LspServerSpec => s !== null)
  const ids = new Set(users.map((s) => s.id))
  return [...users, ...BUILTIN_SERVERS.filter((s) => !ids.has(s.id))]
}

/** The first server in `registry` that covers `path`'s extension. */
export function specForFile(registry: LspServerSpec[], path: string): LspServerSpec | null {
  const ext = extKey(path)
  if (!ext) return null
  return registry.find((s) => ext in s.languages) ?? null
}

export interface ResolveOptions extends BinLookupOptions {
  /** Roots whose `node_modules/.bin` is searched first for `nodeLocal` candidates. */
  roots?: string[]
}

/** A server ready to launch: the resolved executable and argv. */
export interface ResolvedServer {
  spec: LspServerSpec
  /** Absolute path to the executable. */
  path: string
  args: string[]
  /** Where it was found, for status display. */
  source: 'workspace' | 'path' | 'settings'
}

/** `node_modules/.bin/<bin>` under one of `roots`, if present. */
function nodeLocalBin(bin: string, roots: string[], opts: BinLookupOptions): string | null {
  const exists = opts.exists ?? existsSync
  const win = (opts.platform ?? process.platform) === 'win32'
  for (const root of roots) {
    for (const suffix of win ? ['.cmd', '.exe', ''] : ['']) {
      const p = join(root, 'node_modules', '.bin', bin + suffix)
      if (exists(p)) return p
    }
  }
  return null
}

/** Find the executable for `spec`: per candidate, the workspace's local bin, then PATH. */
export function resolveServer(spec: LspServerSpec, opts: ResolveOptions = {}): ResolvedServer | null {
  for (const c of spec.candidates) {
    if (spec.user && isAbsolute(c.bin)) {
      const exists = opts.exists ?? existsSync
      if (exists(c.bin)) return { spec, path: c.bin, args: c.args, source: 'settings' }
      continue
    }
    if (c.nodeLocal && opts.roots?.length) {
      const local = nodeLocalBin(c.bin, opts.roots, opts)
      if (local) return { spec, path: local, args: c.args, source: 'workspace' }
    }
    const onPath = resolveBinaryPath(c.bin, { extensions: WIN_BASH_EXTENSIONS, ...opts })
    if (onPath) return { spec, path: onPath, args: c.args, source: spec.user ? 'settings' : 'path' }
  }
  return null
}

/**
 * Whether a root looks like a project in `spec`'s language: one of its marker files
 * sits at the top level, or (for languages with no universal marker) a top-level file
 * has one of its extensions.
 */
export function rootUsesLanguage(spec: LspServerSpec, root: string, exists: (p: string) => boolean = existsSync): boolean {
  if (spec.rootMarkers.some((m) => exists(join(root, m)))) return true
  if (!spec.markerByExtension) return false
  try {
    return readdirSync(root).some((name) => extKey(name) in spec.languages)
  } catch {
    return false
  }
}
