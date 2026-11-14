import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHeadlessArgs } from './headless'
import { applyAddDir, parseSlashCommand, parseTuiArgs } from './tui'
import { resolveAddDir } from './sessionFlags'
import { defaultSettings } from '@shared/defaults'

let base: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'houston-adddir-')))
  mkdirSync(join(base, 'shared'))
  writeFileSync(join(base, 'file.txt'), 'x')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('--add-dir', () => {
  it('headless: resolves each against the launch folder, dedupes, and keeps order', () => {
    const o = parseHeadlessArgs(['-p', 'go', '--add-dir', 'shared', `--add-dir=${join(base, 'shared')}`, '--add-dir', base], base)
    expect(o?.addDirs).toEqual([join(base, 'shared'), base])
    expect(o?.usageError).toBeUndefined()
  })

  it('headless: a missing or non-directory value is a usage error', () => {
    expect(parseHeadlessArgs(['-p', 'go', '--add-dir', 'nope'], base)?.usageError).toMatch(/--add-dir: "nope" is not a directory/)
    expect(parseHeadlessArgs(['-p', 'go', '--add-dir', 'file.txt'], base)?.usageError).toMatch(/not a directory/)
    expect(parseHeadlessArgs(['-p', 'go', '--add-dir='], base)?.usageError).toMatch(/needs the path of a directory/)
  })

  it('headless: is not taken for the prompt when -p has no value', () => {
    const o = parseHeadlessArgs(['-p', '--add-dir', 'shared'], base, { stdinPiped: true })
    expect(o?.promptFromStdin).toBe(true)
    expect(o?.addDirs).toEqual([join(base, 'shared')])
  })

  it('tui: parsed the same way, with a usage error for a bad one', () => {
    expect(parseTuiArgs(['-i', '--add-dir', 'shared'], base)?.addDirs).toEqual([join(base, 'shared')])
    expect(parseTuiArgs(['-i', '--add-dir', 'nope'], base)?.usageError).toMatch(/--add-dir: "nope" is not a directory/)
    expect(parseTuiArgs(['-i'], base)?.addDirs).toBeUndefined()
  })
})

describe('/add-dir', () => {
  it('parses with or without a path', () => {
    expect(parseSlashCommand('/add-dir ../x y', defaultSettings())).toEqual({ kind: 'add-dir', path: '../x y' })
    expect(parseSlashCommand('/add-dir', defaultSettings())).toEqual({ kind: 'add-dir', path: '' })
  })

  it('adds a directory once, lists them, and refuses what is not a directory', () => {
    const dirs: string[] = []
    expect(applyAddDir(dirs, '', base)).toMatch(/no directories added this session/)
    expect(applyAddDir(dirs, 'shared', base)).toMatch(/^· added .*shared for this session/)
    expect(applyAddDir(dirs, join(base, 'shared'), base)).toMatch(/already added/)
    expect(applyAddDir(dirs, 'file.txt', base)).toMatch(/not a directory/)
    expect(dirs).toEqual([join(base, 'shared')])
    expect(applyAddDir(dirs, '', base)).toBe(`· directories added this session: ${join(base, 'shared')}`)
  })

  it('resolveAddDir keeps an absolute path as given', () => {
    expect(resolveAddDir(base, '/elsewhere')).toEqual({ dir: base })
  })
})
