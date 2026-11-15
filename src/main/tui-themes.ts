import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { THEMES, resolveTheme, type ThemePalette } from './tui'

/**
 * User themes for the terminal: each `~/.houston/themes/<name>.json` is a built-in
 * base theme plus color overrides, listed by /theme and picked like any other.
 *
 *   { "base": "dark", "colors": { "green": "#56b4e9", "red": 208, "dim": "bright-black" } }
 *
 * A color is a named ANSI color (`red`, `bright-blue`, `default`), a 256-color index
 * (0 to 255), or a `#rrggbb` hex color; `none` drops the color. Every value is turned
 * into an SGR code here, so a file can only ever choose colors: nothing it says is
 * written to the terminal as it stands.
 */

/** The style keys a user theme may set. `reset` is not one: it must stay a reset. */
export const THEME_COLOR_KEYS = ['dim', 'bold', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const
type ColorKey = (typeof THEME_COLOR_KEYS)[number]

const NAMED: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  'bright-black': 90,
  gray: 90,
  grey: 90,
  'bright-red': 91,
  'bright-green': 92,
  'bright-yellow': 93,
  'bright-blue': 94,
  'bright-magenta': 95,
  'bright-cyan': 96,
  'bright-white': 97,
  default: 39
}

/** The most theme files read, and the largest one. */
const MAX_THEMES = 50
const MAX_THEME_BYTES = 16 * 1024

/** A theme name: letters, digits, `-` and `_`, starting with a letter or digit. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** One color value as its SGR code, or an error. */
export function colorSgr(key: ColorKey, value: unknown): { sgr: string } | { error: string } {
  if (value === 'none') return { sgr: '' }
  if (key === 'dim' || key === 'bold') {
    // Structure keys also take their attribute back by name.
    if (value === 'faint' && key === 'dim') return { sgr: '\x1b[2m' }
    if (value === 'bold') return { sgr: '\x1b[1m' }
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 255) return { error: `${key}: ${value} is not a color from 0 to 255` }
    return { sgr: `\x1b[38;5;${value}m` }
  }
  if (typeof value !== 'string') return { error: `${key}: expected a color name, a number or "#rrggbb"` }
  const v = value.trim().toLowerCase()
  if (Object.hasOwn(NAMED, v)) return { sgr: `\x1b[${NAMED[v]}m` }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v)
  if (hex) return { sgr: `\x1b[38;2;${parseInt(hex[1], 16)};${parseInt(hex[2], 16)};${parseInt(hex[3], 16)}m` }
  return { error: `${key}: unknown color "${value.slice(0, 40)}"` }
}

/** A theme file's JSON as a palette, or what is wrong with it. */
export function parseUserTheme(raw: unknown): { palette: ThemePalette } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected a JSON object' }
  const { base, colors } = raw as Record<string, unknown>
  const baseName = base === undefined ? 'default' : typeof base === 'string' ? resolveTheme(base) : null
  if (!baseName || !Object.hasOwn(THEMES, baseName)) return { error: `base must be a built-in theme (${Object.keys(THEMES).join(', ')})` }
  const palette: Record<string, string> = { ...THEMES[baseName as keyof typeof THEMES] }
  if (colors !== undefined) {
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return { error: 'colors must be an object' }
    for (const [key, value] of Object.entries(colors)) {
      if (!(THEME_COLOR_KEYS as readonly string[]).includes(key)) {
        return { error: `unknown color key "${key.slice(0, 40)}" (use ${THEME_COLOR_KEYS.join(', ')})` }
      }
      const got = colorSgr(key as ColorKey, value)
      if ('error' in got) return got
      palette[key] = got.sgr
    }
  }
  return { palette: palette as ThemePalette }
}

export interface UserThemes {
  themes: Map<string, ThemePalette>
  /** One line per file that was skipped, and why. */
  errors: string[]
}

export interface ThemeFs {
  list: (dir: string) => string[]
  size: (path: string) => number
  read: (path: string) => string
}

const realFs: ThemeFs = {
  list: (dir) => readdirSync(dir),
  size: (path) => statSync(path).size,
  read: (path) => readFileSync(path, 'utf8')
}

/**
 * Read every `<name>.json` in `dir`. A missing folder is no themes; a bad file is
 * skipped with a reason, and so is one named after a built-in theme (the built-in
 * keeps its name).
 */
export function loadUserThemes(dir: string, fs: ThemeFs = realFs): UserThemes {
  const out: UserThemes = { themes: new Map(), errors: [] }
  let names: string[]
  try {
    names = fs.list(dir)
  } catch {
    return out
  }
  for (const file of names.filter((n) => n.toLowerCase().endsWith('.json')).sort().slice(0, MAX_THEMES)) {
    const name = file.slice(0, -'.json'.length).toLowerCase()
    const label = `themes/${file.slice(0, 64)}`
    if (!NAME_RE.test(name)) {
      out.errors.push(`${label}: skipped, a theme name is letters, digits, - and _`)
      continue
    }
    if (resolveTheme(name)) {
      out.errors.push(`${label}: skipped, ${name} is a built-in theme`)
      continue
    }
    const path = join(dir, file)
    let raw: unknown
    try {
      if (fs.size(path) > MAX_THEME_BYTES) {
        out.errors.push(`${label}: skipped, larger than 16 KB`)
        continue
      }
      raw = JSON.parse(fs.read(path))
    } catch (e) {
      out.errors.push(`${label}: skipped, ${e instanceof SyntaxError ? 'not valid JSON' : 'unreadable'}`)
      continue
    }
    const parsed = parseUserTheme(raw)
    if ('error' in parsed) out.errors.push(`${label}: skipped, ${parsed.error}`)
    else out.themes.set(name, parsed.palette)
  }
  return out
}
