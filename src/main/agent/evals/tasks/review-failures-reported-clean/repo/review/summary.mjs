/** The review's verdict, from the findings that survived verification. */
export function summarize(findings) {
  return {
    status: findings.length ? 'issues' : 'clean',
    findings
  }
}
