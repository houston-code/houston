import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path'
import type { JSONSchema, ToolSchema } from '@shared/agent'
import { runSandboxed } from '../sandbox'

export type ToolKind = 'read' | 'write' | 'shell'

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
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'vendor', '.venv'])

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

const objectSchema = (properties: JSONSchema, required: string[]): JSONSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

const readFile: ToolDef = {
  kind: 'read',
  summarize: (a) => `Read ${str(a, 'path')}`,
  schema: {
    name: 'read_file',
    description: 'Read the contents of a text file within the project. Returns the file text.',
    parameters: objectSchema(
      { path: { type: 'string', description: 'Path relative to the project root.' } },
      ['path']
    )
  },
  async execute(args, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, str(args, 'path'))
    const data = await fs.readFile(abs, 'utf8')
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

async function searchFiles(
  dir: string,
  workspace: string,
  regex: RegExp,
  out: string[],
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
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await searchFiles(full, workspace, regex, out, max)
    } else if (entry.isFile()) {
      let content: string
      try {
        content = await fs.readFile(full, 'utf8')
      } catch {
        continue
      }
      if (content.includes(String.fromCharCode(0))) continue // skip binary files
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          out.push(`${relative(workspace, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (out.length >= max) return
        }
      }
    }
  }
}

const searchTool: ToolDef = {
  kind: 'read',
  summarize: (a) => `Search "${str(a, 'pattern')}"`,
  schema: {
    name: 'search_files',
    description:
      'Search file contents across the project using a regular expression. Returns matching "path:line: text" entries. Skips node_modules, .git, and build output.',
    parameters: objectSchema(
      {
        pattern: { type: 'string', description: 'A JavaScript regular expression.' },
        path: { type: 'string', description: 'Subdirectory to search within (default project root).' }
      },
      ['pattern']
    )
  },
  async execute(args, ctx) {
    const start = resolveInWorkspace(ctx.workspace, str(args, 'path') || '.')
    let regex: RegExp
    try {
      regex = new RegExp(str(args, 'pattern'))
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`)
    }
    const out: string[] = []
    await searchFiles(start, ctx.workspace, regex, out, 100)
    return out.length ? out.join('\n') : 'No matches found.'
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

export const TOOLS: ToolDef[] = [readFile, writeFile, editFile, listDir, searchTool, runShell]

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => t.schema)
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.schema.name === name)
}
