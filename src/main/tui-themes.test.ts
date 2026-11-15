import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { colorSgr, loadUserThemes, parseUserTheme, type ThemeFs } from './tui-themes'
import { isThemeName, makePainter, parseSlashCommand, resolveTheme, setUserThemes, themeNames, THEMES } from './tui'

function memFs(files: Record<string, string>): ThemeFs {
  return {
    list: (dir) => {
      if (dir !== '/t') throw new Error('ENOENT')
      return Object.keys(files)
    },
    size: (path) => Buffer.byteLength(files[path.slice('/t/'.length)] ?? ''),
    read: (path) => {
      const name = path.slice('/t/'.length)
      if (!(name in files)) throw new Error('ENOENT')
      return files[name]
    }
  }
}

afterEach(() => setUserThemes({}))

describe('colorSgr', () => {
  it('turns names, 256-color indexes and hex colors into SGR codes', () => {
    expect(colorSgr('red', 'bright-red')).toEqual({ sgr: '\x1b[91m' })
    expect(colorSgr('green', 33)).toEqual({ sgr: '\x1b[38;5;33m' })
    expect(colorSgr('blue', '#0072B2')).toEqual({ sgr: '\x1b[38;2;0;114;178m' })
    expect(colorSgr('cyan', 'none')).toEqual({ sgr: '' })
    expect(colorSgr('dim', 'faint')).toEqual({ sgr: '\x1b[2m' })
  })

  it('refuses anything that is not a color, escape sequences included', () => {
    expect(colorSgr('red', '\x1b]52;c;x\x07')).toHaveProperty('error')
    expect(colorSgr('red', 256)).toHaveProperty('error')
    expect(colorSgr('red', 1.5)).toHaveProperty('error')
    expect(colorSgr('red', '#12345')).toHaveProperty('error')
    expect(colorSgr('red', { r: 1 })).toHaveProperty('error')
  })
})

describe('parseUserTheme', () => {
  it('starts from the base theme and applies the overrides', () => {
    const got = parseUserTheme({ base: 'light', colors: { green: 25, red: '#d55e00' } })
    expect('palette' in got && got.palette.green).toBe('\x1b[38;5;25m')
    expect('palette' in got && got.palette.red).toBe('\x1b[38;2;213;94;0m')
    expect('palette' in got && got.palette.yellow).toBe(THEMES.light.yellow)
    expect('palette' in got && got.palette.reset).toBe('\x1b[0m')
  })

  it('defaults the base to default', () => {
    const got = parseUserTheme({ colors: { cyan: 'white' } })
    expect('palette' in got && got.palette.red).toBe(THEMES.default.red)
  })

  it('names what is wrong', () => {
    expect(parseUserTheme([])).toEqual({ error: 'expected a JSON object' })
    expect(parseUserTheme({ base: 'nope' })).toHaveProperty('error', expect.stringContaining('base must be'))
    expect(parseUserTheme({ colors: { reset: 'red' } })).toHaveProperty('error', expect.stringContaining('unknown color key'))
    expect(parseUserTheme({ colors: { red: 'puce' } })).toHaveProperty('error', expect.stringContaining('unknown color'))
  })
})

describe('loadUserThemes', () => {
  it('loads each valid file by name and explains the rest', () => {
    const got = loadUserThemes(
      '/t',
      memFs({
        'ocean.json': JSON.stringify({ base: 'dark', colors: { green: 39 } }),
        'Broken.json': '{',
        'dark.json': '{}',
        'bad name!.json': '{}',
        'notes.txt': 'ignored',
        'odd.json': JSON.stringify({ colors: { red: 'puce' } })
      })
    )
    expect([...got.themes.keys()]).toEqual(['ocean'])
    expect(got.errors.join('\n')).toMatch(/Broken\.json: skipped, not valid JSON/)
    expect(got.errors.join('\n')).toMatch(/dark\.json: skipped, dark is a built-in theme/)
    expect(got.errors.join('\n')).toMatch(/bad name!\.json: skipped/)
    expect(got.errors.join('\n')).toMatch(/odd\.json: skipped, red: unknown color/)
    expect(got.errors.join('\n')).not.toMatch(/notes/)
  })

  it('treats a missing folder as no themes', () => {
    expect(loadUserThemes('/missing', memFs({}))).toEqual({ themes: new Map(), errors: [] })
  })

  it('skips a file that is too large', () => {
    const got = loadUserThemes('/t', memFs({ 'big.json': ' '.repeat(20_000) }))
    expect(got.errors[0]).toMatch(/larger than 16 KB/)
  })
})

describe('user themes in the terminal', () => {
  it('are listed, resolved and painted like the built-ins', () => {
    const { themes } = loadUserThemes('/t', memFs({ 'ocean.json': JSON.stringify({ colors: { green: 39 } }) }))
    setUserThemes(themes)
    expect(themeNames()).toEqual([...Object.keys(THEMES), 'ocean'])
    expect(isThemeName('ocean')).toBe(true)
    expect(resolveTheme('Ocean')).toBe('ocean')
    expect(makePainter(true, 'ocean')('+', 'green')).toBe('\x1b[38;5;39m+\x1b[0m')
    expect(parseSlashCommand('/theme ocean', { providers: [] } as unknown as AppSettings)).toEqual({ kind: 'set-theme', theme: 'ocean' })
  })

  it('never shadow a built-in theme', () => {
    setUserThemes({ dark: { ...THEMES.mono } })
    expect(makePainter(true, 'dark')('x', 'red')).toContain('\x1b[91m')
  })
})

describe('built-in accessible themes', () => {
  it('has colorblind palettes for dark and light backgrounds', () => {
    expect(resolveTheme('colorblind-dark')).toBe('colorblind')
    expect(THEMES['colorblind-light'].red).not.toBe(THEMES['colorblind-light'].green)
    expect(THEMES['colorblind-light'].green).not.toBe(THEMES.light.green)
  })

  it('has an ANSI-16 theme that uses only the 16 palette colors', () => {
    for (const code of Object.values(THEMES.ansi16)) {
      expect(code).not.toMatch(/38;[25];/)
    }
    expect(THEMES.ansi16.dim).toBe('\x1b[90m')
  })
})
