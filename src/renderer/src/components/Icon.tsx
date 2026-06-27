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
  check: <path d="M3.5 8.5 6.5 11.5 12.5 5" />
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
