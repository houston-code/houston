import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-write'
import { join, dirname } from 'node:path'
import { getUserDataDir } from './userData'

/**
 * Persists the main window's bounds so a launch restores wherever the user last
 * left the window. On a fresh install (no saved bounds) the window fills the
 * primary display's work area — covering the whole desktop on first start —
 * until the user resizes or moves it, at which point we remember the new bounds.
 */

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

function statePath(): string {
  return join(getUserDataDir(), 'window-state.json')
}

function isBounds(v: unknown): v is WindowBounds {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b['x'] === 'number' &&
    typeof b['y'] === 'number' &&
    typeof b['width'] === 'number' &&
    typeof b['height'] === 'number' &&
    b['width'] > 0 &&
    b['height'] > 0
  )
}

export function loadWindowState(): WindowBounds | null {
  const path = statePath()
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isBounds(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveWindowState(bounds: WindowBounds): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomicSync(path, JSON.stringify(bounds))
}

/**
 * True when the saved window overlaps at least one display's work area, so we
 * don't restore a window onto a monitor that has since been unplugged (leaving
 * it stranded off-screen). A small overlap is enough — the user can still grab
 * the title bar to pull it back.
 */
function isVisibleOn(bounds: WindowBounds, displays: WindowBounds[]): boolean {
  const MIN_OVERLAP = 48
  return displays.some((d) => {
    const overlapX = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x)
    const overlapY = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y)
    return overlapX >= MIN_OVERLAP && overlapY >= MIN_OVERLAP
  })
}

/**
 * Resolve the bounds to open with: the saved bounds if they're still visible on
 * a connected display, otherwise the primary display's work area (whole desktop).
 */
export function pickStartupBounds(
  saved: WindowBounds | null,
  primaryWorkArea: WindowBounds,
  displays: WindowBounds[]
): WindowBounds {
  if (saved && isVisibleOn(saved, displays)) return saved
  return primaryWorkArea
}
