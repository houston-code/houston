/**
 * Where a language server finds the project's dependencies. The sandbox points Go's
 * module cache and Cargo's home at Houston's own package cache (see sandboxEnv), so a
 * shell command can write them. A language server only reads dependencies, and with no
 * network it can't fetch any, so that cache (empty unless the agent downloaded into it)
 * would leave every import unresolved. Servers read the user's own caches instead, the
 * ones the user's builds and editor fill. The sandbox still denies writes there.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, win32 } from 'node:path'
import { pkgCacheDir } from '../../sandbox/shared'

export interface DepCacheOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  exists?: (p: string) => boolean
  readFile?: (p: string) => string | null
}

function readOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** The file `go env -w` writes to, or null when GOENV turns it off. */
export function goEnvFile(o: DepCacheOptions = {}): string | null {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const home = o.home ?? homedir()
  const join_ = platform === 'win32' ? win32.join : posix.join
  if (env.GOENV === 'off') return null
  if (env.GOENV) return env.GOENV
  // os.UserConfigDir, as Go computes it.
  const config =
    platform === 'win32'
      ? env.APPDATA
      : platform === 'darwin'
        ? join_(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || join_(home, '.config')
  return config ? join_(config, 'go', 'env') : null
}

/** `KEY=VALUE` lines of a go env file. */
function parseGoEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/**
 * The user's Go module cache, as `go env GOMODCACHE` would print it (without running
 * `go`, which in a project directory may try to download a toolchain): the environment,
 * then the go env file, then the first GOPATH entry's `pkg/mod`.
 */
export function userGoModCache(o: DepCacheOptions = {}): string {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const home = o.home ?? homedir()
  const join_ = platform === 'win32' ? win32.join : posix.join
  const file = goEnvFile(o)
  const text = file ? (o.readFile ?? readOrNull)(file) : null
  const fromFile = text ? parseGoEnv(text) : {}
  const pick = (k: string): string | undefined => env[k] || fromFile[k] || undefined
  const modcache = pick('GOMODCACHE')
  if (modcache) return modcache
  const gopath = pick('GOPATH')?.split(platform === 'win32' ? ';' : ':').find(Boolean)
  return join_(gopath || join_(home, 'go'), 'pkg', 'mod')
}

/** The user's Cargo home: CARGO_HOME, else `~/.cargo`. */
export function userCargoHome(o: DepCacheOptions = {}): string {
  const env = o.env ?? process.env
  const join_ = (o.platform ?? process.platform) === 'win32' ? win32.join : posix.join
  return env.CARGO_HOME || join_(o.home ?? homedir(), '.cargo')
}

export interface LspDepCaches {
  /** Variables to set over the sandbox's for a language server. */
  env: Record<string, string>
  /** The Go module cache servers read: the user's when it exists, else Houston's. */
  goModCache: string
  /** The Cargo home servers read: the user's when it has a registry, else Houston's. */
  cargoHome: string
}

/**
 * The environment a language server runs with. The user's Go module cache and Cargo
 * home when they exist (else Houston's stay, which the agent's own downloads fill),
 * with Go and Cargo told they're offline so a missing dependency fails at once instead
 * of waiting on the network.
 */
export function lspDepCaches(o: DepCacheOptions = {}): LspDepCaches {
  const env = o.env ?? process.env
  const exists = o.exists ?? existsSync
  const go = userGoModCache(o)
  const cargo = userCargoHome(o)
  const userGo = exists(go)
  const userCargo = exists(join(cargo, 'registry'))
  return {
    env: {
      GOPROXY: 'off',
      // gopls keeps its own cache under the OS user cache dir, which isn't writable here.
      GOPLSCACHE: join(pkgCacheDir(env), 'gopls'),
      CARGO_NET_OFFLINE: 'true',
      ...(userGo ? { GOMODCACHE: go } : {}),
      ...(userCargo ? { CARGO_HOME: cargo } : {})
    },
    // Houston's own, where sandboxEnv points them.
    goModCache: userGo ? go : join(pkgCacheDir(env), 'go-mod'),
    cargoHome: userCargo ? cargo : join(pkgCacheDir(env), 'cargo')
  }
}

/** Dependencies a project needs that a cache doesn't hold. */
export interface MissingDeps {
  /** `name@version` of each missing one. */
  missing: string[]
  /** How many were checked. */
  total: number
}

/*
 * go.mod, go.work, and Cargo.lock come from the project, so they're untrusted: what they
 * name becomes a path probed in the cache and text in the agent's context. Only names and
 * versions in the shapes Go and Cargo allow are used, which keeps both to plain
 * identifiers (no `..` steps, spaces, or prose).
 */
const GO_MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9._~+-]*(\/[A-Za-z0-9._~+-]+)*$/
const GO_VERSION = /^v[0-9A-Za-z.+-]+$/
const CRATE_NAME = /^[A-Za-z0-9_-]+$/
const CRATE_VERSION = /^[0-9A-Za-z.+-]+$/
const hasDotDot = (p: string): boolean => p.split('/').some((seg) => seg === '..' || seg === '.')
const validModule = (path: string, version: string): boolean =>
  GO_MODULE_PATH.test(path) && !hasDotDot(path) && GO_VERSION.test(version) && path.length <= 300 && version.length <= 100

