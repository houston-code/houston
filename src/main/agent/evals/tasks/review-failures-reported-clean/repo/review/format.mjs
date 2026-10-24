/** The text the review command prints. */
export function formatReview(result) {
  if (result.status === 'clean') return 'No issues found.'
  const lines = []
  if (result.status === 'incomplete') {
    const n = result.failures.length
    lines.push(`Review incomplete: ${n} ${n === 1 ? 'step' : 'steps'} failed, so this is not a clean bill of health.`)
    for (const f of result.failures) lines.push(`  ! ${f}`)
  }
  for (const f of result.findings) {
    lines.push(`${f.file}: ${f.message} (${f.reviewer})${f.unverified ? ' [unverified]' : ''}`)
  }
  return lines.join('\n')
}
