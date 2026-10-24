import { callTool, say, turn, type EvalTask } from '../../types'

/**
 * From Houston PR #453, where `review_changes` reported failures as clean. A review
 * fans out over chunks and reviewers, and two kinds of failure vanish on the way: a
 * reviewer that throws is filtered out of `allSettled`'s results, and a skeptic that
 * throws counts as having refuted the finding. Nothing in the summary can say "some
 * of this didn't run", so the fix spans the runner and the summary. The visible test
 * is the reported crash; the holdout checks the "loses real findings" half of the
 * prompt, which only an agent that reads the verification loop will find.
 */
export const task: EvalTask = {
  id: 'review-failures-reported-clean',
  title: 'Stop a review that partly failed from reporting clean',
  prompt:
    "Our review command printed \"No issues found.\" on a change where one of the reviewers had actually crashed, and I suspect it loses real findings too. `node test.mjs` has the cases. Fix it. test.mjs is the spec, so do not change it.",
  verify: { cmd: 'node', args: ['test.mjs'] },
  // The findings the prompt suspects are lost: beside a crash, and behind a failed check.
  holdout: { cmd: 'node', args: ['hidden.test.mjs'] },
  script: [
    turn(callTool('c1', 'run_shell', { command: 'node test.mjs' })),
    turn(
      callTool('c2', 'read_file', { path: 'review/run.mjs' }),
      callTool('c3', 'read_file', { path: 'review/summary.mjs' }),
      callTool('c4', 'read_file', { path: 'review/format.mjs' })
    ),
    turn(
      callTool('c5', 'multi_edit', {
        path: 'review/run.mjs',
        edits: [
          {
            old_string: [
              '  const settled = await Promise.allSettled(jobs)',
              "  const candidates = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value)",
              ''
            ].join('\n'),
            new_string: [
              '  const settled = await Promise.allSettled(jobs)',
              '  // A step that failed is reported, never dropped: a review that skipped part of',
              '  // the change must not read as a clean one.',
              '  const failures = []',
              '  const candidates = []',
              '  settled.forEach((s, i) => {',
              "    if (s.status === 'fulfilled') return candidates.push(...s.value)",
              '    const chunk = chunks[Math.floor(i / reviewers.length)]',
              '    const r = reviewers[i % reviewers.length]',
              "    failures.push(`${r.name} on chunk ${chunk.index} (${chunk.paths.join(', ')}): ${s.reason?.message ?? s.reason}`)",
              '  })',
              ''
            ].join('\n')
          },
          {
            old_string: [
              '    let ok',
              '    try {',
              '      ok = await verify(finding)',
              '    } catch {',
              '      ok = false',
              '    }',
              '    if (ok) confirmed.push(finding)',
              '  }',
              '  return summarize(confirmed)'
            ].join('\n'),
            new_string: [
              '    try {',
              '      if (await verify(finding)) confirmed.push(finding)',
              '    } catch (err) {',
              '      // The skeptic never answered, so nothing was refuted: keep it, flagged.',
              '      failures.push(`verifying ${finding.id} (${finding.file}): ${err?.message ?? err}`)',
              '      confirmed.push({ ...finding, unverified: true })',
              '    }',
              '  }',
              '  return summarize(confirmed, failures)'
            ].join('\n')
          }
        ]
      }),
      callTool('c6', 'write_file', {
        path: 'review/summary.mjs',
        content: [
          '/**',
          ' * The review\'s verdict, from the findings that survived verification and the steps',
          ' * that failed. Any failure makes the review incomplete, whatever was found.',
          ' */',
          'export function summarize(findings, failures = []) {',
          '  return {',
          "    status: failures.length ? 'incomplete' : findings.length ? 'issues' : 'clean',",
          '    findings,',
          '    failures',
          '  }',
          '}',
          ''
        ].join('\n')
      })
    ),
    turn(callTool('c7', 'run_shell', { command: 'node test.mjs' })),
    turn(
      say(
        "Two failures were being swallowed: a reviewer that threw was filtered out of the settled results, and a skeptic that threw counted as a refutation, which dropped real findings. Both are now recorded as failures, the finding whose check errored is kept and marked unverified, and any failure makes the review `incomplete` instead of `clean`. `node test.mjs` prints ok."
      )
    )
  ]
}
