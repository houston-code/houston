import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path'
import { minimatch } from 'minimatch'
import type {
  AgentQuestion,
  DocumentAttachment,
  JSONSchema,
  QuestionOption,
  ToolSchema
} from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { formatTodoList, formatTodoSummary, parseTodos } from '@shared/todos'
import {
  formatSweepList,
  formatSweepSummary,
  parseSweepItems,
  parseSweepMode
} from '@shared/sweep'
import { isSafeGitRef } from '@shared/git'
import { ASK_USER_TOOL, WEB_SEARCH_KEY_ID } from '@shared/constants'
import {
  MAX_ATTACH_IMAGE_BYTES,
  MAX_PDF_BYTES,
  humanSize,
  imageMediaTypeForPath,
  isPdfPath
} from './attachments'
import { clampToolResult, runSandboxed, spawnSandboxed } from '../sandbox'
import { killShell, readShellOutput, registerShell } from './shells'
import { runInSession, type ShellSession } from './shell-session'
import { fetchUrlAsText } from './webfetch'
import type { CaptureInput, LocalhostCapture } from './viewlocalhost'
import { tavilySearch } from './websearch'
import { resolveRipgrep, searchContents, SKIP_DIRS } from './search'
import { resolveAstGrep, searchStructural } from './astgrep'
import { resolveEdit } from './edit-match'
import { bundledRipgrep, bundledAstGrep } from '../binaries'
import { parsePatch } from './apply-patch'
import { resolveGh, runGh, type GhExec } from './github'

export type ToolKind = 'read' | 'write' | 'shell' | 'network' | 'mcp'

export interface ToolContext {
  /** Canonical (realpath'd) workspace root (the primary directory). */
  workspace: string
  /** All allowed roots (workspace + added directories). Defaults to [workspace]. */
  roots?: string[]
  allowNetwork: boolean
  signal?: AbortSignal
  /** Read a secret (e.g. the web-search key) from the main-process secrets store. */
  getSecret?: (id: string) => string | null
  /** Run a read-only research subagent (injected by the loop, which has the provider). */
  dispatchSubAgent?: (prompt: string, agent?: string) => Promise<string>
  /** Run an adversarial multi-agent review of the uncommitted changes (injected by the loop). */
  dispatchReview?: (base?: string) => Promise<string>
  /** Attach an image read by the agent to the tool result (injected by the loop). */
  attachImage?: (img: ImageAttachment) => void
  /** Attach a document (e.g. PDF) read by the agent to the tool result. */
  attachDocument?: (doc: DocumentAttachment) => void
  /** Screenshot + console-capture a loopback URL (injected by the loop; Electron-backed). */
  captureLocalhost?: (input: CaptureInput) => Promise<LocalhostCapture>
  /** Persistent shell state (cwd + exported env) shared across run_shell calls in a run. */
  shellSession?: ShellSession
  /** Max bytes of a single shell command's output kept in a tool result (context guard). */
  shellOutputMaxBytes?: number
  /** Run a `gh` subcommand (injected by the loop; falls back to PATH resolution). */
  ghExec?: GhExec
  /** Ask the user a structured question and resolve with their answer (injected by the loop). */
  askUser?: (q: AgentQuestion) => Promise<string>
}

export interface ToolDef {
  schema: ToolSchema
  kind: ToolKind
  /**
   * Blocked outright in plan mode, regardless of `kind`. Use for tools that
   * mutate remote/repo state through the network (e.g. opening a PR, posting a
   * comment, switching branches) — `kind:'network'` alone only prompts, but plan
   * mode is read-only, so these must be refused like a write/shell call.
   */
  blockedInPlan?: boolean
  /** Short human-readable description of a specific call, for the approval UI. */
  summarize: (args: Record<string, unknown>) => string
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const MAX_READ_CHARS = 100_000
const MAX_GLOB_RESULTS = 200

/** Whether `abs` is `root` itself or lives inside it. */
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve a user-supplied path against the workspace and reject anything that escapes it. */
export function resolveInWorkspace(workspace: string, p: string): string {
  return resolveInRoots([workspace], p)
}

/**
 * Resolve a user-supplied path and reject anything outside every allowed root.
 * Relative paths resolve against the first root (the primary workspace);
 * absolute paths must fall within one of the roots. This is the file-tool
 * containment boundary, so it must stay airtight.
 */
export function resolveInRoots(roots: string[], p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('A path is required.')
  if (roots.length === 0) throw new Error('No allowed roots configured.')
  const base = roots[0]
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p)
  if (roots.some((root) => isWithin(root, abs))) return abs
  throw new Error(`Path escapes the allowed roots: ${p}`)
}

/** The allowed roots for a tool call (workspace plus any added directories). */
function rootsOf(ctx: ToolContext): string[] {
  return ctx.roots && ctx.roots.length ? ctx.roots : [ctx.workspace]
}

