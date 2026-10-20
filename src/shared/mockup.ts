/**
 * `render_mockup`: render an HTML mockup from the project into screenshots, in the
 * viewports and color schemes that matter, without a dev server. The main process
 * validates the arguments and renders; the renderer labels the resulting gallery
 * from the same parsed variants. Pure helpers live here so both share one definition.
 */

export const RENDER_MOCKUP_NAME = 'render_mockup'

/** Most variants one call may render. */
export const MAX_MOCKUP_VARIANTS = 6
/** Tallest a full-page capture gets; anything below is cut off. */
export const MAX_FULL_PAGE_HEIGHT = 6000
export const MIN_MOCKUP_SIZE = 200
export const MAX_MOCKUP_WIDTH = 2560
export const MAX_MOCKUP_HEIGHT = 2000
const MAX_QUERY = 200
const MAX_LABEL = 80

export type ColorScheme = 'light' | 'dark'

export const MOCKUP_PRESETS = {
  desktop: { width: 1280, height: 800, mobile: false },
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true }
} as const
export type MockupPreset = keyof typeof MOCKUP_PRESETS
const PRESET_NAMES = Object.keys(MOCKUP_PRESETS) as MockupPreset[]

export interface MockupVariant {
  label: string
  width: number
  height: number
  colorScheme: ColorScheme
  /** Emulate a touch device, so the page's meta viewport applies. */
  mobile: boolean
  /** Capture the whole page height (up to MAX_FULL_PAGE_HEIGHT), not just the viewport. */
  fullPage: boolean
  /** Appended to the file URL (`?state=error` or `#empty`), so one mockup can show several states. */
  query?: string
}

export interface MockupArgs {
  file: string
  variants: MockupVariant[]
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function defaultLabel(base: string, scheme: ColorScheme, query: string | undefined): string {
  const state = query ? ` ${query}` : ''
  return `${base}, ${scheme}${state}`
}

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a whole number from ${min} to ${max}.`)
  }
  return value
}

function parseVariant(raw: unknown, i: number, fullPageDefault: boolean): MockupVariant {
  const where = `variants[${i}]`
  if (typeof raw === 'string') {
    const m = /^(desktop|tablet|mobile)(?:-(light|dark))?$/.exec(raw.trim().toLowerCase())
    if (!m) {
      throw new Error(`${where} must be a preset like "desktop", "mobile-dark", or "tablet-light", or an object.`)
    }
    const preset = MOCKUP_PRESETS[m[1] as MockupPreset]
    const scheme = (m[2] ?? 'light') as ColorScheme
    return {
      label: defaultLabel(capitalize(m[1]), scheme, undefined),
      width: preset.width,
      height: preset.height,
      colorScheme: scheme,
      mobile: preset.mobile,
      fullPage: fullPageDefault
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be a preset name or an object.`)
  }
  const o = raw as Record<string, unknown>
  let base: { width: number; height: number; mobile: boolean; name?: string }
  if (o.preset !== undefined) {
    if (typeof o.preset !== 'string' || !PRESET_NAMES.includes(o.preset as MockupPreset)) {
      throw new Error(`${where}.preset must be one of: ${PRESET_NAMES.join(', ')}.`)
    }
    base = { ...MOCKUP_PRESETS[o.preset as MockupPreset], name: capitalize(o.preset) }
  } else {
    base = { ...MOCKUP_PRESETS.desktop, name: 'Desktop' }
  }
  const width = o.width === undefined ? base.width : intIn(o.width, `${where}.width`, MIN_MOCKUP_SIZE, MAX_MOCKUP_WIDTH)
  const height =
    o.height === undefined ? base.height : intIn(o.height, `${where}.height`, MIN_MOCKUP_SIZE, MAX_MOCKUP_HEIGHT)
  if (o.colorScheme !== undefined && o.colorScheme !== 'light' && o.colorScheme !== 'dark') {
    throw new Error(`${where}.colorScheme must be "light" or "dark".`)
  }
  const colorScheme = (o.colorScheme ?? 'light') as ColorScheme
  if (o.fullPage !== undefined && typeof o.fullPage !== 'boolean') throw new Error(`${where}.fullPage must be true or false.`)
  if (o.mobile !== undefined && typeof o.mobile !== 'boolean') throw new Error(`${where}.mobile must be true or false.`)
  let query: string | undefined
  if (o.query !== undefined) {
    if (typeof o.query !== 'string' || !/^[?#]/.test(o.query) || o.query.length > MAX_QUERY || /\s/.test(o.query)) {
      throw new Error(`${where}.query must start with "?" or "#", have no spaces, and be at most ${MAX_QUERY} characters.`)
    }
    query = o.query
  }
  let label: string
  if (o.label !== undefined) {
    if (typeof o.label !== 'string' || !o.label.trim()) throw new Error(`${where}.label must be a non-empty string.`)
    label = o.label.replace(/\s+/g, ' ').trim()
    if (label.length > MAX_LABEL) throw new Error(`${where}.label must be at most ${MAX_LABEL} characters.`)
  } else {
    const sized = o.width !== undefined || o.height !== undefined ? `${width}×${height}` : base.name ?? 'Desktop'
    label = defaultLabel(sized, colorScheme, query)
  }
  return {
    label,
    width,
    height,
    colorScheme,
    mobile: typeof o.mobile === 'boolean' ? o.mobile : base.mobile,
    fullPage: typeof o.fullPage === 'boolean' ? o.fullPage : fullPageDefault,
    ...(query ? { query } : {})
  }
}

/**
 * Validate and normalize raw `render_mockup` arguments. Throws a descriptive error
 * on malformed input so the agent gets a useful tool result and can correct itself.
 */
export function parseMockupArgs(args: Record<string, unknown>): MockupArgs {
  if (typeof args.file !== 'string' || !args.file.trim()) throw new Error('file must be a non-empty string.')
  const file = args.file.trim()
  if (!/\.html?$/i.test(file)) throw new Error('file must be an .html or .htm file.')
  if (args.fullPage !== undefined && typeof args.fullPage !== 'boolean') throw new Error('fullPage must be true or false.')
  const fullPage = args.fullPage === true
  const raw = args.variants === undefined ? ['desktop'] : args.variants
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('variants must be a non-empty array.')
  if (raw.length > MAX_MOCKUP_VARIANTS) {
    throw new Error(`variants allows at most ${MAX_MOCKUP_VARIANTS} entries; split them across calls.`)
  }
  return { file, variants: raw.map((v, i) => parseVariant(v, i, fullPage)) }
}

/** Best-effort parse for display code that must not throw. Returns null on bad input. */
export function parseMockupArgsSafe(args: Record<string, unknown> | undefined): MockupArgs | null {
  if (!args) return null
  try {
    return parseMockupArgs(args)
  } catch {
    return null
  }
}
