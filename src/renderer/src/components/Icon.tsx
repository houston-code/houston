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
  | 'stop'
  | 'close'
  | 'eye'
  | 'terminal'
  | 'tasks'

const PATHS: Record<IconName, ReactNode> = {
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
  // Plus over minus — added/removed lines, i.e. a diff / uncommitted changes.
  diff: (
    <>
      <path d="M8 3.6v3" />
      <path d="M6.5 5.1h3" />
      <path d="M6.5 11h3" />
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
  stop: <path d="M4.8 4.8h6.4v6.4H4.8z" />,
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