/** Whether a path exists (file or directory). */
async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs)
    return true
  } catch {
    return false
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const objectSchema = (properties: JSONSchema, required: string[]): JSONSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

const readFile: ToolDef = {
  kind: 'read',
  summarize: (a) => {
    const offset = num(a, 'offset')
    const limit = num(a, 'limit')
    if (offset !== undefined || limit !== undefined) {
      return `Read ${str(a, 'path')} (lines ${offset ?? 1}${limit !== undefined ? `–${(offset ?? 1) + limit - 1}` : '+'})`
    }
    return `Read ${str(a, 'path')}`
  },
  schema: {
    name: 'read_file',
    description:
      'Read a file within the project. For text files, returns the text (pass offset/limit, 1-based line numbers, to read just a slice of a large file). Images (PNG/JPEG/GIF/WebP) and PDFs are returned as attachments the model can view directly.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the project root.' },
        offset: {
          type: 'number',
          description: 'First line to read (1-based). Omit to start at the beginning.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read from offset. Omit to read to the end.'
        }
      },
      ['path']
    )
  },
  async execute(args, ctx) {
    const rel = str(args, 'path')
    const abs = resolveInRoots(rootsOf(ctx), rel)

    // Images and PDFs are binary — hand them to the model as attachments rather
    // than returning garbled bytes as text.
    const imageType = imageMediaTypeForPath(rel)
    if (imageType) {
      const buf = await fs.readFile(abs)
      if (buf.byteLength > MAX_ATTACH_IMAGE_BYTES) {
        return `[image: ${rel} (${humanSize(buf.byteLength)}) — too large to attach; limit is ${humanSize(MAX_ATTACH_IMAGE_BYTES)}]`
      }
      if (!ctx.attachImage) {
        return `[image: ${rel} (${humanSize(buf.byteLength)}) — cannot be displayed in this context]`
      }
      ctx.attachImage({ mediaType: imageType, data: buf.toString('base64') })
      return `[image: ${rel} (${imageType}, ${humanSize(buf.byteLength)}) — attached below for viewing]`
    }
    if (isPdfPath(rel)) {
      const buf = await fs.readFile(abs)
      if (buf.byteLength > MAX_PDF_BYTES) {
        return `[pdf: ${rel} (${humanSize(buf.byteLength)}) — too large to attach; limit is ${humanSize(MAX_PDF_BYTES)}. Extract its text with run_shell (e.g. pdftotext) instead.]`
      }
      if (!ctx.attachDocument) {
        return `[pdf: ${rel} (${humanSize(buf.byteLength)}) — cannot be displayed in this context; extract its text with run_shell (e.g. pdftotext)]`
      }
      ctx.attachDocument({ mediaType: 'application/pdf', data: buf.toString('base64'), name: rel })
      return `[pdf: ${rel} (${humanSize(buf.byteLength)}) — attached below for viewing]`
    }

    const data = await fs.readFile(abs, 'utf8')
    const offset = num(args, 'offset')
    const limit = num(args, 'limit')

    if (offset !== undefined || limit !== undefined) {
      const lines = data.split('\n')
      const start = Math.max(0, (offset ?? 1) - 1)
      const end = limit !== undefined ? start + Math.max(0, Math.floor(limit)) : lines.length
      const sliced = lines.slice(start, end)
      if (sliced.length === 0) {
        return `[no lines in range: offset ${start + 1}, file has ${lines.length} line${
          lines.length === 1 ? '' : 's'
        }]`
      }
      const slice = sliced.join('\n')
      const body =
        slice.length > MAX_READ_CHARS ? `${slice.slice(0, MAX_READ_CHARS)}\n[truncated]` : slice
      // shownEnd is derived from the actual slice length, so the range is never reversed.
      return `[lines ${start + 1}-${start + sliced.length} of ${lines.length}]\n${body}`
    }

    if (data.length > MAX_READ_CHARS) {
      return `${data.slice(0, MAX_READ_CHARS)}\n[truncated: file is ${data.length} chars]`
    }
    return data || '[empty file]'
  }
}

const writeFile: ToolDef = {
  kind: 'write',
  summarize: (a) => `Write ${str(a, 'path')}`,
  schema: {
    name: 'write_file',
    description:
      'Create or overwrite a text file within the project with the given content. Creates parent directories as needed.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the project root.' },
        content: { type: 'string', description: 'The full file contents to write.' }
      },
      ['path', 'content']
    )
  },
  async execute(args, ctx) {
    const abs = resolveInRoots(rootsOf(ctx), str(args, 'path'))
    const content = str(args, 'content')
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    return `Wrote ${Buffer.byteLength(content)} bytes to ${str(args, 'path')}.`
  }
}

const editFile: ToolDef = {
  kind: 'write',
  summarize: (a) => `Edit ${str(a, 'path')}`,
  schema: {
    name: 'edit_file',
    description:
      'Replace a string in a file with a new string. The old string is matched verbatim first; if that fails it is matched ignoring each line\'s indentation/whitespace (so minor drift does not lose the edit). By default the old string must resolve to exactly one match; set replace_all to replace every occurrence.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the project root.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
      },
      ['path', 'old_string', 'new_string']
    )
  },
  async execute(args, ctx) {
    const abs = resolveInRoots(rootsOf(ctx), str(args, 'path'))
    const oldStr = str(args, 'old_string')
    const newStr = str(args, 'new_string')
    const replaceAll = args.replace_all === true
    const data = await fs.readFile(abs, 'utf8')
    const { content, strategy, replacements } = resolveEdit(data, oldStr, newStr, replaceAll)
    await fs.writeFile(abs, content, 'utf8')
    const fuzzy = strategy === 'exact' ? '' : ` [matched via ${strategy}]`
    return `Edited ${str(args, 'path')} (${replacements} replacement${
      replacements === 1 ? '' : 's'
    })${fuzzy}.`
  }
}

interface EditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** Apply one find/replace to `data` via the resilient matcher, with per-edit error context. */
function applyEdit(data: string, edit: EditSpec, index: number): string {
  const oldStr = typeof edit.old_string === 'string' ? edit.old_string : ''
  const newStr = typeof edit.new_string === 'string' ? edit.new_string : ''
  try {
    return resolveEdit(data, oldStr, newStr, edit.replace_all === true).content
  } catch (e) {
    throw new Error(`edit ${index + 1}: ${(e as Error).message}`, { cause: e })
  }
}

const multiEdit: ToolDef = {
  kind: 'write',
  summarize: (a) => {
    const n = Array.isArray(a.edits) ? a.edits.length : 0
    return `Edit ${str(a, 'path')} (${n} edit${n === 1 ? '' : 's'})`
  },
  schema: {
    name: 'multi_edit',
    description:
      'Apply several exact-string replacements to a single file in one atomic operation. The edits are applied in order (each later edit sees the result of the earlier ones), and the file is only written if every edit succeeds. Each edit follows the same rules as edit_file: old_string must occur exactly once unless replace_all is set. Prefer this over multiple edit_file calls when changing several places in the same file.',
    parameters: objectSchema(
      {
        path: { type: 'string', description: 'Path relative to the project root.' },
        edits: {
          type: 'array',
          description: 'The edits to apply, in order.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'The exact text to replace.' },
              new_string: { type: 'string', description: 'The replacement text.' },
              replace_all: {
                type: 'boolean',
                description: 'Replace every occurrence of this edit (default false).'
              }
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false
          }
        }
      },
      ['path', 'edits']
    )
  },
  async execute(args, ctx) {
    const abs = resolveInRoots(rootsOf(ctx), str(args, 'path'))
    const edits = args.edits
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error('edits must be a non-empty array.')
    }
    let data = await fs.readFile(abs, 'utf8')
    edits.forEach((edit, i) => {
      data = applyEdit(data, (edit ?? {}) as EditSpec, i)
    })
    await fs.writeFile(abs, data, 'utf8')
    return `Edited ${str(args, 'path')} (${edits.length} edit${edits.length === 1 ? '' : 's'}).`
  }
}

/** A staged file mutation computed before anything is written, for atomic apply. */
interface StagedChange {
  abs: string
  /** null = delete the file; string = write this content. */
  content: string | null
  verb: 'add' | 'update' | 'delete'
}

