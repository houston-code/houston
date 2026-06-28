import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RULES_CHARS, loadProjectRules } from './rules'

let workspace: string
let home: string
let globalDir: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'houston-rules-'))
  // Isolate the global rules dir so the developer's real ~/.claude/CLAUDE.md
  // never leaks into these tests.
  home = mkdtempSync(join(tmpdir(), 'houston-home-'))
  globalDir = join(home, '.claude')
  mkdirSync(globalDir, { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

/** Default opts that isolate the global dir for a test. */
function opts(): { globalDir: string; home: string } {
  return { globalDir, home }
}

describe('loadProjectRules', () => {
  it('returns empty when no rules files exist', async () => {
    const rules = await loadProjectRules(workspace, opts())
    expect(rules.text).toBe('')
    expect(rules.files).toEqual([])
  })

  it('loads AGENTS.md and tags it with a section header', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'Use tabs, not spaces.')
    const rules = await loadProjectRules(workspace, opts())
    expect(rules.files).toEqual(['AGENTS.md'])
    expect(rules.text).toContain('### AGENTS.md')
    expect(rules.text).toContain('Use tabs, not spaces.')
  })

  it('combines AGENTS.md and CLAUDE.md in precedence order', async () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Claude rules here.')
    writeFileSync(join(workspace, 'AGENTS.md'), 'Agents rules here.')
    const rules = await loadProjectRules(workspace, opts())
    expect(rules.files).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(rules.text.indexOf('Agents rules here.')).toBeLessThan(
      rules.text.indexOf('Claude rules here.')
    )
  })

  it('skips empty / whitespace-only files', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '   \n  \n')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'real content')
    const rules = await loadProjectRules(workspace, opts())
    expect(rules.files).toEqual(['CLAUDE.md'])
  })

  it('truncates content past the size cap', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'x'.repeat(MAX_RULES_CHARS + 5000))
    const rules = await loadProjectRules(workspace, opts())
    expect(rules.text).toContain('[truncated]')
    expect(rules.text.length).toBeLessThan(MAX_RULES_CHARS + 200)
  })

  describe('global rules', () => {
    it('loads ~/.claude/CLAUDE.md before project rules', async () => {
      writeFileSync(join(globalDir, 'CLAUDE.md'), 'Global house style.')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Project rules.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['~/.claude/CLAUDE.md (global)', 'CLAUDE.md'])
      expect(rules.text.indexOf('Global house style.')).toBeLessThan(
        rules.text.indexOf('Project rules.')
      )
    })

    it('works with only global rules present', async () => {
      writeFileSync(join(globalDir, 'CLAUDE.md'), 'Only global.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['~/.claude/CLAUDE.md (global)'])
      expect(rules.text).toContain('Only global.')
    })
  })

  describe('@imports', () => {
    it('inlines a relative @import', async () => {
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Top rules.\nSee @./docs/style.md for more.')
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      writeFileSync(join(workspace, 'docs', 'style.md'), 'Two-space indents.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('Top rules.')
      expect(rules.text).toContain('Two-space indents.')
    })

    it('resolves nested imports relative to the importing file', async () => {
      writeFileSync(join(workspace, 'CLAUDE.md'), '@./docs/a.md')
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      writeFileSync(join(workspace, 'docs', 'a.md'), 'A then @./b.md')
      writeFileSync(join(workspace, 'docs', 'b.md'), 'B-content')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('B-content')
    })

    it('expands ~/ imports in the TRUSTED global file against the home dir', async () => {
      // ~/ imports are only honored from the user's own global rules file. A
      // workspace file doing the same is blocked (see the confinement tests below).
      writeFileSync(join(home, 'shared.md'), 'Shared snippet.')
      writeFileSync(join(globalDir, 'CLAUDE.md'), 'Pull in @~/shared.md here.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('Shared snippet.')
    })

    it('leaves a non-resolving @token untouched', async () => {
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Install @anthropic-ai/sdk and use @param.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('@anthropic-ai/sdk')
      expect(rules.text).toContain('@param')
    })

    it('does not expand imports inside fenced code blocks', async () => {
      writeFileSync(join(workspace, 'docs.md'), 'SHOULD-NOT-APPEAR')
      writeFileSync(
        join(workspace, 'CLAUDE.md'),
        ['```', '@./docs.md', '```'].join('\n')
      )
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('SHOULD-NOT-APPEAR')
      expect(rules.text).toContain('@./docs.md')
    })

    it('breaks import cycles', async () => {
      writeFileSync(join(workspace, 'CLAUDE.md'), 'start @./a.md')
      writeFileSync(join(workspace, 'a.md'), 'a @./b.md')
      writeFileSync(join(workspace, 'b.md'), 'b @./a.md end')
      const rules = await loadProjectRules(workspace, opts())
      // Should terminate and include each file's text once, not loop forever.
      expect(rules.text).toContain('start')
      expect(rules.text).toContain('end')
    })
  })

  describe('@import confinement (untrusted repo)', () => {
    // A workspace AGENTS.md/CLAUDE.md is attacker-controlled when an untrusted
    // repo is opened, and its expanded text goes into the system prompt. It must
    // not be able to @import host files (~/.ssh, /etc, ../escape, or via a
    // symlink) and exfiltrate them into the prompt.

    it('blocks a project file from importing a ~/ (home) path', async () => {
      writeFileSync(join(home, 'secret.md'), 'TOPSECRET-HOME')
      writeFileSync(join(workspace, 'AGENTS.md'), 'Conventions. @~/secret.md')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('Conventions.')
      expect(rules.text).not.toContain('TOPSECRET-HOME')
    })

    it('blocks a project file from importing an absolute path outside the workspace', async () => {
      writeFileSync(join(home, 'secret.md'), 'TOPSECRET-ABS')
      writeFileSync(join(workspace, 'CLAUDE.md'), `Rules. @${join(home, 'secret.md')}`)
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('TOPSECRET-ABS')
    })

    it('blocks a nested file from climbing out of the workspace with ../', async () => {
      // A sibling of the workspace (both are direct children of tmpdir), reachable
      // only by climbing above the root.
      const sibling = mkdtempSync(join(tmpdir(), 'houston-sibling-'))
      try {
        writeFileSync(join(sibling, 'secret.md'), 'TOPSECRET-CLIMB')
        mkdirSync(join(workspace, 'pkg'), { recursive: true })
        // From workspace/pkg: ../.. = tmpdir, then into the sibling.
        const escape = `../../${sibling.split('/').pop()}/secret.md`
        writeFileSync(join(workspace, 'pkg', 'AGENTS.md'), `Pkg. @${escape}`)
        const rules = await loadProjectRules(workspace, opts())
        expect(rules.text).not.toContain('TOPSECRET-CLIMB')
      } finally {
        rmSync(sibling, { recursive: true, force: true })
      }
    })

    it('does not follow a workspace symlink that points outside the tree', async () => {
      writeFileSync(join(home, 'secret.md'), 'TOPSECRET-LINK')
      symlinkSync(join(home, 'secret.md'), join(workspace, 'link.md'))
      writeFileSync(join(workspace, 'AGENTS.md'), 'Rules. @./link.md')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('TOPSECRET-LINK')
    })

    it('still allows an in-workspace import (legitimate split)', async () => {
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      writeFileSync(join(workspace, 'docs', 'style.md'), 'IN-WORKSPACE-OK')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Rules. @./docs/style.md')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('IN-WORKSPACE-OK')
    })

    it('the trusted global file may still import a home path', async () => {
      writeFileSync(join(home, 'extra.md'), 'GLOBAL-EXTRA-OK')
      writeFileSync(join(globalDir, 'CLAUDE.md'), 'Global. @~/extra.md')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('GLOBAL-EXTRA-OK')
    })
  })

  describe('nested rules', () => {
    it('discovers AGENTS.md / CLAUDE.md in subdirectories, shallowest first', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Root rules.')
      mkdirSync(join(workspace, 'packages', 'api'), { recursive: true })
      writeFileSync(join(workspace, 'packages', 'api', 'AGENTS.md'), 'API package rules.')
      mkdirSync(join(workspace, 'packages', 'api', 'deep'), { recursive: true })
      writeFileSync(join(workspace, 'packages', 'api', 'deep', 'CLAUDE.md'), 'Deep rules.')

      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toContain('AGENTS.md')
      expect(rules.files.some((f) => f.includes('packages/api/AGENTS.md'))).toBe(true)
      expect(rules.files.some((f) => f.includes('packages/api/deep/CLAUDE.md'))).toBe(true)
      // Root first, then shallower nested, then deeper nested (precedence order).
      expect(rules.text.indexOf('Root rules.')).toBeLessThan(rules.text.indexOf('API package rules.'))
      expect(rules.text.indexOf('API package rules.')).toBeLessThan(rules.text.indexOf('Deep rules.'))
    })

    it('skips node_modules and other vendor/build dirs', async () => {
      mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(workspace, 'node_modules', 'pkg', 'AGENTS.md'), 'Vendor noise.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('Vendor noise.')
    })

    it('respects the depth limit', async () => {
      mkdirSync(join(workspace, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(workspace, 'a', 'b', 'c', 'AGENTS.md'), 'Too deep.')
      const rules = await loadProjectRules(workspace, { ...opts(), maxNestedDepth: 1 })
      expect(rules.text).not.toContain('Too deep.')
    })

    it('can be disabled with maxNestedDepth 0', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Root.')
      mkdirSync(join(workspace, 'sub'))
      writeFileSync(join(workspace, 'sub', 'AGENTS.md'), 'Nested.')
      const rules = await loadProjectRules(workspace, { ...opts(), maxNestedDepth: 0 })
      expect(rules.files).toEqual(['AGENTS.md'])
      expect(rules.text).not.toContain('Nested.')
    })
  })
})
