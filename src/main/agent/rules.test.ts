import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RULES_CHARS, loadProjectRules } from './rules'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'houston-rules-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('loadProjectRules', () => {
  it('returns empty when no rules files exist', async () => {
    const rules = await loadProjectRules(workspace)
    expect(rules.text).toBe('')
    expect(rules.files).toEqual([])
  })

  it('loads AGENTS.md and tags it with a section header', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'Use tabs, not spaces.')
    const rules = await loadProjectRules(workspace)
    expect(rules.files).toEqual(['AGENTS.md'])
    expect(rules.text).toContain('### AGENTS.md')
    expect(rules.text).toContain('Use tabs, not spaces.')
  })

  it('combines AGENTS.md and CLAUDE.md in precedence order', async () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Claude rules here.')
    writeFileSync(join(workspace, 'AGENTS.md'), 'Agents rules here.')
    const rules = await loadProjectRules(workspace)
    expect(rules.files).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(rules.text.indexOf('Agents rules here.')).toBeLessThan(
      rules.text.indexOf('Claude rules here.')
    )
  })

  it('skips empty / whitespace-only files', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '   \n  \n')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'real content')
    const rules = await loadProjectRules(workspace)
    expect(rules.files).toEqual(['CLAUDE.md'])
  })

  it('truncates content past the size cap', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'x'.repeat(MAX_RULES_CHARS + 5000))
    const rules = await loadProjectRules(workspace)
    expect(rules.text).toContain('[truncated]')
    // Header + capped content + marker — never the full oversized payload.
    expect(rules.text.length).toBeLessThan(MAX_RULES_CHARS + 200)
  })
})
