import { constants as fsConstants, promises as fs, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { McpServerConfig } from '@shared/types'
import type { ImportCandidate, ImportOutcome, ImportScan, ImportScope } from '@shared/importConfig'
import { mcpServersFromJson } from '@shared/mcpJson'
import { parseFrontmatter } from '@shared/frontmatter'
import { parseProjectMcpServers, PROJECT_CONFIG } from './agent/projectConfig'
import { COMMANDS_DIR, USER_COMMANDS_DIR } from './agent/commands'
import { SKILLS_DIR, USER_SKILLS_DIR } from './agent/skills'
import { GLOBAL_RULES_HEADING, globalRulesFile, importLegacyRules, legacyRulesFile, legacyRulesNoticeApplies, readTextOrNull, rulesWriteTarget } from './globalRules'
import { writeFileAtomicSync } from './atomic-write'
import { withFileLock } from './fileLock'

/**
 * Import from other tools. Coding tools keep instruction files, MCP server lists,
 * skills and custom commands in well-known places in the home folder and the
 * project. This finds them and copies the ones the user picks into Houston's own
 * locations. It never moves, edits or deletes an original, never overwrites a file
 * or server Houston already has, and runs nothing: an imported user MCP server is
 * added switched off, and a project's servers go to `.houston/settings.json`, which
 * only takes effect once the user trusts the folder (the edit changes its
 * fingerprint, so an already-trusted folder is asked again).
 *
 * What to import comes back from the renderer as candidate ids only. Every import
 * scans again and acts on its own findings, so no path the renderer sends is used.
 */

/** Largest instruction or command file copied. */
const MAX_TEXT_BYTES = 512 * 1024
/** Largest JSON config read (some keep chat history beside their servers). */
const MAX_JSON_BYTES = 20 * 1024 * 1024
const MAX_PER_DIR = 100
const MAX_SKILL_FILES = 100
const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_SKILL_DEPTH = 8
const NAME = /^[\w-]+$/

/** Home-folder instruction files, copied into `~/.houston/AGENTS.md`. */
const USER_RULES = [join('.codex', 'AGENTS.md'), join('.gemini', 'GEMINI.md'), join('.config', 'opencode', 'AGENTS.md')]
/** Project instruction files Houston does not already load, copied into the project's `AGENTS.md`. */
const PROJECT_RULES = ['GEMINI.md', '.cursorrules', '.windsurfrules', '.clinerules', join('.github', 'copilot-instructions.md')]
/** Home-folder MCP server lists. */
const USER_MCP = [join('.cursor', 'mcp.json'), join('.codeium', 'windsurf', 'mcp_config.json'), join('.gemini', 'settings.json')]
/** A home-folder file that keeps top-level servers plus per-project ones under `projects`. */
const USER_MCP_WITH_PROJECTS = '.claude.json'
/** Project MCP server lists. */
const PROJECT_MCP = ['.mcp.json', join('.cursor', 'mcp.json'), join('.vscode', 'mcp.json'), join('.gemini', 'settings.json')]
/** Home-folder custom command folders, copied into `~/.houston/commands`. */
const USER_COMMANDS = [join('.claude', 'commands'), join('.codex', 'prompts')]
/** Project custom command folders, copied into `.houston/commands`. */
const PROJECT_COMMANDS = [join('.claude', 'commands')]
/** Home-folder skill folders, copied into `~/.houston/skills`. */
const USER_SKILLS = [join('.claude', 'skills')]
/** Project skill folders, copied into `.houston/skills`. */
const PROJECT_SKILLS = [join('.claude', 'skills')]

/** A desktop app's MCP server list, whose folder differs per platform. */
function desktopMcpFile(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const file = 'claude_desktop_config.json'
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', file)
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'Claude', file) : null
  return join(home, '.config', 'Claude', file)
}

