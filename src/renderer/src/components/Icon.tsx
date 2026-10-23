/**
 * Inline SVG icons drawn on a 16×16 grid with `currentColor` strokes, so they
 * inherit the surrounding text/button color and scale crisply at any size.
 *
 * These replace unicode glyphs whose font coverage is unreliable across the
 * platforms Houston runs on (macOS / Windows / Linux) — a glyph like ⊟ or ⤒
 * can render as tofu or wildly different shapes depending on the system font.
 * Icons are decorative (`aria-hidden`): the button or label around them carries
 * the accessible name.
 */
import type { ReactNode } from 'react'

export type IconName =
  | 'filter'
  | 'archive'
  | 'unarchive'
  | 'import'
  | 'export'
  | 'removeFromGroup'
  | 'copy'
  | 'check'
  | 'plus'
  | 'image'
  | 'file'
  | 'folder'
  | 'at'
  | 'diff'
  | 'clipboard'
  | 'link'
  | 'send'
  | 'steer'
  | 'stop'
  | 'close'
  | 'eye'
  | 'terminal'
  | 'tasks'
  | 'gitBranch'
  | 'shield'
  | 'share'
  | 'mail'
  | 'sideChat'
  | 'split'
  | 'chevronRight'
  | 'warning'
  | 'settings'
  | 'refresh'
  | 'rewind'
  | 'star'
  | 'pencil'
  | 'trash'
  | 'external'