const applyPatch: ToolDef = {
  kind: 'write',
  summarize: (a) => {
    let n = 0
    try {
      n = parsePatch(str(a, 'patch')).length
    } catch {
      /* shown as a failed call instead */
    }
    return `Apply patch (${n} file${n === 1 ? '' : 's'})`
  },
  schema: {
    name: 'apply_patch',
    description:
      'Apply a multi-file patch in one atomic operation using the OpenAI patch format: an envelope between "*** Begin Patch" and "*** End Patch" containing "*** Add File: <path>" (with +lines), "*** Update File: <path>" (optionally followed by "*** Move to: <path>", then @@/space/-/+ hunks), and "*** Delete File: <path>". Either every change applies or none does. Prefer this when a single change spans several files; use edit_file/multi_edit for one file.',
    parameters: objectSchema(
      { patch: { type: 'string', description: 'The patch envelope.' } },
      ['patch']
    )
  },
  async execute(args, ctx) {
    const roots = rootsOf(ctx)
    const ops = parsePatch(str(args, 'patch'))
    const staged: StagedChange[] = []
    let added = 0
    let updated = 0
    let deleted = 0

    // Phase 1: validate and compute every change. Nothing is written yet, so a
    // failure on any op leaves the working tree untouched.
    for (const op of ops) {
      const abs = resolveInRoots(roots, op.path)
      if (op.type === 'add') {
        if (await exists(abs)) throw new Error(`Add File: ${op.path} already exists.`)
        staged.push({ abs, content: op.content, verb: 'add' })
        added += 1
      } else if (op.type === 'delete') {
        if (!(await exists(abs))) throw new Error(`Delete File: ${op.path} does not exist.`)
        staged.push({ abs, content: null, verb: 'delete' })
        deleted += 1
      } else {
        let data: string
        try {
          data = await fs.readFile(abs, 'utf8')
        } catch {
          throw new Error(`Update File: ${op.path} does not exist.`)
        }
        for (const hunk of op.hunks) data = resolveEdit(data, hunk.oldText, hunk.newText).content
        if (op.moveTo) {
          const target = resolveInRoots(roots, op.moveTo)
          if (target !== abs && (await exists(target))) {
            throw new Error(`Move to: ${op.moveTo} already exists.`)
          }
          staged.push({ abs, content: null, verb: 'delete' })
          staged.push({ abs: target, content: data, verb: 'update' })
        } else {
          staged.push({ abs, content: data, verb: 'update' })
        }
        updated += 1
      }
    }

    // Phase 2: commit. Deletes first so a Move's delete can't clobber its target.
    for (const change of staged.filter((c) => c.content === null)) {
      await fs.rm(change.abs, { force: true })
    }
    for (const change of staged.filter((c) => c.content !== null)) {
      await fs.mkdir(dirname(change.abs), { recursive: true })
      await fs.writeFile(change.abs, change.content as string, 'utf8')
    }
    return `Applied patch: ${ops.length} file${ops.length === 1 ? '' : 's'} (${added} added, ${updated} updated, ${deleted} deleted).`
  }
}

const listDir: ToolDef = {
  kind: 'read',
  summarize: (a) => `List ${str(a, 'path') || '.'}`,
  schema: {
    name: 'list_dir',
    description: 'List the entries in a directory within the project.',
    parameters: objectSchema(
      { path: { type: 'string', description: 'Directory path relative to the project root (default ".").' } },
      []
    )
  },
  async execute(args, ctx) {
    const target = str(args, 'path') || '.'
    const abs = resolveInRoots(rootsOf(ctx), target)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    if (entries.length === 0) return '[empty directory]'
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n')
  }
}

const searchTool: ToolDef = {
  kind: 'read',
  summarize: (a) => `Search "${str(a, 'pattern')}"`,
  schema: {
    name: 'search_files',
    description:
      'Search file contents across the project using a regular expression. Returns matching "path:line: text" entries. Uses a bundled ripgrep for speed, falling back to a built-in scan. Skips node_modules, .git, and build output.',
    parameters: objectSchema(
      {
        pattern: { type: 'string', description: 'A regular expression.' },
        path: { type: 'string', description: 'Subdirectory to search within (default project root).' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match (default false).' },
        glob: {
          type: 'string',
          description: 'Only search files whose path matches this glob (e.g. "*.ts", "src/**/*.tsx").'
        },
        context: {
          type: 'number',
          description: 'Lines of context to show before and after each match (like grep -C).'
        },
        files_with_matches: {
          type: 'boolean',
          description: 'Return only the matching file paths, not the matching lines (default false).'
        }
      },
      ['pattern']
    )
  },
  async execute(args, ctx) {
    const startAbs = resolveInRoots(rootsOf(ctx), str(args, 'path') || '.')
    const context = num(args, 'context')
    return searchContents({
      pattern: str(args, 'pattern'),
      workspace: ctx.workspace,
      searchRel: relative(ctx.workspace, startAbs) || '.',
      startAbs,
      // Prefer the ripgrep we bundle with the packaged app; fall back to a
      // ripgrep on PATH (dev) and then a pure-JS scan (rgPath: null).
      rgPath: bundledRipgrep() ?? resolveRipgrep(),
      max: 100,
      signal: ctx.signal,
      ignoreCase: args.ignore_case === true,
      glob: str(args, 'glob') || undefined,
      context: context !== undefined ? Math.max(0, Math.floor(context)) : undefined,
      filesWithMatches: args.files_with_matches === true
    })
  }
}

const astGrepTool: ToolDef = {
  kind: 'read',
  summarize: (a) => `Structural search ${str(a, 'pattern')}${str(a, 'lang') ? ` (${str(a, 'lang')})` : ''}`,
  schema: {
    name: 'ast_grep',
    description:
      'Structural (AST-aware) code search using ast-grep. Matches code by syntax-tree shape rather than text, so it ignores formatting/whitespace and supports meta-variables: $NAME matches one node, $$$ARGS matches a list. Examples: "console.log($A)", "function $F($$$) { $$$ }", "useEffect($CB, [])". Returns matching "path:line:col: text" entries. Prefer this over search_files when you want occurrences of a code *pattern* (calls, declarations, JSX elements) without regex false positives. Requires the language of the code.',
    parameters: objectSchema(
      {
        pattern: {
          type: 'string',
          description: 'An ast-grep structural pattern, e.g. "console.log($A)" or "function $F($$$) { $$$ }".'
        },
        lang: {
          type: 'string',
          description: 'Language of the pattern/files: ts, tsx, js, jsx, py, rust, go, java, c, cpp, ruby, etc.'
        },
        path: { type: 'string', description: 'Subdirectory to search within (default project root).' }
      },
      ['pattern', 'lang']
    )
  },
  async execute(args, ctx) {
    const startAbs = resolveInRoots(rootsOf(ctx), str(args, 'path') || '.')
    return searchStructural({
      pattern: str(args, 'pattern'),
      lang: str(args, 'lang'),
      workspace: ctx.workspace,
      searchRel: relative(ctx.workspace, startAbs) || '.',
      // Prefer the ast-grep we bundle with the packaged app; fall back to one on PATH (dev).
      binPath: bundledAstGrep() ?? resolveAstGrep(),
      max: 100,
      signal: ctx.signal
    })
  }
}

async function collectGlob(
  dir: string,
  base: string,
  pattern: string,
  out: { full: string; mtimeMs: number }[],
  max: number
): Promise<void> {
  if (out.length >= max) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= max) return
    if (entry.name.startsWith('.')) continue // honour default glob dot:false
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectGlob(full, base, pattern, out, max)
    } else if (entry.isFile() && minimatch(relative(base, full), pattern)) {
      try {
        const st = await fs.stat(full)
        out.push({ full, mtimeMs: st.mtimeMs })
      } catch {
        out.push({ full, mtimeMs: 0 })
      }
    }
  }
}