/** A module path or version as the Go module cache spells it: each capital as `!` and its lower case. */
export function escapeModulePath(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
}

interface GoMod {
  module: string | null
  requires: { path: string; version: string; indirect: boolean }[]
  /** Replaced module path → its replacement module, or null for a local directory. */
  replaces: Map<string, { path: string; version: string } | null>
}

/** The parts of a go.mod the cache check needs: the module path, requirements, and replacements. */
export function parseGoMod(text: string): GoMod {
  const mod: GoMod = { module: null, requires: [], replaces: new Map() }
  let block: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const indirect = /\/\/\s*indirect\b/.test(raw)
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    if (block) {
      if (line === ')') block = null
      else directive(block, line, indirect)
      continue
    }
    const m = /^(module|require|replace)\s+(.*)$/.exec(line)
    if (!m) continue
    if (m[2] === '(') block = m[1]
    else directive(m[1], m[2], indirect)
  }
  return mod

  function directive(kind: string, rest: string, indirect: boolean): void {
    const words = rest.split(/\s+/).map((w) => w.replace(/^"|"$/g, ''))
    if (kind === 'module') mod.module = words[0]
    else if (kind === 'require' && words.length >= 2) mod.requires.push({ path: words[0], version: words[1], indirect })
    else if (kind === 'replace') {
      const arrow = words.indexOf('=>')
      if (arrow < 1) return
      const [to, toVersion] = words.slice(arrow + 1)
      // `=> ./dir` (no version) points at a directory, which needs no cache.
      mod.replaces.set(words[0], to && toVersion ? { path: to, version: toVersion } : null)
    }
  }
}

/** The `use` directories of a go.work. */
function goWorkUses(text: string): string[] {
  const uses: string[] = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (inBlock) {
      if (line === ')') inBlock = false
      else if (line) uses.push(line.replace(/^"|"$/g, ''))
    } else if (/^use\s*\($/.test(line)) inBlock = true
    else {
      const m = /^use\s+(\S+)$/.exec(line)
      if (m) uses.push(m[1].replace(/^"|"$/g, ''))
    }
  }
  return uses
}

/**
 * The modules the Go projects at `roots` require that `modCache` lacks. Every
 * requirement needs its go.mod in the download cache (Go loads the whole module graph);
 * a direct one also needs its source extracted, since that's what imports read. Null
 * when there's nothing to check: no go.mod, or a vendored project (Go reads vendor/).
 */
