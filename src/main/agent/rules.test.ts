import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

    it('expands ~/ imports against the (test) home dir', async () => {
      writeFileSync(join(home, 'shared.md'), 'Shared snippet.')
      writeFileSync(join(workspace, 'CLAUDE.md'), 'Pull in @~/shared.md here.')
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
})