const globTool: ToolDef = {
  kind: 'read',
  summarize: (a) => `Glob ${str(a, 'pattern')}`,
  schema: {
    name: 'glob',
    description:
      'Find files whose path matches a glob pattern (e.g. "**/*.ts", "src/**/*.test.tsx"). Returns matching paths relative to the project root, most-recently-modified first. Skips node_modules, .git, dotfiles, and build output.',
    parameters: objectSchema(
      {
        pattern: { type: 'string', description: 'A glob pattern, e.g. "**/*.ts" or "src/*.json".' },
        path: {
          type: 'string',
          description:
            'Directory to search within (default project root). The pattern is matched relative to this directory.'
        }
      },
      ['pattern']
    )
  },
  async execute(args, ctx) {
    const pattern = str(args, 'pattern')
    if (!pattern) throw new Error('pattern is required.')
    const start = resolveInRoots(rootsOf(ctx), str(args, 'path') || '.')
    const found: { full: string; mtimeMs: number }[] = []
    await collectGlob(start, start, pattern, found, MAX_GLOB_RESULTS)
    if (found.length === 0) return 'No files found.'
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const lines = found.map((f) => relative(ctx.workspace, f.full)).join('\n')
    return found.length >= MAX_GLOB_RESULTS ? `${lines}\n[truncated at ${MAX_GLOB_RESULTS} matches]` : lines
  }
}

const runShell: ToolDef = {
  kind: 'shell',
  summarize: (a) => (a.background === true ? `${str(a, 'command')} (background)` : str(a, 'command')),
  schema: {
    name: 'run_shell',
    description:
      'Run a shell command inside a macOS Seatbelt sandbox confined to the project directory. Writes are limited to the project and temp dirs. Returns combined stdout/stderr and the exit code. Foreground commands share a persistent session within a turn: `cd` and exported environment variables carry over to later run_shell calls (e.g. `cd build` then `make`, or activate a virtualenv once). Set background:true for long-running commands (e.g. a dev server or watcher): it returns immediately with a shell id you can poll with read_shell_output and stop with kill_shell.',
    parameters: objectSchema(
      {
        command: { type: 'string', description: 'The shell command to run (executed with /bin/bash -c).' },
        background: {
          type: 'boolean',
          description: 'Run without waiting and return a shell id (default false). Use for long-running processes.'
        }
      },
      ['command']
    )
  },
  async execute(args, ctx) {
    const command = str(args, 'command')
    if (!command) throw new Error('command is required.')

    if (args.background === true) {
      const child = spawnSandboxed({
        command,
        cwd: ctx.workspace,
        workspace: ctx.workspace,
        roots: rootsOf(ctx),
        allowNetwork: ctx.allowNetwork,
        signal: ctx.signal
      })
      const id = registerShell(command, child)
      return `Started background shell ${id}. Poll it with read_shell_output({ shell_id: "${id}" }) and stop it with kill_shell({ shell_id: "${id}" }).`
    }

    const result = ctx.shellSession
      ? await runInSession({
          command,
          session: ctx.shellSession,
          workspace: ctx.workspace,
          roots: rootsOf(ctx),
          allowNetwork: ctx.allowNetwork,
          signal: ctx.signal,
          run: runSandboxed
        })
      : await runSandboxed({
          command,
          cwd: ctx.workspace,
          workspace: ctx.workspace,
          roots: rootsOf(ctx),
          allowNetwork: ctx.allowNetwork,
          signal: ctx.signal
        })
    const segments: string[] = []
    if (result.stdout) segments.push(result.stdout.trimEnd())
    if (result.stderr) segments.push(result.stderr.trimEnd())
    // Clamp the combined output to the context budget before the status markers,
    // which are tiny and must always survive, so one runaway command can't swamp
    // the window. (The 1 MB per-stream cap is only a memory bound; see sandbox.ts.)
    const parts: string[] = []
    const body = clampToolResult(segments.join('\n'), ctx.shellOutputMaxBytes)
    if (body) parts.push(body)
    if (result.timedOut) parts.push('[command timed out]')
    parts.push(`[exit code: ${result.exitCode ?? 'killed'}]`)
    return parts.join('\n')
  }
}

const readShellOutputTool: ToolDef = {
  kind: 'read',
  summarize: (a) => `Read output of shell ${str(a, 'shell_id')}`,
  schema: {
    name: 'read_shell_output',
    description:
      'Read new output from a background shell started by run_shell. By default returns only output produced since the last read; set full:true for everything buffered. Also reports whether the shell is still running and its exit code.',
    parameters: objectSchema(
      {
        shell_id: { type: 'string', description: 'The id returned by run_shell with background:true.' },
        full: { type: 'boolean', description: 'Return all buffered output, not just new output (default false).' }
      },
      ['shell_id']
    )
  },
  async execute(args, ctx) {
    const id = str(args, 'shell_id')
    if (!id) throw new Error('shell_id is required.')
    const r = readShellOutput(id, { full: args.full === true })
    if (!r.found) return `No background shell with id ${id}.`
    const segments: string[] = []
    if (r.stdout) segments.push(r.stdout.trimEnd())
    if (r.stderr) segments.push(r.stderr.trimEnd())
    // Same context-budget clamp as foreground run_shell — a `full:true` read can
    // otherwise return the entire 2 MB rolling buffer (see shells.ts MAX_BUF).
    const parts: string[] = []
    const body = clampToolResult(segments.join('\n'), ctx.shellOutputMaxBytes)
    if (body) parts.push(body)
    parts.push(r.running ? '[still running]' : `[exited with code ${r.exitCode ?? 'killed'}]`)
    return parts.join('\n')
  }
}

