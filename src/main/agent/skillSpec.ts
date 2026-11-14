import { isAbsolute, relative, sep } from 'node:path'
import type { FrontmatterValue } from '@shared/frontmatter'

/**
 * The Agent Skills format (agentskills.io): the SKILL.md front-matter fields Houston
 * reads, how they are validated, and the two behaviors they drive at run time
 * (`allowed-tools` narrowing what runs while a skill is active, and `paths:` globs
 * that surface a skill when the agent touches a matching file). Pure, so the
 * loader, the loop and Settings > Customize share one reading.
 */

/** The format's limits on each field. */
export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 1024
export const SKILL_COMPATIBILITY_MAX = 500
/** Houston's own bounds on the list fields, so one file can't flood a run. */
const MAX_LIST_ITEMS = 50
const MAX_METADATA_KEYS = 32
const MAX_ITEM_CHARS = 200

/**
 * A name the format accepts: 1 to 64 lowercase letters, digits and hyphens, not
 * starting or ending with a hyphen and with no two in a row.
 */
export function isSpecSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= SKILL_NAME_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

/** The format's optional fields, as Houston keeps them on a loaded skill. */
export interface SkillSpecFields {
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  /** Tool patterns from `allowed-tools`; while the skill is active only these run. */
  allowedTools?: string[]
  /** Workspace-relative globs from `paths:`; touching a match surfaces the skill. */
  paths?: string[]
}

export interface ParsedSkill extends SkillSpecFields {
  name: string
  description: string
  /** What doesn't follow the format, for Settings > Customize to show. */
  problems: string[]
}

