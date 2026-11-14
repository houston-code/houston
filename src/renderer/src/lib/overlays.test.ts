import { describe, expect, it } from 'vitest'
import { modalOpen, occludesPreview, ownsShiftTab, shortcutAllowedOverModal, suppressesTips, type OverlayFlags } from './overlays'

const none: OverlayFlags = {
  settings: false,
  doctor: false,
  issue: false,
  scorecard: false,
  usage: false,
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
  'issue',
  'scorecard',
  'usage',
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

  it('hides the preview under the Scorecard drawer and the Doctor modal', () => {
    // These were missing from the old hand-written list, so the native preview pane
    // painted over them. (Files, also once missing, is now a tab of the same dock.)
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

  it('lets only the keys that close the open modal act over it', () => {
    expect(shortcutAllowedOverModal('new-chat', none)).toBe(true)
    expect(shortcutAllowedOverModal('find-in-chat', only('find'))).toBe(true)
    for (const key of MODALS) {
      expect(shortcutAllowedOverModal('escape', only(key))).toBe(true)
      for (const action of ['new-chat', 'find-in-chat', 'open-settings', 'select-chat-n', 'toggle-sidebar'] as const) {
        expect(shortcutAllowedOverModal(action, only(key)), `${action} over ${key}`).toBe(false)
      }
    }
    expect(shortcutAllowedOverModal('command-palette', only('palette'))).toBe(true)
    expect(shortcutAllowedOverModal('command-palette', only('settings'))).toBe(false)
    expect(shortcutAllowedOverModal('show-help', only('help'))).toBe(true)
    expect(shortcutAllowedOverModal('show-help', only('palette'))).toBe(false)
  })

  it('holds tips while the inline Connect panel is open, without counting it as a modal', () => {
    expect(suppressesTips(only('connect'))).toBe(true)
    expect(modalOpen(only('connect'))).toBe(false)
  })
})
