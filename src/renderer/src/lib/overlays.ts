import type { ShortcutId } from './shortcuts'

/**
 * Which app surfaces are open, and what each kind of overlay means for the rest of
 * the window. App.tsx used to keep three separate hand-written lists of these flags
 * (for the preview dock, the Shift+Tab mode cycle, and onboarding tips), and they
 * drifted: the Files and Scorecard drawers and the Doctor modal were missing from the
 * preview list, so the native preview pane painted over them. One definition here
 * keeps them in step.
 */
export interface OverlayFlags {
  settings: boolean
  doctor: boolean
  /** Help > Report an Issue: what the new issue will start with. */
  issue: boolean
  scorecard: boolean
  /** The usage drawer (spend and tokens per day and per project). */
  usage: boolean
  help: boolean
  /** The full-size image viewer (opened from a gallery or a tool-card screenshot). */
  viewer: boolean
  palette: boolean
  find: boolean
  /** The get-started "Connect a model" panel (inline, not a modal). */
  connect: boolean
  /** The post-update "What's new" card (bottom-right, non-modal). */
  whatsNew: boolean
  /** The rewind picker or its confirmation. */
  rewind: boolean
}

/** A full-window modal or side drawer is open over the chat (each has a backdrop). */
export function modalOpen(f: OverlayFlags): boolean {
  return (
    f.settings ||
    f.doctor ||
    f.issue ||
    f.scorecard ||
    f.usage ||
    f.help ||
    f.viewer ||
    f.palette ||
    f.rewind
  )
}

/**
 * Whether the native preview views must be hidden. They are WebContentsViews that
 * paint above every HTML element, so anything drawn over the right side of the
 * window (every modal and drawer, and the What's new card that sits in the corner the
 * dock occupies) would otherwise be covered by them.
 */
export function occludesPreview(f: OverlayFlags): boolean {
  return modalOpen(f) || f.whatsNew
}

/**
 * Whether Shift+Tab belongs to something other than the approval-mode cycle: inside a
 * dialog or the find bar it is reverse focus navigation.
 */
export function ownsShiftTab(f: OverlayFlags): boolean {
  return modalOpen(f) || f.find
}

/**
 * Whether a global shortcut may act while a modal is open over the chat. Only the keys
 * that close or toggle that modal pass: Esc, and the palette or shortcuts-sheet key
 * while that sheet is the one open. The rest (new chat, find, Settings, switching
 * chats, the sidebar) would change the view behind the dialog, or open a second one
 * under its backdrop where its focus trap then fights the first.
 */
export function shortcutAllowedOverModal(action: ShortcutId | null, f: OverlayFlags): boolean {
  if (!modalOpen(f)) return true
  if (action === 'escape') return true
  if (action === 'command-palette') return f.palette
  if (action === 'show-help') return f.help
  return false
}

/** Whether onboarding tips should hold back (something else has the user's attention). */
export function suppressesTips(f: OverlayFlags): boolean {
  return modalOpen(f) || f.find || f.connect || f.whatsNew
}