export interface ImportDeps {
  home?: string
  workspace?: string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** The user's configured MCP servers. */
  userMcpServers: () => McpServerConfig[]
  /** Append servers to the user's settings (saved). Returns the fresh settings. */
  addUserMcpServers?: (servers: McpServerConfig[]) => ImportOutcome['settings']
  /** Record that the one-time global-rules notice was answered (its file was imported here). */
  onLegacyImported?: () => void
}

/** A find plus what importing it does. Internal: only the public part leaves main. */
interface Found extends ImportCandidate {
  /** For MCP: the server to add. */
  server?: McpServerConfig
  /** Copy it (rules, commands, skills). MCP servers are added in one batch instead. */
  apply?: () => Promise<void>
}

interface Ctx {
  home: string
  workspace: string | null
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  deps: ImportDeps
}

function under(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

/** A path as the UI shows it: `~/...` in the home folder, project-relative in the project. */
function shown(ctx: Ctx, abs: string): string {
  const inProject = ctx.workspace ? under(ctx.workspace, abs) : null
  if (inProject) return inProject.split(sep).join('/')
  const inHome = under(ctx.home, abs)
  return inHome ? `~/${inHome.split(sep).join('/')}` : abs
}

/** Whether `abs` (symlinks resolved) lies inside `root`. False when either is missing. */
function resolvesInside(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(abs)
    return real === realRoot || under(realRoot, real) !== null
  } catch {
    return false
  }
}

/**
 * A regular file's text, or null when it is missing, too big, or not a plain file.
 * A project file (`within` set) must resolve inside the project: a link pointing at,
 * say, a key in the home folder would otherwise be copied into the project.
 * Home-folder files are often links into a dotfiles repo, so those are followed.
 */