const killShellTool: ToolDef = {
  kind: 'read', // only affects a process the agent itself started — no approval needed
  summarize: (a) => `Kill shell ${str(a, 'shell_id')}`,
  schema: {
    name: 'kill_shell',
    description: 'Stop a background shell started by run_shell.',
    parameters: objectSchema(
      { shell_id: { type: 'string', description: 'The id returned by run_shell with background:true.' } },
      ['shell_id']
    )
  },
  async execute(args) {
    const id = str(args, 'shell_id')
    if (!id) throw new Error('shell_id is required.')
    return killShell(id) ? `Killed background shell ${id}.` : `No background shell with id ${id}.`
  }
}

const webFetch: ToolDef = {
  kind: 'network',
  summarize: (a) => `Fetch ${str(a, 'url')}`,
  schema: {
    name: 'web_fetch',
    description:
      'Fetch a URL over http/https and return its contents as text (HTML is converted to readable text). Use for documentation, references, or APIs. Network egress always requires approval. Private and loopback addresses are blocked.',
    parameters: objectSchema(
      { url: { type: 'string', description: 'An http or https URL to fetch.' } },
      ['url']
    )
  },
  async execute(args, ctx) {
    const url = str(args, 'url')
    if (!url) throw new Error('url is required.')
    return fetchUrlAsText(url, { signal: ctx.signal, maxBytes: MAX_READ_CHARS * 2 })
  }
}

const viewLocalhost: ToolDef = {
  kind: 'network',
  summarize: (a) => `View ${str(a, 'url')}`,
  schema: {
    name: 'view_localhost',
    description:
      'Load a localhost/loopback URL (e.g. a dev server you started with run_shell) in a headless browser, take a screenshot, and capture the page\'s console output. The screenshot is returned as an image you can view directly — so you can SEE the web UI you built and iterate on it, instead of guessing. Only loopback hosts (localhost, 127.0.0.1, ::1) are allowed; use web_fetch for public URLs. This is local network egress, so it always requires approval.',
    parameters: objectSchema(
      {
        url: { type: 'string', description: 'A loopback URL to load, e.g. "http://localhost:3000".' },
        selector: {
          type: 'string',
          description:
            'Optional CSS selector — screenshot just that element\'s bounding box instead of the whole viewport (e.g. "#app", ".hero").'
        }
      },
      ['url']
    )
  },
  async execute(args, ctx) {
    const url = str(args, 'url')
    if (!url) throw new Error('url is required.')
    if (!ctx.captureLocalhost) throw new Error('view_localhost is not available in this context.')
    const selector = str(args, 'selector') || undefined
    const cap = await ctx.captureLocalhost({ url, selector, signal: ctx.signal })

    const lines: string[] = []
    lines.push(`Loaded ${cap.finalUrl}${cap.title ? ` — "${cap.title}"` : ''} (${cap.width}×${cap.height})`)
    if (cap.loadError) lines.push(`[load warning: ${cap.loadError}]`)
    if (selector) {
      lines.push(
        cap.selectorMissed
          ? `[selector "${selector}" matched nothing — captured the full viewport]`
          : `[captured element matching "${selector}"]`
      )
    }

    const bytes = cap.png.byteLength
    if (bytes > MAX_ATTACH_IMAGE_BYTES) {
      lines.push(
        `[screenshot ${humanSize(bytes)} exceeds the ${humanSize(MAX_ATTACH_IMAGE_BYTES)} attach limit — not shown]`
      )
    } else if (!ctx.attachImage) {
      lines.push(`[screenshot ${humanSize(bytes)} captured — cannot be displayed in this context]`)
    } else {
      ctx.attachImage({ mediaType: 'image/png', data: cap.png.toString('base64') })
      lines.push(`[screenshot (${humanSize(bytes)}) attached below for viewing]`)
    }

    lines.push('')
    lines.push(
      cap.console.length
        ? `Console output (${cap.console.length} line${cap.console.length === 1 ? '' : 's'}):\n${cap.console.join('\n')}`
        : 'Console output: (none)'
    )
    return lines.join('\n')
  }
}

const todoWrite: ToolDef = {
  kind: 'read', // a scratchpad with no side effects on the project — never needs approval
  summarize: (a) => {
    try {
      return formatTodoSummary(parseTodos(a.todos))
    } catch {
      return 'Update todo list'
    }
  },
  schema: {
    name: 'todo_write',
    description:
      'Record or update your task list — a scratchpad for planning and tracking multi-step work. Pass the FULL list every time (it replaces the previous one). Use it to break a complex task into steps and to track progress; keep exactly one item "in_progress" while you work on it and mark items "completed" as you finish. Has no side effects on the project.',
    parameters: objectSchema(
      {
        todos: {
          type: 'array',
          description: 'The full todo list, replacing any previous one.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What needs to be done.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current status of this item.'
              }
            },
            required: ['content', 'status'],
            additionalProperties: false
          }
        }
      },
      ['todos']
    )
  },
  async execute(args) {
    const todos = parseTodos(args.todos)
    const summary = formatTodoSummary(todos)
    return todos.length ? `${summary}\n${formatTodoList(todos)}` : summary
  }
}

const prSweep: ToolDef = {
  kind: 'read', // a scratchpad with no side effects on the project — never needs approval
  summarize: (a) => {
    try {
      return formatSweepSummary(parseSweepMode(a.mode), parseSweepItems(a.items))
    } catch {
      return 'Update PR sweep'
    }
  },
  schema: {
    name: 'pr_sweep',
    description:
      'Plan and track a multi-PR sweep — a board, like todo_write but specialized for working a batch of pull requests. Pass the FULL list of items every time (it replaces the previous one); keep exactly one item "in_progress" and advance each item\'s status as you go. This tool only records state — it has no side effects; you do the real work with the other tools.\n\nTwo modes:\n- "author": turn each task into its own PR. For each item: create a branch (e.g. `git worktree add` or `git checkout -b` via run_shell), make the change, commit, push the branch (`git push -u origin <branch>`), then gh_pr_create. Status flow: pending → in_progress → pushed → pr_open → done (or failed). Record the branch and the PR url as you get them.\n- "process": work a list of existing open PRs (find them with gh_pr_list). For each item: gh_pr_checkout the PR, review/fix it (run_shell/review_changes), commit, push, gh_pr_comment if needed, then mark done. Record the PR reference.\n\nWork items one at a time, update this board after each meaningful step, and put a short note on anything that fails or needs the user.',
    parameters: objectSchema(
      {
        mode: {
          type: 'string',
          enum: ['author', 'process'],
          description: '"author" to create new PRs from tasks; "process" to work existing PRs.'
        },
        items: {
          type: 'array',
          description: 'The full sweep board, replacing any previous one.',
          items: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'What this item is — the task to author, or the existing PR to process.'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'pushed', 'pr_open', 'done', 'failed'],
                description: 'Current status of this item.'
              },
              branch: {
                type: 'string',
                description: 'The branch worked on (author) or the PR head branch (process).'
              },
              pr: { type: 'string', description: 'PR reference once known — a number, "#123", or a URL.' },
              note: { type: 'string', description: 'Short note: a blocker, what was done, or why it failed.' }
            },
            required: ['task', 'status'],
            additionalProperties: false
          }
        }
      },
      ['mode', 'items']
    )
  },
  async execute(args) {
    const mode = parseSweepMode(args.mode)
    const items = parseSweepItems(args.items)
    const summary = formatSweepSummary(mode, items)
    return items.length ? `${summary}\n${formatSweepList(items)}` : summary
  }
}

