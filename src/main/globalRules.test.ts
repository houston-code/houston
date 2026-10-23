import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
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
  it('puts the global rules file under ~/.houston', async () => {
    expect(globalRulesFile(home)).toBe(join(home, '.houston', 'AGENTS.md'))
    expect(legacyRulesFile(home)).toBe(join(home, '.claude', 'CLAUDE.md'))
  })
})

describe('legacyRulesNoticeApplies', () => {
  it('is false with no legacy file', async () => {
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false for an empty or whitespace-only legacy file', async () => {
    writeLegacy('')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
    writeLegacy('  \n\n')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the global file is a symlink to the legacy file', async () => {
    writeLegacy()
    mkdirSync(join(home, '.houston'), { recursive: true })
    symlinkSync(legacyRulesFile(home), globalRulesFile(home))
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the legacy file is a symlink to the global file', async () => {
    writeGlobal('Houston rules.')
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(globalRulesFile(home), legacyRulesFile(home))
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is false when the legacy file comes in through another import', async () => {
    writeLegacy()
    mkdirSync(join(home, 'rules'), { recursive: true })
    writeFileSync(join(home, 'rules', 'shared.md'), `Shared.\n${LEGACY_RULES_IMPORT}\n`)
    writeGlobal('@~/rules/shared.md')
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('survives an import cycle while searching', async () => {
    writeLegacy()
    mkdirSync(join(home, 'rules'), { recursive: true })
    writeFileSync(join(home, 'rules', 'a.md'), '@./b.md')
    writeFileSync(join(home, 'rules', 'b.md'), '@./a.md')
    writeGlobal('@~/rules/a.md')
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is false when the legacy path is a directory', async () => {
    mkdirSync(legacyRulesFile(home), { recursive: true })
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it('is true when the legacy file exists and there is no global file', async () => {
    writeLegacy()
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is true when the global file exists but does not import it', async () => {
    writeLegacy()
    writeGlobal('# Mine\n\nUse tabs.\n')
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })

  it('is false once the global file imports it (~/ or absolute spelling)', async () => {
    writeLegacy('LEGACY-RULE')
    writeGlobal(`Stuff\n${LEGACY_RULES_IMPORT}\n`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
    // An import names its path with forward slashes on every platform (C:/Users/...
    // on Windows); that is the absolute spelling the loader expands.
    const absolute = legacyRulesFile(home).split(sep).join('/')
    writeGlobal(`See @${absolute}.`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
    // The notice and the loader agree: that line really loads the legacy rules.
    expect((await loadProjectRules(workspace, { home })).text).toContain('LEGACY-RULE')
  })

  it('does not count a mention inside a fenced code block as an import', async () => {
    writeLegacy()
    writeGlobal(['```', LEGACY_RULES_IMPORT, '```'].join('\n'))
    expect(legacyRulesNoticeApplies(home)).toBe(true)
  })
})

describe('importLegacyRules', () => {
  it('creates the global file with a heading and the import', async () => {
    writeLegacy()
    const file = await importLegacyRules(home)
    expect(file).toBe(globalRulesFile(home))
    expect(readGlobal()).toBe(`${GLOBAL_RULES_HEADING}\n\n${LEGACY_RULES_IMPORT}\n`)
    expect(legacyRulesNoticeApplies(home)).toBe(false)
  })

  it("puts the import under an existing top heading, before the user's rules", async () => {
    writeGlobal('# Mine\n\nUse tabs.\n')
    await importLegacyRules(home)
    const out = readGlobal()
    expect(out).toBe(`# Mine\n\n${LEGACY_RULES_IMPORT}\n\nUse tabs.\n`)
  })

  it('keeps the import under a heading that has no trailing newline', async () => {
    writeGlobal('# Mine')
    await importLegacyRules(home)
    expect(readGlobal()).toBe(`# Mine\n\n${LEGACY_RULES_IMPORT}\n`)
  })

  it('leaves a symlinked global file alone instead of replacing the link', async () => {
    writeLegacy('Legacy rule.')
    mkdirSync(join(home, '.houston'), { recursive: true })
    symlinkSync(legacyRulesFile(home), globalRulesFile(home))
    await importLegacyRules(home)
    expect(lstatSync(globalRulesFile(home)).isSymbolicLink()).toBe(true)
    expect(readFileSync(legacyRulesFile(home), 'utf8')).toBe('Legacy rule.')
  })

  it('adds the import through a global file linked elsewhere, keeping the link', async () => {
    writeLegacy('Legacy rule.')
    mkdirSync(join(home, 'dotfiles'), { recursive: true })
    writeFileSync(join(home, 'dotfiles', 'AGENTS.md'), '# Mine\n\nUse tabs.\n')
    mkdirSync(join(home, '.houston'), { recursive: true })
    symlinkSync(join(home, 'dotfiles', 'AGENTS.md'), globalRulesFile(home))
    await importLegacyRules(home)
    expect(lstatSync(globalRulesFile(home)).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(home, 'dotfiles', 'AGENTS.md'), 'utf8')).toBe(`# Mine\n\n${LEGACY_RULES_IMPORT}\n\nUse tabs.\n`)
  })

  it('does not make a file import itself through a reverse symlink', async () => {
    writeGlobal('Houston rules.\n')
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(globalRulesFile(home), legacyRulesFile(home))
    await importLegacyRules(home)
    expect(readGlobal()).toBe('Houston rules.\n')
  })

  it('prepends the import to a file with no top heading', async () => {
    writeGlobal('Use tabs.\n')
    await importLegacyRules(home)
    expect(readGlobal()).toBe(`${LEGACY_RULES_IMPORT}\n\nUse tabs.\n`)
  })

  it('is idempotent', async () => {
    writeLegacy()
    await importLegacyRules(home)
    const once = readGlobal()
    await importLegacyRules(home)
    expect(readGlobal()).toBe(once)
  })

  it('makes the legacy rules load, ahead of the Houston-specific ones', async () => {
    writeLegacy('LEGACY-RULE')
    writeGlobal('# Mine\n\nHOUSTON-RULE\n')
    let rules = await loadProjectRules(workspace, { home })
    expect(rules.text).not.toContain('LEGACY-RULE')
    await importLegacyRules(home)
    rules = await loadProjectRules(workspace, { home })
    expect(rules.text).toContain('LEGACY-RULE')
    expect(rules.text.indexOf('LEGACY-RULE')).toBeLessThan(rules.text.indexOf('HOUSTON-RULE'))
  })
})

describe('decideLegacyRulesNotice', () => {
  const settings = { recentWorkspaces: [] } as unknown as import('@shared/types').AppSettings
  const dismissed = { ...settings, theme: 'dark' as const }

  function deps(importRules?: () => Promise<string>) {
    return { current: vi.fn(() => settings), dismiss: vi.fn(() => dismissed), importRules }
  }

  it('import: writes, then dismisses, and reports the file', async () => {
    const order: string[] = []
    const d = deps(async () => {
      order.push('import')
      return '/h/.houston/AGENTS.md'
    })
    d.dismiss.mockImplementation(() => {
      order.push('dismiss')
      return dismissed
    })
    expect(await decideLegacyRulesNotice('import', d)).toEqual({
      settings: dismissed,
      file: '/h/.houston/AGENTS.md'
    })
    expect(order).toEqual(['import', 'dismiss'])
  })

  it('import failure: reports the error and records nothing', async () => {
    const d = deps(async () => {
      throw new Error('EACCES: permission denied')
    })
    const res = await decideLegacyRulesNotice('import', d)
    expect(res).toEqual({ settings, error: 'EACCES: permission denied' })
    expect(d.dismiss).not.toHaveBeenCalled()
  })

  it('keep: dismisses without importing', async () => {
    const importRules = vi.fn(async () => 'x')
    const d = deps(importRules)
    expect(await decideLegacyRulesNotice('keep', d)).toEqual({ settings: dismissed })
    expect(importRules).not.toHaveBeenCalled()
  })

  it('ignores anything else', async () => {
    const importRules = vi.fn(async () => 'x')
    const d = deps(importRules)
    for (const bad of ['delete', undefined, null, 1, { choice: 'import' }]) {
      expect(await decideLegacyRulesNotice(bad, d)).toEqual({ settings })
    }
    expect(importRules).not.toHaveBeenCalled()
    expect(d.dismiss).not.toHaveBeenCalled()
  })
})
