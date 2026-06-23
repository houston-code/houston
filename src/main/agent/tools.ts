import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path'
import { minimatch } from 'minimatch'
import type { JSONSchema, ToolSchema } from '@shared/agent'
import { formatTodoList, formatTodoSummary, parseTodos } from '@shared/todos'
import { runSandboxed } from '../sandbox'
import { fetchUrlAsText } from './webfetch'
import { resolveRipgrep, searchContents, SKIP_DIRS } from './search'

export type ToolKind = 'read' | 'write' | 'shell' | 'network'

export interface ToolContext {
  /** Canonical (realpath'd) workspace root. */
  workspace: string
  allowNetwork: boolean
  signal?: AbortSignal
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

/** Resolve a user-supplied path against the workspace and reject anything that escapes it. */
function resolveInWorkspace(workspace: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('A path is required.')
  const abs = isAbsolute(p) ? p : resolve(workspace, p)
  const rel = relative(workspace, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${p}`)
  }
  return abs
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
      'Read the contents of a text file within the project. Returns the file text. For large files, pass offset/limit (1-based line numbers) to read just a slice.',
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
    const abs = resolveInWorkspace(ctx.workspace, str(args, 'path'))
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
    const abs = resolveInWorkspace(ctx.workspace, str(args, 'path'))
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
      'Replace an exact string in a file with a new string. By default the old string must occur exactly once; set replace_all to replace every occurrence.',
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
    const abs = resolveInWorkspace(ctx.workspace, str(args, 'path'))
    const oldStr = str(args, 'old_string')
    const newStr = str(args, 'new_string')
    const replaceAll = args.replace_all === true
    const data = await fs.readFile(abs, 'utf8')
    if (!oldStr) throw new Error('old_string must not be empty.')
    const count = data.split(oldStr).length - 1
    if (count === 0) throw new Error('old_string was not found in the file.')
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string occurs ${count} times; pass replace_all or provide more context.`)
    }
    const updated = replaceAll ? data.split(oldStr).join(newStr) : data.replace(oldStr, newStr)
    await fs.writeFile(abs, updated, 'utf8')
    return `Edited ${str(args, 'path')} (${replaceAll ? count : 1} replacement${
      replaceAll && count !== 1 ? 's' : ''
    }).`
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
    const abs = resolveInWorkspace(ctx.workspace, target)
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
      'Search file contents across the project using a regular expression. Returns matching "path:line: text" entries. Uses ripgrep when available, otherwise a built-in scan. Skips node_modules, .git, and build output.',
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
    const startAbs = resolveInWorkspace(ctx.workspace, str(args, 'path') || '.')
    const context = num(args, 'context')
    return searchContents({
      pattern: str(args, 'pattern'),
      workspace: ctx.workspace,
      searchRel: relative(ctx.workspace, startAbs) || '.',
      startAbs,
      rgPath: resolveRipgrep(),
      max: 100,
      signal: ctx.signal,
      ignoreCase: args.ignore_case === true,
      glob: str(args, 'glob') || undefined,
      context: context !== undefined ? Math.max(0, Math.floor(context)) : undefined,
      filesWithMatches: args.files_with_matches === true
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
    const start = resolveInWorkspace(ctx.workspace, str(args, 'path') || '.')
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
  summarize: (a) => str(a, 'command'),
  schema: {
    name: 'run_shell',
    description:
      'Run a shell command inside a macOS Seatbelt sandbox confined to the project directory. Writes are limited to the project and temp dirs. Returns combined stdout/stderr and the exit code.',
    parameters: objectSchema(
      {
        command: { type: 'string', description: 'The shell command to run (executed with /bin/bash -c).' }
      },
      ['command']
    )
  },
  async execute(args, ctx) {
    const command = str(args, 'command')
    if (!command) throw new Error('command is required.')
    const result = await runSandboxed({
      command,
      cwd: ctx.workspace,
      workspace: ctx.workspace,
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

export const TOOLS: ToolDef[] = [
  readFile,
  writeFile,
  editFile,
  listDir,
  globTool,
  searchTool,
  runShell,
  webFetch,
  todoWrite
]

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => t.schema)
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.schema.name === name)
}