const webSearch: ToolDef = {
  kind: 'network',
  summarize: (a) => `Search the web: ${str(a, 'query')}`,
  schema: {
    name: 'web_search',
    description:
      'Search the web and return the top results (title, URL, snippet) plus a short synthesized answer. Use for current information or docs you cannot find in the project. Network egress requires approval. Requires a Tavily API key set in Settings.',
    parameters: objectSchema(
      {
        query: { type: 'string', description: 'The search query.' },
        max_results: { type: 'number', description: 'Maximum results to return (1–10, default 5).' }
      },
      ['query']
    )
  },
  async execute(args, ctx) {
    const query = str(args, 'query')
    if (!query) throw new Error('query is required.')
    const key = ctx.getSecret?.(WEB_SEARCH_KEY_ID)
    if (!key) {
      throw new Error('No web-search API key set. Add a Tavily API key in Settings to enable web_search.')
    }
    return tavilySearch(query, key, { signal: ctx.signal, maxResults: num(args, 'max_results') })
  }
}

const dispatchAgent: ToolDef = {
  kind: 'read', // spawns a read-only subagent — no side effects, no approval needed
  summarize: (a) => `Subagent: ${str(a, 'description') || 'research task'}`,
  schema: {
    name: 'dispatch_agent',
    description:
      'Delegate a focused, read-only research task to a subagent with its own fresh context. The subagent can read, list, glob, and search the project (it cannot edit, run commands, or use the network) and returns a written report. Use it to investigate a question or locate code without filling your own context with the search — e.g. "find where auth tokens are validated and summarize the flow". Do your own editing based on its report.',
    parameters: objectSchema(
      {
        description: { type: 'string', description: 'A short label for the task (a few words).' },
        prompt: {
          type: 'string',
          description: 'The full task/question for the subagent, with all the context it needs.'
        },
        agent: {
          type: 'string',
          description:
            'Optional: the name of a custom agent (from .houston/agents) to use. Omit for the default research agent.'
        }
      },
      ['description', 'prompt']
    )
  },
  async execute(args, ctx) {
    const prompt = str(args, 'prompt')
    if (!prompt) throw new Error('prompt is required.')
    if (!ctx.dispatchSubAgent) throw new Error('Subagents are not available in this context.')
    return ctx.dispatchSubAgent(prompt, str(args, 'agent') || undefined)
  }
}

const reviewChanges: ToolDef = {
  kind: 'read', // spawns read-only reviewer subagents + read-only git — no side effects, no approval
  summarize: (a) => `Review changes${str(a, 'base') ? ` vs ${str(a, 'base')}` : ''}`,
  schema: {
    name: 'review_changes',
    description:
      'Run an adversarial, multi-agent review of the current uncommitted changes for correctness, security, and quality. It spawns an independent read-only reviewer per dimension (each in its own fresh context, so they don\'t inherit your blind spots), then a skeptical verifier that re-checks every candidate finding against the real code and drops false positives, and returns the confirmed findings. Use it to self-review after completing a substantial change, before telling the user you are done — then fix what it confirms. Reviews uncommitted changes (vs HEAD) by default; pass base to review against another commit or branch.',
    parameters: objectSchema(
      {
        base: {
          type: 'string',
          description:
            'Optional git ref to diff against (e.g. "main" or a commit SHA). Default: HEAD (all uncommitted changes).'
        }
      },
      []
    )
  },
  async execute(args, ctx) {
    if (!ctx.dispatchReview) throw new Error('Review is not available in this context.')
    return ctx.dispatchReview(str(args, 'base') || undefined)
  }
}

// Config keys that let a repo-local .git/config run arbitrary commands when git
// reads or diffs files (diff.external, textconv, fsmonitor, ext-diff, the `ext`
// protocol). We neutralize all of them so inspecting an UNTRUSTED repo can't
// execute code — these tools are kind:'read' and never prompt for approval.
const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never'
]
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0'
}

/**
 * Run a read-only git subcommand with execFile (an argument array — NO shell, so
 * no injection) and config-driven execution neutralized. Returns combined output.
 */
function runReadGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_HARDENING, '--no-pager', ...args],
      { cwd, env: GIT_ENV, timeout: 10_000, maxBuffer: 4_000_000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim()
        if (err && !out) resolve(`[git error: ${(err as Error).message}]`)
        else resolve(out || '[no output]')
      }
    )
  })
}

/** Validate an optional user path against the workspace; return ['--', path] argv or []. */
function gitPathArgs(args: Record<string, unknown>, ctx: ToolContext): string[] {
  const p = str(args, 'path')
  if (!p) return []
  resolveInRoots(rootsOf(ctx), p) // throws if it escapes the workspace
  return ['--', p]
}

const gitStatus: ToolDef = {
  kind: 'read',
  summarize: (a) => `git status${str(a, 'path') ? ` ${str(a, 'path')}` : ''}`,
  schema: {
    name: 'git_status',
    description:
      'Show the working-tree status of the project git repository (staged, unstaged, and untracked changes). Read-only. Optionally restrict to a path.',
    parameters: objectSchema(
      { path: { type: 'string', description: 'Optional path within the project to restrict to.' } },
      []
    )
  },
  async execute(args, ctx) {
    return runReadGit(['status', ...gitPathArgs(args, ctx)], ctx.workspace)
  }
}

const gitDiff: ToolDef = {
  kind: 'read',
  summarize: (a) => `git diff${str(a, 'path') ? ` ${str(a, 'path')}` : ''}`,
  schema: {
    name: 'git_diff',
    description:
      'Show uncommitted changes in the project git repository as a unified diff (both staged and unstaged). Read-only. Optionally restrict to a path.',
    parameters: objectSchema(
      { path: { type: 'string', description: 'Optional path within the project to restrict to.' } },
      []
    )
  },
  async execute(args, ctx) {
    return runReadGit(
      ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', ...gitPathArgs(args, ctx)],
      ctx.workspace
    )
  }
}