function scalar(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/** A list field: a YAML list, or one string split on whitespace (and commas, when `commas`). */
function list(v: FrontmatterValue | undefined, commas: boolean): string[] | undefined {
  let items: string[]
  if (Array.isArray(v)) items = v
  else if (typeof v === 'string') items = v.split(commas ? /[\s,]+/ : /\s+/)
  else return undefined
  const out = items
    .map((s) => s.trim())
    .filter((s) => s && s.length <= MAX_ITEM_CHARS)
    .slice(0, MAX_LIST_ITEMS)
  return out.length ? out : undefined
}

/**
 * Read and check a SKILL.md's front matter. `dirName` is the skill's folder. With
 * `strict` (a skill from `.agents/skills`, written to the format) a skill whose name
 * breaks the format or doesn't match its folder, or that has no description, is
 * refused (null). Without it (`.houston/skills`, which predates the format) the same
 * findings are only reported, so an existing skill keeps loading.
 */
export function parseSkillFields(
  fields: Record<string, FrontmatterValue>,
  dirName: string,
  strict: boolean
): ParsedSkill | null {
  const problems: string[] = []
  // Findings that keep a strict skill from loading; truncations below don't.
  let fatal = false
  const name = scalar(fields.name) ?? dirName
  if (!isSpecSkillName(name)) {
    problems.push('The name should be up to 64 lowercase letters, digits and single hyphens.')
    fatal = true
  } else if (name !== dirName) {
    problems.push(`The name should match its folder (${dirName}).`)
    fatal = true
  }
  let description = scalar(fields.description)
  if (!description) {
    problems.push('A description is required.')
    fatal = true
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    problems.push(`The description is cut to ${SKILL_DESCRIPTION_MAX} characters.`)
    description = description.slice(0, SKILL_DESCRIPTION_MAX)
  }
  if (strict && fatal) return null
  let compatibility = scalar(fields.compatibility)
  if (compatibility && compatibility.length > SKILL_COMPATIBILITY_MAX) {
    problems.push(`The compatibility note is cut to ${SKILL_COMPATIBILITY_MAX} characters.`)
    compatibility = compatibility.slice(0, SKILL_COMPATIBILITY_MAX)
  }
  const license = scalar(fields.license)
  let metadata: Record<string, string> | undefined
  const raw = fields.metadata
  if (raw !== undefined) {
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const entries = Object.entries(raw)
        .filter(([k, v]) => k.trim() && typeof v === 'string')
        .slice(0, MAX_METADATA_KEYS)
      if (entries.length) metadata = Object.fromEntries(entries)
    } else if (scalar(raw as FrontmatterValue)) {
      problems.push('metadata should be a map of keys to text.')
    }
  }
  const allowedTools = list(fields['allowed-tools'], false)
  const paths = list(fields.paths, true)
  return {
    name,
    description: description ?? 'No description.',
    problems,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(metadata ? { metadata } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(paths ? { paths } : {})
  }
}

/**
 * Tool names the format's examples use, read as the Houston tools they mean, so a
 * skill written for the format narrows to the right ones here.
 */
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  read: ['read_file'],
  write: ['write_file'],
  edit: ['edit_file', 'multi_edit', 'apply_patch'],
  multiedit: ['multi_edit'],
  notebookedit: ['notebook_edit'],
  bash: ['run_shell', 'read_shell_output', 'kill_shell'],
  shell: ['run_shell', 'read_shell_output', 'kill_shell'],
  grep: ['search_files', 'ast_grep'],
  glob: ['glob'],
  ls: ['list_dir'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
  todowrite: ['todo_write'],
  task: ['dispatch_agent']
}

/**
 * Tools a restriction never stops: they change nothing and only steer the turn
 * (load another skill, ask the user, keep the task list, present a plan).
 */
const ALWAYS_ALLOWED = new Set(['skill', 'ask_user', 'todo_write', 'present_plan'])

function wildcard(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${esc}$`, 'i')
}

/**
 * Whether `tool` is among a skill's `allowed-tools` patterns. An entry may carry an
 * argument scope (`Bash(git:*)`); Houston can't hold a tool to one, so the entry
 * names the whole tool. `*` is a wildcard (`mcp__github__*`).
 */
export function toolMatchesAllowed(patterns: readonly string[], tool: string): boolean {
  if (ALWAYS_ALLOWED.has(tool)) return true
  for (const raw of patterns) {
    const entry = raw.replace(/\(.*$/, '').trim()
    if (!entry) continue
    const alias = TOOL_ALIASES[entry.toLowerCase().replace(/[_-]/g, '')]
    if (alias?.includes(tool)) return true
    if (wildcard(entry).test(tool)) return true
  }
  return false
}

/** An active skill that narrows the tools: its name and its `allowed-tools`. */
export interface SkillRestriction {
  skill: string
  allowedTools: readonly string[]
}

/**
 * The restriction that stops `tool`, or null when it may run. Restrictions only
 * ever narrow: with two skills active, a tool runs only when both allow it.
 */
export function blockingRestriction(restrictions: readonly SkillRestriction[], tool: string): SkillRestriction | null {
  return restrictions.find((r) => !toolMatchesAllowed(r.allowedTools, tool)) ?? null
}

/** The refusal a blocked call returns to the model. */
export function skillRestrictionRefusal(r: SkillRestriction, tool: string): string {
  return `Not run: the "${r.skill}" skill is active for this turn and limits tools to: ${r.allowedTools.join(' ')}. ${tool} is not among them. Finish with the allowed tools, or tell the user what else is needed.`
}

/** A glob as a regex over a `/`-separated relative path. */
export function pathGlob(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  // A pattern with no slash matches the file name at any depth, as in .gitignore.
  if (!g.includes('/')) g = `**/${g}`
  if (g.startsWith('/')) g = g.slice(1)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` is zero or more folders; a trailing `**` is anything below.
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const close = g.indexOf('}', i)
      if (close === -1) re += '\\{'
      else {
        const alts = g.slice(i + 1, close).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        re += `(?:${alts.join('|')})`
        i = close
      }
    } else re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** `path` as a `/`-separated path relative to the workspace, or null when it is outside. */
export function workspaceRelative(workspace: string, path: string): string | null {
  const rel = isAbsolute(path) ? relative(workspace, path) : path
  const norm = rel.split(sep).join('/').replace(/^\.\//, '')
  if (!norm || norm === '..' || norm.startsWith('../') || isAbsolute(norm)) return null
  return norm
}

/** Whether any of a skill's `paths:` globs matches a workspace-relative path. */
export function skillMatchesPath(globs: readonly string[], relPath: string): boolean {
  return globs.some((g) => {
    try {
      return pathGlob(g).test(relPath)
    } catch {
      return false
    }
  })
}

/** Starts the note that surfaces path-matched skills, so earlier ones can be found. */
export const SKILL_PATH_NOTE_HEAD = 'A skill matches a file you just worked on'

/**
 * The note for skills whose `paths:` matched a file the agent touched, or null when
 * there are none. One line per skill: its name and description, as in the skill list.
 */
export function skillPathNote(matches: ReadonlyArray<{ name: string; description: string; file: string }>): string | null {
  if (!matches.length) return null
  const lines = matches.map((m) => `- ${m.name} (${m.file}): ${m.description}`)
  return `${SKILL_PATH_NOTE_HEAD}. Load it with the skill tool if it applies to what you are doing:\n${lines.join('\n')}`
}

/** Skill names an earlier path note in `texts` already surfaced. */
export function notedSkillNames(texts: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const t of texts) {
    if (!t.includes(SKILL_PATH_NOTE_HEAD)) continue
    for (const m of t.matchAll(/^- ([\w-]+) \(/gm)) out.add(m[1].toLowerCase())
  }
  return out
}