const PATHS: Record<IconName, ReactNode> = {
  // Counter-clockwise arrow: going back to an earlier point.
  rewind: (
    <>
      <path d="M3.2 7.6a5 5 0 1 1 1.5 4.1" />
      <path d="M2.6 4.4v3.4H6" />
    </>
  ),
  // Funnel.
  filter: <path d="M2.5 4h11L9.5 8.6v4.1l-3 1.3V8.6z" />,
  // Storage box with a down arrow — putting a chat away.
  archive: (
    <>
      <path d="M2.2 3.6h11.6v2.8H2.2z" />
      <path d="M3.3 6.4v8.1h9.4V6.4" />
      <path d="M8 8.4v3.4" />
      <path d="M6.5 10.3 8 11.8l1.5-1.5" />
    </>
  ),
  // Storage box with an up arrow — taking a chat back out.
  unarchive: (
    <>
      <path d="M2.2 3.6h11.6v2.8H2.2z" />
      <path d="M3.3 6.4v8.1h9.4V6.4" />
      <path d="M8 11.8V8.4" />
      <path d="M6.5 9.9 8 8.4l1.5 1.5" />
    </>
  ),
  // Up arrow toward a bar at the top — load into the app.
  import: (
    <>
      <path d="M8 13.5V6.6" />
      <path d="M5.3 9.3 8 6.6l2.7 2.7" />
      <path d="M3.5 3h9" />
    </>
  ),
  // Down arrow toward a bar at the bottom — save out to a file.
  export: (
    <>
      <path d="M8 2.5v6.9" />
      <path d="M5.3 6.7 8 9.4l2.7-2.7" />
      <path d="M3.5 13h9" />
    </>
  ),
  // Arrow turning up-and-out of a container — eject from a group.
  removeFromGroup: (
    <>
      <path d="M4 12V8.5A2.5 2.5 0 0 1 6.5 6H11" />
      <path d="M8.7 3.6 11.3 6 8.7 8.4" />
    </>
  ),
  // Two overlapping sheets.
  copy: (
    <>
      <path d="M3.5 6.5h5v6h-5z" />
      <path d="M6 6.5V4h6.5v6.5H10" />
    </>
  ),
  // Checkmark (e.g. the "copied" confirmation).
  check: <path d="M3.5 8.5 6.5 11.5 12.5 5" />,
  // Plus — the composer's "add attachment" affordance.
  plus: (
    <>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </>
  ),
  // Framed picture with a sun and a hill — an image attachment.
  image: (
    <>
      <path d="M2.5 3.5h11v9h-11z" />
      <circle cx="5.6" cy="6.4" r="1" />
      <path d="M3 12 6.5 8.5l2 2 2.5-2.5 2 2" />
    </>
  ),
  // Document with a folded corner — a file.
  file: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  // Tabbed folder.
  folder: <path d="M2.5 4.5h3.6l1.2 1.5h6.2v7.5h-11z" />,
  // The @ sign — reference a workspace file.
  at: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M10.2 8v1.1a1.6 1.6 0 0 0 3.1-.6A5.3 5.3 0 1 0 11 12.6" />
    </>
  ),
  // A page with plus over minus — added/removed lines, i.e. a diff / uncommitted
  // changes. The page outline gives it the same visual weight as its titlebar
  // neighbours; a bare ± read as a speck.
  diff: (
    <>
      <path d="M3.5 2.5h9v11h-9z" />
      <path d="M8 4.7v3" />
      <path d="M6.5 6.2h3" />
      <path d="M6.5 10.3h3" />
    </>
  ),
  // Clipboard with a clip — paste from clipboard.
  clipboard: (
    <>
      <path d="M4 3.5h8v10H4z" />
      <path d="M6 3.5a2 2 0 0 1 4 0" />
    </>
  ),
  // Two chain links — attach a URL.
  link: (
    <>
      <path d="M6.8 9.2a2.4 2.4 0 0 0 3.4 0l2-2a2.4 2.4 0 0 0-3.4-3.4l-1 1" />
      <path d="M9.2 6.8a2.4 2.4 0 0 0-3.4 0l-2 2a2.4 2.4 0 0 0 3.4 3.4l1-1" />
    </>
  ),
  // Upward arrow — send the message.
  send: (
    <>
      <path d="M8 13V4" />
      <path d="M4.5 7.5 8 4l3.5 3.5" />
    </>
  ),
  // Rounded square — stop the run.
  // An arrow pushing into a bar (→|): inject into the run that is already going.
  steer: (
    <>
      <path d="M2.5 8h7" />
      <path d="M6.5 5l3 3-3 3" />
      <path d="M13 3.5v9" />
    </>
  ),
  stop: <path d="M4.8 4.8h6.4v6.4H4.8z" />,
  // Speech bubble with a tail — the side chat (ask aside, off the main thread).
  sideChat: (
    <>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      <path d="M5.5 6.5h5" />
    </>
  ),
  // A path forking in two — split off parallel work into its own session.
  // A right-pointing chevron; rotated 90deg when its row is expanded.
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  // Warning triangle with an exclamation mark.
  warning: (
    <>
      <path d="M8 2.2 14.3 13.3H1.7z" />
      <path d="M8 6.3v3.4" />
      <path d="M8 11.7v.1" />
    </>
  ),
  split: (
    <>
      <path d="M8 13.5V8.5" />
      <path d="M8 8.5 4 4.5" />
      <path d="M8 8.5l4-4" />
      <path d="M3.5 7V4h3" />
      <path d="M12.5 7V4h-3" />
    </>
  ),
  // X — dismiss a chip.
  close: (
    <>
      <path d="M4.5 4.5 11.5 11.5" />
      <path d="M11.5 4.5 4.5 11.5" />
    </>
  ),
  // Eye — preview / show the live preview panel.
  eye: (
    <>
      <path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  // Framed window with a chevron prompt and cursor line — a terminal.
  terminal: (
    <>
      <path d="M2.3 3.6h11.4v8.8H2.3z" />
      <path d="m4.7 6.7 1.9 1.6-1.9 1.6" />
      <path d="M8 10h3.1" />
    </>
  ),
  // Checklist — a list of tasks with a leading check.
  tasks: (
    <>
      <path d="m2.6 4.7 1 1 1.7-1.9" />
      <path d="M7.5 4.8h6" />
      <path d="M7.5 8h6" />
      <path d="M7.5 11.2h6" />
      <path d="M2.7 7.8h.01" />
      <path d="M2.7 11h.01" />
    </>
  ),
  // Two nodes joined by a branching line — a git branch / repository.
  gitBranch: (
    <>
      <path d="M4.3 2.2v7.3" />
      <circle cx="4.3" cy="11.6" r="1.9" />
      <circle cx="11.7" cy="4.4" r="1.9" />
      <path d="M11.7 6.3a5.4 5.4 0 0 1-5.4 5.3" />
    </>
  ),
  // A shield — trust / protection (the trusted-folders consent banner).
  shield: (
    <>
      <path d="M8 1.8 13 3.7v4.1c0 3.1-2.1 5.4-5 6.4-2.9-1-5-3.3-5-6.4V3.7L8 1.8z" />
      <path d="m5.8 7.8 1.6 1.6 2.8-3" />
    </>
  ),
  // A box with an arrow leaving it: share (the platform share-sheet glyph).
  share: (
    <>
      <path d="M8 10V2.5" />
      <path d="M5.5 5 8 2.5 10.5 5" />
      <path d="M5.5 7.5H4v6h8v-6h-1.5" />
    </>
  ),
  // An envelope: send by email.
  mail: (
    <>
      <path d="M2.5 4.5h11v7h-11z" />
      <path d="m2.5 4.5 5.5 4.2 5.5-4.2" />
    </>
  ),
  // A toothed cog — settings.
  settings: (
    <>
      <path d="M12.71 6.65 14.22 7.01 14.22 8.99 12.71 9.35 12.29 10.38 13.1 11.7 11.7 13.1 10.38 12.29 9.35 12.71 8.99 14.22 7.01 14.22 6.65 12.71 5.62 12.29 4.3 13.1 2.9 11.7 3.71 10.38 3.29 9.35 1.78 8.99 1.78 7.01 3.29 6.65 3.71 5.62 2.9 4.3 4.3 2.9 5.62 3.71 6.65 3.29 7.01 1.78 8.99 1.78 9.35 3.29 10.38 3.71 11.7 2.9 13.1 4.3 12.29 5.62z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // A circular arrow — refresh / retry.
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M12.2 2.2v2.6H9.6" />
    </>
  ),
  // A five-pointed star — pin a chat to the top.
  star: <path d="M8 2.6l1.65 3.35 3.7.54-2.68 2.6.63 3.68L8 11.03l-3.3 1.74.63-3.68-2.68-2.6 3.7-.54z" />,
  // A pencil — rename.
  pencil: (
    <>
      <path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.1.6.6-3.1z" />
      <path d="M9.2 4.3l2.5 2.5" />
    </>
  ),
  // A lidded bin — delete.
  trash: (
    <>
      <path d="M3 4.5h10" />
      <path d="M6.2 4.5V3h3.6v1.5" />
      <path d="M4.3 4.5l.6 8.5h6.2l.6-8.5" />
      <path d="M6.8 7v3.8M9.2 7v3.8" />
    </>
  ),
  // An arrow leaving a box — open in another app.
  external: (
    <>
      <path d="M12.5 9v3.5h-9v-9H7" />
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 8 8" />
    </>
  )
}

export function Icon({
  name,
  size = 14,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      data-icon={name}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