// ---- GitHub (gh CLI) ------------------------------------------------------

const MAX_GH_OUTPUT_CHARS = 30_000

/**
 * Resolve the gh runner for a call: the loop-injected one, else a freshly
 * resolved binary. Throws a guiding error (surfaced as a failed tool call) when
 * `gh` isn't installed, so the model can tell the user how to fix it.
 */
function ghRunner(ctx: ToolContext): GhExec {
  if (ctx.ghExec) return ctx.ghExec
  const ghPath = resolveGh()
  if (!ghPath) {
    throw new Error(
      'The GitHub CLI (gh) was not found. Install it from https://cli.github.com and run `gh auth login`, then try again.'
    )
  }
  return runGh(ghPath)
}

/** Turn a gh result into tool output: stdout on success, a useful error otherwise. */
function ghOutput(r: { ok: boolean; stdout: string; stderr: string; code: number | null }): string {
  if (r.ok) {
    const out = r.stdout.trim() || '[no output]'
    return out.length > MAX_GH_OUTPUT_CHARS
      ? `${out.slice(0, MAX_GH_OUTPUT_CHARS)}\n[truncated]`
      : out
  }
  const detail = (r.stderr.trim() || r.stdout.trim() || `gh exited with code ${r.code ?? 'null'}`).slice(
    0,
    MAX_GH_OUTPUT_CHARS
  )
  // gh's own auth error is actionable; pass it through verbatim.
  return `gh failed (exit ${r.code ?? 'null'}): ${detail}`
}

/** Validate an optional positional PR number into argv (`["12"]`) or `[]`. */
function prNumberArgs(args: Record<string, unknown>, required = false): string[] {
  const v = args.number
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error('number (the PR number) is required.')
    return []
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error('number must be a positive integer.')
  return [String(n)]
}

/** Validate an optional git ref (branch) flag, rejecting option-like injection. */
function refFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  const v = str(args, key)
  if (!v) return []
  if (!isSafeGitRef(v)) throw new Error(`Invalid ${key}: "${v}" is not a valid branch/ref name.`)
  return [flag, v]
}

const ghPrCreate: ToolDef = {
  kind: 'network',
  blockedInPlan: true,
  summarize: (a) => `Open PR: ${str(a, 'title') || '(no title)'}`,
  schema: {
    name: 'gh_pr_create',
    description:
      'Open a GitHub pull request for the current branch using the gh CLI. The branch must already be pushed to the remote (push it first with run_shell, e.g. `git push -u origin <branch>`). Requires approval (network) and is refused in plan mode. Returns the new PR URL.',
    parameters: objectSchema(
      {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR description (Markdown). Omit for an empty body.' },
        base: {
          type: 'string',
          description: 'Base branch to merge into (e.g. "main"). Defaults to the repo default branch.'
        },
        head: {
          type: 'string',
          description: 'Head branch the PR is opened from. Defaults to the current branch.'
        },
        draft: { type: 'boolean', description: 'Open as a draft PR (default false).' }
      },
      ['title']
    )
  },
  async execute(args, ctx) {
    const title = str(args, 'title')
    if (!title.trim()) throw new Error('title is required.')
    const argv = ['pr', 'create', '--title', title, '--body', str(args, 'body')]
    argv.push(...refFlag(args, 'base', '--base'))
    argv.push(...refFlag(args, 'head', '--head'))
    if (args.draft === true) argv.push('--draft')
    return ghOutput(await ghRunner(ctx)(argv, ctx.workspace, ctx.signal))
  }
}

const ghPrList: ToolDef = {
  kind: 'network',
  summarize: (a) => `List PRs${str(a, 'state') ? ` (${str(a, 'state')})` : ''}`,
  schema: {
    name: 'gh_pr_list',
    description:
      'List pull requests in the current repository via the gh CLI. Returns "#<number> [state] <title> (<headBranch> by <author>) <url>" per PR. Requires approval (network).',
    parameters: objectSchema(
      {
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all'],
          description: 'Which PRs to list (default open).'
        },
        limit: { type: 'number', description: 'Max PRs to return (1–100, default 30).' },
        author: { type: 'string', description: 'Filter by author login (e.g. "@me" for yours).' },
        label: { type: 'string', description: 'Filter by label.' },
        base: { type: 'string', description: 'Filter by base branch.' }
      },
      []
    )
  },
  async execute(args, ctx) {
    const stateRaw = str(args, 'state') || 'open'
    const state = ['open', 'closed', 'merged', 'all'].includes(stateRaw) ? stateRaw : 'open'
    const limit = Math.min(100, Math.max(1, Math.floor(num(args, 'limit') ?? 30)))
    const argv = [
      'pr',
      'list',
      '--state',
      state,
      '--limit',
      String(limit),
      '--json',
      'number,title,state,isDraft,headRefName,url,author'
    ]
    const author = str(args, 'author')
    if (author) argv.push('--author', author)
    const label = str(args, 'label')
    if (label) argv.push('--label', label)
    argv.push(...refFlag(args, 'base', '--base'))

    const r = await ghRunner(ctx)(argv, ctx.workspace, ctx.signal)
    if (!r.ok) return ghOutput(r)
    return formatPrList(r.stdout)
  }
}

interface PrSummary {
  number: number
  title: string
  state: string
  isDraft: boolean
  headRefName: string
  url: string
  author?: { login?: string }
}

/** Render `gh pr list --json` output into compact one-line-per-PR text. Pure. */
export function formatPrList(json: string): string {
  let prs: PrSummary[]
  try {
    prs = JSON.parse(json) as PrSummary[]
  } catch {
    return json.trim() || '[no output]'
  }
  if (!Array.isArray(prs) || prs.length === 0) return 'No matching pull requests.'
  return prs
    .map((p) => {
      const tag = p.isDraft ? 'draft' : (p.state || '').toLowerCase()
      const who = p.author?.login ? ` by ${p.author.login}` : ''
      return `#${p.number} [${tag}] ${p.title} (${p.headRefName}${who}) ${p.url}`
    })
    .join('\n')
}

