import type { ITheme } from '@xterm/xterm'

/** The 16 ANSI colours of an xterm theme. */
export type AnsiPalette = Required<
  Pick<
    ITheme,
    | 'black'
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'brightBlack'
    | 'brightRed'
    | 'brightGreen'
    | 'brightYellow'
    | 'brightBlue'
    | 'brightMagenta'
    | 'brightCyan'
    | 'brightWhite'
  >
>

/** xterm.js's own palette, made for a dark background: what the dark themes keep. */
export const DARK_ANSI: AnsiPalette = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec'
}

/**
 * For the light themes' pale background (#f2f0e8, or white with the high-contrast
 * code theme). The dark palette's white, bright white and bright yellow, green and
 * cyan sit near 1:1 there and vanish; every colour here reads at 4.5:1 or better on
 * both. "White" maps to a dim grey and "bright white" to a dark one, the way light
 * terminal themes do, so text a program prints in white still shows.
 */
export const LIGHT_ANSI: AnsiPalette = {
  black: '#2c2a26',
  red: '#c4262e',
  green: '#2b7a2f',
  yellow: '#8a6100',
  blue: '#1f5fbf',
  magenta: '#a2329a',
  cyan: '#0f7480',
  white: '#6a655b',
  brightBlack: '#716b61',
  brightRed: '#b3262d',
  brightGreen: '#22702a',
  brightYellow: '#7d5800',
  brightBlue: '#1a55ad',
  brightMagenta: '#8f2b88',
  brightCyan: '#0b6670',
  brightWhite: '#4b4740'
}

/** The ANSI palette for the resolved app theme (`data-theme` on the document root). */
export function ansiPalette(theme: string | undefined): AnsiPalette {
  return theme === 'light' ? LIGHT_ANSI : DARK_ANSI
}
