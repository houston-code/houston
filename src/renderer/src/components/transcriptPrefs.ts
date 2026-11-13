import { createContext, useContext } from 'react'

/**
 * How much detail the transcript shows. The settings (`toolOutputExpanded`,
 * `showReasoning`) set the defaults; the transcript's Expand/Collapse tools control
 * sends a command every tool row follows, numbered so a repeat of the same command
 * still reaches rows the user has toggled since.
 */
export interface TranscriptPrefs {
  /** Tool rows open with their output in view. */
  toolsExpanded: boolean
  /** Reasoning stays open under each reply. */
  showReasoning: boolean
  /** The latest Expand all / Collapse all, if any. */
  expandAll: { open: boolean; seq: number } | null
}

export const DEFAULT_TRANSCRIPT_PREFS: TranscriptPrefs = {
  toolsExpanded: false,
  showReasoning: false,
  expandAll: null
}

export const TranscriptPrefsContext = createContext<TranscriptPrefs>(DEFAULT_TRANSCRIPT_PREFS)

export function useTranscriptPrefs(): TranscriptPrefs {
  return useContext(TranscriptPrefsContext)
}

/** Whether a tool row starts open, before the user touches it. */
export function toolRowStartsOpen(prefs: TranscriptPrefs, opts: { awaiting: boolean; agentRunning: boolean }): boolean {
  if (opts.awaiting || opts.agentRunning) return true
  return prefs.expandAll ? prefs.expandAll.open : prefs.toolsExpanded
}
