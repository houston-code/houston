import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHostImports, scanHostImports } from './hostImports'

/** Reads `source` as a module whose host specifier is `../agentHost`. */
const read = (source: string): ReturnType<typeof readHostImports> =>
  readHostImports(source, (spec) => spec === '../agentHost' || spec === '../agentHost.js')

describe('readHostImports', () => {
  it('reads a one-line named import', () => {
    expect(read("import { getKey, getSettings } from '../agentHost'\n")).toEqual({
      names: ['getKey', 'getSettings'],
      unreadable: []
    })
  })

  it('reads an import list over many lines, with comments and a trailing comma', () => {
    const source = [
      "import { x } from './other'",
      'import {',
      '  addPermissionRule,',
      '  // bookkeeping, best effort',
      '  noteRuleUsed,',
      '  /* flagged in settings */ setModelUnavailable,',
      '} from "../agentHost"',
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: ['addPermissionRule', 'noteRuleUsed', 'setModelUnavailable'], unreadable: [] })
  })

  // The compiler erases a type-only import, so the module never asks the mock for it.
  it('leaves out type-only imports, whole statements and single specifiers', () => {
    const source = [
      "import type { AgentHost } from '../agentHost'",
      "import { type AgentHost as Host, getKey, type Other } from '../agentHost'",
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: ['getKey'], unreadable: [] })
  })

  it('reads the exported name behind an alias, and an export named type', () => {
    expect(read("import { getKey as keyFor, type as kind } from '../agentHost'").names).toEqual(['getKey', 'type'])
  })

  it('reads a default import, alone or beside named ones, as default', () => {
    expect(read("import host from '../agentHost'").names).toEqual(['default'])
    expect(read("import host, { getKey } from '../agentHost'").names).toEqual(['default', 'getKey'])
  })

  it('reads a namespace import through the members it is used by', () => {
    const source = [
      "import * as host from '../agentHost'",
      'const key = host.getKey(id)',
      'const s = host?.getSettings()',
      '// host is mentioned in a comment',
      'const hostile = 1',
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: ['getKey', 'getSettings'], unreadable: [] })
  })

  // Passed on, the namespace could reach any export, so the check can't say it's covered.
  it('calls a namespace used other than through a member unreadable', () => {
    const source = ["import * as host from '../agentHost'", 'register(host)', ''].join('\n')
    expect(read(source)).toEqual({ names: [], unreadable: [2] })
  })

  it('reads destructured and namespace dynamic imports', () => {
    const source = [
      'async function f() {',
      "  const { getKey, getSettings: settings } = await import('../agentHost')",
      "  const host = await import('../agentHost.js')",
      '  return host.collectSecrets()',
      '}',
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: ['getKey', 'getSettings', 'collectSecrets'], unreadable: [] })
  })

  it('reads a named re-export, and calls export * unreadable', () => {
    expect(read("export { getKey, type AgentHost } from '../agentHost'")).toEqual({ names: ['getKey'], unreadable: [] })
    expect(read("export * from '../agentHost'")).toEqual({ names: [], unreadable: [1] })
  })

  it('binds nothing from a bare import', () => {
    expect(read("import '../agentHost'\n")).toEqual({ names: [], unreadable: [] })
  })

  // The point of the check is that a form this reader doesn't know fails it.
  it('calls any other reference to the host unreadable, naming its line', () => {
    const source = [
      "import { getKey } from '../agentHost'",
      "const lazy = import('../agentHost').then((m) => m.getSettings)",
      "const old = require(\"../agentHost\")",
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: ['getKey'], unreadable: [2, 3] })
  })

  it('ignores the host named on comment lines, and other modules', () => {
    const source = [
      '/**',
      " * Reads settings via `import { getSettings } from '../agentHost'`.",
      ' */',
      "// don't import '../agentHost' here",
      "import { getSettings } from './agentHostish'",
      "import { getKey } from '../other/agentHost'",
      ''
    ].join('\n')
    expect(read(source)).toEqual({ names: [], unreadable: [] })
  })
})

describe('scanHostImports', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-imports-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const put = (rel: string, text: string): void => {
    const path = join(root, ...rel.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('reads every engine module that imports the host, resolving each specifier from its own folder', () => {
    put('agentHost.ts', 'export function getKey() {}\n')
    put('agent/loop.ts', "import { getSettings } from '../agentHost'\n")
    put('agent/deep/inner.ts', "import { getKey } from '../../agentHost'\n")
    put('agent/deep/agentHost.ts', 'export const local = 1\n')
    put('agent/deep/local.ts', "import { local } from './agentHost'\n")
    put('agent/none.ts', 'export const x = 1\n')
    put('providers/index.ts', "import {\n  getSecretHeaders\n} from '../agentHost.js'\n")
    expect(scanHostImports(root, ['agent', 'providers'], join(root, 'agentHost.ts'))).toEqual([
      { file: 'agent/deep/inner.ts', names: ['getKey'], unreadable: [] },
      { file: 'agent/loop.ts', names: ['getSettings'], unreadable: [] },
      { file: 'providers/index.ts', names: ['getSecretHeaders'], unreadable: [] }
    ])
  })

  // A test's vi.mock of the host is not an import of it, and declarations hold no code.
  it('leaves out tests, evals and declaration files', () => {
    put('agentHost.ts', '')
    put('agent/loop.test.ts', "import { getKey } from '../agentHost'\n")
    put('agent/evals/evals.eval.ts', "import { getKey } from '../../agentHost'\n")
    put('agent/types.d.ts', "import { getKey } from '../agentHost'\n")
    expect(scanHostImports(root, ['agent'], join(root, 'agentHost.ts'))).toEqual([])
  })
})