async function readSource(path: string, within: string | null, max: number): Promise<string | null> {
  try {
    if (within !== null && !resolvesInside(within, path)) return null
    const st = await fs.stat(path)
    if (!st.isFile() || st.size > max) return null
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Create `relDir` under `root` and make sure it really is inside it, so a project's
 * `.houston` that is a symlink out of the project can't route a copy elsewhere.
 */
async function dirInside(root: string, relDir: string): Promise<string> {
  const dir = join(root, relDir)
  await fs.mkdir(dir, { recursive: true })
  const realRoot = realpathSync(root)
  if (under(realRoot, realpathSync(dir)) === null) {
    throw new Error(`${relDir.split(sep).join('/')} points outside the folder`)
  }
  return dir
}

/** The marker line an instruction file is copied under, so it is never copied twice. */
export function rulesMarker(source: string): string {
  return `<!-- Imported from ${source} -->`
}

/** `current` (the target file, or null) with `body` appended under its marker. */
export function withImportedRules(current: string | null, marker: string, body: string, heading?: string): string {
  const block = `${marker}\n${body.trim()}\n`
  if (current === null || !current.trim()) return heading ? `${heading}\n\n${block}` : block
  return `${current.replace(/\s*$/, '')}\n\n${block}`
}

async function findRules(ctx: Ctx, out: Found[]): Promise<void> {
  // The file Houston used to load on its own goes in through an import line (as the
  // one-time notice does), so the two paths agree on what "imported" means.
  const legacy = legacyRulesFile(ctx.home)
  if ((await readSource(legacy, null, MAX_TEXT_BYTES))?.trim()) {
    const applies = legacyRulesNoticeApplies(ctx.home)
    out.push({
      id: `rules:user:${shown(ctx, legacy)}`,
      kind: 'rules',
      scope: 'user',
      name: 'CLAUDE.md',
      source: shown(ctx, legacy),
      target: shown(ctx, globalRulesFile(ctx.home)),
      detail: 'Adds one line that imports it, so later edits to it apply too',
      status: applies ? 'new' : 'present',
      ...(applies ? {} : { note: 'Already imported' }),
      apply: async () => {
        await importLegacyRules(ctx.home)
        ctx.deps.onLegacyImported?.()
      }
    })
  }
  const userTarget = globalRulesFile(ctx.home)
  const userText = readTextOrNull(userTarget)
  for (const rel of USER_RULES) {
    const src = join(ctx.home, rel)
    const text = await readSource(src, null, MAX_TEXT_BYTES)
    if (!text?.trim()) continue
    const marker = rulesMarker(shown(ctx, src))
    const present = userText?.includes(marker) ?? false
    out.push({
      id: `rules:user:${shown(ctx, src)}`,
      kind: 'rules',
      scope: 'user',
      name: rel.split(sep).pop() ?? rel,
      source: shown(ctx, src),
      target: shown(ctx, userTarget),
      detail: 'Copies its text to the end',
      status: present ? 'present' : 'new',
      ...(present ? { note: 'Already imported' } : {}),
      apply: () => appendRules(userTarget, marker, text, { heading: GLOBAL_RULES_HEADING, mkdir: true })
    })
  }
  const ws = ctx.workspace
  if (!ws) return
  const projectTarget = join(ws, 'AGENTS.md')
  const projectText = readTextOrNull(projectTarget)
  for (const rel of PROJECT_RULES) {
    const src = join(ws, rel)
    const text = await readSource(src, ws, MAX_TEXT_BYTES)
    if (!text?.trim()) continue
    const marker = rulesMarker(shown(ctx, src))
    const present = projectText?.includes(marker) ?? false
    out.push({
      id: `rules:project:${shown(ctx, src)}`,
      kind: 'rules',
      scope: 'project',
      name: rel.split(sep).pop() ?? rel,
      source: shown(ctx, src),
      target: 'AGENTS.md',
      detail: 'Copies its text to the end',
      status: present ? 'present' : 'new',
      ...(present ? { note: 'Already imported' } : {}),
      apply: () => appendRules(projectTarget, marker, text, { within: ws })
    })
  }
}

async function appendRules(
  file: string,
  marker: string,
  body: string,
  opts: { heading?: string; mkdir?: boolean; within?: string }
): Promise<void> {
  if (opts.mkdir) await fs.mkdir(dirname(file), { recursive: true })
  // Through a symlinked rules file to its target (and, for a project, only inside it),
  // under the same lock a `#` note save takes.
  const target = rulesWriteTarget(file, opts.within)
  await withFileLock(target, () => {
    const current = readTextOrNull(target)
    if (current?.includes(marker)) return
    writeFileAtomicSync(target, withImportedRules(current, marker, body, opts.heading))
  })
}

/** The servers a JSON config file lists, read leniently (a broken file lists none). */
async function serversIn(path: string, within: string | null, workspace: string | null): Promise<McpServerConfig[]> {
  const text = await readSource(path, within, MAX_JSON_BYTES)
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const servers = mcpServersFromJson(raw).servers
  // A file that also keeps per-project servers: add the open project's.
  if (workspace && raw && typeof raw === 'object') {
    const projects = (raw as { projects?: unknown }).projects
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      let real = workspace
      try {
        real = realpathSync(workspace)
      } catch {
        // keep the given path
      }
      const entry = (projects as Record<string, unknown>)[workspace] ?? (projects as Record<string, unknown>)[real]
      if (entry && typeof entry === 'object' && 'mcpServers' in entry) {
        for (const s of mcpServersFromJson({ mcpServers: (entry as { mcpServers: unknown }).mcpServers }).servers) {
          if (!servers.some((x) => x.id === s.id)) servers.push(s)
        }
      }
    }
  }
  return servers
}

function commandLine(s: McpServerConfig): string {
  return s.command ? [s.command, ...(s.args ?? [])].join(' ') : `${s.transport ?? 'http'} ${s.url ?? ''}`
}

async function findMcp(ctx: Ctx, out: Found[]): Promise<void> {
  const userIds = new Set(ctx.deps.userMcpServers().map((s) => s.id))
  const files = [...USER_MCP, USER_MCP_WITH_PROJECTS].map((rel) => join(ctx.home, rel))
  const desktop = desktopMcpFile(ctx.home, ctx.platform, ctx.env)
  if (desktop) files.push(desktop)
  const seenUser = new Map<string, string>()
  for (const file of files) {
    for (const server of await serversIn(file, null, ctx.workspace)) {
      const source = shown(ctx, file)
      const earlier = seenUser.get(server.id)
      const status = userIds.has(server.id) || earlier ? 'present' : 'new'
      if (!earlier) seenUser.set(server.id, source)
      out.push({
        id: `mcp:user:${source}:${server.id}`,
        kind: 'mcp',
        scope: 'user',
        name: server.id,
        source,
        target: 'Settings > MCP Servers (added switched off)',
        detail: commandLine(server),
        status,
        ...(status === 'present'
          ? { note: earlier ? `Also found in ${earlier}` : `Houston already has a server named ${server.id}` }
          : {}),
        // Added off: it runs nothing until the user reviews it and switches it on.
        server: { ...server, enabled: false }
      })
    }
  }
  const ws = ctx.workspace
  if (!ws) return
  const current = parseProjectMcpServers(await readProjectConfig(ws).catch(() => ({}))).map((s) => s.id)
  const seenProject = new Map<string, string>()
  for (const rel of PROJECT_MCP) {
    const file = join(ws, rel)
    for (const server of await serversIn(file, ws, null)) {
      const source = shown(ctx, file)
      const earlier = seenProject.get(server.id)
      const status = current.includes(server.id) || earlier ? 'present' : 'new'
      if (!earlier) seenProject.set(server.id, source)
      out.push({
        id: `mcp:project:${source}:${server.id}`,
        kind: 'mcp',
        scope: 'project',
        name: server.id,
        source,
        target: PROJECT_CONFIG,
        detail: commandLine(server),
        status,
        ...(status === 'present'
          ? { note: earlier ? `Also found in ${earlier}` : `${PROJECT_CONFIG} already has a server named ${server.id}` }
          : {}),
        server
      })
    }
  }
}

/** The project's `.houston/settings.json` as an object; {} when it doesn't exist. */
async function readProjectConfig(ws: string): Promise<Record<string, unknown>> {
  const file = join(ws, PROJECT_CONFIG)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return {}
  }
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${PROJECT_CONFIG} is not a JSON object`)
  return raw as Record<string, unknown>
}

/** Append servers to the project's `.houston/settings.json`, keeping everything else in it. */
async function addProjectServers(ws: string, servers: McpServerConfig[]): Promise<void> {
  const dir = await dirInside(ws, '.houston')
  const file = join(dir, 'settings.json')
  await withFileLock(file, async () => {
    const config = await readProjectConfig(ws)
    const list = Array.isArray(config.mcpServers) ? [...(config.mcpServers as unknown[])] : []
    const taken = new Set(parseProjectMcpServers({ mcpServers: list }).map((s) => s.id))
    for (const s of servers) {
      if (taken.has(s.id)) continue
      taken.add(s.id)
      list.push({
        id: s.id,
        ...(s.transport ? { transport: s.transport } : {}),
        command: s.command,
        ...(s.args?.length ? { args: s.args } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.env ? { env: s.env } : {}),
        ...(s.url ? { url: s.url } : {}),
        ...(s.headers ? { headers: s.headers } : {})
      })
    }
    writeFileAtomicSync(file, `${JSON.stringify({ ...config, mcpServers: list }, null, 2)}\n`)
  })
}

/** The `*.md` files with command-safe names directly in `dir`, sorted. */
async function mdFiles(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.md') && NAME.test(n.slice(0, -3)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PER_DIR)
}

function describe(text: string): string {
  const { data, body } = parseFrontmatter(text)
  const first = (body.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim()
  return (data.description?.trim() || first).slice(0, 100)
}

async function findCommands(ctx: Ctx, out: Found[]): Promise<void> {
  const groups: Array<{ scope: ImportScope; dirs: string[]; root: string; targetRel: string }> = [
    { scope: 'user', dirs: USER_COMMANDS.map((d) => join(ctx.home, d)), root: ctx.home, targetRel: USER_COMMANDS_DIR }
  ]
  if (ctx.workspace) {
    groups.push({
      scope: 'project',
      dirs: PROJECT_COMMANDS.map((d) => join(ctx.workspace as string, d)),
      root: ctx.workspace,
      targetRel: COMMANDS_DIR
    })
  }
  for (const g of groups) {
    const claimed = new Map<string, string>()
    for (const dir of g.dirs) {
      for (const file of await mdFiles(dir)) {
        const src = join(dir, file)
        const text = await readSource(src, g.scope === 'project' ? g.root : null, MAX_TEXT_BYTES)
        if (!text?.trim()) continue
        const name = file.slice(0, -3)
        const target = join(g.root, g.targetRel, file)
        const earlier = claimed.get(name)
        const there = await exists(target)
        if (!earlier) claimed.set(name, shown(ctx, src))
        const status = there || earlier ? 'present' : 'new'
        out.push({
          id: `command:${g.scope}:${shown(ctx, src)}`,
          kind: 'command',
          scope: g.scope,
          name: `/${name}`,
          source: shown(ctx, src),
          target: shown(ctx, target),
          detail: describe(text),
          status,
          ...(status === 'present'
            ? { note: earlier ? `Also found in ${earlier}` : `Houston already has /${name}` }
            : {}),
          apply: async () => {
            const dirAbs = g.scope === 'project' ? await dirInside(g.root, g.targetRel) : join(g.root, g.targetRel)
            await fs.mkdir(dirAbs, { recursive: true })
            // 'wx': fails rather than overwrite one created since the scan.
            await fs.writeFile(join(dirAbs, file), text, { flag: 'wx' })
          }
        })
      }
    }
  }
}

/** A skill folder's files (relative paths), or null when it can't be copied safely. */
export async function skillFiles(dir: string): Promise<string[] | null> {
  const files: string[] = []
  let bytes = 0
  const walk = async (abs: string, rel: string, depth: number): Promise<boolean> => {
    if (depth > MAX_SKILL_DEPTH) return false
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) {
        if (!(await walk(join(abs, e.name), childRel, depth + 1))) return false
      } else if (e.isFile()) {
        const st = await fs.stat(join(abs, e.name))
        bytes += st.size
        files.push(childRel)
        if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) return false
      }
      // Symlinks and anything else are left behind, never followed.
    }
    return true
  }
  if (!(await walk(dir, '', 0))) return null
  return files.includes('SKILL.md') ? files.sort() : null
}

async function findSkills(ctx: Ctx, out: Found[]): Promise<void> {
  const groups: Array<{ scope: ImportScope; dirs: string[]; root: string; targetRel: string }> = [
    { scope: 'user', dirs: USER_SKILLS.map((d) => join(ctx.home, d)), root: ctx.home, targetRel: USER_SKILLS_DIR }
  ]
  if (ctx.workspace) {
    groups.push({
      scope: 'project',
      dirs: PROJECT_SKILLS.map((d) => join(ctx.workspace as string, d)),
      root: ctx.workspace,
      targetRel: SKILLS_DIR
    })
  }
  for (const g of groups) {
    const claimed = new Map<string, string>()
    for (const root of g.dirs) {
      let entries
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries.slice(0, MAX_PER_DIR)) {
        if (!e.isDirectory() || !NAME.test(e.name)) continue
        const src = join(root, e.name)
        // A project's skill folder that links outside the project is left behind.
        if (g.scope === 'project' && !resolvesInside(g.root, src)) continue
        const files = await skillFiles(src)
        if (!files) continue
        const text = (await readSource(join(src, 'SKILL.md'), g.scope === 'project' ? g.root : null, MAX_TEXT_BYTES)) ?? ''
        const target = join(g.root, g.targetRel, e.name)
        const earlier = claimed.get(e.name)
        const there = await exists(target)
        if (!earlier) claimed.set(e.name, shown(ctx, src))
        const status = there || earlier ? 'present' : 'new'
        out.push({
          id: `skill:${g.scope}:${shown(ctx, src)}`,
          kind: 'skill',
          scope: g.scope,
          name: parseFrontmatter(text).data.name || e.name,
          source: shown(ctx, src),
          target: shown(ctx, target),
          detail: describe(text),
          status,
          ...(status === 'present'
            ? { note: earlier ? `Also found in ${earlier}` : `Houston already has a skill folder named ${e.name}` }
            : {}),
          apply: async () => {
            const parent =
              g.scope === 'project' ? await dirInside(g.root, g.targetRel) : join(g.root, g.targetRel)
            await fs.mkdir(parent, { recursive: true })
            const dest = join(parent, e.name)
            await fs.mkdir(dest) // fails if it appeared since the scan: never merge into one
            for (const f of files) {
              await fs.mkdir(dirname(join(dest, f)), { recursive: true })
              await fs.copyFile(join(src, f), join(dest, f), fsConstants.COPYFILE_EXCL)
            }
          }
        })
      }
    }
  }
}

function context(deps: ImportDeps): Ctx {
  return {
    home: deps.home ?? homedir(),
    workspace: deps.workspace ?? null,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    deps
  }
}

async function findAll(ctx: Ctx): Promise<Found[]> {
  const out: Found[] = []
  await findRules(ctx, out)
  await findMcp(ctx, out)
  await findSkills(ctx, out)
  await findCommands(ctx, out)
  return out
}

function publicPart(f: Found): ImportCandidate {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { server, apply, ...rest } = f
  return rest
}

/** Everything found in the home folder and the open project. */
export async function scanImportables(deps: ImportDeps): Promise<ImportScan> {
  return { candidates: (await findAll(context(deps))).map(publicPart) }
}

/**
 * Whether the one-time offer has something to show: a find that isn't imported yet.
 * The old global rules file is left out, since its own notice already asks about it.
 */
export async function hasNewImportables(deps: ImportDeps): Promise<boolean> {
  const ctx = context(deps)
  const legacy = shown(ctx, legacyRulesFile(ctx.home))
  return (await findAll(ctx)).some((f) => f.status === 'new' && f.source !== legacy)
}

/** Import the finds with these ids (as of a fresh scan); anything else is ignored. */
export async function importSelected(ids: unknown, deps: ImportDeps): Promise<ImportOutcome> {
  const wanted = new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [])
  const outcome: ImportOutcome = { imported: [], failed: [] }
  if (wanted.size === 0) return outcome
  const ctx = context(deps)
  const found = (await findAll(ctx)).filter((f) => wanted.has(f.id))
  for (const id of wanted) {
    if (!found.some((f) => f.id === id)) outcome.failed.push({ id, reason: 'No longer found' })
  }
  const userServers: Found[] = []
  const projectServers: Found[] = []
  for (const f of found) {
    if (f.status !== 'new') {
      outcome.failed.push({ id: f.id, reason: f.note ?? 'Already there' })
    } else if (f.server) {
      ;(f.scope === 'user' ? userServers : projectServers).push(f)
    } else if (f.apply) {
      try {
        await f.apply()
        outcome.imported.push(f.id)
      } catch (e) {
        outcome.failed.push({ id: f.id, reason: (e as Error).message })
      }
    }
  }
  if (userServers.length) {
    if (!deps.addUserMcpServers) {
      for (const f of userServers) outcome.failed.push({ id: f.id, reason: 'Settings are not available' })
    } else {
      try {
        outcome.settings = deps.addUserMcpServers(userServers.map((f) => f.server as McpServerConfig))
        outcome.imported.push(...userServers.map((f) => f.id))
      } catch (e) {
        for (const f of userServers) outcome.failed.push({ id: f.id, reason: (e as Error).message })
      }
    }
  }
  if (projectServers.length && ctx.workspace) {
    try {
      await addProjectServers(ctx.workspace, projectServers.map((f) => f.server as McpServerConfig))
      outcome.imported.push(...projectServers.map((f) => f.id))
    } catch (e) {
      for (const f of projectServers) outcome.failed.push({ id: f.id, reason: (e as Error).message })
    }
  }
  return outcome
}
