import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GLOBAL_RULES_LABEL,
  MAX_RULES_CHARS,
  fitRules,
  importTargets,
  loadProjectRules,
  neutralizeImports
} from './rules'

let workspace: string
let home: string
let globalDir: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'houston-rules-'))
  // Isolate the global rules dir so the developer's real ~/.houston/AGENTS.md
  // never leaks into these tests.
  home = mkdtempSync(join(tmpdir(), 'houston-home-'))
  globalDir = join(home, '.houston')
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
    it('loads ~/.houston/AGENTS.md before project rules', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Global house style.')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Project rules.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual([GLOBAL_RULES_LABEL, 'CLAUDE.md'])
      expect(rules.text.indexOf('Global house style.')).toBeLessThan(
        rules.text.indexOf('Project rules.')
      )
    })

    it('works with only global rules present', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Only global.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual([GLOBAL_RULES_LABEL])
      expect(rules.text).toContain('Only global.')
    })

    it('defaults the global dir to ~/.houston under the home dir', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Default-dir global.')
      const rules = await loadProjectRules(workspace, { home })
      expect(rules.files[0]).toBe('~/.houston/AGENTS.md (global)')
      expect(rules.text).toContain('Default-dir global.')
    })

    it('does NOT load ~/.claude/CLAUDE.md on its own', async () => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'OTHER-TOOL-RULES')
      const rules = await loadProjectRules(workspace, { home })
      expect(rules.text).not.toContain('OTHER-TOOL-RULES')
      expect(rules.files).toEqual([])
    })

    it('loads ~/.claude/CLAUDE.md when the global file imports it', async () => {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'OTHER-TOOL-RULES')
      writeFileSync(join(globalDir, 'AGENTS.md'), '@~/.claude/CLAUDE.md\n\nHouston rule.')
      writeFileSync(join(workspace, 'AGENTS.md'), 'Project rule.')
      const rules = await loadProjectRules(workspace, { home })
      expect(rules.text).toContain('OTHER-TOOL-RULES')
      // Precedence is unchanged: global (with its import) < project.
      expect(rules.text.indexOf('OTHER-TOOL-RULES')).toBeLessThan(rules.text.indexOf('Houston rule.'))
      expect(rules.text.indexOf('Houston rule.')).toBeLessThan(rules.text.indexOf('Project rule.'))
    })

    it('a workspace rules file cannot import ~/.claude/CLAUDE.md', async () => {
      // The old file is reachable only from the TRUSTED global file, never from a
      // workspace file (confinement).
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'OTHER-TOOL-RULES')
      writeFileSync(join(workspace, 'AGENTS.md'), '@~/.claude/CLAUDE.md')
      const rules = await loadProjectRules(workspace, { home })
      expect(rules.text).not.toContain('OTHER-TOOL-RULES')
    })
  })

  describe('size cap', () => {
    it('shrinks the global file first so project rules still fit', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'G'.repeat(MAX_RULES_CHARS + 1000))
      writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT-RULE-KEPT')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).toContain('PROJECT-RULE-KEPT')
      expect(rules.files).toEqual([GLOBAL_RULES_LABEL, 'AGENTS.md'])
      expect(rules.truncated).toEqual([GLOBAL_RULES_LABEL])
      expect(rules.text).toContain(`shortened or left out: ${GLOBAL_RULES_LABEL}`)
      expect(rules.text.length).toBeLessThanOrEqual(MAX_RULES_CHARS)
    })

    it('reports nothing truncated when everything fits', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Global.')
      writeFileSync(join(workspace, 'AGENTS.md'), 'Project.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.truncated).toEqual([])
      expect(rules.text).not.toContain('[Rules over')
    })
  })

  describe('fitRules', () => {
    const g = (n: number) => ({ label: GLOBAL_RULES_LABEL, block: 'g'.repeat(n) })
    const p = (label: string, n: number) => ({ label, block: label[0].repeat(n) })

    it('drops the global block when too little of it would be left', () => {
      const r = fitRules([g(300), p('AGENTS.md', 900)], 1000)
      expect(r.files).toEqual(['AGENTS.md'])
      expect(r.truncated).toEqual([GLOBAL_RULES_LABEL])
      expect(r.text.startsWith('A'.repeat(900))).toBe(true)
    })

    it('cuts the tail when project and nested rules alone exceed the cap', () => {
      const r = fitRules([g(500), p('AGENTS.md', 600), p('pkg/AGENTS.md', 600)], 1000)
      expect(r.files).toEqual(['AGENTS.md', 'pkg/AGENTS.md'])
      expect(r.truncated).toEqual([GLOBAL_RULES_LABEL, 'pkg/AGENTS.md'])
      expect(r.text).toContain('[truncated]')
      expect(r.text.length).toBeLessThanOrEqual(1000)
    })

    it('lists a fully dropped tail source as truncated but not as loaded', () => {
      const r = fitRules([p('AGENTS.md', 1000), p('pkg/AGENTS.md', 50)], 1000)
      expect(r.files).toEqual(['AGENTS.md'])
      // AGENTS.md is shortened to leave room for the cut note; pkg is left out.
      expect(r.truncated).toEqual(['AGENTS.md', 'pkg/AGENTS.md'])
    })

    it('leaves a lone oversized global block to the tail cut', () => {
      const r = fitRules([g(1500)], 1000)
      expect(r.files).toEqual([GLOBAL_RULES_LABEL])
      expect(r.truncated).toEqual([GLOBAL_RULES_LABEL])
      expect(r.text.startsWith('g'.repeat(800))).toBe(true)
    })

    it('keeps the text, cut note included, within the cap', () => {
      for (const parts of [
        [g(500), p('AGENTS.md', 600), p('pkg/AGENTS.md', 600)],
        [g(300), p('AGENTS.md', 900)],
        [g(1500)],
        [p('AGENTS.md', 1000), p('pkg/AGENTS.md', 50)],
        [g(5000), p('AGENTS.md', 400), p('a/AGENTS.md', 400), p('b/AGENTS.md', 400)]
      ]) {
        const r = fitRules(parts, 1000)
        expect(r.text.length).toBeLessThanOrEqual(1000)
        expect(r.text).toContain('[Rules over the 1000-character limit')
      }
    })

    it('drops a source when only a few characters of it would fit', () => {
      const r = fitRules([p('AGENTS.md', 790), p('pkg/AGENTS.md', 400)], 1000)
      expect(r.files).toEqual(['AGENTS.md'])
      expect(r.truncated).toEqual(['pkg/AGENTS.md'])
      expect(r.text).not.toContain('pkg/AGENTS.md\n') // no stray fragment of its block
    })
  })

  describe('concurrent expansion', () => {
    it('expands correctly while other expansions run at the same time', async () => {
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      for (const n of ['a', 'b', 'c']) writeFileSync(join(workspace, 'docs', `${n}.md`), `CONTENT-${n}`)
      writeFileSync(join(workspace, 'AGENTS.md'), 'see @./docs/a.md and @./docs/b.md and @./docs/c.md end')
      const runs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 ? loadProjectRules(workspace, opts()) : Promise.resolve(neutralizeImports('x @~/y.md z')).then(() => loadProjectRules(workspace, opts()))
        )
      )
      for (const r of runs) {
        expect(r.text).toContain('see CONTENT-a and CONTENT-b and CONTENT-c end')
      }
    })
  })

  describe('neutralizeImports', () => {
    it('wraps path imports in inline code so the loader skips them', async () => {
      const out = neutralizeImports('keys in @~/.aws/credentials and @./x.md. Ping @alice')
      expect(out).toBe('keys in `@~/.aws/credentials` and `@./x.md.` Ping @alice')
      writeFileSync(join(home, 'secret.md'), 'TOP-SECRET')
      writeFileSync(join(globalDir, 'AGENTS.md'), neutralizeImports('see @~/secret.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('TOP-SECRET')
      expect(rules.text).toContain('`@~/secret.md`')
    })

    it('finds no import targets in neutralized text', () => {
      expect(importTargets(neutralizeImports('a @~/x.md b @/abs/y.md'), '/b', '/h')).toEqual([])
    })
  })

  describe('importTargets', () => {
    it('resolves ~/, relative, and absolute imports, skipping fences and bare mentions', () => {
      const text = ['@~/a.md and @./b.md.', '```', '@~/fenced.md', '```', 'see @/abs/c.md', '@param'].join('\n')
      expect(importTargets(text, '/base', '/home/u')).toEqual([
        join('/home/u', 'a.md'),
        resolve('/base', 'b.md'),
        '/abs/c.md'
      ])
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
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Pull in @~/shared.md here.')
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

    it('does not load a rules file that is itself a symlink out of the tree', async () => {
      // The file, not just its imports: `AGENTS.md -> ~/secret.md` put the target
      // straight into the system prompt.
      writeFileSync(join(home, 'secret.md'), 'TOPSECRET-RULESFILE')
      symlinkSync(join(home, 'secret.md'), join(workspace, 'AGENTS.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.text).not.toContain('TOPSECRET-RULESFILE')
      expect(rules.files).not.toContain('AGENTS.md')
    })

    it('still loads a rules file symlinked to another file in the tree', async () => {
      // Only CLAUDE.md exists for real; it points at another in-tree file.
      mkdirSync(join(workspace, 'docs'), { recursive: true })
      writeFileSync(join(workspace, 'docs', 'rules.md'), 'SHARED-RULES-OK')
      symlinkSync(join(workspace, 'docs', 'rules.md'), join(workspace, 'CLAUDE.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['CLAUDE.md'])
      expect(rules.text).toContain('SHARED-RULES-OK')
    })

    it('loads a CLAUDE.md symlinked to AGENTS.md once, not twice', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'SHARED-RULES-OK')
      symlinkSync(join(workspace, 'AGENTS.md'), join(workspace, 'CLAUDE.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['AGENTS.md'])
      expect(rules.text.split('SHARED-RULES-OK')).toHaveLength(2)
    })

    it('loads an AGENTS.md symlinked to CLAUDE.md once, not twice', async () => {
      writeFileSync(join(workspace, 'CLAUDE.md'), 'SHARED-RULES-OK')
      symlinkSync(join(workspace, 'CLAUDE.md'), join(workspace, 'AGENTS.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['AGENTS.md'])
      expect(rules.text.split('SHARED-RULES-OK')).toHaveLength(2)
    })

    it('loads identical copies once', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Same rules.\n')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Same rules.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['AGENTS.md'])
      expect(rules.text.split('Same rules.')).toHaveLength(2)
    })

    it('still loads both files when they differ', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Agents rules.')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Claude rules.')
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['AGENTS.md', 'CLAUDE.md'])
    })

    it('loads a nested copy of the root rules once', async () => {
      writeFileSync(join(workspace, 'AGENTS.md'), 'Root rules.')
      mkdirSync(join(workspace, 'pkg'), { recursive: true })
      symlinkSync(join(workspace, 'AGENTS.md'), join(workspace, 'pkg', 'AGENTS.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual(['AGENTS.md'])
    })

    it('loads a global file that a project file links to once', async () => {
      writeFileSync(join(globalDir, 'AGENTS.md'), 'My global rules.')
      symlinkSync(join(globalDir, 'AGENTS.md'), join(workspace, 'AGENTS.md'))
      const rules = await loadProjectRules(workspace, opts())
      expect(rules.files).toEqual([GLOBAL_RULES_LABEL])
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
      writeFileSync(join(globalDir, 'AGENTS.md'), 'Global. @~/extra.md')
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
      expect(rules.files.some((f) => f.includes(join('packages', 'api', 'AGENTS.md')))).toBe(true)
      expect(rules.files.some((f) => f.includes(join('packages', 'api', 'deep', 'CLAUDE.md')))).toBe(true)
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