export function missingGoModules(roots: string[], modCache: string, o: DepCacheOptions = {}): MissingDeps | null {
  const exists = o.exists ?? existsSync
  const read = o.readFile ?? readOrNull
  const modules: GoMod[] = []
  for (const root of roots) {
    if (exists(join(root, 'vendor', 'modules.txt'))) continue
    const work = read(join(root, 'go.work'))
    // A `use` outside the project isn't the project's to check.
    const dirs = work ? goWorkUses(work).filter((u) => !isAbsolute(u) && !u.split(/[\\/]/).includes('..')).map((u) => join(root, u)) : [root]
    for (const dir of dirs) {
      const text = read(join(dir, 'go.mod'))
      if (text) modules.push(parseGoMod(text))
    }
  }
  if (modules.length === 0) return null
  const local = new Set(modules.map((m) => m.module).filter((m): m is string => m !== null))
  const seen = new Set<string>()
  const missing: string[] = []
  for (const mod of modules) {
    for (const req of mod.requires) {
      if (local.has(req.path)) continue
      const replaced = mod.replaces.get(req.path)
      if (replaced === null) continue
      const target = replaced ?? req
      if (!validModule(target.path, target.version)) continue
      const key = `${target.path}@${target.version}`
      if (seen.has(key)) continue
      seen.add(key)
      const path = escapeModulePath(target.path)
      const version = escapeModulePath(target.version)
      const haveMod = exists(join(modCache, 'cache', 'download', path, '@v', `${version}.mod`))
      const haveSource = req.indirect || exists(join(modCache, `${path}@${version}`))
      if (!haveMod || !haveSource) missing.push(key)
    }
  }
  return { missing, total: seen.size }
}

/**
 * The registry crates a Rust project's Cargo.lock pins that `cargoHome` hasn't
 * unpacked (Cargo reads every crate's manifest to load the workspace). Null without a
 * Cargo.lock: unlocked, Cargo would resolve versions from the index first, which this
 * doesn't model. Git dependencies aren't checked.
 */
export function missingCrates(roots: string[], cargoHome: string, o: DepCacheOptions & { readDir?: (p: string) => string[] } = {}): MissingDeps | null {
  const exists = o.exists ?? existsSync
  const read = o.readFile ?? readOrNull
  const readDir = o.readDir ?? ((p: string) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  })
  const lock = roots.map((r) => read(join(r, 'Cargo.lock'))).find((t): t is string => t !== null)
  if (!lock) return null
  const src = join(cargoHome, 'registry', 'src')
  const indexes = readDir(src)
  const missing: string[] = []
  let total = 0
  for (const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (k: string): string | undefined => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(block)?.[1]
    const name = field('name')
    const version = field('version')
    const source = field('source') ?? ''
    if (!name || !version || !/^(registry|sparse)\+/.test(source)) continue
    if (!CRATE_NAME.test(name) || !CRATE_VERSION.test(version) || name.length > 100 || version.length > 100) continue
    total++
    if (!indexes.some((ix) => exists(join(src, ix, `${name}-${version}`)))) missing.push(`${name}@${version}`)
  }
  return { missing, total }
}

/** What a server's missing dependencies are called and how the user fetches them. */
export interface DepCacheReport extends MissingDeps {
  /** The cache, as people call it. */
  name: string
  path: string
  /** The command that fills it, run in the project. */
  command: string
}

/**
 * The dependencies a built-in server can't see in the cache it reads, for the
 * languages that have one (Go, Rust); null for other servers or nothing to check.
 */
export function depCacheReport(serverId: string, roots: string[], o: DepCacheOptions = {}): DepCacheReport | null {
  const caches = lspDepCaches(o)
  if (serverId === 'go') {
    const r = missingGoModules(roots, caches.goModCache, o)
    return r && { ...r, name: 'Go module cache', path: caches.goModCache, command: 'go mod download' }
  }
  if (serverId === 'rust') {
    const r = missingCrates(roots, caches.cargoHome, o)
    return r && { ...r, name: 'Cargo registry', path: caches.cargoHome, command: 'cargo fetch' }
  }
  return null
}

/** The note for the agent when a server can't see some dependencies, or null when it sees them all. */
export function missingDepsHint(report: DepCacheReport | null): string | null {
  if (!report || report.missing.length === 0) return null
  const shown = report.missing.slice(0, 3).join(', ')
  const more = report.missing.length > 3 ? `, and ${report.missing.length - 3} more` : ''
  return (
    `The language server can't find ${report.missing.length} of this project's ${report.total} dependencies ` +
    `(${shown}${more}) in the ${report.name} it reads (${report.path}). It runs offline, so it can't see them: imports ` +
    `from them show as errors and lookups stop there. Running \`${report.command}\` in the project from the ` +
    `user's own terminal fixes it, and Houston restarts the server once they're there.`
  )
}