const ghPrView: ToolDef = {
  kind: 'network',
  summarize: (a) => `View PR ${str(a, 'number') || '(current branch)'}`,
  schema: {
    name: 'gh_pr_view',
    description:
      "View a pull request's details (title, state, author, body, file stats) via the gh CLI. Omit number to view the PR for the current branch. Set diff:true to also include the unified diff. Read-only, but requires approval (network).",
    parameters: objectSchema(
      {
        number: { type: 'number', description: 'PR number. Omit to use the current branch\'s PR.' },
        diff: { type: 'boolean', description: 'Also include the PR diff (default false).' }
      },
      []
    )
  },
  async execute(args, ctx) {
    const positional = prNumberArgs(args)
    const run = ghRunner(ctx)
    const viewArgs = [
      'pr',
      'view',
      ...positional,
      '--json',
      'number,title,state,isDraft,url,headRefName,baseRefName,author,additions,deletions,changedFiles,body'
    ]
    const r = await run(viewArgs, ctx.workspace, ctx.signal)
    if (!r.ok) return ghOutput(r)
    let out = formatPrView(r.stdout)
    if (args.diff === true) {
      const d = await run(['pr', 'diff', ...positional], ctx.workspace, ctx.signal)
      const body = d.ok ? d.stdout.trim() : `[could not load diff: ${d.stderr.trim()}]`
      const capped =
        body.length > MAX_GH_OUTPUT_CHARS ? `${body.slice(0, MAX_GH_OUTPUT_CHARS)}\n[diff truncated]` : body
      out += `\n\n--- diff ---\n${capped}`
    }
    return out
  }
}

interface PrDetail {
  number: number
  title: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  baseRefName: string
  author?: { login?: string }
  additions?: number
  deletions?: number
  changedFiles?: number
  body?: string
}

/** Render `gh pr view --json` output into a readable summary block. Pure. */
export function formatPrView(json: string): string {
  let p: PrDetail
  try {
    p = JSON.parse(json) as PrDetail
  } catch {
    return json.trim() || '[no output]'
  }
  const tag = p.isDraft ? 'draft' : (p.state || '').toLowerCase()
  const lines = [
    `#${p.number} ${p.title} [${tag}]`,
    `${p.headRefName} → ${p.baseRefName}${p.author?.login ? ` · by ${p.author.login}` : ''}`,
    `${p.changedFiles ?? 0} file(s), +${p.additions ?? 0} −${p.deletions ?? 0}`,
    p.url
  ]
  if (p.body && p.body.trim()) lines.push('', p.body.trim())
  return lines.join('\n')
}

const ghPrComment: ToolDef = {
  kind: 'network',
  blockedInPlan: true,
  summarize: (a) => `Comment on PR ${str(a, 'number') || '(current branch)'}`,
  schema: {
    name: 'gh_pr_comment',
    description:
      'Post a comment on a GitHub pull request via the gh CLI. Omit number to comment on the current branch\'s PR. Requires approval (network) and is refused in plan mode.',
    parameters: objectSchema(
      {
        number: { type: 'number', description: 'PR number. Omit to use the current branch\'s PR.' },
        body: { type: 'string', description: 'The comment body (Markdown).' }
      },
      ['body']
    )
  },
  async execute(args, ctx) {
    const body = str(args, 'body')
    if (!body.trim()) throw new Error('body is required.')
    const argv = ['pr', 'comment', ...prNumberArgs(args), '--body', body]
    return ghOutput(await ghRunner(ctx)(argv, ctx.workspace, ctx.signal))
  }
}

const ghPrCheckout: ToolDef = {
  kind: 'network',
  blockedInPlan: true,
  summarize: (a) => `Checkout PR ${str(a, 'number')}`,
  schema: {
    name: 'gh_pr_checkout',
    description:
      'Check out a GitHub pull request branch locally via the gh CLI (fetches the branch and switches the working tree to it). Use it to review or update an existing PR. Requires approval (network) and is refused in plan mode. Note: this switches the current checkout — commit or stash your work first.',
    parameters: objectSchema(
      { number: { type: 'number', description: 'The PR number to check out.' } },
      ['number']
    )
  },
  async execute(args, ctx) {
    const argv = ['pr', 'checkout', ...prNumberArgs(args, true)]
    return ghOutput(await ghRunner(ctx)(argv, ctx.workspace, ctx.signal))
  }
}

export const ASK_USER_NAME = ASK_USER_TOOL

/**
 * Normalize the model's `options` argument into clean QuestionOptions. Models
 * sometimes send a plain string array and sometimes `{label, description}`
 * objects; accept both and drop anything without a usable label.
 */
function parseQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ label })
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const label = typeof rec.label === 'string' ? rec.label.trim() : ''
      if (!label) continue
      const description = typeof rec.description === 'string' ? rec.description.trim() : ''
      out.push(description ? { label, description } : { label })
    }
  }
  return out
}

const askUser: ToolDef = {
  kind: 'read',
  summarize: (a) => `Ask: ${str(a, 'question')}`,
  schema: {
    name: ASK_USER_NAME,
    description:
      'Ask the user a question and wait for their answer before continuing. Use this to resolve a ' +
      'genuine ambiguity or get a decision only the user can make (which option, which approach, a ' +
      'missing detail) — not for routine narration or confirmations you can infer. Offer 2–4 concise ' +
      'options; the user may also type their own answer. Returns the user’s answer as text. Available ' +
      'in Plan mode, so use it to settle open questions before presenting a plan.',
    parameters: objectSchema(
      {
        question: {
          type: 'string',
          description: 'The question to ask. Be specific and concise.'
        },
        options: {
          type: 'array',
          description: 'Suggested answers (2–4 recommended). The user can also type a custom answer.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option text the user selects.' },
              description: {
                type: 'string',
                description: 'Optional one-line explanation of what choosing this option means.'
              }
            },
            required: ['label'],
            additionalProperties: false
          }
        },
        multiSelect: {
          type: 'boolean',
          description: 'Allow the user to select more than one option (default false).'
        }
      },
      ['question']
    )
  },
  async execute(args, ctx) {
    if (!ctx.askUser) throw new Error('Asking the user is not available in this context.')
    const question = str(args, 'question').trim()
    if (!question) throw new Error('question is required.')
    const options = parseQuestionOptions(args.options)
    const multiSelect = args.multiSelect === true
    const answer = await ctx.askUser({ question, options, multiSelect })
    return answer.trim() ? answer : '[The user did not provide an answer.]'
  }
}

export const TOOLS: ToolDef[] = [
  readFile,
  writeFile,
  editFile,
  multiEdit,
  applyPatch,
  listDir,
  globTool,
  searchTool,
  astGrepTool,
  runShell,
  readShellOutputTool,
  killShellTool,
  webFetch,
  viewLocalhost,
  webSearch,
  todoWrite,
  prSweep,
  askUser,
  dispatchAgent,
  reviewChanges,
  gitStatus,
  gitDiff,
  ghPrCreate,
  ghPrList,
  ghPrView,
  ghPrComment,
  ghPrCheckout
]

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => t.schema)
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.schema.name === name)
}
