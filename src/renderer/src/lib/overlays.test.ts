import { describe, expect, it } from 'vitest'
import { modalOpen, occludesPreview, ownsShiftTab, suppressesTips, type OverlayFlags } from './overlays'

const none: OverlayFlags = {
  settings: false,
  doctor: false,
  changes: false,
  files: false,
  scorecard: false,
  help: false,
  viewer: false,
  palette: false,
  find: false,
  connect: false,
  whatsNew: false,
  rewind: false
}
const only = (key: keyof OverlayFlags): OverlayFlags => ({ ...none, [key]: true })

const MODALS: (keyof OverlayFlags)[] = [
  'settings',
  'doctor',
  'changes',
  'files',
  'scorecard',
  'help',
  'viewer',
  'palette',
  'rewind'
]

describe('overlays', () => {
  it('reports nothing open for the plain chat view', () => {
    expect(modalOpen(none)).toBe(false)
    expect(occludesPreview(none)).toBe(false)
    expect(ownsShiftTab(none)).toBe(false)
    expect(suppressesTips(none)).toBe(false)
  })

  it.each(MODALS)('treats %s as a modal that hides the preview, owns Shift+Tab, and holds tips', (key) => {
    expect(modalOpen(only(key))).toBe(true)
    expect(occludesPreview(only(key))).toBe(true)
    expect(ownsShiftTab(only(key))).toBe(true)
    expect(suppressesTips(only(key))).toBe(true)
  })

  it('hides the preview under the Files and Scorecard drawers and the Doctor modal', () => {
    // These three were missing from the old hand-written list, so the native preview
    // pane painted over them.
    expect(occludesPreview(only('files'))).toBe(true)
    expect(occludesPreview(only('scorecard'))).toBe(true)
    expect(occludesPreview(only('doctor'))).toBe(true)
  })

  it('lets the find bar keep Shift+Tab without hiding the preview', () => {
    expect(ownsShiftTab(only('find'))).toBe(true)
    expect(occludesPreview(only('find'))).toBe(false)
  })

  it('hides the preview under the What’s new card but leaves Shift+Tab to the chat', () => {
    expect(occludesPreview(only('whatsNew'))).toBe(true)
    expect(ownsShiftTab(only('whatsNew'))).toBe(false)
  })

  it('holds tips while the inline Connect panel is open, without counting it as a modal', () => {
    expect(suppressesTips(only('connect'))).toBe(true)
    expect(modalOpen(only('connect'))).toBe(false)
  })
})
