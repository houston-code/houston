import { createContext, useContext, type MouseEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { FileTarget } from '../lib/fileLinks'

/**
 * How the transcript opens a file it mentions: the open chat's workspace (paths are
 * checked against it) and what opening does (the Files panel's preview, at the line
 * when one is known). Absent outside a chat with a project folder, where paths stay
 * plain text.
 */
export interface FileLinks {
  workspace: string
  open: (target: FileTarget) => void
}

export const FileLinkContext = createContext<FileLinks | null>(null)

export function useFileLinks(): FileLinks | null {
  return useContext(FileLinkContext)
}

/**
 * A path the user can click to preview the file. A button rather than an anchor,
 * since it opens a panel, not a page. Stops the click from reaching a clickable row
 * it sits in (a tool row toggles open on click).
 */
export function FileLink({
  target,
  links,
  className,
  title,
  children
}: {
  target: FileTarget
  links: FileLinks
  className?: string
  title?: string
  children: ReactNode
}): JSX.Element {
  const where = target.line ? `${target.path}, line ${target.line}` : target.path
  const open = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    links.open(target)
  }
  return (
    <button
      type="button"
      className={className ? `file-link ${className}` : 'file-link'}
      title={title ?? `Open ${where}`}
      onClick={open}
      onKeyDown={(e) => {
        // Enter and Space activate the button; keep them from also toggling a parent row.
        if (e.key === 'Enter' || e.key === ' ') open(e)
      }}
    >
      {children}
    </button>
  )
}
