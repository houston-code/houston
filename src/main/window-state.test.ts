import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The window-state module persists the main window's bounds and decides what to
 * open with on launch. The userData seam is pointed at a temp dir so the
 * load/save round-trips hit real files; `pickStartupBounds` is pure.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

async function mod() {
  return import('./window-state')
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-winstate-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
})

describe('loadWindowState', () => {
  it('returns null when no state file exists', async () => {
    const { loadWindowState } = await mod()
    expect(loadWindowState()).toBeNull()
  })

  it('round-trips bounds through save/load', async () => {
    const { saveWindowState, loadWindowState } = await mod()
    const bounds = { x: 100, y: 200, width: 800, height: 600 }
    saveWindowState(bounds)
    expect(loadWindowState()).toEqual(bounds)
  })

  it('returns null for malformed JSON', async () => {
    writeFileSync(join(state.userData, 'window-state.json'), '{not json', 'utf8')
    const { loadWindowState } = await mod()
    expect(loadWindowState()).toBeNull()
  })

  it('rejects state missing required numeric fields', async () => {
    writeFileSync(join(state.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0 }), 'utf8')
    const { loadWindowState } = await mod()
    expect(loadWindowState()).toBeNull()
  })

  it('rejects non-positive dimensions', async () => {
    writeFileSync(
      join(state.userData, 'window-state.json'),
      JSON.stringify({ x: 0, y: 0, width: 0, height: 600 }),
      'utf8'
    )
    const { loadWindowState } = await mod()
    expect(loadWindowState()).toBeNull()
  })
})

describe('saveWindowState', () => {
  it('writes atomically and leaves no temp file behind', async () => {
    const { saveWindowState } = await mod()
    saveWindowState({ x: 1, y: 2, width: 300, height: 400 })
    expect(existsSync(join(state.userData, 'window-state.json'))).toBe(true)
    expect(existsSync(join(state.userData, 'window-state.json.tmp'))).toBe(false)
  })

  it('overwrites a previous save', async () => {
    const { saveWindowState } = await mod()
    saveWindowState({ x: 1, y: 1, width: 100, height: 100 })
    saveWindowState({ x: 5, y: 5, width: 200, height: 200 })
    const onDisk = JSON.parse(readFileSync(join(state.userData, 'window-state.json'), 'utf8'))
    expect(onDisk).toEqual({ x: 5, y: 5, width: 200, height: 200 })
  })
})

describe('pickStartupBounds', () => {
  it('fills the primary work area when there are no saved bounds', async () => {
    const { pickStartupBounds } = await mod()
    expect(pickStartupBounds(null, WORK_AREA, [WORK_AREA])).toEqual(WORK_AREA)
  })

  it('restores saved bounds that are still visible on a display', async () => {
    const { pickStartupBounds } = await mod()
    const saved = { x: 200, y: 150, width: 800, height: 600 }
    expect(pickStartupBounds(saved, WORK_AREA, [WORK_AREA])).toEqual(saved)
  })

  it('falls back to the work area when saved bounds are off every display', async () => {
    const { pickStartupBounds } = await mod()
    // Saved on a second monitor (x: 2000) that's no longer connected.
    const saved = { x: 2200, y: 100, width: 800, height: 600 }
    expect(pickStartupBounds(saved, WORK_AREA, [WORK_AREA])).toEqual(WORK_AREA)
  })

  it('restores bounds that only partially overlap a display', async () => {
    const { pickStartupBounds } = await mod()
    // Half off the right edge but still well within the visibility margin.
    const saved = { x: 1500, y: 100, width: 800, height: 600 }
    expect(pickStartupBounds(saved, WORK_AREA, [WORK_AREA])).toEqual(saved)
  })

  it('treats a barely-peeking window (under the overlap margin) as off-screen', async () => {
    const { pickStartupBounds } = await mod()
    // Only ~10px of the window pokes back onto the display — below the 48px margin.
    const saved = { x: 1910, y: 100, width: 800, height: 600 }
    expect(pickStartupBounds(saved, WORK_AREA, [WORK_AREA])).toEqual(WORK_AREA)
  })
})
