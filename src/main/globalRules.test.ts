import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GLOBAL_RULES_HEADING,
  LEGACY_RULES_IMPORT,
  decideLegacyRulesNotice,
  globalRulesFile,
  importLegacyRules,
  legacyRulesFile,
  legacyRulesNoticeApplies
} from './globalRules'
import { loadProjectRules } from './agent/rules'

let home: string
let workspace: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'houston-grhome-'))
  workspace = mkdtempSync(join(tmpdir(), 'houston-grws-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function writeLegacy(text = 'Legacy rule.'): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(legacyRulesFile(home), text)
}
function writeGlobal(text: string): void {
  mkdirSync(join(home, '.houston'), { recursive: true })
  writeFileSync(globalRulesFile(home), text)
}
const readGlobal = (): string => readFileSync(globalRulesFile(home), 'utf8')

describe('paths', () => {
  it('puts the global rules file under ~/.houston', () => {
    expect(globalRulesFile(home)).toBe(join(home, '.houston', 'AGENTS.md'))
    expect(legacyRulesFile(home)).toBe(join(home, '.claude', 'CLAUDE.md'))
  })
})

describe('legacyRulesNoticeApplies', () => {
  it('is false with no legacy file', () => {
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false for an empty or whitespace-only legacy file', () => {
    writeLegacy('')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
    writeLegacy('  \n\n')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the global file is a symlink to the legacy file', () => {
    writeLegacy()
    mkdirSync(join(home, '.houston'), { recursive: true })
    symlinkSync(legacyRulesFile(home), globalRulesFile(home))
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the legacy file is a symlink to the global file', () => {
    writeGlobal('Houston rules.')
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(globalRulesFile(home), legacyRulesFile(home))
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the legacy file comes in through another import', () => {
    writeLegacy()
    mkdirSync(join(home, 'rules'), { recursive: true })
    writeFileSync(join(home, 'rules', 'shared.md'), `Shared.\n${LEGACY_RULES_IMPORT}\n`)
    writeGlobal('@~/rules/shared.md')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('survives an import cycle while searching', () => {
    writeLegacy()
    mkdirSync(join(home, 'rules'), { recursive: true })
    writeFileSync(join(home, 'rules', 'a.md'), '@./b.md')
    writeFileSync(join(home, 'rules', 'b.md'), '@./a.md')
    writeGlobal('@~/rules/a.md')
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is false when the legacy path is a directory', () => {
    mkdirSync(legacyRulesFile(home), { recursive: true })
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is true when the legacy file exists and there is no global file', () => {
    writeLegacy()
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is true when the global file exists but does not import it', () => {
    writeLegacy()
    writeGlobal('# Mine\n\nUse tabs.\n')
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is false once the global file imports it (~/ or absolute spelling)', () => {
    writeLegacy()
    writeGlobal(`Stuff\n${LEGACY_RULES_IMPORT}\n`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
    writeGlobal(`See @${legacyRulesFile(home)}.`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('does not count a mention inside a fenced code block as an import', () => {
    writeLegacy()
    writeGlobal(['```', LEGACY_RULES_IMPORT, '```'].join('\n'))
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })
})

describe('importLegacyRules', () => {
  it('creates the global file with a heading and the import', () => {
    writeLegacy()
    const file = importLegacyRules(home)
    expect(file).toBe(globalRulesFile(home))
    expect(readGlobal()).toBe(`${GLOBAL_RULES_HEADING}\n\n${LEGACY_RULES_IMPORT}\n`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('puts the import under an existing top heading, before the user\'s rules', () => {
    writeGlobal('# Mine\n\nUse tabs.\n')
    importLegacyRules(home)
    const out = readGlobal()
    expect(out).toBe(`# Mine\n\n${LEGACY_RULES_IMPORT}\n\nUse tabs.\n`)
  })

  it('keeps the import under a heading that has no trailing newline', () => {
    writeGlobal('# Mine')
    importLegacyRules(home)
    expect(readGlobal()).toBe(`# Mine\n\n${LEGACY_RULES_IMPORT}\n`)
  })

  it('leaves a symlinked global file alone instead of replacing the link', () => {
    writeLegacy('Legacy rule.')
    mkdirSync(join(home, '.houston'), { recursive: true })
    symlinkSync(legacyRulesFile(home), globalRulesFile(home))
    importLegacyRules(home)
    expect(lstatSync(globalRulesFile(home)).isSymbolicLink()).toBe(true)
    expect(readFileSync(legacyRulesFile(home), 'utf8')).toBe('Legacy rule.')
  })

  it('does not make a file import itself through a reverse symlink', () => {
    writeGlobal('Houston rules.\n')
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(globalRulesFile(home), legacyRulesFile(home))
    importLegacyRules(home)
    expect(readGlobal()).toBe('Houston rules.\n')
  })

  it('prepends the import to a file with no top heading', () => {
    writeGlobal('Use tabs.\n')
    importLegacyRules(home)
    expect(readGlobal()).toBe(`${LEGACY_RULES_IMPORT}\n\nUse tabs.\n`)
  })

  it('is idempotent', () => {
    writeLegacy()
    importLegacyRules(home)
    const once = readGlobal()
    importLegacyRules(home)
    expect(readGlobal()).toBe(once)
  })

  it('makes the legacy rules load, ahead of the Houston-specific ones', async () => {
    writeLegacy('LEGACY-RULE')
    writeGlobal('# Mine\n\nHOUSTON-RULE\n')
    let rules = await loadProjectRules(workspace, { home })
    expect(rules.text).not.toContain('LEGACY-RULE')
    importLegacyRules(home)
    rules = await loadProjectRules(workspace, { home })
    expect(rules.text).toContain('LEGACY-RULE')
    expect(rules.text.indexOf('LEGACY-RULE')).toBeLessThan(rules.text.indexOf('HOUSTON-RULE'))
  })
})

describe('decideLegacyRulesNotice', () => {
  const settings = { recentWorkspaces: [] } as unknown as import('@shared/types').AppSettings
  const dismissed = { ...settings, theme: 'dark' as const }

  function deps(importRules?: () => string) {
    return { current: vi.fn(() => settings), dismiss: vi.fn(() => dismissed), importRules }
  }

  it('import: writes, then dismisses, and reports the file', () => {
    const order: string[] = []
    const d = deps(() => {
      order.push('import')
      return '/h/.houston/AGENTS.md'
    })
    d.dismiss.mockImplementation(() => {
      order.push('dismiss')
      return dismissed
    })
    expect(decideLegacyRulesNotice('import', d)).toEqual({
      settings: dismissed,
      file: '/h/.houston/AGENTS.md'
    })
    expect(order).toEqual(['import', 'dismiss'])
  })

  it('import failure: reports the error and records nothing', () => {
    const d = deps(() => {
      throw new Error('EACCES: permission denied')
    })
    const res = decideLegacyRulesNotice('import', d)
    expect(res).toEqual({ settings, error: 'EACCES: permission denied' })
    expect(d.dismiss).not.toHaveBeenCalled()
  })

  it('keep: dismisses without importing', () => {
    const importRules = vi.fn(() => 'x')
    const d = deps(importRules)
    expect(decideLegacyRulesNotice('keep', d)).toEqual({ settings: dismissed })
    expect(importRules).not.toHaveBeenCalled()
  })

  it('ignores anything else', () => {
    const importRules = vi.fn(() => 'x')
    const d = deps(importRules)
    for (const bad of ['delete', undefined, null, 1, { choice: 'import' }]) {
      expect(decideLegacyRulesNotice(bad, d)).toEqual({ settings })
    }
    expect(importRules).not.toHaveBeenCalled()
    expect(d.dismiss).not.toHaveBeenCalled()
  })
})
