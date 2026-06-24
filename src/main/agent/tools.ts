import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path'
import { minimatch } from 'minimatch'
import type { DocumentAttachment, JSONSchema, ToolSchema } from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { formatTodoList, formatTodoSummary, parseTodos } from '@shared/todos'
import { WEB_SEARCH_KEY_ID } from '@shared/constants'
import {
  MAX_ATTACH_IMAGE_BYTES,
  MAX_PDF_BYTES,
  humanSize,
  imageMediaTypeForPath,
  isPdfPath
} from './attachments'
import { runSandboxed, spawnSandboxed } from '../sandbox'
import { killShell, readShellOutput, registerShell } from './shells'
import { runInSession, type ShellSession } from './shell-session'
import { fetchUrlAsText } from './webfetch'
import { tavilySearch } from './websearch'
import { resolveRipgrep, searchContents, SKIP_DIRS } from './search'
import { resolveAstGrep, searchStructural } from './astgrep'
import { resolveEdit } from './edit-match'
import { bundledRipgrep, bundledAstGrep } from '../binaries'
import { parsePatch } from './apply-patch'

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
  /** Persistent shell state (cwd + exported env) shared across run_shell calls in a run. */
  shellSession?: ShellSession
}

export interface ToolDef {
  schema: ToolSchema
  kind: ToolKind
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
    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout.trimEnd())
    if (result.stderr) parts.push(result.stderr.trimEnd())
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
  async execute(args) {
    const id = str(args, 'shell_id')
    if (!id) throw new Error('shell_id is required.')
    const r = readShellOutput(id, { full: args.full === true })
    if (!r.found) return `No background shell with id ${id}.`
    const parts: string[] = []
    if (r.stdout) parts.push(r.stdout.trimEnd())
    if (r.stderr) parts.push(r.stderr.trimEnd())
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
  webSearch,
  todoWrite,
  dispatchAgent,
  reviewChanges
]

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => t.schema)
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.schema.name === name)
}
