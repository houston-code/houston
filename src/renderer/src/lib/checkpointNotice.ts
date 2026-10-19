/**
 * What to tell the user after Revert or Redo on the turn's changes bar, or null when
 * nothing needs saying. Success is shown by the bar itself ("Reverted … / Redo"), so
 * it gets no message; this used to be a blocking native alert. Only a shortfall is
 * worth interrupting for: none, or not all, of the files could be put back.
 */
export function checkpointNotice(
  action: 'revert' | 'redo',
  restored: number,
  expected: number
): string | null {
  if (restored === 0) {
    return `Couldn't ${action} this turn's changes: the saved copies of those files are gone.`
  }
  if (restored < expected) {
    const verb = action === 'revert' ? 'Reverted' : 'Re-applied'
    return `${verb} ${restored} of ${expected} files; the rest couldn't be restored.`
  }
  return null
}
