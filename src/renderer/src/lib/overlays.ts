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
  changes: boolean
  files: boolean
  scorecard: boolean
  help: boolean
  /** The full-size image viewer (opened from a gallery or a tool-card screenshot). */
  viewer: boolean
  palette: boolean
  find: boolean
  /** The get-started "Connect a model" panel (inline, not a modal). */
  connect: boolean
  /** The post-update "What's new" card (bottom-right, non-modal). */
  whatsNew: boolean
}

/** A full-window modal or side drawer is open over the chat (each has a backdrop). */
export function modalOpen(f: OverlayFlags): boolean {
  return f.settings || f.doctor || f.changes || f.files || f.scorecard || f.help || f.viewer || f.palette
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

/** Whether onboarding tips should hold back (something else has the user's attention). */
export function suppressesTips(f: OverlayFlags): boolean {
  return modalOpen(f) || f.find || f.connect || f.whatsNew
}
